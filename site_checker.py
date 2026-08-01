#!/usr/bin/env python3
"""
PRC Workforce — website accuracy & health checker (+ UK HR news watch).

Crawls a site (default: https://www.prcworkforce.com/) and reports:

  1. Broken links        — links that genuinely fail (404/410/5xx/unreachable),
                           kept separate from links that merely block automated
                           checkers (403/429 — flagged "verify manually").
  2. Flagship consistency — the claims that should be identical everywhere
                            (core programme length, headline per-employee price)
                            checked for disagreement page-to-page.
  3. Stats to verify      — percentage/"million"-style claims about people or
                            businesses stated with no visible source. These are
                            the highest risk for inaccuracies/falsehoods.
  4. Page-quality issues  — missing <title>/meta description, missing/multiple H1,
                            thin pages, duplicate titles.
  5. UK HR / employment-law news — recent items from UK sources (GOV.UK, Acas,
                            Personnel Today, CIPD). UK-scoped so it does NOT drift
                            into China/PRC-as-country news.

Output: Markdown report -> reports/site-check-<timestamp>.md and reports/latest.md

Runtime: Python 3.9+
Dependencies: requests, beautifulsoup4, feedparser
    pip install requests beautifulsoup4 feedparser

Usage:
    python site_checker.py
    python site_checker.py --url https://example.com --max-pages 80
    python site_checker.py --no-news        # skip the UK HR news watch
    python site_checker.py --no-external    # skip external link checks
"""

from __future__ import annotations

import argparse
import os
import re
import smtplib
import ssl
import sys
import time
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formatdate
from html import escape as _esc
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from urllib.parse import urljoin, urlparse, urldefrag

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:
    sys.exit("Missing deps. Run: pip install requests beautifulsoup4 feedparser")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DEFAULT_URL = "https://www.prcworkforce.com/"
DEFAULT_MAX_PAGES = 60
CRAWL_DELAY = 0.4
TIMEOUT = 20
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

NON_HTML_EXT = (
    ".pdf", ".jpg", ".jpeg", ".png", ".gif", ".svg", ".webp", ".ico", ".zip",
    ".mp4", ".mov", ".mp3", ".css", ".js", ".xml", ".json", ".woff", ".woff2",
    ".ttf", ".eot",
)

CITATION_HINTS = (
    "source", "according to", "ons", "gov.uk", "study", "report", "research",
    "survey", "cipd", "acas", "hse", "office for national statistics", "deloitte",
    "mckinsey", "oxford economics", "[", "footnote", "cite",
)

# Words that mark a percentage as a *claim about people/businesses* (worth
# verifying) rather than an internal calculator number.
CLAIM_SUBJECTS = (
    "employe", "worker", "workforce", "staff", "people", "business", "compan",
    "organisation", "organization", "manager", "team", "eap", "absence",
    "productivity", "turnover", "retention", "burnout", "sick", "uk ",
)

# UK HR / employment-law news feeds (RSS/Atom). UK-scoped on purpose.
UK_NEWS_FEEDS = [
    ("GOV.UK — Business & Trade news",
     "https://www.gov.uk/search/news-and-communications.atom"
     "?organisations%5B%5D=department-for-business-and-trade"),
    ("GOV.UK — DWP news",
     "https://www.gov.uk/search/news-and-communications.atom"
     "?organisations%5B%5D=department-for-work-pensions"),
    ("Acas — news", "https://www.acas.org.uk/news.atom"),
    ("Personnel Today", "https://www.personneltoday.com/feed/"),
    ("People Management (CIPD)", "https://www.peoplemanagement.co.uk/feed"),
]
UK_NEWS_KEYWORDS = (
    "employment", "worker", "workforce", "employee", "employer", "tribunal",
    "redundancy", "dismissal", "discrimination", "holiday pay", "minimum wage",
    "national living wage", "sick pay", "ssp", "acas", "trade union", "tupe",
    "flexible working", "maternity", "paternity", "right to work", "ir35",
    "zero hours", "employment rights", "hr", "payroll", "pension", "whistleblow",
    "harassment", "grievance", "wellbeing", "mental health", "absence",
)
# Exclude items that are really about other countries (the old tool's bug).
UK_NEWS_EXCLUDE = ("china", "chinese", "prc ", "beijing", "hong kong", "japan",
                   "korea", "singapore", "xinjiang", "mohrss")
