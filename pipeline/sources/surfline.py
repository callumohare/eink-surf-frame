"""Surfline (primary) — undocumented public 'kbyg' endpoints.

UNVERIFIED AGAINST CURRENT DOCS (there are none): the endpoint paths, the
`associated.units` object and the field names below come from community
reverse-engineering (e.g. github.com/swrobel/meta-surf-forecast and the
surflinef Go package) and have been stable for years, but Surfline can change
or block them at any time. Every field is read defensively; any exception
makes the caller fall back to Open-Meteo.

Terms: personal use, one request per endpoint per spot per run, results are
kept in a private bucket and never republished.
"""
from __future__ import annotations

import logging

from ..util import height_to_m, http_session, normalise_wind_type, wind_to

log = logging.getLogger("surf.surfline")
BASE = "https://services.surfline.com/kbyg/spots/forecasts"

RATING_SCORE = {  # Surfline rating key -> 0..5 score used across the display
    "FLAT": 0.0, "VERY_POOR": 0.5, "POOR": 1.0, "POOR_TO_FAIR": 1.75,
    "FAIR": 2.5, "FAIR_TO_GOOD": 3.25, "GOOD": 4.0, "VERY_GOOD": 4.5,
    "GOOD_TO_EPIC": 4.75, "EPIC": 5.0,
}


class SurflineError(RuntimeError):
    pass


def _get(session, kind: str, spot_id: str, days: int, interval: int) -> dict:
    params = {"spotId": spot_id, "days": days, "intervalHours": interval}
    if kind == "wave":
        params["maxHeights"] = "false"
    r = session.get(f"{BASE}/{kind}", params=params, timeout=20)
    if r.status_code != 200:
        raise SurflineError(f"{kind}: HTTP {r.status_code}")
    try:
        j = r.json()
    except ValueError as e:
        raise SurflineError(f"{kind}: non-JSON response (blocked?)") from e
    if not isinstance(j, dict) or "data" not in j:
        raise SurflineError(f"{kind}: unexpected shape")
    return j


def fetch(spot_id: str, days: int, interval: int, wind_unit: str, session=None) -> dict:
    """Return {'points': [...], 'source': 'surfline'} with heights in metres,
    wind in `wind_unit`. Raises SurflineError on any failure."""
    s = session or http_session()
    wave = _get(s, "wave", spot_id, days, interval)
    wind = _get(s, "wind", spot_id, days, interval)
    try:
        rating = _get(s, "rating", spot_id, days, interval)
    except SurflineError as e:  # rating is a nice-to-have
        log.warning("rating unavailable: %s", e)
        rating = {"data": {"rating": []}}

    wu = (wave.get("associated") or {}).get("units") or {}
    wave_unit = wu.get("waveHeight", "FT")
    swell_unit = wu.get("swellHeight", wave_unit)
    wind_unit_in = ((wind.get("associated") or {}).get("units") or {}).get("windSpeed", "KTS")

    points: dict[int, dict] = {}
    for w in wave["data"].get("wave") or []:
        ts = int(w["timestamp"])
        surf = w.get("surf") or {}
        swells = []
        for sw in w.get("swells") or []:
            h = height_to_m(sw.get("height"), swell_unit)
            if h and h > 0.05:
                swells.append({"height_m": round(h, 2), "period_s": sw.get("period"),
                               "dir_deg": sw.get("direction")})
        swells.sort(key=lambda x: (x["height_m"] or 0) * (x["period_s"] or 0), reverse=True)
        points[ts] = {
            "ts": ts,
            "surf_min_m": height_to_m(surf.get("min"), wave_unit),
            "surf_max_m": height_to_m(surf.get("max"), wave_unit),
            "human": surf.get("humanRelation"),
            "swells": swells[:3],
        }
    if not points:
        raise SurflineError("wave: no data points")

    for w in wind["data"].get("wind") or []:
        p = points.get(int(w["timestamp"]))
        if p is None:
            continue
        p["wind_speed"] = wind_to(w.get("speed"), wind_unit_in, wind_unit)
        p["wind_gust"] = wind_to(w.get("gust"), wind_unit_in, wind_unit)
        p["wind_dir"] = w.get("direction")
        p["wind_type"] = normalise_wind_type(w.get("directionType"))

    for r in rating["data"].get("rating") or []:
        p = points.get(int(r["timestamp"]))
        key = ((r.get("rating") or {}).get("key") or "").upper()
        if p is not None and key in RATING_SCORE:
            p["rating_key"] = key
            p["score"] = RATING_SCORE[key]

    return {"points": [points[k] for k in sorted(points)], "source": "surfline"}


def fetch_tides(spot_id: str, days: int, session=None) -> list[dict]:
    """Fallback tide source: HIGH/LOW events from Surfline, heights in metres."""
    s = session or http_session()
    j = _get(s, "tides", spot_id, days, 1)
    unit = ((j.get("associated") or {}).get("units") or {}).get("tideHeight", "M")
    events = []
    for t in j["data"].get("tides") or []:
        typ = (t.get("type") or "").upper()
        if typ in ("HIGH", "LOW"):
            events.append({"ts": int(t["timestamp"]), "type": typ,
                           "height_m": height_to_m(t.get("height"), unit)})
    if not events:
        raise SurflineError("tides: no events")
    return events
