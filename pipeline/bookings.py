"""The Wave (Bristol) booking confirmations -> structured bookings.

Flow: your Gmail auto-forwards confirmation emails (via a filter) to a
dedicated Gmail inbox. Each pipeline run logs in to that inbox over IMAP with
an app password (read-only mailbox select, BODY.PEEK so nothing is changed),
keeps only mail whose From domain is allow-listed AND carries a valid DKIM
signature for that domain, and extracts just date / time / wave setting.
Names, booking references and prices are never stored.

DKIM is checked as of when Gmail received the email (IMAP INTERNALDATE, or the
top Received header for a saved .eml): The Wave's mail service puts an expiry
(x=) of a few days on its signatures, and the inbox is re-read every run, so
checking "as of now" would drop bookings made more than a few days ahead.

The Wave's confirmation ("Order Confirmation <number>") has no date or time in
the email body. It carries a small calendar invite (text/calendar): the booking
is read from that first (DTSTART/DTEND/SUMMARY, times converted to UK time).
Only if there is none, the body and any PDF receipt (pypdf, size/page limited)
are searched instead. All of this happens only after the sender and DKIM checks.

UNVERIFIED: I have not seen a real Wave confirmation email. The parser is a
tolerant heuristic (dates like "Saturday 3rd October 2026", "03/10/2026";
times like "08:00 - 09:00", "8am"). Run
    python -m pipeline.bookings --parse path/to/email.eml
on a saved confirmation to check it, and adjust KNOWN_SETTINGS/patterns.
"""
from __future__ import annotations

import argparse
import email
import imaplib
import io
import json
import logging
import re
import ssl
from datetime import date, datetime, timedelta
from email import policy
from email.utils import parseaddr, parsedate_to_datetime
from unittest import mock
from html.parser import HTMLParser

log = logging.getLogger("surf.bookings")

KNOWN_SETTINGS = [
    "Expert Barrels", "Expert Turns", "Expert Plus", "Expert",
    "Advanced Plus", "Advanced Coaching", "Advanced",
    "Intermediate Plus", "Intermediate", "Improver",
    "Performance Coaching", "Mega Turns", "Longboarding",
    "Play in the Bay", "Beginner",
]
MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}
_MON = r"(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?"
DATE_RES = [
    (re.compile(r"\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?" + _MON + r",?\s+(\d{4})\b", re.I), "dmy_name"),
    (re.compile(r"\b" + _MON + r"\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b", re.I), "mdy_name"),
    (re.compile(r"\b(\d{1,2})/(\d{1,2})/(\d{2,4})\b"), "dmy_num"),   # UK order
    (re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b"), "iso"),
]
_T = r"(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?"
RANGE_RE = re.compile(r"\b" + _T + r"\s*(?:-|–|—|to|until)\s*" + _T + r"\b", re.I)
TIME_RE = re.compile(r"\b(\d{1,2})[:.](\d{2})\s*(am|pm)?\b|\b(\d{1,2})\s*(am|pm)\b", re.I)
SETTING_RE = re.compile("|".join(re.escape(s) for s in KNOWN_SETTINGS), re.I)
CONFIRM_HINT = re.compile(r"confirm|booking|booked|reservation|your surf|see you", re.I)
CANCEL_HINT = re.compile(r"cancel", re.I)
MAX_PDF_BYTES = 8_000_000     # The Wave's receipts are 3-5 MB (images); text is on page 1
MAX_PDF_PAGES = 4
MAX_EMAIL_BYTES = 25_000_000   # whole email incl. attachments (DKIM needs all of it)
UK = "Europe/London"


# ----------------------------------------------------------------------------- text
class _Text(HTMLParser):
    BLOCK = {"p", "div", "br", "tr", "li", "h1", "h2", "h3", "h4", "td", "table", "section"}

    def __init__(self):
        super().__init__()
        self.parts, self.skip = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "head"):
            self.skip += 1
        if tag in self.BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style", "head") and self.skip:
            self.skip -= 1
        if tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def html_to_text(html: str) -> str:
    p = _Text()
    p.feed(html)
    return "".join(p.parts)