NEWS_LOOKBACK_DAYS = 14


# ---------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------


@dataclass
class Page:
    url: str
    status: int = 0
    title: str = ""
    meta_description: str = ""
    h1_count: int = 0
    word_count: int = 0
    text: str = ""
    internal_links: set = field(default_factory=set)
    external_links: set = field(default_factory=set)
    error: str = ""


# ---------------------------------------------------------------------------
# URL helpers — canonicalise so www/non-www aren't crawled twice
# ---------------------------------------------------------------------------

START_NETLOC = ""  # set in main(), e.g. "www.prcworkforce.com"


def registered(netloc: str) -> str:
    return netloc.lower().replace("www.", "")


def canonical(url: str) -> str:
    """Strip fragment, trailing slash, and force the canonical host for same-site URLs."""
    url, _ = urldefrag(url)
    parts = urlparse(url)
    netloc = parts.netloc
    if START_NETLOC and registered(netloc) == registered(START_NETLOC):
        netloc = START_NETLOC
        scheme = "https"
    else:
        scheme = parts.scheme or "https"
    path = parts.path
    if path in ("", "/"):
        path = ""                      # canonicalise the site root to one form
    elif path.endswith("/"):
        path = path.rstrip("/")
    rebuilt = f"{scheme}://{netloc}{path}"
    if parts.query:
        rebuilt += f"?{parts.query}"
    return rebuilt


def is_internal(url: str) -> bool:
    return registered(urlparse(url).netloc) == registered(START_NETLOC)


def looks_like_html(url: str) -> bool:
    return not urlparse(url).path.lower().endswith(NON_HTML_EXT)


# ---------------------------------------------------------------------------
# Crawl
# ---------------------------------------------------------------------------


def fetch(session, url):
    try:
        return session.get(url, timeout=TIMEOUT, allow_redirects=True)
    except requests.RequestException as exc:
        print(f"[warn] fetch failed: {url} ({exc})", file=sys.stderr)
        return None


def parse_page(url, resp) -> Page:
    page = Page(url=url, status=resp.status_code)
    if "html" not in resp.headers.get("Content-Type", "").lower():
        return page
    # Use raw bytes so BeautifulSoup detects the real charset (avoids £ -> "Â£").
    soup = BeautifulSoup(resp.content, "html.parser")
    if soup.title and soup.title.string:
        page.title = soup.title.string.strip()
    md = soup.find("meta", attrs={"name": "description"})
    if md and md.get("content"):
        page.meta_description = md["content"].strip()
    page.h1_count = len(soup.find_all("h1"))
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()
    page.text = re.sub(r"\s+", " ", soup.get_text(" ")).strip()
    page.word_count = len(page.text.split())
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if href.startswith(("mailto:", "tel:", "javascript:", "#")):
            continue
        absolute = canonical(urljoin(url, href))
        if is_internal(absolute):
            page.internal_links.add(absolute)
        elif absolute.startswith("http"):
            page.external_links.add(absolute)
    return page


def crawl(start_url, max_pages) -> dict:
    session = requests.Session()
    session.headers.update({"User-Agent": BROWSER_UA})
    start = canonical(start_url)
    queue, seen, pages = [start], set(), {}
    while queue and len(pages) < max_pages:
        url = queue.pop(0)
        if url in seen:
            continue
        seen.add(url)
        if not looks_like_html(url):
            continue
        resp = fetch(session, url)
        if resp is None:
            pages[url] = Page(url=url, error="request failed")
            continue
        page = parse_page(url, resp)
        pages[url] = page
        print(f"[info] crawled {url} -> {page.status} ({page.word_count} words)")
        for link in page.internal_links:
            if link not in seen and looks_like_html(link):
                queue.append(link)
        time.sleep(CRAWL_DELAY)
    return pages


