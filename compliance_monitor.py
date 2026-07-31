#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
compliance_monitor.py
=====================

Automated web-content monitoring + PRC (People's Republic of China) workforce /
HR / labour-law compliance tracker.

What it does, in order:

  1. CRAWL   - Fetches every landing page listed in the config and extracts the
               full content skeleton: title, meta description, heading tree
               (h1-h6), body text blocks, list items, table cells and tab /
               accordion structures (ARIA tabs, Bootstrap tabs, data-tab
               attributes and <details>/<summary>).

  2. EXTRACT - Parses every numeric data point out of that content:
               percentages, currency amounts (RMB / CNY / USD / EUR / GBP),
               scaled figures (million / billion / 万 / 亿), durations, ratios,
               multipliers and years. Each figure is stored with the heading it
               sits under, the surrounding sentence, and a stable fingerprint
               that ignores the number itself - so when only the number moves,
               we can tell it is the SAME claim with a NEW value.

  3. WATCH   - Searches for news and official updates on PRC workforce
               regulations, HR policy and labour law. Default backend is Google
               News RSS (no API key required) plus any extra RSS/Atom feeds you
               configure. If SERPER_API_KEY or SERPAPI_KEY is present in the
               environment it will additionally query that search API.

  4. COMPARE - Diffs this run against the stored baseline (compliance_state.json)
               to find CHANGED / NEW / REMOVED figures, flags articles not seen
               before, and cross-references article figures against the figures
               on your pages to surface likely stale statistics.

  5. REPORT  - Writes a markdown report naming the exact page + section that
               needs updating, with the source URL for every claim so you can
               validate it, and emails it via smtplib using EMAIL_HOST_USER /
               EMAIL_HOST_PASSWORD from the environment.

Usage
-----
    python compliance_monitor.py                     # normal run
    python compliance_monitor.py --init              # write a starter config
    python compliance_monitor.py --url https://x.com # ad-hoc, ignores config pages
    python compliance_monitor.py --no-email          # write report, don't send
    python compliance_monitor.py --always-email      # send even if nothing changed
    python compliance_monitor.py --render            # use Playwright (JS pages)
    python compliance_monitor.py --fail-on-change    # exit 2 if action required

Dependencies
------------
    pip install requests beautifulsoup4
    # optional, only if you use --render:
    pip install playwright && playwright install chromium

Environment variables
---------------------
    EMAIL_HOST_USER      (required to send)  SMTP username / from-address
    EMAIL_HOST_PASSWORD  (required to send)  SMTP password or app password
    EMAIL_HOST           default smtp.gmail.com
    EMAIL_PORT           default 465
    EMAIL_USE_SSL        default "true"  (set "false" to use STARTTLS)
    EMAIL_FROM           default = EMAIL_HOST_USER
    EMAIL_TO             default = config email.to  (jon@prcworkforce.com)
    MONITOR_PAGES        optional comma-separated URLs, overrides config pages
    SERPER_API_KEY       optional, enables serper.dev news search
    SERPAPI_KEY          optional, enables SerpApi google_news search
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import re
import smtplib
import ssl
import sys
import time
import unicodedata
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field, asdict
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple
from urllib.parse import quote_plus, urljoin, urlparse
from urllib.robotparser import RobotFileParser

try:
    import requests
except ImportError:  # pragma: no cover
    sys.exit("Missing dependency: pip install requests")

try:
    from bs4 import BeautifulSoup
except ImportError:  # pragma: no cover
    sys.exit("Missing dependency: pip install beautifulsoup4")


# --------------------------------------------------------------------------- #
# Constants & defaults
# --------------------------------------------------------------------------- #

VERSION = "1.1.0"

DEFAULT_CONFIG_PATH = Path("compliance_config.json")
DEFAULT_STATE_PATH = Path("compliance_state.json")
DEFAULT_REPORT_DIR = Path("reports")

DEFAULT_CONFIG: Dict[str, Any] = {
    "pages": [
        # >>> REPLACE THESE WITH YOUR OWN LANDING PAGES <<<
        "https://www.prcworkforce.com/"
    ],
    "news_queries": [
        "China labour law amendment",
        "China Labor Contract Law revision",
        "PRC social insurance contribution policy",
        "MOHRSS new regulation employment",
        "China minimum wage standard adjustment",
        "China statutory retirement age reform",
        "China work permit foreign employee policy",
        "China labour dispatch outsourcing rules",
        "China paid annual leave regulation",
        "China housing provident fund rate",
    ],
    "rss_feeds": [
        # Extra feeds are fetched verbatim. Verify each URL returns valid RSS
        # before relying on it; unreachable feeds are logged and skipped.
    ],
    "news_lookback_days": 120,
    "max_articles_per_query": 12,
    "email": {
        "to": "jon@prcworkforce.com",
        "subject_prefix": "[PRC Compliance Monitor]",
        "send_when_no_changes": False,
        "attach_markdown": True,
    },
    "request": {
        "timeout": 30,
        "delay_seconds": 1.5,
        "max_retries": 3,
        "respect_robots": True,
        "user_agent": (
            "Mozilla/5.0 (compatible; PRCComplianceMonitor/1.1; "
            "+https://www.prcworkforce.com/bot)"
        ),
    },
    "render_js": False,
    "ignore_selectors": ["nav", "footer", "script", "style", "noscript", "svg"],
}

# Terms that must appear for an article to count as China-related.
CHINA_TERMS = [
    "china", "chinese", "prc", "beijing", "shanghai", "shenzhen", "guangdong",
    "mohrss", "state council", "npc standing committee", "中国", "人力资源",
]

# Terms that must appear for an article to count as workforce/HR-related.
LABOUR_TERMS = [
    "labour", "labor", "employment", "employee", "worker", "workforce", "hr ",
    "human resources", "social insurance", "social security", "minimum wage",
    "retirement age", "pension", "work permit", "visa", "payroll",
    "labour contract", "labor contract", "severance", "overtime", "工时",
    "劳动法", "劳动合同", "社保", "公积金", "退休", "工资", "用工",
    "provident fund", "trade union", "collective bargaining", "dispatch",
    "annual leave", "maternity leave", "工伤", "劳务派遣",
]

# Phrases that mark a nearby number as an "official figure".
OFFICIAL_MARKERS = [
    "official", "officially", "according to", "as reported by", "government",
    "ministry", "mohrss", "national bureau of statistics", "nbs", "state council",
    "statutory", "regulation", "law", "policy", "circular", "notice",
    "gazette", "source:", "data from", "survey", "census", "report",
    "国家统计局", "人力资源和社会保障部", "国务院", "统计",
]

HEADING_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6"]
BLOCK_TAGS = [
    "p", "li", "td", "th", "dd", "dt", "blockquote", "figcaption",
    "caption", "summary", "label", "strong", "em", "span", "div", "a",
]

STOPWORDS = {
    "the", "and", "for", "with", "from", "that", "this", "have", "has", "are",
    "was", "were", "will", "your", "our", "you", "who", "how", "why", "what",
    "when", "which", "than", "then", "them", "they", "their", "there", "into",
    "over", "under", "about", "more", "most", "less", "also", "been", "being",
    "can", "may", "must", "shall", "should", "would", "could", "per", "its",
    "all", "any", "new", "one", "two", "not", "but", "out", "off", "each",
}

# Words that overlap between almost any two workforce texts - they carry no
# evidence that two figures are about the same thing.
GENERIC_TOKENS = {
    "day", "days", "week", "weeks", "month", "months", "year", "years", "hour",
    "hours", "china", "chinese", "employee", "employees", "employer", "employers",
    "worker", "workers", "staff", "leave", "law", "laws", "rate", "rates",
    "percent", "national", "nationally", "average", "total", "level", "levels",
    "policy", "policies", "rule", "rules", "government", "state", "city",
    "cities", "province", "provinces", "company", "companies", "business",
}

USER_AGENT_FALLBACK = "PRCComplianceMonitor/1.1"

log = logging.getLogger("compliance_monitor")


# --------------------------------------------------------------------------- #
# Numeric extraction
# --------------------------------------------------------------------------- #

_NUM = r"\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?"

# Order matters: the most specific pattern wins a given span of text.
NUMBER_PATTERNS: List[Tuple[str, re.Pattern]] = [
    (
        "percentage",
        re.compile(rf"(?<![\w.])(?P<num>{_NUM})\s*(?:%|percent\b|per cent\b|pct\b|个百分点)", re.I),
    ),
    (
        "currency",
        re.compile(
            rf"(?:(?P<sym>RMB|CNY|USD|US\$|HK\$|EUR|GBP|¥|￥|\$|€|£)\s*(?P<num>{_NUM})"
            rf"|(?P<num2>{_NUM})\s*(?P<sym2>yuan|renminbi|RMB|CNY|USD|dollars?|euros?|pounds?|元|人民币))"
            rf"\s*(?P<scale>billion|million|thousand|trillion|bn|mn|k|万|亿|兆)?",
            re.I,
        ),
    ),
    (
        "scaled",
        re.compile(
            rf"(?<![\w.])(?P<num>{_NUM})\s*(?P<scale>trillion|billion|million|thousand|万|亿)\b",
            re.I,
        ),
    ),
    (
        "duration",
        re.compile(
            rf"(?<![\w.])(?P<num>{_NUM})[\s-]*(?P<unit>calendar days|working days|business days|"
            rf"days|day|hours|hour|hrs|weeks|week|months|month|years|year|"
            rf"天|日|小时|周|个月|年)\b",
            re.I,
        ),
    ),
    (
        "ratio",
        re.compile(rf"(?<![\w.])(?P<num>{_NUM})\s*[:：]\s*(?P<num2>{_NUM})(?![\w.])"),
    ),
    (
        "multiplier",
        re.compile(rf"(?<![\w.])(?P<num>{_NUM})\s*(?:x\b|×|-fold\b|fold\b|times\b)", re.I),
    ),
    (
        "year",
        re.compile(r"(?<![\w.])(?P<num>(?:19|20)\d{2})(?:\s*年)?(?![\w.%])"),
    ),
    (
        "count",
        re.compile(rf"(?<![\w.])(?P<num>{_NUM})(?![\w.%])"),
    ),
]

SCALE_FACTORS = {
    "thousand": 1e3, "k": 1e3,
    "million": 1e6, "mn": 1e6, "万": 1e4,
    "billion": 1e9, "bn": 1e9, "亿": 1e8,
    "trillion": 1e12, "兆": 1e12,
}


def _clean_number(raw: str) -> Optional[float]:
    try:
        return float(raw.replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def normalise_ws(text: str) -> str:
    text = unicodedata.normalize("NFKC", text or "")
    return re.sub(r"\s+", " ", text).strip()


def fingerprint(*parts: str) -> str:
    joined = "||".join(p or "" for p in parts)
    return hashlib.sha1(joined.encode("utf-8", "replace")).hexdigest()[:16]


@dataclass
class DataPoint:
    """A single numeric claim found on a page."""
    id: str
    url: str
    kind: str
    raw: str
    value: Optional[float]
    unit: str
    context: str
    template: str
    heading: str
    section_path: str
    location: str
    official: bool

    def label(self) -> str:
        return f"{self.raw} ({self.kind})"


def extract_numbers(text: str) -> List[Dict[str, Any]]:
    """Return non-overlapping numeric matches from a text block."""
    text = normalise_ws(text)
    if not text:
        return []
    taken: List[Tuple[int, int]] = []
    found: List[Dict[str, Any]] = []

    def overlaps(a: int, b: int) -> bool:
        return any(not (b <= s or a >= e) for s, e in taken)

    for kind, pattern in NUMBER_PATTERNS:
        for m in pattern.finditer(text):
            start, end = m.span()
            if overlaps(start, end):
                continue
            gd = m.groupdict()
            num_raw = gd.get("num") or gd.get("num2")
            if not num_raw:
                continue
            value = _clean_number(num_raw)
            scale = (gd.get("scale") or "").lower()
            if value is not None and scale in SCALE_FACTORS:
                value *= SCALE_FACTORS[scale]
            if kind == "ratio" and gd.get("num2"):
                unit = f":{gd['num2']}"
            else:
                unit = (gd.get("unit") or gd.get("sym") or gd.get("sym2") or scale or "").strip()
            # Filter obvious noise: bare 0/1-digit counts with no unit.
            if kind == "count" and value is not None and len(num_raw) <= 1:
                continue
            taken.append((start, end))
            found.append(
                {
                    "kind": kind,
                    "raw": m.group(0).strip(),
                    "number": num_raw,
                    "value": value,
                    "unit": unit,
                    "start": start,
                    "end": end,
                }
            )
    found.sort(key=lambda d: d["start"])
    return found


def _sentence_around(text: str, start: int, end: int, width: int = 180) -> str:
    left = max(0, start - width)
    right = min(len(text), end + width)
    snippet = text[left:right]
    if left > 0:
        snippet = "…" + snippet
    if right < len(text):
        snippet = snippet + "…"
    return snippet.strip()


def _template(text: str, start: int, end: int, width: int = 90) -> str:
    """Context with the number blanked out - the stable identity of a claim."""
    left = max(0, start - width)
    right = min(len(text), end + width)
    tpl = text[left:start] + "<NUM>" + text[end:right]
    # Collapse every other digit run to a single '#' so that a neighbouring number
    # changing (98 -> 128) does not re-key this data point.
    tpl = re.sub(r"\d+", "#", tpl)
    return normalise_ws(tpl).lower()


def is_official(context: str) -> bool:
    low = context.lower()
    return any(marker in low for marker in OFFICIAL_MARKERS)


# --------------------------------------------------------------------------- #
# Page model
# --------------------------------------------------------------------------- #

@dataclass
class PageSnapshot:
    url: str
    fetched_at: str
    status: int
    title: str
    meta_description: str
    headings: List[Dict[str, str]] = field(default_factory=list)
    tabs: List[Dict[str, str]] = field(default_factory=list)
    text_blocks: int = 0
    word_count: int = 0
    content_hash: str = ""
    data_points: List[DataPoint] = field(default_factory=list)
    error: str = ""

    def to_state(self) -> Dict[str, Any]:
        return {
            "url": self.url,
            "fetched_at": self.fetched_at,
            "title": self.title,
            "meta_description": self.meta_description,
            "headings": self.headings,
            "tabs": self.tabs,
            "word_count": self.word_count,
            "content_hash": self.content_hash,
            "data_points": {dp.id: asdict(dp) for dp in self.data_points},
        }


# --------------------------------------------------------------------------- #
# Fetching
# --------------------------------------------------------------------------- #

class Fetcher:
    def __init__(self, cfg: Dict[str, Any], render: bool = False):
        rq = cfg.get("request", {})
        self.timeout = rq.get("timeout", 30)
        self.delay = rq.get("delay_seconds", 1.5)
        self.max_retries = rq.get("max_retries", 3)
        self.respect_robots = rq.get("respect_robots", True)
        self.user_agent = rq.get("user_agent", USER_AGENT_FALLBACK)
        self.render = render
        self._robots: Dict[str, Optional[RobotFileParser]] = {}
        self._last_request = 0.0
        self.session = requests.Session()
        self.session.headers.update(
            {
                "User-Agent": self.user_agent,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-GB,en;q=0.9",
            }
        )
        self._pw = None  # lazy Playwright handle

    # -- politeness ------------------------------------------------------- #
    def _throttle(self) -> None:
        wait = self.delay - (time.time() - self._last_request)
        if wait > 0:
            time.sleep(wait)
        self._last_request = time.time()

    def allowed(self, url: str) -> bool:
        if not self.respect_robots:
            return True
        parsed = urlparse(url)
        root = f"{parsed.scheme}://{parsed.netloc}"
        if root not in self._robots:
            rp = RobotFileParser()
            rp.set_url(urljoin(root, "/robots.txt"))
            try:
                rp.read()
                self._robots[root] = rp
            except Exception as exc:  # robots unreachable -> fail open
                log.warning("Could not read robots.txt for %s (%s); proceeding.", root, exc)
                self._robots[root] = None
        rp = self._robots[root]
        if rp is None:
            return True
        try:
            return rp.can_fetch(self.user_agent, url)
        except Exception:
            return True

    # -- HTTP ------------------------------------------------------------- #
    def get(self, url: str, *, as_text: bool = True) -> Tuple[int, str]:
        last_exc: Optional[Exception] = None
        for attempt in range(1, self.max_retries + 1):
            self._throttle()
            try:
                resp = self.session.get(url, timeout=self.timeout)
                if resp.status_code in (429, 500, 502, 503, 504) and attempt < self.max_retries:
                    backoff = min(30, 2 ** attempt)
                    log.warning("HTTP %s from %s - retrying in %ss", resp.status_code, url, backoff)
                    time.sleep(backoff)
                    continue
                resp.raise_for_status()
                if as_text:
                    # requests falls back to ISO-8859-1 for text/* without an explicit
                    # charset, which mangles UTF-8 pages. Sniff instead.
                    ctype = resp.headers.get("content-type", "").lower()
                    if not resp.encoding or "charset" not in ctype:
                        resp.encoding = resp.apparent_encoding or "utf-8"
                return resp.status_code, (resp.text if as_text else resp.content)
            except Exception as exc:
                last_exc = exc
                if attempt < self.max_retries:
                    backoff = min(30, 2 ** attempt)
                    log.warning("Fetch error for %s (%s) - retry %s/%s in %ss",
                                url, exc, attempt, self.max_retries, backoff)
                    time.sleep(backoff)
        raise RuntimeError(f"Failed to fetch {url}: {last_exc}")

    # -- optional JS rendering -------------------------------------------- #
    def get_rendered(self, url: str) -> Tuple[int, str]:
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            log.warning("--render requested but Playwright is not installed; "
                        "falling back to plain HTTP for %s", url)
            return self.get(url)
        self._throttle()
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=["--no-sandbox"])
            try:
                page = browser.new_page(user_agent=self.user_agent)
                page.goto(url, timeout=self.timeout * 1000, wait_until="networkidle")
                # Click through tab controls so hidden panels render into the DOM.
                for sel in ('[role="tab"]', '[data-toggle="tab"]', '[data-bs-toggle="tab"]'):
                    for handle in page.query_selector_all(sel):
                        try:
                            handle.click(timeout=1500)
                            page.wait_for_timeout(200)
                        except Exception:
                            pass
                html = page.content()
                return 200, html
            finally:
                browser.close()

    def close(self) -> None:
        try:
            self.session.close()
        except Exception:
            pass


# --------------------------------------------------------------------------- #
# Parsing
# --------------------------------------------------------------------------- #

def parse_page(url: str, html: str, status: int, cfg: Dict[str, Any]) -> PageSnapshot:
    soup = BeautifulSoup(html, "html.parser")

    for sel in cfg.get("ignore_selectors", []):
        for node in soup.select(sel):
            node.decompose()

    title = normalise_ws(soup.title.get_text() if soup.title else "")
    meta_desc = ""
    md = soup.find("meta", attrs={"name": re.compile("^description$", re.I)})
    if md and md.get("content"):
        meta_desc = normalise_ws(md["content"])

    snapshot = PageSnapshot(
        url=url,
        fetched_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        status=status,
        title=title,
        meta_description=meta_desc,
    )

    # ---- headings + text blocks, in document order ----
    seen_blocks = set()
    template_counts: Dict[str, int] = {}
    heading_stack: List[str] = []
    current_heading = title or "(page top)"
    all_text: List[str] = []
    root = soup.body or soup

    for el in root.find_all(HEADING_TAGS + BLOCK_TAGS):
        name = el.name.lower()

        if name in HEADING_TAGS:
            text = normalise_ws(el.get_text(" ", strip=True))
            if not text:
                continue
            level = int(name[1])
            heading_stack = heading_stack[: level - 1]
            while len(heading_stack) < level - 1:
                heading_stack.append("")
            heading_stack.append(text)
            current_heading = text
            snapshot.headings.append({"level": name, "text": text, "id": el.get("id", "")})
            all_text.append(text)
            _harvest(snapshot, text, current_heading, heading_stack, name, url,
                     counter=template_counts)
            continue

        # Only leaf-ish blocks, so nested containers aren't counted twice.
        if el.find(BLOCK_TAGS) is not None:
            continue
        text = normalise_ws(el.get_text(" ", strip=True))
        if len(text) < 2:
            continue
        key = (text, name)
        if key in seen_blocks:
            continue
        seen_blocks.add(key)
        snapshot.text_blocks += 1
        all_text.append(text)

        # Table cells are ambiguous on their own ("RMB 2,420" appears in many rows),
        # so prepend the column header + row label to give the figure an identity.
        prefix = _cell_prefix(el) if name in ("td", "th") else ""
        if prefix:
            combined = f"{prefix} — {text}"
            _harvest(snapshot, combined, current_heading, heading_stack, name, url,
                     skip_before=len(prefix) + 3, counter=template_counts)
        else:
            _harvest(snapshot, text, current_heading, heading_stack, name, url,
                     counter=template_counts)

    # ---- tab / accordion structures ----
    snapshot.tabs = extract_tabs(soup)

    joined = "\n".join(all_text)
    snapshot.word_count = len(joined.split())
    snapshot.content_hash = hashlib.sha256(joined.encode("utf-8", "replace")).hexdigest()[:16]
    return snapshot


def _cell_prefix(cell) -> str:
    """Column header + row label for a table cell, used to disambiguate figures."""
    tr = cell.find_parent("tr")
    if tr is None:
        return ""
    cells = tr.find_all(["td", "th"], recursive=False) or tr.find_all(["td", "th"])
    try:
        idx = cells.index(cell)
    except ValueError:
        idx = -1
    parts: List[str] = []
    table = cell.find_parent("table")
    if table is not None and idx >= 0:
        header_row = table.find("tr")
        if header_row is not None and header_row is not tr:
            hcells = header_row.find_all(["td", "th"])
            if idx < len(hcells):
                head = normalise_ws(hcells[idx].get_text(" ", strip=True))
                if head:
                    parts.append(head)
    if idx > 0 and cells:
        row_label = normalise_ws(cells[0].get_text(" ", strip=True))
        if row_label:
            parts.append(row_label)
    return " / ".join(parts)


def _harvest(
    snapshot: PageSnapshot,
    text: str,
    heading: str,
    heading_stack: Sequence[str],
    tag: str,
    url: str,
    skip_before: int = 0,
    counter: Optional[Dict[str, int]] = None,
) -> None:
    """Pull numeric data points out of one text block."""
    if counter is None:
        counter = {}
    for hit in extract_numbers(text):
        if hit["start"] < skip_before:
            continue  # part of the injected row/column label, not the cell value
        context = _sentence_around(text, hit["start"], hit["end"])
        tpl = _template(text, hit["start"], hit["end"])
        section_path = " > ".join([h for h in heading_stack if h]) or heading
        # Identical templates (e.g. repeated card layouts) get a stable ordinal so
        # two different figures never collapse into one tracked data point.
        seq_key = f"{hit['kind']}::{tpl}"
        occurrence = counter.get(seq_key, 0)
        counter[seq_key] = occurrence + 1
        dp = DataPoint(
            id=fingerprint(url, hit["kind"], tpl, str(occurrence)),
            url=url,
            kind=hit["kind"],
            raw=hit["raw"],
            value=hit["value"],
            unit=hit["unit"],
            context=context,
            template=tpl,
            heading=heading,
            section_path=section_path,
            location=f"<{tag}>",
            official=is_official(context),
        )
        snapshot.data_points.append(dp)


def extract_tabs(soup: BeautifulSoup) -> List[Dict[str, str]]:
    """Detect ARIA tabs, Bootstrap tabs, data-tab widgets and <details> panels."""
    tabs: List[Dict[str, str]] = []
    seen = set()
    claimed_panels: set = set()

    def add(label: str, panel_text: str, mechanism: str, panel_id: str = "") -> None:
        label = normalise_ws(label)
        if not label:
            return
        key = (label, mechanism)
        if key in seen:
            return
        seen.add(key)
        panel_text = normalise_ws(panel_text)
        tabs.append(
            {
                "label": label,
                "mechanism": mechanism,
                "panel_id": panel_id,
                "panel_excerpt": panel_text[:400],
                "panel_words": str(len(panel_text.split())),
            }
        )

    def panel_for(node) -> Tuple[str, str]:
        target = node.get("aria-controls") or ""
        if not target:
            for attr in ("href", "data-target", "data-bs-target", "data-tab", "data-tab-target"):
                val = node.get(attr) or ""
                if isinstance(val, list):
                    val = " ".join(val)
                if val.startswith("#"):
                    target = val[1:]
                    break
                if attr in ("data-tab", "data-tab-target") and val:
                    target = val.lstrip("#.")
                    break
        if not target:
            return "", ""
        panel = soup.find(id=target)
        if panel is None:
            panel = soup.find(attrs={"data-tab-panel": target}) or soup.find(
                attrs={"data-tab": target}
            )
        return (target, panel.get_text(" ", strip=True) if panel else "")

    # 1. ARIA tabs
    for node in soup.select('[role="tab"]'):
        pid, ptext = panel_for(node)
        claimed_panels.add(pid)
        add(node.get_text(" ", strip=True), ptext, "aria-tab", pid)

    # 2. Bootstrap / jQuery style
    for node in soup.select('[data-toggle="tab"], [data-bs-toggle="tab"], '
                            '[data-toggle="pill"], [data-bs-toggle="pill"], '
                            '.nav-tabs a, .nav-tabs button, .tabs a, .tab-link'):
        pid, ptext = panel_for(node)
        claimed_panels.add(pid)
        add(node.get_text(" ", strip=True), ptext, "bootstrap-tab", pid)

    # 3. Generic data-tab attributes
    for node in soup.select("[data-tab], [data-tab-target]"):
        if node.name in ("div", "section") and not node.get_text(" ", strip=True)[:80]:
            continue
        pid, ptext = panel_for(node)
        claimed_panels.add(pid)
        add(node.get_text(" ", strip=True)[:120], ptext or node.get_text(" ", strip=True),
            "data-tab", pid)

    # 4. Accordions
    for node in soup.find_all("details"):
        summary = node.find("summary")
        label = summary.get_text(" ", strip=True) if summary else "(details)"
        body = node.get_text(" ", strip=True)
        if summary:
            body = body[len(label):]
        add(label, body, "details-accordion", node.get("id", ""))

    # 5. Orphan tab panels (rendered but with no detected control)
    for node in soup.select('[role="tabpanel"], .tab-pane'):
        if node.get("id") and node.get("id") in claimed_panels:
            continue  # already reported via its control
        label = node.get("aria-label") or node.get("id") or "(tab panel)"
        add(f"panel: {label}", node.get_text(" ", strip=True), "tabpanel", node.get("id", ""))

    return tabs


# --------------------------------------------------------------------------- #
# News / regulatory watch
# --------------------------------------------------------------------------- #

@dataclass
class Article:
    id: str
    title: str
    link: str
    source: str
    published: str
    summary: str
    query: str
    source_url: str = ""
    score: int = 0
    numbers: List[Dict[str, Any]] = field(default_factory=list)


def _parse_date(value: str) -> Optional[datetime]:
    if not value:
        return None
    try:
        dt = parsedate_to_datetime(value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        pass
    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            dt = datetime.strptime(value.strip(), fmt)
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def _strip_html(value: str) -> str:
    return normalise_ws(BeautifulSoup(value or "", "html.parser").get_text(" ", strip=True))


def relevance(title: str, summary: str) -> int:
    blob = f" {title} {summary} ".lower()
    china = sum(1 for t in CHINA_TERMS if t in blob)
    labour = sum(1 for t in LABOUR_TERMS if t in blob)
    if china == 0 or labour == 0:
        return 0
    score = china + labour * 2
    if any(w in blob for w in ("amend", "revis", "new rule", "new regulation", "takes effect",
                               "effective from", "draft", "enact", "issued", "circular",
                               "implementation", "came into force", "promulgat")):
        score += 4
    return score


def parse_feed(xml_text: str, query: str) -> List[Article]:
    """Parse RSS 2.0 or Atom into Article objects."""
    articles: List[Article] = []
    try:
        root = ET.fromstring(xml_text.strip())
    except ET.ParseError as exc:
        log.warning("Feed parse error for query %r: %s", query, exc)
        return articles

    ns = {"atom": "http://www.w3.org/2005/Atom"}

    items = root.findall(".//item")
    if items:
        for item in items:
            title = _strip_html(item.findtext("title", ""))
            link = (item.findtext("link", "") or "").strip()
            desc = _strip_html(item.findtext("description", ""))
            pub = (item.findtext("pubDate", "") or "").strip()
            source_el = item.find("source")
            source = normalise_ws(source_el.text) if source_el is not None and source_el.text else ""
            source_url = (source_el.get("url", "") if source_el is not None else "") or ""
            if not source and link:
                source = urlparse(link).netloc
            if not title or not link:
                continue
            articles.append(
                Article(id=fingerprint(link), title=title, link=link, source=source,
                        published=pub, summary=desc, query=query, source_url=source_url)
            )
        return articles

    for entry in root.findall(".//atom:entry", ns):
        title = _strip_html(entry.findtext("atom:title", "", ns))
        link_el = entry.find("atom:link", ns)
        link = (link_el.get("href") if link_el is not None else "") or ""
        desc = _strip_html(entry.findtext("atom:summary", "", ns)
                           or entry.findtext("atom:content", "", ns))
        pub = (entry.findtext("atom:updated", "", ns)
               or entry.findtext("atom:published", "", ns)).strip()
        if not title or not link:
            continue
        articles.append(
            Article(id=fingerprint(link), title=title, link=link,
                    source=urlparse(link).netloc, published=pub, summary=desc, query=query)
        )
    return articles


def google_news_rss(query: str, lookback_days: int = 120) -> str:
    """Google News RSS search URL.

    Google News ranks by relevance, not date, and will happily return items from
    years ago. The `when:Nd` operator constrains it to the recent window, which is
    what makes the date filter downstream useful rather than empty.
    """
    q = query if "when:" in query.lower() else f"{query} when:{max(1, int(lookback_days))}d"
    return "https://news.google.com/rss/search?q=" + quote_plus(q) + "&hl=en-US&gl=US&ceid=US:EN"


def search_api_news(query: str, fetcher: Fetcher) -> List[Article]:
    """Optional paid-search backends. Silently skipped when no key is set."""
    out: List[Article] = []
    serper = os.environ.get("SERPER_API_KEY")
    serpapi = os.environ.get("SERPAPI_KEY")

    if serper:
        try:
            resp = fetcher.session.post(
                "https://google.serper.dev/news",
                headers={"X-API-KEY": serper, "Content-Type": "application/json"},
                json={"q": query, "num": 10},
                timeout=fetcher.timeout,
            )
            resp.raise_for_status()
            for item in resp.json().get("news", []):
                link = item.get("link", "")
                if not link:
                    continue
                out.append(Article(
                    id=fingerprint(link), title=item.get("title", ""), link=link,
                    source=item.get("source", urlparse(link).netloc),
                    published=item.get("date", ""), summary=item.get("snippet", ""),
                    query=query))
        except Exception as exc:
            log.warning("serper.dev search failed for %r: %s", query, exc)

    if serpapi:
        try:
            resp = fetcher.session.get(
                "https://serpapi.com/search.json",
                params={"engine": "google_news", "q": query, "api_key": serpapi},
                timeout=fetcher.timeout,
            )
            resp.raise_for_status()
            for item in resp.json().get("news_results", []):
                link = item.get("link", "")
                if not link:
                    continue
                src = item.get("source")
                if isinstance(src, dict):
                    src = src.get("name", "")
                out.append(Article(
                    id=fingerprint(link), title=item.get("title", ""), link=link,
                    source=src or urlparse(link).netloc, published=item.get("date", ""),
                    summary=item.get("snippet", ""), query=query))
        except Exception as exc:
            log.warning("SerpApi search failed for %r: %s", query, exc)

    return out


def gather_news(cfg: Dict[str, Any], fetcher: Fetcher) -> List[Article]:
    lookback = int(cfg.get("news_lookback_days", 120))
    cutoff = datetime.now(timezone.utc) - timedelta(days=lookback)
    per_query = int(cfg.get("max_articles_per_query", 12))
    collected: Dict[str, Article] = {}

    sources: List[Tuple[str, str]] = [
        (q, google_news_rss(q, lookback)) for q in cfg.get("news_queries", [])
    ]
    sources += [(f"feed:{u}", u) for u in cfg.get("rss_feeds", [])]

    for query, url in sources:
        try:
            _, body = fetcher.get(url)
        except Exception as exc:
            log.warning("News source failed (%s): %s", url, exc)
            continue
        found = parse_feed(body, query)
        log.info("  %-55s %d raw items", query[:55], len(found))
        kept = 0
        for art in found:
            if kept >= per_query:
                break
            art.score = relevance(art.title, art.summary)
            if art.score <= 0:
                continue
            pub_dt = _parse_date(art.published)
            if pub_dt and pub_dt < cutoff:
                continue
            art.numbers = extract_numbers(f"{art.title}. {art.summary}")
            existing = collected.get(art.id)
            if existing is None or art.score > existing.score:
                collected[art.id] = art
            kept += 1

    for art in search_api_news_all(cfg, fetcher):
        art.score = relevance(art.title, art.summary)
        if art.score <= 0:
            continue
        art.numbers = extract_numbers(f"{art.title}. {art.summary}")
        collected.setdefault(art.id, art)

    ranked = sorted(collected.values(), key=lambda a: (-a.score, a.title))
    log.info("News watch: %d relevant articles after filtering", len(ranked))
    return ranked


def search_api_news_all(cfg: Dict[str, Any], fetcher: Fetcher) -> List[Article]:
    if not (os.environ.get("SERPER_API_KEY") or os.environ.get("SERPAPI_KEY")):
        return []
    out: List[Article] = []
    for query in cfg.get("news_queries", []):
        out.extend(search_api_news(query, fetcher))
    return out


# --------------------------------------------------------------------------- #
# Comparison
# --------------------------------------------------------------------------- #

@dataclass
class Findings:
    changed: List[Dict[str, Any]] = field(default_factory=list)
    added: List[DataPoint] = field(default_factory=list)
    removed: List[Dict[str, Any]] = field(default_factory=list)
    page_errors: List[Dict[str, str]] = field(default_factory=list)
    structure_changes: List[Dict[str, Any]] = field(default_factory=list)
    new_articles: List[Article] = field(default_factory=list)
    conflicts: List[Dict[str, Any]] = field(default_factory=list)
    first_run: bool = False

    def action_required(self) -> bool:
        return bool(self.changed or self.new_articles or self.conflicts
                    or self.removed or self.page_errors)


def significant_tokens(text: str) -> set:
    words = re.findall(r"[a-z]{3,}", (text or "").lower())
    return {w for w in words if w not in STOPWORDS}


def compare(snapshots: List[PageSnapshot], articles: List[Article],
            state: Dict[str, Any]) -> Findings:
    findings = Findings()
    prev_pages: Dict[str, Any] = state.get("pages", {})
    seen_articles: Dict[str, Any] = state.get("articles", {})
    findings.first_run = not prev_pages

    for snap in snapshots:
        if snap.error:
            findings.page_errors.append({"url": snap.url, "error": snap.error})
            continue

        prev = prev_pages.get(snap.url)
        current = {dp.id: dp for dp in snap.data_points}

        if not prev:
            continue  # nothing to diff against yet

        prev_points: Dict[str, Any] = prev.get("data_points", {})

        for dp_id, dp in current.items():
            old = prev_points.get(dp_id)
            if old is None:
                findings.added.append(dp)
            elif normalise_ws(old.get("raw", "")) != normalise_ws(dp.raw):
                findings.changed.append(
                    {
                        "url": snap.url,
                        "heading": dp.heading,
                        "section_path": dp.section_path,
                        "kind": dp.kind,
                        "old": old.get("raw", ""),
                        "new": dp.raw,
                        "context": dp.context,
                        "official": dp.official,
                    }
                )

        for dp_id, old in prev_points.items():
            if dp_id not in current:
                findings.removed.append(
                    {
                        "url": snap.url,
                        "heading": old.get("heading", ""),
                        "raw": old.get("raw", ""),
                        "context": old.get("context", ""),
                        "kind": old.get("kind", ""),
                    }
                )

        if prev.get("title") and prev["title"] != snap.title:
            findings.structure_changes.append(
                {"url": snap.url, "field": "title", "old": prev["title"], "new": snap.title})
        old_headings = [h.get("text", "") for h in prev.get("headings", [])]
        new_headings = [h["text"] for h in snap.headings]
        if old_headings != new_headings:
            findings.structure_changes.append(
                {
                    "url": snap.url,
                    "field": "headings",
                    "added": [h for h in new_headings if h not in old_headings],
                    "removed": [h for h in old_headings if h not in new_headings],
                }
            )
        old_tabs = [t.get("label", "") for t in prev.get("tabs", [])]
        new_tabs = [t["label"] for t in snap.tabs]
        if old_tabs != new_tabs:
            findings.structure_changes.append(
                {
                    "url": snap.url,
                    "field": "tabs",
                    "added": [t for t in new_tabs if t not in old_tabs],
                    "removed": [t for t in old_tabs if t not in new_tabs],
                }
            )

    for art in articles:
        if art.id not in seen_articles:
            findings.new_articles.append(art)

    findings.conflicts = cross_reference(snapshots, findings.new_articles)
    return findings


def cross_reference(snapshots: List[PageSnapshot],
                    articles: List[Article]) -> List[Dict[str, Any]]:
    """Flag page figures that a fresh article appears to contradict."""
    conflicts: List[Dict[str, Any]] = []
    for art in articles:
        art_tokens = significant_tokens(f"{art.title} {art.summary}")
        if not art.numbers:
            continue
        for snap in snapshots:
            if snap.error:
                continue
            for dp in snap.data_points:
                if dp.kind in ("year", "count") and not dp.official:
                    continue
                overlap = art_tokens & significant_tokens(dp.context)
                specific = overlap - GENERIC_TOKENS
                # Needs real topical overlap, not just shared filler like
                # "days"/"employees"/"leave", or every figure on the page matches.
                if len(overlap) < 4 or len(specific) < 2:
                    continue
                for num in art.numbers:
                    if num["kind"] != dp.kind:
                        continue
                    if num["value"] is None or dp.value is None:
                        continue
                    if abs(num["value"] - dp.value) < 1e-9:
                        continue
                    conflicts.append(
                        {
                            "url": snap.url,
                            "heading": dp.heading,
                            "section_path": dp.section_path,
                            "page_figure": dp.raw,
                            "article_figure": num["raw"],
                            "kind": dp.kind,
                            "context": dp.context,
                            "article_title": art.title,
                            "article_link": art.link,
                            "article_source": art.source,
                            "article_published": art.published,
                            "shared_terms": sorted(overlap)[:8],
                        }
                    )
                    break
    # De-duplicate on (page, page figure, article link)
    unique: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
    for c in conflicts:
        unique.setdefault((c["url"], c["page_figure"], c["article_link"]), c)
    return sorted(unique.values(), key=lambda c: (c["url"], c["page_figure"]))


# --------------------------------------------------------------------------- #
# Reporting
# --------------------------------------------------------------------------- #

def md_escape(text: str) -> str:
    return (text or "").replace("|", "\\|").replace("\n", " ").strip()


def build_report(snapshots: List[PageSnapshot], findings: Findings,
                 articles: List[Article], cfg: Dict[str, Any]) -> str:
    now = datetime.now(timezone.utc)
    lines: List[str] = []
    a = lines.append

    total_points = sum(len(s.data_points) for s in snapshots if not s.error)
    official_points = sum(1 for s in snapshots if not s.error for d in s.data_points if d.official)

    a(f"# PRC Workforce Compliance Monitor — {now:%d %B %Y}")
    a("")
    a(f"*Generated {now:%Y-%m-%d %H:%M} UTC by `compliance_monitor.py` v{VERSION}*")
    a("")

    # ---- Summary ----
    a("## 1. Summary")
    a("")
    a("| Metric | Value |")
    a("| --- | --- |")
    a(f"| Pages crawled | {len([s for s in snapshots if not s.error])} |")
    a(f"| Pages failed | {len(findings.page_errors)} |")
    a(f"| Data points tracked | {total_points} |")
    a(f"| Flagged as official figures | {official_points} |")
    a(f"| **Figures changed since last run** | **{len(findings.changed)}** |")
    a(f"| New figures added to site | {len(findings.added)} |")
    a(f"| Figures removed from site | {len(findings.removed)} |")
    a(f"| New PRC HR/labour developments | {len(findings.new_articles)} |")
    a(f"| Possible stale-figure conflicts | {len(findings.conflicts)} |")
    a("")

    if findings.first_run:
        a("> **Baseline run.** No previous state file was found, so this run *establishes* "
          "the baseline. Figure-change detection starts from the next run. "
          "The news watch below is live from this run onward.")
        a("")

    verdict = "ACTION REQUIRED" if findings.action_required() else "No action required"
    a(f"**Status: {verdict}**")
    a("")

    # ---- Changed figures ----
    a("## 2. Figures that changed on your pages")
    a("")
    if findings.changed:
        a("These are the same claims as last run with a different number. "
          "Verify which value is correct before publishing.")
        a("")
        a("| Page | Section | Was | Now | Type | Context |")
        a("| --- | --- | --- | --- | --- | --- |")
        for c in findings.changed:
            a(f"| {md_escape(c['url'])} | {md_escape(c['section_path'] or c['heading'])} "
              f"| `{md_escape(c['old'])}` | `{md_escape(c['new'])}` | {c['kind']} "
              f"| {md_escape(c['context'])[:160]} |")
    else:
        a("_No tracked figure changed value since the last run._")
    a("")

    # ---- Regulatory watch ----
    a("## 3. New PRC workforce / HR / labour-law developments")
    a("")
    if findings.new_articles:
        a("Each item below is new since the last run and passed the China + workforce "
          "relevance filter. **Open the source link to validate before acting.**")
        a("")
        for art in findings.new_articles[:40]:
            pub = art.published or "date not stated"
            a(f"### {md_escape(art.title)}")
            a("")
            a(f"- **Source:** {md_escape(art.source or urlparse(art.link).netloc)}")
            a(f"- **Published:** {md_escape(pub)}")
            a(f"- **Relevance score:** {art.score}")
            a(f"- **Matched watch query:** `{md_escape(art.query)}`")
            a(f"- **Validation link:** <{art.link}>")
            if art.source_url:
                a(f"- **Publisher:** <{art.source_url}>")
            if art.summary:
                a(f"- **Summary:** {md_escape(art.summary)[:500]}")
            if art.numbers:
                figs = ", ".join(f"`{n['raw']}`" for n in art.numbers[:8])
                a(f"- **Figures cited in article:** {figs}")
            a("")
        if len(findings.new_articles) > 40:
            a(f"_…and {len(findings.new_articles) - 40} more new items (truncated)._")
            a("")
    else:
        a("_No new qualifying developments since the last run._")
        a("")

    # ---- Conflicts ----
    a("## 4. Pages that may need updating (figure vs. source conflict)")
    a("")
    if findings.conflicts:
        a("A new article discusses the same subject as a figure on your site but cites a "
          "different number. These are heuristic matches — confirm against the source.")
        a("")
        for c in findings.conflicts[:40]:
            a(f"- **Page:** {c['url']}")
            a(f"  - **Section:** {md_escape(c['section_path'] or c['heading'])}")
            a(f"  - **Your figure:** `{md_escape(c['page_figure'])}` — "
              f"\"{md_escape(c['context'])[:200]}\"")
            a(f"  - **Article figure:** `{md_escape(c['article_figure'])}` ({c['kind']})")
            a(f"  - **Article:** {md_escape(c['article_title'])} — "
              f"{md_escape(c['article_source'])}, {md_escape(c['article_published'] or 'n/d')}")
            a(f"  - **Validate at:** <{c['article_link']}>")
            a(f"  - **Matched on terms:** {', '.join(c['shared_terms'])}")
            a("")
    else:
        a("_No figure conflicts detected this run._")
        a("")

    # ---- Added / removed ----
    a("## 5. Other content movement")
    a("")
    if findings.added:
        a(f"**{len(findings.added)} new figure(s) appeared on the site:**")
        a("")
        for dp in findings.added[:30]:
            a(f"- `{md_escape(dp.raw)}` under *{md_escape(dp.section_path or dp.heading)}* "
              f"on {dp.url} — {md_escape(dp.context)[:160]}")
        if len(findings.added) > 30:
            a(f"- _…and {len(findings.added) - 30} more._")
        a("")
    if findings.removed:
        a(f"**{len(findings.removed)} figure(s) disappeared from the site:**")
        a("")
        for r in findings.removed[:30]:
            a(f"- `{md_escape(r['raw'])}` was under *{md_escape(r['heading'])}* on {r['url']}")
        if len(findings.removed) > 30:
            a(f"- _…and {len(findings.removed) - 30} more._")
        a("")
    if findings.structure_changes:
        a("**Structural changes:**")
        a("")
        for s in findings.structure_changes:
            if s["field"] == "title":
                a(f"- {s['url']}: title changed from \"{md_escape(s['old'])}\" "
                  f"to \"{md_escape(s['new'])}\"")
            else:
                added = ", ".join(md_escape(x) for x in s.get("added", [])[:8]) or "none"
                removed = ", ".join(md_escape(x) for x in s.get("removed", [])[:8]) or "none"
                a(f"- {s['url']}: {s['field']} added [{added}] / removed [{removed}]")
        a("")
    if not (findings.added or findings.removed or findings.structure_changes):
        a("_No structural or inventory changes._")
        a("")

    # ---- Errors ----
    if findings.page_errors:
        a("## 6. Crawl errors")
        a("")
        for e in findings.page_errors:
            a(f"- {e['url']} — {md_escape(e['error'])}")
        a("")

    # ---- Inventory ----
    a("## 7. Current page inventory")
    a("")
    for snap in snapshots:
        if snap.error:
            a(f"### {snap.url}")
            a("")
            a(f"> Crawl failed: {md_escape(snap.error)}")
            a("")
            continue
        a(f"### {snap.title or snap.url}")
        a("")
        a(f"- URL: <{snap.url}>")
        a(f"- Fetched: {snap.fetched_at}")
        a(f"- Words: {snap.word_count} · Text blocks: {snap.text_blocks} "
          f"· Headings: {len(snap.headings)} · Tabs/panels: {len(snap.tabs)} "
          f"· Figures: {len(snap.data_points)}")
        a(f"- Content hash: `{snap.content_hash}`")
        a("")
        if snap.headings:
            a("<details><summary>Heading structure</summary>")
            a("")
            for h in snap.headings[:120]:
                indent = "  " * (int(h["level"][1]) - 1)
                a(f"{indent}- `{h['level']}` {md_escape(h['text'])}")
            a("")
            a("</details>")
            a("")
        if snap.tabs:
            a("<details><summary>Tab / accordion structures</summary>")
            a("")
            a("| Label | Mechanism | Panel id | Panel words |")
            a("| --- | --- | --- | --- |")
            for t in snap.tabs[:80]:
                a(f"| {md_escape(t['label'])[:70]} | {t['mechanism']} "
                  f"| {md_escape(t['panel_id'])} | {t['panel_words']} |")
            a("")
            a("</details>")
            a("")
        if snap.data_points:
            a("<details><summary>All extracted figures</summary>")
            a("")
            a("| Figure | Type | Official? | Section | Context |")
            a("| --- | --- | --- | --- | --- |")
            for dp in snap.data_points[:250]:
                a(f"| `{md_escape(dp.raw)}` | {dp.kind} | {'yes' if dp.official else 'no'} "
                  f"| {md_escape(dp.section_path or dp.heading)[:60]} "
                  f"| {md_escape(dp.context)[:140]} |")
            if len(snap.data_points) > 250:
                a(f"| _…{len(snap.data_points) - 250} more_ | | | | |")
            a("")
            a("</details>")
            a("")

    # ---- Sources ----
    a("## 8. Sources consulted this run")
    a("")
    a("**Pages monitored:**")
    a("")
    for snap in snapshots:
        a(f"- <{snap.url}>")
    a("")
    lookback = int(cfg.get("news_lookback_days", 120))
    a(f"**Watch queries (Google News RSS, last {lookback} days):**")
    a("")
    for q in cfg.get("news_queries", []):
        a(f"- `{md_escape(q)}` — <{google_news_rss(q, lookback)}>")
    a("")
    if cfg.get("rss_feeds"):
        a("**Additional feeds:**")
        a("")
        for f in cfg["rss_feeds"]:
            a(f"- <{f}>")
        a("")
    if articles:
        a("**All relevant articles seen this run (new and previously seen):**")
        a("")
        for art in articles[:80]:
            a(f"- [{md_escape(art.title)}]({art.link}) — {md_escape(art.source)}, "
              f"{md_escape(art.published or 'n/d')}")
        a("")

    a("---")
    a("")
    a("*This report is generated automatically from public web sources. Figures and legal "
      "developments must be verified against the linked primary source before any page is "
      "updated or any compliance decision is taken. It is not legal advice.*")
    a("")
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Email
# --------------------------------------------------------------------------- #

def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def send_email(markdown: str, subject: str, cfg: Dict[str, Any],
               attachment_name: str = "compliance_report.md") -> bool:
    """Send the report via SMTP. Credentials come from the environment only."""
    user = os.environ.get("EMAIL_HOST_USER")
    password = os.environ.get("EMAIL_HOST_PASSWORD")
    if not user or not password:
        log.error("EMAIL_HOST_USER / EMAIL_HOST_PASSWORD are not set — cannot send email. "
                  "The report has still been written to disk.")
        return False

    host = os.environ.get("EMAIL_HOST", "smtp.gmail.com")
    port = int(os.environ.get("EMAIL_PORT", "465"))
    use_ssl = _env_bool("EMAIL_USE_SSL", port == 465)
    sender = os.environ.get("EMAIL_FROM", user)
    recipients = [
        r.strip()
        for r in os.environ.get("EMAIL_TO", cfg.get("email", {}).get("to", "")).split(",")
        if r.strip()
    ]
    if not recipients:
        log.error("No recipient configured (EMAIL_TO or config email.to).")
        return False

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = ", ".join(recipients)
    msg.set_content(markdown)

    if cfg.get("email", {}).get("attach_markdown", True):
        msg.add_attachment(
            markdown.encode("utf-8"),
            maintype="text",
            subtype="markdown",
            filename=attachment_name,
        )

    context = ssl.create_default_context()
    try:
        if use_ssl:
            with smtplib.SMTP_SSL(host, port, context=context, timeout=60) as server:
                server.login(user, password)
                server.send_message(msg, from_addr=sender, to_addrs=recipients)
        else:
            with smtplib.SMTP(host, port, timeout=60) as server:
                server.ehlo()
                if _env_bool("EMAIL_USE_STARTTLS", True):
                    server.starttls(context=context)
                    server.ehlo()
                server.login(user, password)
                server.send_message(msg, from_addr=sender, to_addrs=recipients)
    except smtplib.SMTPAuthenticationError as exc:
        log.error("SMTP authentication failed: %s. For Gmail you must use an App Password "
                  "with 2FA enabled, not your normal password.", exc)
        return False
    except Exception as exc:
        log.error("Failed to send email: %s", exc)
        return False

    log.info("Report emailed to %s via %s:%s", ", ".join(recipients), host, port)
    return True


# --------------------------------------------------------------------------- #
# State
# --------------------------------------------------------------------------- #

def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        with path.open("r", encoding="utf-8") as fh:
            return json.load(fh)
    except (json.JSONDecodeError, OSError) as exc:
        log.warning("Could not read %s (%s) — starting fresh.", path, exc)
        return default


def save_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, ensure_ascii=False, sort_keys=True)
    tmp.replace(path)


def build_state(snapshots: List[PageSnapshot], articles: List[Article],
                previous: Dict[str, Any]) -> Dict[str, Any]:
    now = datetime.now(timezone.utc)
    pages = dict(previous.get("pages", {}))
    for snap in snapshots:
        if snap.error:
            continue  # keep the last good snapshot rather than wiping the baseline
        pages[snap.url] = snap.to_state()

    seen = dict(previous.get("articles", {}))
    for art in articles:
        seen.setdefault(art.id, {
            "title": art.title, "link": art.link, "source": art.source,
            "published": art.published, "first_seen": now.isoformat(timespec="seconds"),
        })

    # Prune article memory older than a year to keep the file small.
    cutoff = now - timedelta(days=365)
    pruned = {}
    for aid, meta in seen.items():
        first_seen = _parse_date(meta.get("first_seen", ""))
        if first_seen is None or first_seen >= cutoff:
            pruned[aid] = meta

    return {
        "version": VERSION,
        "last_run": now.isoformat(timespec="seconds"),
        "pages": pages,
        "articles": pruned,
    }


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #

def resolve_pages(cfg: Dict[str, Any], cli_urls: Sequence[str]) -> List[str]:
    if cli_urls:
        return list(cli_urls)
    env_pages = os.environ.get("MONITOR_PAGES", "")
    if env_pages.strip():
        return [u.strip() for u in env_pages.split(",") if u.strip()]
    return [u for u in cfg.get("pages", []) if u]


def crawl(pages: Sequence[str], cfg: Dict[str, Any], fetcher: Fetcher,
          render: bool) -> List[PageSnapshot]:
    snapshots: List[PageSnapshot] = []
    for url in pages:
        log.info("Crawling %s", url)
        snap = PageSnapshot(
            url=url,
            fetched_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
            status=0, title="", meta_description="",
        )
        try:
            if not fetcher.allowed(url):
                raise PermissionError("Blocked by robots.txt (set request.respect_robots=false "
                                      "in the config to override for your own site)")
            status, html = fetcher.get_rendered(url) if render else fetcher.get(url)
            snap = parse_page(url, html, status, cfg)
            log.info("  title=%r headings=%d tabs=%d figures=%d words=%d",
                     snap.title[:60], len(snap.headings), len(snap.tabs),
                     len(snap.data_points), snap.word_count)
        except Exception as exc:
            snap.error = str(exc)
            log.error("  failed: %s", exc)
        snapshots.append(snap)
    return snapshots


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Crawl landing pages, track figures, watch PRC labour-law updates, "
                    "and email a markdown compliance report.")
    p.add_argument("--config", type=Path, default=DEFAULT_CONFIG_PATH,
                   help=f"Config JSON (default: {DEFAULT_CONFIG_PATH})")
    p.add_argument("--state", type=Path, default=DEFAULT_STATE_PATH,
                   help=f"Baseline state JSON (default: {DEFAULT_STATE_PATH})")
    p.add_argument("--report-dir", type=Path, default=DEFAULT_REPORT_DIR,
                   help=f"Where to write reports (default: {DEFAULT_REPORT_DIR})")
    p.add_argument("--url", action="append", default=[],
                   help="Crawl this URL instead of the config list (repeatable)")
    p.add_argument("--init", action="store_true", help="Write a starter config and exit")
    p.add_argument("--no-email", action="store_true", help="Never send email")
    p.add_argument("--always-email", action="store_true",
                   help="Send even when nothing changed")
    p.add_argument("--no-news", action="store_true", help="Skip the news/regulatory watch")
    p.add_argument("--render", action="store_true",
                   help="Render pages with Playwright (for JS-driven tabs)")
    p.add_argument("--dry-run", action="store_true",
                   help="Do not write state and do not send email")
    p.add_argument("--fail-on-change", action="store_true",
                   help="Exit with code 2 when action is required (useful in CI)")
    p.add_argument("-v", "--verbose", action="store_true", help="Debug logging")
    return p.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s  %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )

    if args.init:
        if args.config.exists():
            log.error("%s already exists — refusing to overwrite.", args.config)
            return 1
        save_json(args.config, DEFAULT_CONFIG)
        log.info("Wrote starter config to %s — edit the 'pages' list, then re-run.", args.config)
        return 0

    cfg = dict(DEFAULT_CONFIG)
    if args.config.exists():
        user_cfg = load_json(args.config, {})
        for key, value in user_cfg.items():
            if isinstance(value, dict) and isinstance(cfg.get(key), dict):
                merged = dict(cfg[key])
                merged.update(value)
                cfg[key] = merged
            else:
                cfg[key] = value
        log.info("Loaded config from %s", args.config)
    else:
        log.warning("No config at %s — using built-in defaults. Run with --init to create one.",
                    args.config)

    pages = resolve_pages(cfg, args.url)
    if not pages:
        log.error("No pages to crawl. Add URLs to config 'pages', set MONITOR_PAGES, or use --url.")
        return 1

    render = args.render or bool(cfg.get("render_js"))
    fetcher = Fetcher(cfg, render=render)

    try:
        snapshots = crawl(pages, cfg, fetcher, render)
        articles: List[Article] = []
        if not args.no_news:
            log.info("Running PRC workforce / labour-law watch…")
            articles = gather_news(cfg, fetcher)
    finally:
        fetcher.close()

    state = load_json(args.state, {})
    findings = compare(snapshots, articles, state)

    report = build_report(snapshots, findings, articles, cfg)
    args.report_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d_%H%M")
    report_path = args.report_dir / f"compliance-report-{stamp}.md"
    report_path.write_text(report, encoding="utf-8")
    latest_path = args.report_dir / "latest.md"
    latest_path.write_text(report, encoding="utf-8")
    log.info("Report written to %s", report_path)

    # GitHub Actions job summary, if we're running there.
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        try:
            with open(summary_path, "a", encoding="utf-8") as fh:
                fh.write(report[:60000])
        except OSError as exc:
            log.warning("Could not write GitHub step summary: %s", exc)

    should_email = (
        not args.no_email
        and not args.dry_run
        and (
            args.always_email
            or findings.action_required()
            or cfg.get("email", {}).get("send_when_no_changes", False)
        )
    )
    if should_email:
        prefix = cfg.get("email", {}).get("subject_prefix", "[PRC Compliance Monitor]")
        flag = "ACTION REQUIRED" if findings.action_required() else "no changes"
        subject = (f"{prefix} {datetime.now(timezone.utc):%d %b %Y} - {flag} "
                   f"({len(findings.changed)} figure changes, "
                   f"{len(findings.new_articles)} new developments)")
        send_email(report, subject, cfg, attachment_name=report_path.name)
    elif args.no_email or args.dry_run:
        log.info("Email suppressed by flag.")
    else:
        log.info("Nothing to report — email skipped (use --always-email to force).")

    if not args.dry_run:
        save_json(args.state, build_state(snapshots, articles, state))
        log.info("Baseline state saved to %s", args.state)

    if findings.page_errors and all(s.error for s in snapshots):
        return 1
    if args.fail_on_change and findings.action_required():
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