PLACEHOLDER_RE = re.compile(r"html (viewer|version|email|compatible)|view (this|it) in (a|your) browser|"
                            r"does not support html|enable html", re.I)


def _clean(content: str) -> str:
    lines = [re.sub(r"\s+", " ", ln).strip() for ln in content.splitlines()]
    return "\n".join(ln for ln in lines if ln)


def message_text(msg: email.message.EmailMessage) -> str:
    """Readable text of the email. Uses the plain-text part unless it's missing, a
    stub ("An HTML viewer is required to see this message") or much shorter than the
    HTML part, in which case the HTML part is converted to text instead."""
    plain_part = msg.get_body(preferencelist=("plain",))
    html_part = msg.get_body(preferencelist=("html",))
    plain = _clean(plain_part.get_content()) if plain_part is not None else ""
    html = _clean(html_to_text(html_part.get_content())) if html_part is not None else ""
    stub = len(plain) < 400 and bool(PLACEHOLDER_RE.search(plain))
    body = html if html and (not plain or stub or len(plain) * 3 < len(html)) else plain
    pdfs = pdf_texts(msg)
    return "\n".join([body] + [f"--- attachment {i + 1} ---\n{t}" for i, t in enumerate(pdfs)])


def _pdf_parts(msg: email.message.EmailMessage):
    """Every leaf part that really is a PDF (checked by its %PDF header), wherever it
    sits in the email and whatever it is labelled (application/pdf, octet-stream, inline)."""
    for part in msg.walk():
        if part.is_multipart():
            continue
        ctype = part.get_content_type()
        if ctype.startswith("text/") or ctype.startswith("image/"):
            continue
        try:
            data = part.get_payload(decode=True) or b""
        except Exception:  # noqa: BLE001
            continue
        if data[:1024].lstrip().startswith(b"%PDF"):
            yield data


def pdf_texts(msg: email.message.EmailMessage) -> list[str]:
    """Text of each PDF in the email (size- and page-limited). Failures are skipped."""
    out = []
    for data in _pdf_parts(msg):
        if len(data) > MAX_PDF_BYTES:
            continue
        try:
            from pypdf import PdfReader
            reader = PdfReader(io.BytesIO(data))
            if reader.is_encrypted:
                continue
            text = "\n".join((pg.extract_text() or "") for pg in reader.pages[:MAX_PDF_PAGES])
        except ImportError:
            log.warning("pypdf not installed: PDF attachments not read")
            return out
        except Exception as e:  # noqa: BLE001 - a broken PDF just contributes nothing
            log.debug("pdf skipped: %s", e)
            continue
        if text.strip():
            out.append(_clean(text))
    return out


def structure(msg: email.message.EmailMessage) -> list[str]:
    """Outline of the email's parts for troubleshooting: type, disposition, file
    extension and size only (no file names, which can contain order numbers)."""
    rows = []
    for part in msg.walk():
        ctype = part.get_content_type()
        if part.is_multipart():
            rows.append(f"{ctype}")
            continue
        try:
            data = part.get_payload(decode=True) or b""
        except Exception:  # noqa: BLE001
            data = b""
        name = part.get_filename() or ""
        ext = name.rsplit(".", 1)[-1].lower() if "." in name else ("(no name)" if not name else "(no extension)")
        disp = part.get_content_disposition() or "-"
        magic = "PDF" if data[:1024].lstrip().startswith(b"%PDF") else "-"
        rows.append(f"  {ctype} | {disp} | .{ext} | {len(data)} bytes | looks like {magic}")
    return rows