# ---------------------------------------------------------------------------
# Link checking (separate genuinely-broken from bot-blocked)
# ---------------------------------------------------------------------------


def check_links(pages, check_external) -> tuple[list, list]:
    session = requests.Session()
    session.headers.update({"User-Agent": BROWSER_UA})
    link_sources = defaultdict(set)
    for page in pages.values():
        for link in page.internal_links:
            link_sources[link].add(page.url)
        if check_external:
            for link in page.external_links:
                link_sources[link].add(page.url)
    known = {u: p.status for u, p in pages.items() if p.status}

    broken, blocked = [], []
    cache = {}
    for link, sources in link_sources.items():
        if link in known:
            status = known[link]
        elif link in cache:
            status = cache[link]
        else:
            status = 0
            try:
                r = session.get(link, timeout=TIMEOUT, allow_redirects=True)
                status = r.status_code
            except requests.RequestException:
                status = 0
            cache[link] = status
            time.sleep(0.15)
        rec = {"url": link, "status": status, "found_on": sorted(sources)}
        if status in (403, 429, 405, 999):
            blocked.append(rec)                      # anti-bot, not necessarily dead
        elif status == 0 or status in (404, 410) or status >= 500:
            broken.append(rec)                        # genuinely broken
    return broken, blocked


# ---------------------------------------------------------------------------
# Flagship consistency: claims that SHOULD be identical everywhere
# ---------------------------------------------------------------------------

DAYS_RE = re.compile(r"(\d{1,3})[-\s]?day", re.IGNORECASE)
PRICE_PER_RE = re.compile(
    r"£\s?(\d[\d,]*(?:\.\d+)?)\s*(?:/|per)\s*(employee|seat|user|head|person|staff)",
    re.IGNORECASE,
)
PROGRAMME_WORDS = ("protocol", "programme", "program", "journey", "plan", "course")


def _windows(text, match_iter, radius=45):
    """Yield (value, context) for each regex match, with a text window around it."""
    for m in match_iter:
        s, e = m.span()
        ctx = text[max(0, s - radius): e + radius].lower()
        yield m, ctx


def flagship_consistency(pages) -> list:
    """Flag disagreement only in claims that ought to be singular."""
    programme_days = defaultdict(set)   # value -> pages (only near programme words)
    per_emp_price = defaultdict(set)    # value -> pages

    for page in pages.values():
        if not page.text:
            continue
        t = page.text
        for m, ctx in _windows(t, DAYS_RE.finditer(t)):
            if any(w in ctx for w in PROGRAMME_WORDS):
                programme_days[f"{m.group(1)}-day"].add(page.url)
        for m in PRICE_PER_RE.finditer(t):
            val = "£" + m.group(1).replace(",", "")
            per_emp_price[f"{val} per {m.group(2).lower()}"].add(page.url)

    findings = []
    if len(programme_days) > 1:
        findings.append({
            "claim": "Core programme length (values seen next to programme/protocol wording)",
            "values": {k: sorted(v) for k, v in programme_days.items()},
        })
    if len(per_emp_price) > 1:
        findings.append({
            "claim": "Per-employee price",
            "values": {k: sorted(v) for k, v in per_emp_price.items()},
        })
    return findings


# ---------------------------------------------------------------------------
# Stats-to-verify (percentage / million claims about people, no source)
# ---------------------------------------------------------------------------

SENTENCE_RE = re.compile(r"[^.!?]*[.!?]")
STAT_RE = re.compile(r"(\b\d{1,3}(?:\.\d+)?\s?%|\b\d[\d,]*\s?(?:million|billion|thousand)\b)",
                     re.IGNORECASE)


def stats_to_verify(pages) -> list:
    findings, seen = [], set()
    for page in pages.values():
        if not page.text:
            continue
        for raw in SENTENCE_RE.findall(page.text):
            s = raw.strip()
            if not (25 <= len(s) <= 300):
                continue
            if not STAT_RE.search(s):
                continue
            low = s.lower()
            if any(h in low for h in CITATION_HINTS):
                continue
            if not any(w in low for w in CLAIM_SUBJECTS):
                continue
            if low in seen:
                continue
            seen.add(low)
            findings.append({"sentence": s, "page": page.url})
    return findings


