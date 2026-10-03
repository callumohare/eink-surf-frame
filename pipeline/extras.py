"""Extra data for the non-surf widgets: weather, moon/tide type and day length.

Weather comes from the Open-Meteo forecast rows gather() already fetches.
Moon phase is computed locally (astral). Nothing here makes extra network calls.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from astral import moon

# WMO weather codes (Open-Meteo) -> (icon kind, short label)
_WMO = [
    ({0}, "sun", "Clear"), ({1}, "sun", "Mostly sunny"), ({2}, "partly", "Partly cloudy"),
    ({3}, "cloud", "Overcast"), ({45, 48}, "fog", "Fog"),
    ({51, 53, 55, 56, 57}, "drizzle", "Drizzle"), ({61, 63, 65, 66, 67}, "rain", "Rain"),
    ({71, 73, 75, 77, 85, 86}, "snow", "Snow"), ({80, 81, 82}, "showers", "Showers"),
    ({95, 96, 99}, "thunder", "Thunder"),
]
# Worst-first order, used to pick the headline weather for a whole day
_SEVERITY = ["thunder", "snow", "rain", "showers", "drizzle", "fog", "cloud", "partly", "sun"]


def wmo(code) -> tuple[str, str]:
    if code is None:
        return ("cloud", "–")
    c = int(code)
    for codes, kind, label in _WMO:
        if c in codes:
            return kind, label
    return ("cloud", "Cloudy")


def _r(v, n=0):
    return None if v is None else round(v, n) if n else round(v)


def weather_block(rows: list[dict], now_ts: float, zone: ZoneInfo, hours_day: date) -> dict | None:
    """hours_day: the day whose fixed 06-21h slots the hourly strip shows (today, or
    tomorrow once it's dark), so the strip doesn't depend on when the data was fetched."""
    if not rows:
        return None
    rows = sorted(rows, key=lambda r: r["ts"])
    past = [r for r in rows if r["ts"] <= now_ts + 1800]
    cur = past[-1] if past else rows[0]
    kind, label = wmo(cur.get("weather_code"))
    now = {"temp": _r(cur.get("temperature_2m")), "feels": _r(cur.get("apparent_temperature")),
           "kind": kind, "label": label, "pop": _r(cur.get("precipitation_probability")),
           "uv": _r(cur.get("uv_index"))}

    hours = []
    slots = [r for r in rows if datetime.fromtimestamp(r["ts"], zone).date() == hours_day
             and datetime.fromtimestamp(r["ts"], zone).hour in (6, 9, 12, 15, 18, 21)]
    for r in slots:
        k, _ = wmo(r.get("weather_code"))
        hours.append({"t": datetime.fromtimestamp(r["ts"], zone).strftime("%H:%M"),
                      "temp": _r(r.get("temperature_2m")), "kind": k,
                      "pop": _r(r.get("precipitation_probability"))})

    by_day: dict = {}
    for r in rows:
        d = datetime.fromtimestamp(r["ts"], zone)
        by_day.setdefault(d.date(), []).append((d.hour, r))
    days = []
    for d in sorted(by_day)[:7]:
        rs = [r for _, r in by_day[d]]
        daytime = [r for h, r in by_day[d] if 7 <= h <= 19] or rs
        temps = [r["temperature_2m"] for r in rs if r.get("temperature_2m") is not None]
        kinds = [wmo(r.get("weather_code"))[0] for r in daytime]
        # headline = worst weather that lasts at least 2 daytime hours (one bad hour doesn't spoil a day)
        head = next((k for k in _SEVERITY if kinds.count(k) >= 2), kinds[len(kinds) // 2] if kinds else "cloud")
        pops = [r["precipitation_probability"] for r in rs if r.get("precipitation_probability") is not None]
        rain = [r["precipitation"] for r in rs if r.get("precipitation") is not None]
        uvs = [r["uv_index"] for r in rs if r.get("uv_index") is not None]
        days.append({"date": d.isoformat(), "dow": d.strftime("%a"), "day": d.day,
                     "max": _r(max(temps)) if temps else None, "min": _r(min(temps)) if temps else None,
                     "kind": head, "label": dict((k, l) for _, k, l in _WMO).get(head, ""),
                     "pop": _r(max(pops)) if pops else None,
                     "rain_mm": round(sum(rain), 1) if rain else None,
                     "uv": _r(max(uvs)) if uvs else None})
    return {"now": now, "hours": hours, "today": days[0] if days else None, "days": days}


# --------------------------------------------------------------------------- moon
_PHASES = [(1.0, "New moon", "new"), (6.4, "Waxing crescent", "wax-cres"), (8.4, "First quarter", "first-q"),
           (13.8, "Waxing gibbous", "wax-gib"), (15.8, "Full moon", "full"), (21.1, "Waning gibbous", "wane-gib"),
           (23.1, "Last quarter", "last-q"), (27.7, "Waning crescent", "wane-cres"), (29.6, "New moon", "new")]
SPRING_LAG_DAYS = 1.5   # UK spring tides typically arrive ~1-2 days after new/full moon


def _tide_kind(ph: float) -> str:
    # distance (days) from the lagged new/full moon
    p = (ph - SPRING_LAG_DAYS) % 29.53
    d = min(p, abs(p - 14.77), 29.53 - p)
    return "Spring tides" if d <= 2.5 else "Neap tides" if d >= 5.0 else ""


def moon_block(today: date) -> dict:
    ph = moon.phase(today)  # 0..27.99 (astral's scale)
    ph = ph * 29.53 / 28.0
    name, key = next((n, k) for lim, n, k in _PHASES if ph < lim)
    kind = _tide_kind(ph)
    nxt = None
    for i in range(1, 16):
        k2 = _tide_kind(moon.phase(today + timedelta(days=i)) * 29.53 / 28.0)
        if k2 == "Spring tides" and kind != "Spring tides":
            d = today + timedelta(days=i)
            nxt = {"what": "Springs", "dow": d.strftime("%a"), "day": d.day, "in_days": i}
            break
        if k2 == "Neap tides" and kind == "Spring tides":
            d = today + timedelta(days=i)
            nxt = {"what": "Neaps", "dow": d.strftime("%a"), "day": d.day, "in_days": i}
            break
    # illuminated fraction (0..1), for drawing
    import math
    illum = round((1 - math.cos(2 * math.pi * ph / 29.53)) / 2, 3)
    return {"phase_days": round(ph, 1), "name": name, "key": key, "illum": illum,
            "waxing": ph < 14.77, "tides": kind, "next": nxt}


def day_length(sun_today: dict, sun_yesterday: dict) -> dict:
    def mins(s):
        return (s["sunset"] - s["sunrise"]).total_seconds() / 60
    t, y = mins(sun_today), mins(sun_yesterday)
    return {"minutes": round(t), "hm": f"{int(t // 60)}h {int(round(t % 60)):02d}m",
            "change": round(t - y)}
