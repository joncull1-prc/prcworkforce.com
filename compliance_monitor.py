#!/usr/bin/env python3
"""
UK Employment Law / HR Regulation / Workforce weekly digest.

Fetches recent items from a set of UK employment-law, HR-regulation and
workforce sources, filters to the last 7 days, and emails a digest to
the configured recipient.

Runtime: Python 3.11+
Dependencies: feedparser  (pip install feedparser)

Delivery: SMTP. Configure via environment variables / GitHub Actions secrets:
    SMTP_HOST   e.g. smtp.gmail.com
    SMTP_PORT   e.g. 587  (STARTTLS) or 465 (SSL)
    SMTP_USER   SMTP username / login
    SMTP_PASS   SMTP password or app password
    EMAIL_FROM  From address (defaults to SMTP_USER)
    EMAIL_TO    Recipient (defaults to jon@prcworkforce.com)
"""

from __future__ import annotations

import os
import smtplib
import ssl
import sys
from datetime import datetime, timedelta, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formatdate
from html import escape

import feedparser

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# How far back to look, in days.
LOOKBACK_DAYS = 7

# Default recipient (overridable via EMAIL_TO env var).
DEFAULT_RECIPIENT = "jon@prcworkforce.com"

# Sources. Each entry: (Human-readable name, feed URL).
# NOTE: feed URLs change over time — verify these resolve before relying on
# them. Add or remove sources here as needed.
FEEDS: list[tuple[str, str]] = [
    # GOV.UK — Employment Appeal Tribunal decisions (case law).
    ("GOV.UK — Employment Appeal Tribunal decisions",
     "https://www.gov.uk/employment-appeal-tribunal-decisions.atom"),
    # GOV.UK — Employment Tribunal decisions.
    ("GOV.UK — Employment Tribunal decisions",
     "https://www.gov.uk/employment-tribunal-decisions.atom"),
    # GOV.UK — news from the Department for Business and Trade.
    ("GOV.UK — Department for Business and Trade",
     "https://www.gov.uk/search/news-and-communications.atom"
     "?organisations%5B%5D=department-for-business-and-trade"),
    # Acas — news and articles.
    ("Acas — news",
     "https://www.acas.org.uk/news.atom"),
    # Personnel Today — HR and employment news.
    ("Personnel Today",
     "https://www.personneltoday.com/feed/"),
    # CIPD — People Management.
    ("People Management (CIPD)",
     "https://www.peoplemanagement.co.uk/feed"),
]

# Optional relevance keywords. If set, an item must contain at least one of
# these (in title or summary) to be included. Leave the list empty to include
# every recent item from every feed.
KEYWORDS: list[str] = [
    "employment", "worker", "workforce", "employee", "employer",
    "tribunal", "redundancy", "dismissal", "discrimination", "holiday pay",
    "minimum wage", "national living wage", "sick pay", "ssp", "acas",
    "trade union", "tupe", "flexible working", "maternity", "paternity",
    "right to work", "immigration", "ir35", "gig", "zero hours",
    "employment rights", "hr", "payroll", "pension", "whistleblow",
    "harassment", "settlement agreement", "grievance", "furlough",
]

# ---------------------------------------------------------------------------
# Fetching
# ---------------------------------------------------------------------------


def _entry_datetime(entry) -> datetime | None:
    """Return a timezone-aware datetime for a feed entry, or None."""
    for key in ("published_parsed", "updated_parsed"):
        parsed = entry.get(key)
        if parsed:
            return datetime(*parsed[:6], tzinfo=timezone.utc)
    return None


def _is_relevant(entry) -> bool:
    """True if the entry matches at least one keyword (or no keywords set)."""
    if not KEYWORDS:
        return True
    haystack = " ".join(
        str(entry.get(field, "")) for field in ("title", "summary")
    ).lower()
    return any(kw in haystack for kw in KEYWORDS)


def collect_items(cutoff: datetime) -> list[dict]:
    """Fetch all feeds and return recent, relevant items sorted newest first."""
    items: list[dict] = []
    for name, url in FEEDS:
        try:
            parsed = feedparser.parse(url)
        except Exception as exc:  # noqa: BLE001 — never let one feed kill the run
            print(f"[warn] failed to fetch {name} ({url}): {exc}", file=sys.stderr)
            continue

        if getattr(parsed, "bozo", 0) and not parsed.entries:
            print(f"[warn] no usable entries from {name} ({url})", file=sys.stderr)
            continue

        for entry in parsed.entries:
            when = _entry_datetime(entry)
            # Keep items with no date (better to surface than silently drop),
            # and items newer than the cutoff.
            if when is not None and when < cutoff:
                continue
            if not _is_relevant(entry):
                continue
            items.append(
                {
                    "source": name,
                    "title": entry.get("title", "(no title)").strip(),
                    "link": entry.get("link", ""),
                    "summary": (entry.get("summary", "") or "").strip(),
                    "when": when,
                }
            )

    # Sort newest first; undated items go last.
    items.sort(key=lambda i: (i["when"] is not None, i["when"] or cutoff), reverse=True)
    return items


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


