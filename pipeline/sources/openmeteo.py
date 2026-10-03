"""Open-Meteo (keyless). Used every run for sea temperature and air temperature,
and as the full fallback for surf/wind/tide when Surfline fails.

Verified against https://open-meteo.com/en/docs/marine-weather-api (Sep 2026):
hourly swell_wave_*, secondary_swell_wave_*, wave_height, sea_surface_temperature,
sea_level_height_msl; swell_wave_peak_period confirmed working by the calibration run; `timeformat=unixtime`; `cell_selection=sea`.
Attribution required when shown: "Weather data by Open-Meteo.com".
"""
from __future__ import annotations

from ..util import http_session

MARINE = "https://marine-api.open-meteo.com/v1/marine"
WEATHER = "https://api.open-meteo.com/v1/forecast"


def _get(session, url, params):
    r = session.get(url, params=params, timeout=20)
    r.raise_for_status()
    j = r.json()
    if j.get("error"):
        raise RuntimeError(j.get("reason"))
    return j


def _series(j: dict, block: str = "hourly") -> list[dict]:
    h = j.get(block) or {}
    times = h.get("time") or []
    out = []
    for i, t in enumerate(times):
        row = {"ts": int(t)}
        for k, v in h.items():
            if k != "time":
                row[k] = v[i] if i < len(v) else None
        out.append(row)
    return out


MARINE_VARS = [
    "wave_height", "wave_period",
    "swell_wave_height", "swell_wave_period", "swell_wave_direction",
    "secondary_swell_wave_height", "secondary_swell_wave_period",
    "secondary_swell_wave_direction",
    "sea_surface_temperature", "sea_level_height_msl",
]
# Peak period is what Surfline shows and what the per-spot height formulas were
# fitted with. Confirmed available on this endpoint by the Sep 2026 calibration run
# (it came back for Jan 2025 - Sep 2026). If a request with it ever fails, we retry
# without it and fall back to the mean period.
PEAK_VARS = ["swell_wave_peak_period", "wave_peak_period"]


def fetch_marine(lat: float, lon: float, days: int, session=None) -> list[dict]:
    s = session or http_session()
    params = {"latitude": lat, "longitude": lon, "timeformat": "unixtime",
              "forecast_days": min(days, 7), "cell_selection": "sea"}
    try:
        j = _get(s, MARINE, {**params, "hourly": ",".join(MARINE_VARS + PEAK_VARS)})
    except Exception:  # noqa: BLE001 - most likely the peak variables; retry without them
        j = _get(s, MARINE, {**params, "hourly": ",".join(MARINE_VARS)})
    return _series(j)


def fetch_weather(lat: float, lon: float, days: int, wind_unit: str, session=None) -> list[dict]:
    s = session or http_session()
    unit = {"mph": "mph", "kph": "kmh", "kts": "kn"}[wind_unit]
    j = _get(s, WEATHER, {
        "latitude": lat, "longitude": lon, "timeformat": "unixtime",
        "forecast_days": 7, "wind_speed_unit": unit,   # weather always 7 days (for the outlook)
        "hourly": "temperature_2m,apparent_temperature,wind_speed_10m,"
                  "wind_gusts_10m,wind_direction_10m,weather_code,"
                  "precipitation_probability,precipitation,uv_index",
    })
    return _series(j)


def surf_model(spot: dict | None) -> dict | None:
    """Per-spot height formula from settings ([spots.<key>.surf_model]), or None.
    Coefficients come from  python -m pipeline.calibrate <spot>."""
    m = (spot or {}).get("surf_model")
    if not m or m.get("a") is None or m.get("b") is None:
        return None
    return {"a": float(m["a"]), "b": float(m["b"]), "c": float(m.get("c", 0.0)),
            "facing": float(spot.get("facing_deg", 0.0)),
            "min_ratio": float(m.get("min_ratio", MIN_RATIO))}


MIN_RATIO = 0.65  # bottom of the range / top; Surfline's Saunton bands average 0.65


def angle_off(dir_from: float | None, facing: float) -> float | None:
    """Signed degrees from the beach's facing (-180..180); + = from north of facing."""
    if dir_from is None:
        return None
    return (dir_from - facing + 540) % 360 - 180


def estimate_surf_m(hs: float | None, period: float | None, dir_deg: float | None = None,
                    model: dict | None = None) -> tuple[float, float] | None:
    """Breaking-surf range (min, max) in metres from offshore swell.

    With a per-spot `model` (see surf_model):
        top = hs x (a + b x period + c x |swell direction - facing| / 90)
    fitted against Surfline's daily ranges, using the PEAK period. An unknown
    direction counts as straight in, as in the calibration.
    Without one: the old generic guess (longer periods shoal more)."""
    if hs is None:
        return None
    t = period or 8
    if model:
        off = angle_off(dir_deg, model["facing"]) or 0.0
        k = max(0.0, model["a"] + model["b"] * t + model["c"] * abs(off) / 90)
        ratio = model["min_ratio"]
    else:
        k = max(0.9, min(1.6, 0.5 + 0.06 * t))
        ratio = MIN_RATIO
    hi = hs * k
    return (round(hi * ratio, 2), round(hi, 2))


def human_relation(max_m: float | None) -> str | None:
    if max_m is None:
        return None
    ft = max_m * 3.28084
    bands = [(1, "Flat"), (2, "Ankle to knee"), (3, "Knee to thigh"), (4, "Thigh to waist"),
             (5, "Waist to chest"), (6, "Chest to head"), (7, "Head high"),
             (9, "Overhead"), (99, "Well overhead")]
    return next(label for lim, label in bands if ft < lim)


def to_points(marine: list[dict], weather: list[dict], model: dict | None = None) -> list[dict]:
    """Hourly points in the same shape as Surfline's. `model` = surf_model(spot)."""
    wx = {w["ts"]: w for w in weather}
    points = []
    for m in marine:
        # Same choice as calibrate.py: swell if present, else total sea; peak period if present.
        if m.get("swell_wave_height") is not None:
            hs, per = m["swell_wave_height"], m.get("swell_wave_peak_period") or m.get("swell_wave_period")
        else:
            hs, per = m.get("wave_height"), m.get("wave_peak_period") or m.get("wave_period")
        est = estimate_surf_m(hs, per, m.get("swell_wave_direction"), model)
        swells = []
        if m.get("swell_wave_height"):
            swells.append({"height_m": m["swell_wave_height"],
                           "period_s": m.get("swell_wave_peak_period") or m.get("swell_wave_period"),
                           "dir_deg": m.get("swell_wave_direction")})
        if m.get("secondary_swell_wave_height"):
            swells.append({"height_m": m["secondary_swell_wave_height"],
                           "period_s": m.get("secondary_swell_wave_period"),
                           "dir_deg": m.get("secondary_swell_wave_direction")})
        w = wx.get(m["ts"], {})
        points.append({
            "ts": m["ts"],
            "surf_min_m": est[0] if est else None,
            "surf_max_m": est[1] if est else None,
            "human": human_relation(est[1] if est else None),
            "swells": swells,
            "wind_speed": w.get("wind_speed_10m"),
            "wind_gust": w.get("wind_gusts_10m"),
            "wind_dir": w.get("wind_direction_10m"),
        })
    return points