# ----------------------------------------------------------------------------- calendar
def _ics_lines(text: str) -> list[tuple[str, dict, str]]:
    """Unfold an iCalendar text into (NAME, params, value) triples."""
    unfolded = re.sub(r"\r?\n[ \t]", "", text)
    out = []
    for ln in unfolded.splitlines():
        if ":" not in ln:
            continue
        head, value = ln.split(":", 1)
        name, *params = head.split(";")
        pd = {}
        for prm in params:
            if "=" in prm:
                k, v = prm.split("=", 1)
                pd[k.upper()] = v.strip('"')
        out.append((name.upper(), pd, value.strip()))
    return out


def _ics_unescape(v: str) -> str:
    return v.replace("\\n", " ").replace("\\N", " ").replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\")


def _ics_time(value: str, params: dict) -> datetime | None:
    """DTSTART/DTEND -> aware datetime in UK time. Handles ...Z (UTC), TZID=..., and
    floating times (taken as UK time). All-day dates return None (no session time)."""
    from zoneinfo import ZoneInfo
    uk = ZoneInfo(UK)
    m = re.fullmatch(r"(\d{8})T(\d{4})(\d{2})?(Z?)", value)
    if not m:
        return None
    dt = datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M")
    if m.group(4) == "Z":
        return dt.replace(tzinfo=ZoneInfo("UTC")).astimezone(uk)
    tzid = params.get("TZID")
    try:
        tz = ZoneInfo(tzid) if tzid else uk
    except Exception:  # noqa: BLE001 - Windows-style or unknown TZID: assume UK
        tz = uk
    return dt.replace(tzinfo=tz).astimezone(uk)


def calendar_bookings(msg: email.message.EmailMessage) -> list[dict]:
    """Bookings from any text/calendar part (the "add to calendar" invite)."""
    out = []
    for part in msg.walk():
        if part.get_content_type() != "text/calendar":
            continue
        try:
            text = part.get_content()
        except Exception:  # noqa: BLE001
            continue
        if not isinstance(text, str) or len(text) > 200_000:
            continue
        lines = _ics_lines(text)
        method_cancel = any(n == "METHOD" and v.upper() == "CANCEL" for n, _, v in lines)
        ev = None
        for name, params, value in lines:
            if name == "BEGIN" and value.upper() == "VEVENT":
                ev = {}
            elif name == "END" and value.upper() == "VEVENT" and ev is not None:
                start = ev.get("DTSTART")
                if start:
                    end = ev.get("DTEND")
                    blob = " ".join(ev.get(k, "") for k in ("SUMMARY", "DESCRIPTION", "LOCATION"))
                    sm = SETTING_RE.search(blob)
                    setting = (next(x for x in KNOWN_SETTINGS if x.lower() == sm.group(0).lower()) if sm
                               else re.sub(r"\s+", " ", ev.get("SUMMARY", "Surf session"))[:40])
                    if end is not None and end.minute == 59:  # "16:59" ends -> "17:00"
                        end = end + timedelta(minutes=1)
                    out.append({"date": start.date().isoformat(), "start": start.strftime("%H:%M"),
                                "end": end.strftime("%H:%M") if end else None, "setting": setting,
                                "cancelled": method_cancel or ev.get("STATUS", "").upper() == "CANCELLED"})
                ev = None
            elif ev is not None:
                if name in ("DTSTART", "DTEND"):
                    t = _ics_time(value, params)
                    if t:
                        ev[name] = t
                elif name in ("SUMMARY", "DESCRIPTION", "LOCATION", "STATUS"):
                    ev[name] = _ics_unescape(value)
    return out


def calendar_outline(msg: email.message.EmailMessage) -> list[str]:
    """For the --parse test: the calendar fields that matter (no attendee/organiser)."""
    rows = []
    for part in msg.walk():
        if part.get_content_type() == "text/calendar":
            try:
                for name, params, value in _ics_lines(part.get_content()):
                    if name in ("METHOD", "BEGIN", "END", "DTSTART", "DTEND", "SUMMARY", "STATUS"):
                        tz = f";TZID={params['TZID']}" if "TZID" in params else ""
                        rows.append(f"{name}{tz}:{_ics_unescape(value)[:80]}")
            except Exception as e:  # noqa: BLE001
                rows.append(f"(unreadable calendar part: {type(e).__name__})")
    return rows