# ---------------------------------------------------------------------------
# Page quality
# ---------------------------------------------------------------------------


def page_quality(pages) -> dict:
    issues = {
        "missing_title": [], "missing_meta_description": [],
        "missing_or_multiple_h1": [], "thin_content": [], "duplicate_titles": [],
    }
    titles = defaultdict(list)
    for p in pages.values():
        if p.error or not p.status or p.status >= 400:
            continue
        if not p.title:
            issues["missing_title"].append(p.url)
        else:
            titles[p.title].append(p.url)
        if not p.meta_description:
            issues["missing_meta_description"].append(p.url)
        if p.h1_count != 1:
            issues["missing_or_multiple_h1"].append(f"{p.url} (H1s: {p.h1_count})")
        if p.word_count and p.word_count < 120:
            issues["thin_content"].append(f"{p.url} ({p.word_count} words)")
    for title, urls in titles.items():
        if len(urls) > 1:
            issues["duplicate_titles"].append(f'"{title}" — {", ".join(urls)}')
    return issues


# ---------------------------------------------------------------------------
# UK HR news watch
# ---------------------------------------------------------------------------


def uk_hr_news() -> list:
    try:
        import feedparser
    except ImportError:
        return [{"error": "feedparser not installed — skipping news watch"}]

    cutoff = datetime.now(timezone.utc) - timedelta(days=NEWS_LOOKBACK_DAYS)
    items = []
    for name, url in UK_NEWS_FEEDS:
        try:
            parsed = feedparser.parse(url)
        except Exception as exc:  # noqa: BLE001
            print(f"[warn] news feed failed: {name} ({exc})", file=sys.stderr)
            continue
        for e in parsed.entries:
            when = None
            for key in ("published_parsed", "updated_parsed"):
                if e.get(key):
                    when = datetime(*e[key][:6], tzinfo=timezone.utc)
                    break
            if when is not None and when < cutoff:
                continue
            hay = f"{e.get('title','')} {e.get('summary','')}".lower()
            if not any(k in hay for k in UK_NEWS_KEYWORDS):
                continue
            if any(x in hay for x in UK_NEWS_EXCLUDE):
                continue
            items.append({
                "source": name,
                "title": e.get("title", "(no title)").strip(),
                "link": e.get("link", ""),
                "when": when,
            })
    items.sort(key=lambda i: (i["when"] is not None, i["when"] or cutoff), reverse=True)
    return items


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------


def _fmt_date(when):
    return when.strftime("%d %b %Y") if when else "Undated"


