"""Tide helpers: build a smooth curve from HW/LW events (cosine interpolation,
the standard 'rule of twelfths'-like shape), and derive events from a sea-level
series when only Open-Meteo is available."""
from __future__ import annotations

import math

HALF_CYCLE = 6.21 * 3600  # ~ M2 half period


def _pad(events: list[dict], start: float, end: float) -> list[dict]:
    ev = sorted(events, key=lambda e: e["ts"])
    if len(ev) < 2:
        return ev
    while ev[0]["ts"] > start:
        ev.insert(0, {"ts": ev[0]["ts"] - HALF_CYCLE, "type": ev[1]["type"],
                      "height_m": ev[1]["height_m"], "synthetic": True})
    while ev[-1]["ts"] < end:
        ev.append({"ts": ev[-1]["ts"] + HALF_CYCLE, "type": ev[-2]["type"],
                   "height_m": ev[-2]["height_m"], "synthetic": True})
    return ev


def curve(events: list[dict], start: float, end: float, step: int = 900) -> list[dict]:
    ev = _pad(events, start, end)
    if len(ev) < 2 or any(e.get("height_m") is None for e in ev):
        return []
    out, i = [], 0
    t = start
    while t <= end:
        while i < len(ev) - 2 and ev[i + 1]["ts"] < t:
            i += 1
        a, b = ev[i], ev[i + 1]
        frac = 0 if b["ts"] == a["ts"] else (t - a["ts"]) / (b["ts"] - a["ts"])
        frac = min(1, max(0, frac))
        h = a["height_m"] + (b["height_m"] - a["height_m"]) * (1 - math.cos(math.pi * frac)) / 2
        out.append({"ts": int(t), "h": round(h, 2)})
        t += step
    return out


def height_at(events: list[dict], ts: float) -> float | None:
    c = curve(events, ts, ts, 60)
    return c[0]["h"] if c else None


def rising(events: list[dict], ts: float) -> bool | None:
    nxt = next((e for e in sorted(events, key=lambda e: e["ts"]) if e["ts"] > ts), None)
    return None if nxt is None else nxt["type"] == "HIGH"


def events_from_series(series: list[dict], key: str = "sea_level_height_msl") -> list[dict]:
    pts = [(p["ts"], p.get(key)) for p in series if p.get(key) is not None]
    ev = []
    for (t0, h0), (t1, h1), (t2, h2) in zip(pts, pts[1:], pts[2:]):
        if h1 >= h0 and h1 > h2:
            ev.append({"ts": t1, "type": "HIGH", "height_m": round(h1, 2)})
        elif h1 <= h0 and h1 < h2:
            ev.append({"ts": t1, "type": "LOW", "height_m": round(h1, 2)})
    return ev