# ----------------------------------------------------------------------------- parse
def _to_date(m: re.Match, kind: str) -> date | None:
    try:
        if kind == "dmy_name":
            return date(int(m.group(3)), MONTHS[m.group(2)[:3].lower()], int(m.group(1)))
        if kind == "mdy_name":
            return date(int(m.group(3)), MONTHS[m.group(1)[:3].lower()], int(m.group(2)))
        if kind == "dmy_num":
            y = int(m.group(3))
            return date(y + 2000 if y < 100 else y, int(m.group(2)), int(m.group(1)))
        if kind == "iso":
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except (ValueError, KeyError):
        return None
    return None


def _hm(h: str, mnt: str | None, ampm: str | None) -> str | None:
    hh, mm = int(h), int(mnt or 0)
    if ampm:
        a = ampm.lower()
        if hh == 12:
            hh = 0
        if a == "pm":
            hh += 12
    if not (0 <= hh < 24 and 0 <= mm < 60):
        return None
    return f"{hh:02d}:{mm:02d}"


def _find_time(text: str) -> tuple[str | None, str | None]:
    for m in RANGE_RE.finditer(text):
        if not (m.group(2) or m.group(3) or m.group(5) or m.group(6)):
            continue  # bare "3 - 5" is too ambiguous
        a = _hm(m.group(1), m.group(2), m.group(3) or m.group(6))
        b = _hm(m.group(4), m.group(5), m.group(6))
        if a and b:
            return a, b
    for m in TIME_RE.finditer(text):
        t = _hm(m.group(1), m.group(2), m.group(3)) if m.group(1) else _hm(m.group(4), None, m.group(5))
        if t:
            return t, None
    return None, None


def _find_date(text: str, not_before: date | None) -> date | None:
    found = []
    for rx, kind in DATE_RES:
        for m in rx.finditer(text):
            d = _to_date(m, kind)
            if d:
                found.append((m.start(), d))
    found.sort()
    for _, d in found:
        if not_before is None or d >= not_before:
            return d
    return found[0][1] if found else None


def parse_booking_text(text: str, subject: str = "", sent: datetime | None = None) -> list[dict]:
    """Extract bookings from confirmation text. Looks for each wave-setting
    mention and searches a window of nearby lines for the date and time."""
    lines = text.splitlines()
    not_before = sent.date() - timedelta(days=1) if sent else None
    cancelled = bool(CANCEL_HINT.search(subject))
    out, seen = [], set()
    for i, ln in enumerate(lines):
        for m in SETTING_RE.finditer(ln):
            setting = next(s for s in KNOWN_SETTINGS if s.lower() == m.group(0).lower())
            # widen the window progressively: same line, then +/-2, then +/-5
            d = t0 = t1 = None
            for span in (0, 2, 5):
                window = "\n".join(lines[max(0, i - span): i + span + 1])
                d = d or _find_date(window, not_before)
                if not t0:
                    t0, t1 = _find_time(window)
                if d and t0:
                    break
            if not d or not t0:
                continue
            key = (d.isoformat(), t0)
            if key in seen:
                continue
            seen.add(key)
            out.append({"date": d.isoformat(), "start": t0, "end": t1,
                        "setting": setting, "cancelled": cancelled})
    return out


# ----------------------------------------------------------------------------- auth
def _domain(addr: str) -> str:
    return parseaddr(addr)[1].rpartition("@")[2].lower()


def _allowed(domain: str, allow: list[str]) -> bool:
    return any(domain == a or domain.endswith("." + a) for a in allow)


def received_at(msg) -> float | None:
    """When the receiving mail server got the message: the date on the TOP Received
    header (added by Gmail itself; a sender can only add headers below it)."""
    rec = msg.get_all("Received") or []
    if not rec:
        return None
    try:
        return parsedate_to_datetime(str(rec[0]).rsplit(";", 1)[-1].strip()).timestamp()
    except (TypeError, ValueError, IndexError):
        return None