def build_report(start_url, pages, broken, blocked, flagship, stats, quality,
                 news, generated) -> str:
    ok = [p for p in pages.values() if p.status and p.status < 400]
    failed = [p for p in pages.values() if p.error or not p.status or p.status >= 400]
    action = "ACTION REQUIRED" if (broken or flagship or failed) else "REVIEW"

    L = ["# PRC Workforce — Website Check", "",
         f"*Generated {generated.strftime('%d %b %Y %H:%M UTC')} · target: {start_url}*", "",
         "## Summary", "",
         "| Metric | Value |", "| --- | --- |",
         f"| Pages crawled | {len(pages)} |",
         f"| Pages OK | {len(ok)} |",
         f"| Pages failed | {len(failed)} |",
         f"| Broken links (genuine) | {len(broken)} |",
         f"| Links to verify manually (bot-blocked) | {len(blocked)} |",
         f"| Flagship inconsistencies | {len(flagship)} |",
         f"| Stats to verify | {len(stats)} |",
         f"| Missing meta descriptions | {len(quality['missing_meta_description'])} |",
         f"| UK HR news items | {len([n for n in news if 'error' not in n])} |",
         "", f"**Status: {action}**", ""]

    # 1. Broken links
    L += ["## 1. Broken links", ""]
    if not broken:
        L.append("No genuinely broken links found (nothing returned 404/410/5xx or was unreachable).")
    else:
        L += ["These returned 404/410/5xx or did not resolve (`status 0`). Fix or remove.", "",
              "| Link | Status | Found on |", "| --- | --- | --- |"]
        for b in sorted(broken, key=lambda x: x["status"]):
            found = "<br>".join(b["found_on"][:3]) + (
                f"<br>(+{len(b['found_on'])-3} more)" if len(b["found_on"]) > 3 else "")
            L.append(f"| {b['url']} | {b['status']} | {found} |")
    L.append("")
    if blocked:
        L += ["**Links to verify manually** — these returned 403/429, which usually means the "
              "site blocks automated checkers, *not* that the link is dead. Open each in a browser to confirm.",
              "", "| Link | Status | Found on |", "| --- | --- | --- |"]
        for b in sorted(blocked, key=lambda x: x["status"]):
            found = "<br>".join(b["found_on"][:3]) + (
                f"<br>(+{len(b['found_on'])-3} more)" if len(b["found_on"]) > 3 else "")
            L.append(f"| {b['url']} | {b['status']} | {found} |")
        L.append("")

    # 2. Flagship consistency
    L += ["## 2. Flagship consistency", "",
          "Claims that should read the *same* everywhere on the site. A difference here is "
          "the kind of contradiction a prospect or auditor would notice.", ""]
    if not flagship:
        L.append("No inconsistency detected in core programme length or per-employee price.")
    else:
        for f in flagship:
            L += [f"### {f['claim']}", ""]
            for val, urls in f["values"].items():
                L.append(f"- **{val}** on:")
                for u in urls:
                    L.append(f"    - {u}")
            L.append("")
    L.append("")

    # 3. Stats to verify
    L += ["## 3. Stats to verify (no visible source)", "",
          "Claims about people or businesses stated with a percentage or big number and **no nearby "
          "citation**. These are the highest-risk lines for inaccuracies — confirm each has a source you can stand behind.", ""]
    if not stats:
        L.append("None flagged.")
    else:
        for f in stats[:50]:
            L += [f"- \"{f['sentence']}\"", f"  — {f['page']}"]
        if len(stats) > 50:
            L.append(f"\n_(+{len(stats)-50} more.)_")
    L.append("")

    # 4. Page quality
    L += ["## 4. Page-quality issues", ""]
    labels = {
        "missing_title": "Pages with no <title>",
        "missing_meta_description": "Pages with no meta description",
        "missing_or_multiple_h1": "Pages without exactly one H1",
        "thin_content": "Thin pages (under 120 words)",
        "duplicate_titles": "Duplicate page titles",
    }
    any_q = False
    for key, label in labels.items():
        items = quality[key]
        if items:
            any_q = True
            L += [f"**{label}** ({len(items)}):", ""]
            L += [f"- {it}" for it in items]
            L.append("")
    if not any_q:
        L.append("No page-quality issues found.")
    L.append("")

    # 5. UK HR news
    L += ["## 5. UK HR / employment-law news", "",
          f"Recent UK items (previous {NEWS_LOOKBACK_DAYS} days), UK-scoped so it stays on your market. "
          "Open the link to read the source.", ""]
    real = [n for n in news if "error" not in n]
    errs = [n for n in news if "error" in n]
    if errs:
        L.append(f"_Note: {errs[0]['error']}_")
        L.append("")
    if not real:
        L.append("No new UK HR items in the window.")
    else:
        for n in real:
            L.append(f"- **[{_fmt_date(n['when'])}]** {n['title']}  \n  {n['source']} — {n['link']}")
    L.append("")

    # Appendix
    L += ["## Appendix — pages crawled", "", "| Page | Status | Words |", "| --- | --- | --- |"]
    for p in sorted(pages.values(), key=lambda x: x.url):
        st = p.status if p.status else (p.error or "ERR")
        L.append(f"| {p.url} | {st} | {p.word_count} |")
    L.append("")
    return "\n".join(L)


# ---------------------------------------------------------------------------
# Email delivery
# ---------------------------------------------------------------------------


