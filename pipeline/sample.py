"""Synthetic but realistic inputs so layouts can be designed offline
(python -m pipeline.main --sample). Shapes match what gather() returns."""
from __future__ import annotations

import math
from datetime import datetime, timedelta

from .scoring import midnight


def sample_raws(settings: dict, now: datetime) -> dict:
    zone = now.tzinfo
    start = midnight(now.date(), zone)
    raws = {}
    for i, key in enumerate(settings["spots"]):
        pts, marine, weather = [], [], []
        for h in range(0, 7 * 24):
            ts = int(start + h * 3600)
            swell = 1.1 + 0.5 * math.sin(h / 18 + i) + 0.15 * math.sin(h / 3)
            per = 11 + 2 * math.sin(h / 30 + i)
            wind = 6 + 8 * (0.5 + 0.5 * math.sin((h - 14) / 24 * 2 * math.pi))
            wdir = (80 + h * 2.2 + i * 40) % 360
            wt = ["offshore", "cross-off", "cross", "cross-on", "onshore"][int((h / 12 + i) % 5)]
            pts.append({"ts": ts, "surf_min_m": round(swell * 0.7, 2), "surf_max_m": round(swell, 2),
                        "human": "Waist to chest" if swell > 0.9 else "Thigh to waist",
                        "swells": [{"height_m": round(swell * 0.9, 2), "period_s": round(per), "dir_deg": 265 + i * 10},
                                   {"height_m": 0.4, "period_s": 7, "dir_deg": 300}],
                        "wind_speed": wind, "wind_gust": wind * 1.4, "wind_dir": wdir, "wind_type": wt})
            marine.append({"ts": ts, "sea_surface_temperature": 16.1 - i * 0.4})
            codes = [0, 1, 2, 3, 61, 80, 2, 1, 51, 3, 95, 45]
            weather.append({"ts": ts, "temperature_2m": round(14.0 + 4 * math.sin((h - 9) / 24 * 2 * math.pi) + i * 0.5, 1),
                            "apparent_temperature": round(12.5 + 4 * math.sin((h - 9) / 24 * 2 * math.pi), 1),
                            "weather_code": codes[(h // 9 + i) % len(codes)],
                            "precipitation_probability": (h * 7 + i * 13) % 90,
                            "precipitation": 0.4 if codes[(h // 9 + i) % len(codes)] in (61, 80, 51, 95) else 0.0,
                            "uv_index": max(0.0, round(4 * math.sin((h % 24 - 6) / 13 * math.pi), 1))})
        ev, t, high = [], start - 2 * 3600 + i * 3000, True
        while t < start + 7 * 86400:
            ev.append({"ts": int(t), "type": "HIGH" if high else "LOW",
                       "height_m": (7.6 if high else 1.4) if i == 0 else (8.9 if high else 1.6)})
            t += 6.21 * 3600
            high = not high
        # Like the real run: Surfline covers 5 days, Open-Meteo estimates the rest (outlook only).
        cut = int(start + settings["forecast"]["days"] * 86400)
        extra = [dict(p, est=True, wind_type=None) for p in pts if p["ts"] >= cut]
        pts = [p for p in pts if p["ts"] < cut]
        raws[key] = {"warnings": [], "source": "sample", "points": pts, "extra_points": extra, "marine": marine,
                     "weather": weather, "tide_events": ev, "tide_source": "admiralty"}
    return raws


def sample_bookings(now: datetime) -> list[dict]:
    d1 = (now + timedelta(days=3)).date().isoformat()
    d2 = (now + timedelta(days=10)).date().isoformat()
    return [{"date": d1, "start": "08:00", "end": "09:00", "setting": "Advanced Plus"},
            {"date": d2, "start": "17:00", "end": "18:00", "setting": "Advanced"}]


def sample_home_weather(now: datetime) -> list[dict]:
    """Inland-ish weather for the [home] location: warmer days, cooler nights, drier."""
    start = midnight(now.date(), now.tzinfo)
    codes = [1, 2, 3, 2, 0, 80, 3, 1, 2, 61, 3, 0]
    rows = []
    for h in range(0, 7 * 24):
        c = codes[(h // 8 + 3) % len(codes)]
        rows.append({"ts": int(start + h * 3600),
                     "temperature_2m": round(15.5 + 5.5 * math.sin((h - 9) / 24 * 2 * math.pi), 1),
                     "apparent_temperature": round(14.5 + 5.5 * math.sin((h - 9) / 24 * 2 * math.pi), 1),
                     "weather_code": c, "precipitation_probability": (h * 5 + 7) % 70,
                     "precipitation": 0.3 if c in (61, 80) else 0.0,
                     "uv_index": max(0.0, round(4.5 * math.sin((h % 24 - 6) / 13 * math.pi), 1))})
    return rows
