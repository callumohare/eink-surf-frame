"""ADMIRALTY UK Tidal API — Discovery tier (HW/LW events, today + 6 days).

Verified against the ADMIRALTY developer portal (Sep 2026):
  GET https://admiraltyapi.azure-api.net/uktidalapi/api/V1/Stations/{id}/TidalEvents?duration=1..7
  header Ocp-Apim-Subscription-Key
Response fields used: EventType (HighWater/LowWater), DateTime, Height.
ASSUMPTION (flagged): DateTime is UTC with no offset suffix; treated as UTC.
Display credit is mandatory: see CREDIT below.
"""
from __future__ import annotations

from datetime import datetime, timezone

from ..util import http_session

BASE = "https://admiraltyapi.azure-api.net/uktidalapi/api/V1"
CREDIT = "Contains ADMIRALTY® tidal data: © Crown copyright and database right"


def _parse_dt(s: str) -> datetime:
    s = s.rstrip("Z")
    s = s.split(".")[0]
    dt = datetime.fromisoformat(s)
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def fetch_events(station_id: str, api_key: str, days: int = 7, session=None) -> list[dict]:
    if not station_id or not api_key:
        raise RuntimeError("ADMIRALTY station or key not configured")
    s = session or http_session()
    r = s.get(f"{BASE}/Stations/{station_id}/TidalEvents",
              params={"duration": max(1, min(7, days))},
              headers={"Ocp-Apim-Subscription-Key": api_key}, timeout=20)
    r.raise_for_status()
    events = []
    for e in r.json():
        typ = {"HighWater": "HIGH", "LowWater": "LOW"}.get(e.get("EventType"))
        if not typ or not e.get("DateTime"):
            continue
        events.append({"ts": int(_parse_dt(e["DateTime"]).timestamp()), "type": typ,
                       "height_m": e.get("Height")})
    if not events:
        raise RuntimeError("ADMIRALTY returned no events")
    return sorted(events, key=lambda x: x["ts"])


def list_stations(api_key: str, session=None) -> list[dict]:
    s = session or http_session()
    r = s.get(f"{BASE}/Stations", headers={"Ocp-Apim-Subscription-Key": api_key}, timeout=30)
    r.raise_for_status()
    out = []
    for f in r.json().get("features", []):
        p = f.get("properties", {})
        lon, lat = (f.get("geometry") or {}).get("coordinates", [None, None])[:2]
        out.append({"id": p.get("Id"), "name": p.get("Name"), "lat": lat, "lon": lon})
    return out