def _verify_at(raw: bytes, idx: int, at: float | None) -> bool:
    import dkim  # dkimpy
    d = dkim.DKIM(raw)
    if at is None:
        return bool(d.verify(idx=idx))
    # dkimpy checks t=/x= against time.time(); check them as of receipt instead.
    with mock.patch("time.time", return_value=float(at)):
        return bool(d.verify(idx=idx))


def dkim_report(raw: bytes, allow: list[str], at: float | None = None) -> list[dict]:
    """For the --parse test only: each DKIM signature's domain, selector and result.
    Domains/selectors are not personal data, so this is safe to share."""
    import dkim  # dkimpy
    msg = email.message_from_bytes(raw)
    out = []
    for idx, sig in enumerate(msg.get_all("DKIM-Signature") or []):
        tags = dict(t.strip().split("=", 1) for t in re.sub(r"\s+", "", str(sig)).split(";") if "=" in t)
        row = {"d": tags.get("d"), "s": tags.get("s"), "allowed_domain": bool(tags.get("d")) and
               _allowed(tags.get("d", "").lower(), allow)}
        try:
            row["verifies"] = _verify_at(raw, idx, at)
        except Exception as e:  # noqa: BLE001
            row["verifies"] = False
            row["error"] = f"{type(e).__name__}: {e}"[:200]
        out.append(row)
    return out


def dkim_ok(raw: bytes, allow: list[str], at: float | None = None) -> bool:
    """True if a DKIM signature from an allow-listed domain verifies, as of `at`
    (when the email was received) if given."""
    try:
        import dkim  # dkimpy
    except ImportError as e:
        raise RuntimeError("require_dkim is on but dkimpy is not installed") from e
    msg = email.message_from_bytes(raw)
    for idx, sig in enumerate(msg.get_all("DKIM-Signature") or []):
        dom = re.search(r"(?:^|;)\s*d\s*=\s*([^;\s]+)", str(sig))
        if not dom or not _allowed(dom.group(1).lower(), allow):
            continue  # only signatures by an allowed domain count
        try:
            if _verify_at(raw, idx, at):
                return True
        except Exception as e:  # noqa: BLE001 - malformed signatures are just failures
            log.debug("dkim idx %s failed: %s", idx, e)
    return False


# ----------------------------------------------------------------------------- imap
def fetch_bookings(user: str, app_password: str, cfg: dict, today: date) -> tuple[list[dict], list[str]]:
    """Return (future bookings, warnings)."""
    warnings: list[str] = []
    allow = [d.lower() for d in cfg["sender_domains"]]
    since = (today - timedelta(days=cfg["lookback_days"])).strftime("%d-%b-%Y")
    ctx = ssl.create_default_context()
    raws: list[tuple[bytes, float | None]] = []
    with imaplib.IMAP4_SSL(cfg["imap_host"], 993, ssl_context=ctx, timeout=30) as M:
        M.login(user, app_password)
        M.select("INBOX", readonly=True)
        ids: list[bytes] = []
        for dom in allow:
            typ, data = M.search(None, "SINCE", since, "FROM", f'"{dom}"')
            if typ == "OK" and data and data[0]:
                ids.extend(data[0].split())
        ids = sorted(set(ids), key=int)[-cfg["max_messages"]:]
        for mid in ids:
            typ, data = M.fetch(mid, "(RFC822.SIZE)")
            size = int(re.search(rb"RFC822\.SIZE (\d+)", data[0]).group(1)) if typ == "OK" else 0
            if size > MAX_EMAIL_BYTES:
                warnings.append("skipped oversized email")
                continue
            typ, data = M.fetch(mid, "(INTERNALDATE BODY.PEEK[])")
            if typ == "OK" and data and isinstance(data[0], tuple):
                idate = imaplib.Internaldate2tuple(data[0][0])  # when Gmail received it
                raws.append((data[0][1], time_mktime(idate) if idate else None))
    return process_raw_messages(raws, cfg, today, warnings), warnings