def email_report(report_md: str, generated: datetime, summary_line: str) -> None:
    """
    Email the report. Configure via environment variables (GitHub Actions secrets):
        SMTP_HOST, SMTP_PORT (587 STARTTLS or 465 SSL), SMTP_USER, SMTP_PASS,
        EMAIL_FROM (defaults to SMTP_USER), EMAIL_TO (defaults to jon@prcworkforce.com).
    """
    host = os.environ.get("SMTP_HOST")
    port = int(os.environ.get("SMTP_PORT", "587"))
    user = os.environ.get("SMTP_USER")
    password = os.environ.get("SMTP_PASS")
    sender = os.environ.get("EMAIL_FROM", user or "")
    recipient = os.environ.get("EMAIL_TO", "jon@prcworkforce.com")

    missing = [n for n, v in (("SMTP_HOST", host), ("SMTP_USER", user),
                              ("SMTP_PASS", password)) if not v]
    if missing:
        print(f"[warn] email skipped — missing env vars: {', '.join(missing)}",
              file=sys.stderr)
        return

    subject = f"PRC Workforce — Website Check ({generated.strftime('%d %b %Y')})"
    html_body = (
        '<div style="font-family:Arial,Helvetica,sans-serif;color:#0b1f3a;max-width:720px;">'
        '<div style="background:#0b1f3a;color:#c9a227;padding:14px 18px;font-weight:bold;">'
        'PRC Workforce — Website Check</div>'
        f'<p style="font-size:13px;color:#333;">{_esc(summary_line)}</p>'
        f'<pre style="white-space:pre-wrap;font:13px/1.5 Menlo,Consolas,monospace;'
        f'background:#f6f7f9;padding:14px;border-radius:6px;">{_esc(report_md)}</pre></div>'
    )

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = recipient
    msg["Date"] = formatdate(localtime=False)
    msg.attach(MIMEText(report_md, "plain", "utf-8"))
    msg.attach(MIMEText(html_body, "html", "utf-8"))

    context = ssl.create_default_context()
    if port == 465:
        with smtplib.SMTP_SSL(host, port, context=context) as s:
            s.login(user, password)
            s.sendmail(sender, [recipient], msg.as_string())
    else:
        with smtplib.SMTP(host, port) as s:
            s.starttls(context=context)
            s.login(user, password)
            s.sendmail(sender, [recipient], msg.as_string())
    print(f"[ok] report emailed to {recipient} — subject: {subject!r}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    global START_NETLOC
    ap = argparse.ArgumentParser(description="PRC Workforce website checker + UK HR news")
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--max-pages", type=int, default=DEFAULT_MAX_PAGES)
    ap.add_argument("--no-external", action="store_true")
    ap.add_argument("--no-news", action="store_true")
    ap.add_argument("--email", action="store_true", help="email the report via SMTP env vars")
    ap.add_argument("--out-dir", default="reports")
    args = ap.parse_args()

    START_NETLOC = urlparse(canonical(args.url)).netloc
    generated = datetime.now(timezone.utc)

    print(f"[info] crawling {args.url} (max {args.max_pages} pages)…")
    pages = crawl(args.url, args.max_pages)
    print(f"[info] {len(pages)} page(s). Checking links…")
    broken, blocked = check_links(pages, check_external=not args.no_external)
    flagship = flagship_consistency(pages)
    stats = stats_to_verify(pages)
    quality = page_quality(pages)
    news = [] if args.no_news else uk_hr_news()

    report = build_report(args.url, pages, broken, blocked, flagship, stats,
                          quality, news, generated)

    os.makedirs(args.out_dir, exist_ok=True)
    stamp = generated.strftime("%Y-%m-%d_%H%M")
    dated = os.path.join(args.out_dir, f"site-check-{stamp}.md")
    latest = os.path.join(args.out_dir, "latest.md")
    for path in (dated, latest):
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(report)

    print(f"[ok] report -> {dated} and {latest}")
    summary_line = (
        f"pages={len(pages)} broken={len(broken)} blocked={len(blocked)} "
        f"flagship_issues={len(flagship)} stats_to_verify={len(stats)} "
        f"news={len([n for n in news if 'error' not in n])}"
    )
    print(f"[summary] {summary_line}")

    if args.email:
        email_report(report, generated, summary_line)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
