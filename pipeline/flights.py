"""Flight details for the Flight widget.

Each Flight widget stores a flight number and a departure date (layout props). Before
rendering, the pipeline collects them from a frame's layouts, looks each one up, and puts
the result in that frame's data.json as  data["flights"]["<NUMBER>_<YYYY-MM-DD>"]:

    {"from": "LGW", "to": "FAO", "from_name": "London", "to_name": "Faro",
     "dep": "06:40", "arr": "10:55", "dep_date": "2026-10-06", "arr_date": "2026-10-06",
     "terminal": "", "status": "Expected", "airline": "Ryanair", "aircraft": "Boeing 737-800"}

Anything typed into the widget's own From / To / Departs / Arrives boxes wins over this,
so the widget still works with no lookup at all.

Lookup: AeroDataBox (RapidAPI), only if the AERODATABOX_KEY secret is set.
  GET https://aerodatabox.p.rapidapi.com/flights/number/{number}/{YYYY-MM-DD}
  headers X-RapidAPI-Key, X-RapidAPI-Host: aerodatabox.p.rapidapi.com
UNVERIFIED against current docs (Oct 2026): the response field names below
(departure/arrival -> airport.iata / airport.municipalityName / scheduledTime.local,
terminal, status, airline.name, aircraft.model) are parsed defensively, and how far ahead
AeroDataBox has schedules is unknown — far-off flights may only resolve nearer the date.

Results are cached in the bucket (cache/flights/<key>.json) to keep API calls low:
refreshed weekly while the flight is more than 2 weeks away, daily inside 2 weeks, and
every run on the day itself; nothing is looked up for flights that have already gone.
"""
from __future__ import annotations

import json
import logging
import os
import re
import time
from datetime import date, datetime

log = logging.getLogger("surf")

NUM_RE = re.compile(r"^[A-Z0-9]{2,3}\d{1,4}[A-Z]?$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
HOST = "aerodatabox.p.rapidapi.com"
MAX_LOOKUPS_PER_RUN = 10


def flight_key(num: str, day: str) -> str | None:
    n = re.sub(r"[^A-Z0-9]", "", str(num or "").upper())[:8]
    d = str(day or "")
    return f"{n}_{d}" if NUM_RE.match(n) and DATE_RE.match(d) else None


def collect(store, prefix: str) -> set[str]:
    """Keys of every Flight widget on a frame's layouts."""
    keys = set()
    for k in store.list(prefix + "layouts/"):
        if not k.endswith(".json"):
            continue
        try:
            layout = json.loads(store.get(k) or b"{}")
        except ValueError:
            continue
        for w in layout.get("widgets", []):
            if w.get("type") == "flight":
                p = w.get("props") or {}
                key = flight_key(p.get("flight"), p.get("date"))
                if key:
                    keys.add(key)
    return keys


def _hhmm_date(t) -> tuple[str, str]:
    """'2026-10-06 06:40+01:00' (or ISO with T) -> ('06:40', '2026-10-06')."""
    s = str(t or "")
    m = re.match(r"(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})", s)
    return (m.group(2), m.group(1)) if m else ("", "")


def parse(resp, day: str) -> dict | None:
    """First flight in an AeroDataBox response that departs on `day` (or the first one)."""
    items = resp if isinstance(resp, list) else (resp or {}).get("items") or []
    best = None
    for f in items:
        if not isinstance(f, dict):
            continue
        dep, arr = f.get("departure") or {}, f.get("arrival") or {}
        st = dep.get("scheduledTime") or {}
        dep_t, dep_d = _hhmm_date(st.get("local") if isinstance(st, dict) else dep.get("scheduledTimeLocal"))
        at = arr.get("scheduledTime") or {}
        arr_t, arr_d = _hhmm_date(at.get("local") if isinstance(at, dict) else arr.get("scheduledTimeLocal"))
        ap_d, ap_a = dep.get("airport") or {}, arr.get("airport") or {}
        out = {
            "from": str(ap_d.get("iata") or "")[:4], "to": str(ap_a.get("iata") or "")[:4],
            "from_name": str(ap_d.get("municipalityName") or ap_d.get("shortName") or "")[:40],
            "to_name": str(ap_a.get("municipalityName") or ap_a.get("shortName") or "")[:40],
            "dep": dep_t, "arr": arr_t, "dep_date": dep_d or day, "arr_date": arr_d,
            "terminal": str(dep.get("terminal") or "")[:6], "status": str(f.get("status") or "")[:20],
            "airline": str((f.get("airline") or {}).get("name") or "")[:30],
            "aircraft": str((f.get("aircraft") or {}).get("model") or "")[:30],
        }
        if best is None:
            best = out
        if (dep_d or day) == day:
            return out
    return best


def _due(cached: dict | None, days_to_go: int, now: float) -> bool:
    if not cached:
        return True
    age = now - cached.get("fetched", 0)
    if days_to_go <= 0:
        return age > 2 * 3600
    return age > (86400 - 600 if days_to_go <= 14 else 7 * 86400 - 600)


def lookup(keys: set[str], store, today: date, session, api_key: str | None = None) -> dict:
    """{key: details} for the given keys, from the cache or AeroDataBox. Never raises."""
    api_key = api_key if api_key is not None else os.environ.get("AERODATABOX_KEY", "")
    now, out, calls = time.time(), {}, 0
    for key in sorted(keys):
        num, day = key.split("_", 1)
        try:
            to_go = (datetime.strptime(day, "%Y-%m-%d").date() - today).days
        except ValueError:
            continue
        ck = f"cache/flights/{key}.json"
        try:
            cached = json.loads(store.get(ck) or b"null")
        except ValueError:
            cached = None
        if to_go >= -1 and api_key and calls < MAX_LOOKUPS_PER_RUN and _due(cached, to_go, now):
            calls += 1
            try:
                r = session.get(f"https://{HOST}/flights/number/{num}/{day}",
                                headers={"X-RapidAPI-Key": api_key, "X-RapidAPI-Host": HOST}, timeout=20)
                if r.status_code == 200:
                    info = parse(r.json(), day)
                    cached = {"fetched": now, "info": info}
                elif r.status_code in (204, 404):
                    cached = {"fetched": now, "info": (cached or {}).get("info")}  # not scheduled yet
                else:
                    log.warning("flight %s: lookup HTTP %s", key, r.status_code)
                store.put(ck, json.dumps(cached).encode(), "application/json")
            except Exception as e:  # noqa: BLE001
                log.warning("flight %s: lookup failed (%s)", key, type(e).__name__)
        if cached and cached.get("info"):
            out[key] = cached["info"]
    return out