def _fmt_date(when: datetime | None) -> str:
    return when.strftime("%d %b %Y") if when else "Undated"


def render_plain(items: list[dict], generated: datetime) -> str:
    lines = [
        "UK EMPLOYMENT LAW / HR / WORKFORCE — WEEKLY UPDATE",
        f"Generated: {generated.strftime('%d %b %Y %H:%M UTC')}",
        f"Window: previous {LOOKBACK_DAYS} days",
        f"Items: {len(items)}",
        "=" * 60,
        "",
    ]
    if not items:
        lines.append("No new items in the reporting window.")
        return "\n".join(lines)

    for i in items:
        lines.append(f"[{_fmt_date(i['when'])}] {i['source']}")
        lines.append(i["title"])
        if i["link"]:
            lines.append(i["link"])
        lines.append("")
    return "\n".join(lines)


def render_html(items: list[dict], generated: datetime) -> str:
    head = f"""\
<div style="font-family:Arial,Helvetica,sans-serif;color:#0b1f3a;max-width:680px;">
  <div style="background:#0b1f3a;color:#c9a227;padding:16px 20px;">
    <div style="font-size:18px;font-weight:bold;letter-spacing:.5px;">
      UK EMPLOYMENT LAW / HR / WORKFORCE — WEEKLY UPDATE
    </div>
    <div style="font-size:12px;color:#e6e6e6;margin-top:4px;">
      Generated {escape(generated.strftime('%d %b %Y %H:%M UTC'))}
      &nbsp;|&nbsp; Window: previous {LOOKBACK_DAYS} days
      &nbsp;|&nbsp; {len(items)} item(s)
    </div>
  </div>
  <div style="padding:20px;">
"""
    if not items:
        return head + (
            '<p style="font-size:14px;">No new items in the reporting window.</p>'
            "</div></div>"
        )

    rows = []
    for i in items:
        title = escape(i["title"])
        link = escape(i["link"])
        source = escape(i["source"])
        date = escape(_fmt_date(i["when"]))
        title_html = f'<a href="{link}" style="color:#0b1f3a;">{title}</a>' if link else title
        rows.append(
            f"""\
    <div style="border-left:3px solid #c9a227;padding:6px 0 6px 12px;margin-bottom:14px;">
      <div style="font-size:11px;text-transform:uppercase;color:#6b7280;">
        {date} &middot; {source}
      </div>
      <div style="font-size:15px;font-weight:bold;margin-top:2px;">{title_html}</div>
    </div>"""
        )
    return head + "\n".join(rows) + "</div></div>"


# ---------------------------------------------------------------------------
# Email
# ---------------------------------------------------------------------------


def send_email(subject: str, text_body: str, html_body: str) -> None:
    host = os.environ.get("SMTP_HOST")
    port = int(os.environ.get("SMTP_PORT", "587"))
    user = os.environ.get("SMTP_USER")
    password = os.environ.get("SMTP_PASS")
    sender = os.environ.get("EMAIL_FROM", user or "")
    recipient = os.environ.get("EMAIL_TO", DEFAULT_RECIPIENT)

    missing = [
        name
        for name, val in (
            ("SMTP_HOST", host),
            ("SMTP_USER", user),
            ("SMTP_PASS", password),
        )
        if not val
    ]
    if missing:
        raise RuntimeError(
            "Missing required environment variables: " + ", ".join(missing)
        )

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = recipient
    msg["Date"] = formatdate(localtime=False)
    msg.attach(MIMEText(text_body, "plain", "utf-8"))
    msg.attach(MIMEText(html_body, "html", "utf-8"))

    context = ssl.create_default_context()
    if port == 465:
        with smtplib.SMTP_SSL(host, port, context=context) as server:
            server.login(user, password)
            server.sendmail(sender, [recipient], msg.as_string())
    else:
        with smtplib.SMTP(host, port) as server:
            server.starttls(context=context)
            server.login(user, password)
            server.sendmail(sender, [recipient], msg.as_string())

    print(f"[ok] digest emailed to {recipient} ({len(text_body)} bytes text)")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> int:
    generated = datetime.now(timezone.utc)
    cutoff = generated - timedelta(days=LOOKBACK_DAYS)

    items = collect_items(cutoff)
    print(f"[info] collected {len(items)} item(s) since {cutoff.date()}")

    subject = (
        f"UK Employment Law / HR / Workforce — weekly update "
        f"({generated.strftime('%d %b %Y')})"
    )
    text_body = render_plain(items, generated)
    html_body = render_html(items, generated)

    send_email(subject, text_body, html_body)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
