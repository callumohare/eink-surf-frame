"""Shared helpers: config loading, HTTP session, time and unit conversion."""
from __future__ import annotations

import json
import logging
import math
import tomllib
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

ROOT = Path(__file__).resolve().parent.parent
CONFIG_DIR = ROOT / "config"
log = logging.getLogger("surf")

M_TO_FT = 3.28084
COMPASS16 = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
             "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]


def load_settings() -> dict:
    with open(CONFIG_DIR / "settings.toml", "rb") as f:
        return tomllib.load(f)


def load_rules() -> dict:
    return json.loads((CONFIG_DIR / "board_fin_rules.json").read_text())


def tz(settings: dict) -> ZoneInfo:
    return ZoneInfo(settings.get("timezone", "Europe/London"))


def http_session() -> requests.Session:
    """Session with modest retries and an honest User-Agent. All requests are
    HTTPS with certificate verification left ON."""
    s = requests.Session()
    retry = Retry(total=2, backoff_factor=1.5, status_forcelist=(429, 500, 502, 503, 504),
                  allowed_methods=("GET",))
    s.mount("https://", HTTPAdapter(max_retries=retry))
    s.headers["User-Agent"] = "surf-frame/1.0 (personal e-ink display; low-volume)"
    s.headers["Accept"] = "application/json"
    return s


def compass(deg: float | None) -> str:
    if deg is None or (isinstance(deg, float) and math.isnan(deg)):
        return "–"
    return COMPASS16[int(((deg % 360) + 11.25) // 22.5) % 16]


def wind_to(value: float | None, unit_in: str, unit_out: str) -> float | None:
    """Convert wind speed between KTS/KPH/MPH/MS."""
    if value is None:
        return None
    u_in = unit_in.upper()
    to_ms = {"KTS": 0.514444, "KT": 0.514444, "KPH": 1 / 3.6, "KMH": 1 / 3.6,
             "MPH": 0.44704, "MS": 1.0, "M/S": 1.0}[u_in]
    ms = value * to_ms
    out = {"kts": 1 / 0.514444, "kph": 3.6, "mph": 1 / 0.44704}[unit_out.lower()]
    return ms * out


def height_to_m(value: float | None, unit_in: str) -> float | None:
    if value is None:
        return None
    return value / M_TO_FT if unit_in.upper() in ("FT", "F") else value


def local_iso(ts: float, zone: ZoneInfo) -> str:
    return datetime.fromtimestamp(ts, zone).isoformat(timespec="minutes")


def hhmm(ts: float | None, zone: ZoneInfo) -> str | None:
    if ts is None:
        return None
    return datetime.fromtimestamp(ts, zone).strftime("%H:%M")


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def wind_type_from_facing(wind_from_deg: float, facing_deg: float) -> str:
    """Classify wind relative to a beach that faces `facing_deg` (seaward).
    Wind *from* the sea (same direction the beach faces) is onshore."""
    diff = abs(((wind_from_deg - facing_deg + 180) % 360) - 180)  # 0..180
    if diff < 30:
        return "onshore"
    if diff < 70:
        return "cross-on"
    if diff < 110:
        return "cross"
    if diff < 150:
        return "cross-off"
    return "offshore"


def normalise_wind_type(s: str | None) -> str | None:
    """Surfline returns e.g. 'Offshore', 'Onshore', 'Cross-shore'."""
    if not s:
        return None
    k = s.lower().replace("_", "-").replace(" ", "-")
    if "cross" in k and "off" in k:
        return "cross-off"
    if "cross" in k and "on" in k.replace("cross", ""):
        return "cross-on"
    if "cross" in k:
        return "cross"
    if "off" in k:
        return "offshore"
    if "on" in k:
        return "onshore"
    if "glass" in k or "calm" in k:
        return "glassy"
    return k