def time_mktime(t) -> float:
    import time
    return time.mktime(t)


def process_raw_messages(raws: list, cfg: dict, today: date, warnings: list[str]) -> list[dict]:
    """raws: raw emails, or (raw, received_timestamp) pairs from IMAP."""
    allow = [d.lower() for d in cfg["sender_domains"]]
    parsed = []
    for item in raws:
        raw, at = item if isinstance(item, tuple) else (item, None)
        msg = email.message_from_bytes(raw, policy=policy.default)
        if not _allowed(_domain(msg.get("From", "")), allow):
            continue
        if at is None:
            at = received_at(msg)
        if cfg.get("require_dkim", True) and not dkim_ok(raw, allow, at):
            warnings.append("ignored email failing DKIM")
            continue
        subject = str(msg.get("Subject", ""))
        try:
            sent = parsedate_to_datetime(msg.get("Date"))
        except (TypeError, ValueError):
            sent = None
        found = calendar_bookings(msg)  # the calendar invite, when there is one
        if found and CANCEL_HINT.search(subject):
            found = [dict(b, cancelled=True) for b in found]
        if not found:
            text = message_text(msg)
            if not (CONFIRM_HINT.search(subject) or CONFIRM_HINT.search(text[:2000])):
                continue
            found = parse_booking_text(text, subject, sent)
        for b in found:
            parsed.append((sent.timestamp() if sent else 0, b))
    # apply in send order so a later cancellation removes an earlier booking
    book: dict = {}
    for _, b in sorted(parsed, key=lambda x: x[0]):
        key = (b["date"], b["start"])
        if b["cancelled"]:
            book.pop(key, None)
        else:
            book[key] = b
    return sorted((b for b in book.values() if b["date"] >= today.isoformat()),
                  key=lambda b: (b["date"], b["start"]))


def _cli():
    ap = argparse.ArgumentParser(description="Test the booking parser on a saved .eml file")
    ap.add_argument("--parse", required=True, help="path to an .eml file")
    ap.add_argument("--no-dkim", action="store_true")
    ap.add_argument("--show-text", action="store_true",
                    help="also print the email and PDF text (contains your name, email and prices)")
    a = ap.parse_args()
    from .util import load_settings
    cfg = dict(load_settings()["bookings"])
    if a.no_dkim:
        cfg["require_dkim"] = False
    raw = open(a.parse, "rb").read()
    msg = email.message_from_bytes(raw, policy=policy.default)
    if a.show_text:
        print("--- extracted text (first 120 lines; contains personal details, don't share as is) ---")
        print("\n".join(message_text(msg).splitlines()[:120]))
    warnings: list[str] = []
    res = process_raw_messages([raw], cfg, date.today() - timedelta(days=3650), warnings)
    print("--- email structure (safe to share) ---")
    print("\n".join(structure(msg)))
    cal = calendar_outline(msg)
    if cal:
        print("--- calendar invite (key fields only) ---")
        print("\n".join(cal))
    print("--- bookings ---")
    print(json.dumps(res, indent=2))
    if warnings:
        print("warnings:", warnings)
    print("--- sender check (safe to share: no names or booking details) ---")
    print("From domain:", _domain(msg.get("From", "")), "| allowed:",
          _allowed(_domain(msg.get("From", "")), [d.lower() for d in cfg["sender_domains"]]))
    try:
        at = received_at(msg)
        print("Received by Gmail:", datetime.fromtimestamp(at).isoformat(timespec="minutes") if at else "unknown",
              "(signatures are checked as of this time)")
        rep = dkim_report(raw, [d.lower() for d in cfg["sender_domains"]], at)
        print("DKIM signatures:", json.dumps(rep) if rep else "none (the email isn't DKIM-signed)")
    except ImportError:
        print("DKIM signatures: dkimpy not installed")


if __name__ == "__main__":
    _cli()
