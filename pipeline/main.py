"""Pipeline entry point: fetch -> build data.json -> render every layout -> store.

Frames: the main frame's files sit at the bucket root; friend frames (listed in
state/frames.json by an admin in the studio) each get their own copy of the data under
frames/<id>/ — without The Wave bookings, and with their own home-town weather — and
their own layouts and renders there. See frames.py.

    python -m pipeline.main --storage local --out out            # live data, local folder
    python -m pipeline.main --storage local --out out --sample   # synthetic data, no network
    python -m pipeline.main --storage r2                         # what GitHub Actions runs
"""
from __future__ import annotations

import math

import argparse
import json
import logging
import os
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

from . import extras, flights, frames as fr, gear, scoring, tides, wavemap
from .sources import admiralty, openmeteo, surfline
from .sources.sun import sun_times
from .storage import make_storage
from .util import (ROOT, compass, hhmm, http_session, load_rules, load_settings,
                   tz, wind_type_from_facing)

log = logging.getLogger("surf")
TIDE_DAYS = 3  # days of tide curve in data.json: the tide chart shows up to 72 hours


# ============================================================================ gather
def gather_home(settings: dict, session, home: dict | None = None) -> tuple[list[dict], list[str]]:
    """Weather rows for a home location: [home] in settings unless another
    {name, lat, lon} is given (a frame's own home town). Optional; never raises."""
    home = home if home is not None else settings.get("home")
    if not home:
        return [], []
    try:
        return openmeteo.fetch_weather(home["lat"], home["lon"], settings["forecast"]["days"],
                                       settings["units"]["wind"], session), []
    except Exception as e:  # noqa: BLE001
        return [], [f"Home weather (Open-Meteo): {e}"]


def home_block(home: dict | None, rows: list[dict], spots: dict, now: datetime, zone) -> dict | None:
    """The data.json "home" entry for the weather widgets' Home location."""
    if not home or not rows:
        return None
    local = now.astimezone(zone)
    first = next(iter(spots.values()), None)
    day = (datetime.fromisoformat(first["session_day"]["date"]).date() if first else local.date())
    return {"name": home.get("name", "Home"),
            "session_day": first["session_day"] if first else {"date": day.isoformat(), "label": "Today"},
            "weather": extras.weather_block(rows, now.timestamp(), zone, day)}


def gather(spot_key: str, spot: dict, settings: dict, session) -> dict:
    """Fetch raw inputs for one spot. Never raises: failures become warnings."""
    fc, units = settings["forecast"], settings["units"]
    raw = {"warnings": [], "source": None, "points": [], "extra_points": [], "marine": [], "weather": [],
           "tide_events": [], "tide_source": None}
    # Open-Meteo marine covers the whole outlook (up to 7 days), so days past Surfline's
    # range can still be estimated for the multi-day outlook.
    om_days = max(fc["days"], fc.get("outlook_days", fc["days"]))
    model = openmeteo.surf_model(spot)  # per-spot height formula, None = generic guess
    try:
        raw["marine"] = openmeteo.fetch_marine(spot["lat"], spot["lon"], om_days, session)
        raw["weather"] = openmeteo.fetch_weather(spot["lat"], spot["lon"], fc["days"], units["wind"], session)
    except Exception as e:  # noqa: BLE001
        raw["warnings"].append(f"Open-Meteo: {e}")
        log.warning("[%s] Open-Meteo failed: %s", spot_key, e)

    use_surfline = bool((settings.get("sources") or {}).get("surfline", False)) and spot.get("surfline_id")
    try:
        if not use_surfline:
            raise LookupError("off in settings")
        sl = surfline.fetch(spot["surfline_id"], fc["days"], fc["interval_hours"], units["wind"], session)
        raw["points"], raw["source"] = sl["points"], "surfline"
        last = max((p["ts"] for p in raw["points"] if p.get("ts") is not None), default=None)
        if last is not None and raw["marine"]:
            # Outlook-only: estimated days after Surfline's last forecast hour.
            raw["extra_points"] = [dict(p, est=True) for p in openmeteo.to_points(raw["marine"], raw["weather"], model)
                                   if p["ts"] > last]
    except Exception as e:  # noqa: BLE001
        if use_surfline:
            raw["warnings"].append(f"Surfline: {e}")
            log.warning("[%s] Surfline failed, using Open-Meteo: %s", spot_key, e)
        if raw["marine"]:
            raw["points"], raw["source"] = openmeteo.to_points(raw["marine"], raw["weather"], model), "open-meteo"

    key = os.environ.get("ADMIRALTY_KEY", "")
    try:
        raw["tide_events"] = admiralty.fetch_events(spot.get("admiralty_station", ""), key, 7, session)
        raw["tide_source"] = "admiralty"
    except Exception as e:  # noqa: BLE001
        if spot.get("admiralty_station") and key:
            raw["warnings"].append(f"ADMIRALTY: {e}")
        try:
            if not use_surfline:
                raise LookupError("off in settings")
            raw["tide_events"] = surfline.fetch_tides(spot["surfline_id"], min(fc["days"], 6), session)
            raw["tide_source"] = "surfline"
        except Exception as e2:  # noqa: BLE001
            raw["tide_events"] = tides.events_from_series(raw["marine"])
            raw["tide_source"] = "open-meteo" if raw["tide_events"] else None
            log.info("[%s] tides fallback: %s", spot_key, e2)
    return raw


# ============================================================================= build
def _nearest(rows: list[dict], ts: float) -> dict | None:
    return min(rows, key=lambda r: abs(r["ts"] - ts)) if rows else None


def _slim(p: dict, zone) -> dict:
    sw = (p.get("swells") or [{}])[0]
    return {
        "ts": p["ts"], "t": hhmm(p["ts"], zone),
        "min": round(p["surf_min_m"], 2) if p.get("surf_min_m") is not None else None,
        "max": round(p["surf_max_m"], 2) if p.get("surf_max_m") is not None else None,
        "score": p.get("score"),
        "ws": round(p["wind_speed"]) if p.get("wind_speed") is not None else None,
        "wg": round(p["wind_gust"]) if p.get("wind_gust") is not None else None,
        "wd": p.get("wind_dir"), "wt": p.get("wind_type"),
        "per": sw.get("period_s"),
    }


def wind_hours(points: list[dict], zone, day) -> list[dict]:
    """Wind at the session day's 06-21h slots (the same hours as the weather strip)."""
    out, seen = [], set()
    for p in points:
        d = datetime.fromtimestamp(p["ts"], zone)
        if d.date() != day or d.minute or d.hour not in (6, 9, 12, 15, 18, 21) or d.hour in seen:
            continue
        seen.add(d.hour)
        out.append({"t": d.strftime("%H:%M"),
                    "ws": round(p["wind_speed"]) if p.get("wind_speed") is not None else None,
                    "wg": round(p["wind_gust"]) if p.get("wind_gust") is not None else None,
                    "wd": p.get("wind_dir"), "wt": p.get("wind_type")})
    return out


def tide_scale(ev: list[dict], tide_max_m, datum: str) -> dict:
    """Fixed y-axis for tide charts, so a neap day looks small next to a spring day
    instead of every day's curve being stretched to fill the box."""
    hs = [e["height_m"] for e in ev if e.get("height_m") is not None]
    cfg = float(tide_max_m) if tide_max_m else 0.0
    if datum == "MSL":  # Open-Meteo fallback: heights either side of mean sea level
        amp = max([abs(h) for h in hs] + [cfg / 2, 1.0])
        amp = math.ceil(amp * 2) / 2
        return {"min": -amp, "max": amp}
    lo = min([0.0] + hs)
    hi = max([cfg, 1.0] + hs)
    return {"min": math.floor(lo * 2) / 2, "max": math.ceil(hi * 2) / 2}


def build_spot(spot_key: str, spot: dict, raw: dict, settings: dict, rules: dict,
               now: datetime) -> dict:
    zone = tz(settings)
    units = settings["units"]
    now_ts = now.timestamp()
    today = now.astimezone(zone).date()
    points = [p for p in raw["points"] if p.get("ts") is not None]

    # wind type + score for every point
    for p in points:
        if not p.get("wind_type") and p.get("wind_dir") is not None:
            p["wind_type"] = wind_type_from_facing(p["wind_dir"], spot["facing_deg"])
        if p.get("score") is None:
            p["score"] = scoring.heuristic_score(p, units["wind"])

    extra = [p for p in raw.get("extra_points", []) if p.get("ts") is not None]
    for p in extra:
        if not p.get("wind_type") and p.get("wind_dir") is not None:
            p["wind_type"] = wind_type_from_facing(p["wind_dir"], spot["facing_deg"])
        if p.get("score") is None:
            p["score"] = scoring.heuristic_score(p, units["wind"])

    # sun
    sun_by_date = {today + timedelta(days=i): sun_times(spot["lat"], spot["lon"], today + timedelta(days=i), zone)
                   for i in range(-1, 8)}
    s_today = sun_by_date[today]
    session_day = today if now_ts < s_today["last_light"].timestamp() else today + timedelta(days=1)
    s_sess = sun_by_date[session_day]
    win_start = max(now_ts - 1800, s_sess["first_light"].timestamp())
    win_end = s_sess["last_light"].timestamp()
    sess_pts = [p for p in points if win_start <= p["ts"] <= win_end]
    # Wetsuit and board/fins always describe TODAY's ocean, first light to last light.
    day_start = s_today["first_light"].timestamp()
    day_end = s_today["last_light"].timestamp()
    today_pts = [p for p in points if day_start <= p["ts"] <= day_end]

    now_p = _nearest([p for p in points if p["ts"] <= now_ts + 1800], now_ts) or _nearest(points, now_ts)
    wx_now = _nearest(raw["weather"], now_ts) or {}
    mar_now = _nearest(raw["marine"], now_ts) or {}

    # water + wetsuit (use the session window)
    sst_vals = [m["sea_surface_temperature"] for m in raw["marine"]
                if day_start <= m["ts"] <= day_end and m.get("sea_surface_temperature") is not None]
    water = round(sum(sst_vals) / len(sst_vals), 1) if sst_vals else mar_now.get("sea_surface_temperature")
    feels = [w["apparent_temperature"] for w in raw["weather"]
             if day_start <= w["ts"] <= day_end and w.get("apparent_temperature") is not None]
    winds = [p["wind_speed"] for p in today_pts if p.get("wind_speed") is not None]
    wetsuit = gear.choose_wetsuit(water, min(feels) if feels else None,
                                  max(winds) if winds else None, units["wind"], settings["wetsuit"])

    # quiver
    best_p = max(today_pts, key=lambda p: p.get("score") or 0) if today_pts else now_p
    tops = [p["surf_max_m"] for p in today_pts if p.get("surf_max_m") is not None]
    top = max(tops) if tops else (now_p or {}).get("surf_max_m")
    per = ((best_p or {}).get("swells") or [{}])[0].get("period_s")
    quiver = gear.choose_quiver(rules, spot["rules"], top, per, (best_p or {}).get("wind_type"),
                                settings["quiver"])

    # tides
    ev = raw["tide_events"]
    day0 = scoring.midnight(today, zone)
    day1 = scoring.next_midnight(today, zone)
    # Tide chart can show 24, 48 or 72 hours from midnight today (its "Hours" option), so
    # the curve and events cover three local days; `days` gives each day's exact bounds
    # (a clock-change day is 23 or 25 hours) and its name for the chart's axis.
    tide_days = []
    for i in range(TIDE_DAYS):
        d = today + timedelta(days=i)
        tide_days.append({"start": int(scoring.midnight(d, zone)), "end": int(scoring.next_midnight(d, zone)),
                          "dow": d.strftime("%a").upper()})
    tide_end = tide_days[-1]["end"]
    tide_block = None
    if ev:
        shown = [e for e in ev if day0 <= e["ts"] < tide_end and not e.get("synthetic")]
        tide_block = {
            "source": raw["tide_source"],
            "credit": admiralty.CREDIT if raw["tide_source"] == "admiralty" else None,
            "datum": "MSL" if raw["tide_source"] == "open-meteo" else "CD",
            "events": [{"ts": e["ts"], "t": hhmm(e["ts"], zone), "type": e["type"],
                        "h": round(e["height_m"], 1) if e.get("height_m") is not None else None,
                        "day": next(i for i, dd in enumerate(tide_days) if e["ts"] < dd["end"])}
                       for e in shown],
            "curve": tides.curve(ev, day0, tide_end, 900),
            "days": tide_days,
            "now_h": tides.height_at(ev, now_ts),
            "range_today": (lambda hs: round(max(hs) - min(hs), 1) if len(hs) >= 2 else None)(
                [e["height_m"] for e in ev if day0 <= e["ts"] < day1 and e.get("height_m") is not None]),
            "rising": tides.rising(ev, now_ts),
            "day_start": int(day0), "day_end": int(day1),
        }
        tide_block["scale"] = tide_scale(ev, spot.get("tide_max_m"), tide_block["datum"])

    now_block = None
    if now_p:
        now_block = {
            "ts": now_p["ts"], "t": hhmm(now_p["ts"], zone),
            "surf_min": now_p.get("surf_min_m"), "surf_max": now_p.get("surf_max_m"),
            "human": now_p.get("human"),
            "score": now_p.get("score"), "label": scoring.label_for(now_p.get("score")),
            "swells": [{"h": round(s["height_m"], 1), "per": round(s["period_s"]) if s.get("period_s") else None,
                        "dir": round(s["dir_deg"]) if s.get("dir_deg") is not None else None,
                        "cmp": compass(s.get("dir_deg"))} for s in (now_p.get("swells") or [])],
            "wind": {"speed": round(now_p["wind_speed"]) if now_p.get("wind_speed") is not None else None,
                     "gust": round(now_p["wind_gust"]) if now_p.get("wind_gust") is not None else None,
                     "dir": round(now_p["wind_dir"]) if now_p.get("wind_dir") is not None else None,
                     "cmp": compass(now_p.get("wind_dir")), "type": now_p.get("wind_type")},
            "air": wx_now.get("temperature_2m"), "feels": wx_now.get("apparent_temperature"),
        }

    chart_end = day0 + 3 * 86400
    chart = [_slim(p, zone) for p in points if day0 <= p["ts"] < chart_end]
    daylight = [{"start": int(s["first_light"].timestamp()), "end": int(s["last_light"].timestamp())}
                for d, s in sun_by_date.items() if d < today + timedelta(days=3)]

    return {
        "key": spot_key, "name": spot["name"], "source": raw["source"],
        "warnings": raw["warnings"],
        "now": now_block,
        "session_day": {"date": session_day.isoformat(), "label": "Today" if session_day == today else "Tomorrow"},
        "sun": {k: hhmm(v.timestamp(), zone) for k, v in s_today.items()},
        "sun_tomorrow": {k: hhmm(v.timestamp(), zone) for k, v in sun_by_date[today + timedelta(days=1)].items()},
        "day_length": extras.day_length(s_today, sun_by_date[today - timedelta(days=1)]),
        "weather": extras.weather_block(raw["weather"], now_ts, zone, session_day),
        "wind_hours": wind_hours(points, zone, session_day),
        "water_c": water,
        "wetsuit": wetsuit,
        "quiver": quiver,
        "best_windows": scoring.best_windows(points, win_start, win_end, zone),
        "outlook": scoring.daily_outlook(points + extra, sun_by_date, zone, settings["forecast"]["outlook_days"]),
        "tides": tide_block,
        "chart": {"start": int(day0), "end": int(chart_end), "points": chart, "daylight": daylight},
    }


def build_bookings(settings: dict, rules: dict, today) -> tuple[list[dict], list[str]]:
    from . import bookings as bk
    cfg = settings["bookings"]
    user, pw = os.environ.get("GMAIL_USER"), os.environ.get("GMAIL_APP_PASSWORD")
    if not cfg.get("enabled") or not user or not pw:
        return [], []
    try:
        found, warns = bk.fetch_bookings(user, pw, cfg, today)
    except Exception as e:  # noqa: BLE001
        log.warning("bookings failed: %s", type(e).__name__)  # don't log IMAP details/credentials
        return [], [f"Bookings: {type(e).__name__}"]
    return decorate_bookings(found, settings, rules), warns


def decorate_bookings(found: list[dict], settings: dict, rules: dict) -> list[dict]:
    out = []
    for b in found:
        d = datetime.fromisoformat(b["date"])
        out.append({**{k: b[k] for k in ("date", "start", "end", "setting")},
                    "dow": d.strftime("%a"), "day": d.day, "mon": d.strftime("%b")})
    return out


def build_data(settings: dict, rules: dict, raws: dict, bookings: list[dict],
               extra_warnings: list[str], now: datetime, home_rows: list[dict] | None = None) -> dict:
    zone = tz(settings)
    local = now.astimezone(zone)
    spots = {k: build_spot(k, settings["spots"][k], raws[k], settings, rules, now) for k in raws}
    home = home_block(settings.get("home"), home_rows or [], spots, now, zone)
    credits = set()
    for s in spots.values():
        if s["tides"] and s["tides"]["credit"]:
            credits.add(s["tides"]["credit"])
        if s["source"] == "open-meteo" or s["tides"] and s["tides"]["source"] == "open-meteo":
            credits.add("Weather data by Open-Meteo.com")
    return {
        "schema": 1,
        "generated_ts": int(now.timestamp()),
        "generated": local.strftime("%H:%M"),
        "today": {"iso": local.date().isoformat(), "dow": local.strftime("%A"),
                  "dow3": local.strftime("%a"), "day": local.day, "month": local.strftime("%B"),
                  "mon3": local.strftime("%b"), "year": local.year},
        "units": settings["units"],
        "spots": spots,
        "spot_order": list(settings["spots"].keys()),
        "moon": extras.moon_block(local.date()),
        "home": home,
        "bookings": bookings,
        "credits": sorted(credits),
        "warnings": extra_warnings,
    }


# ============================================================================ layouts
def seed_layouts(store, prefix: str = "", friend: bool = False) -> list[str]:
    """Add starter layouts from the repo. Each starter is added once: ones you've
    deleted in the studio stay deleted, and new starters in future updates still appear.
    Friend frames get copies without the main-frame-only widgets (see frames.py)."""
    ids = [k.split("/")[-1][:-5] for k in store.list(prefix + "layouts/") if k.endswith(".json")]
    seeded = set(json.loads(store.get(prefix + "state/seeded.json") or b"[]"))
    if not seeded:
        seeded = set(ids)  # first run on an existing studio: treat what's there as seeded
    added = []
    for p in sorted((ROOT / "layouts").glob("*.json")):
        if p.stem in seeded or p.stem in ids:
            seeded.add(p.stem)
            continue
        seeded.add(p.stem)
        if friend:
            layout = fr.friend_starter(json.loads(p.read_text(encoding="utf-8")))
            if layout is None:
                continue  # a Wave-booking layout: nothing to show on a friend's frame
            body = json.dumps(layout, indent=2).encode()
        else:
            body = p.read_bytes()
        store.put(f"{prefix}layouts/{p.name}", body, "application/json")
        ids.append(p.stem); added.append(p.stem)
    if added:
        log.info("%sadded starter layouts: %s", prefix, ", ".join(added))
    store.put(prefix + "state/seeded.json", json.dumps(sorted(seeded)).encode(), "application/json")
    if store.get(prefix + "state/selected.json") is None and ids:
        first = "classic" if "classic" in ids else sorted(ids)[0]
        store.put(prefix + "state/selected.json", json.dumps({"layout": first}).encode(), "application/json")
    return ids


def render_all(store, data: dict, settings: dict, only: str | None = None,
               strict: bool = False, frame: dict | None = None, renderer=None) -> tuple[dict, list[str]]:
    """Render every stored layout of one frame (the main frame by default).
    Returns (index, ids that failed). strict=True also treats widget errors as failures
    (used by the CI tests). Pass renderer to reuse one browser across frames."""
    frame = frame or fr.main_frame()
    prefix = frame["prefix"]
    ids = seed_layouts(store, prefix, friend=not frame["main"])
    index = json.loads(store.get(prefix + "renders/index.json") or b"{}")
    failed: list[str] = []
    own = renderer is None
    if own:
        from .render import Renderer
        renderer = Renderer(strict=strict)
    try:
        for lid in ids:
            if only and lid != only:
                continue
            try:
                layout = json.loads(store.get(f"{prefix}layouts/{lid}.json"))
                out = renderer.render(layout, data, settings["render"]["default_threshold"],
                                      shrink=frame["shrink_px"])
            except Exception as e:  # noqa: BLE001
                log.error("%slayout %s failed: %s", prefix, lid, e)
                failed.append(lid)
                continue
            store.put(f"{prefix}renders/{lid}.png", out["png"], "image/png")
            store.put(f"{prefix}renders/{lid}.bmp", out["bmp"], "image/bmp")
            store.put(f"{prefix}renders/{lid}-grey.png", out["grey"], "image/png")
            store.put(f"{prefix}renders/{lid}-thumb.png", out["thumb"], "image/png")
            index[lid] = {"ts": data["generated_ts"], "name": layout.get("name", lid)}
        index = {k: v for k, v in index.items() if k in ids}
        store.put(prefix + "renders/index.json", json.dumps(index).encode(), "application/json")
    finally:
        if own:
            renderer.close()
    return index, failed


# =============================================================================== main
def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--storage", choices=["local", "r2"], default="local")
    ap.add_argument("--out", default="out", help="folder for --storage local")
    ap.add_argument("--sample", action="store_true", help="synthetic data, no network")
    ap.add_argument("--no-render", action="store_true")
    ap.add_argument("--only", help="render just this layout id")
    ap.add_argument("--strict", action="store_true",
                    help="exit non-zero if any layout or widget fails (CI checks)")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    settings, rules = load_settings(), load_rules()
    store = make_storage(a.storage, a.out)
    now = datetime.now(tz(settings))
    t0 = time.time()

    frames = fr.load_frames(store)
    if a.sample:
        from .sample import sample_raws, sample_bookings, sample_home_weather
        raws, bookings, bwarn = sample_raws(settings, now), decorate_bookings(sample_bookings(now), settings, rules), []
        home_rows = sample_home_weather(now) if settings.get("home") else []
        fetch_home = lambda home: (sample_home_weather(now), [])  # noqa: E731
    else:
        session = http_session()
        raws = {k: gather(k, s, settings, session) for k, s in settings["spots"].items()}
        bookings, bwarn = build_bookings(settings, rules, now.date())
        home_rows, hwarn = gather_home(settings, session)
        bwarn = bwarn + hwarn
        fetch_home = lambda home: gather_home(settings, session, home)  # noqa: E731

    data = build_data(settings, rules, raws, bookings, bwarn, now, home_rows)
    # Wave map (NOAA GFS-Wave), shared by every frame; None if unavailable
    data["wave_map"] = wavemap.build(store, settings, now, None if a.sample else session, tz(settings), sample=a.sample)
    for k, s in data["spots"].items():
        log.info("[%s] surf source=%s tides=%s warnings=%s", k, s["source"],
                 (s["tides"] or {}).get("source"), s["warnings"])

    if all(s["source"] is None for s in data["spots"].values()):
        # Keep the last good data and images: the frame keeps showing them and
        # its "Updated" time shows they're stale. A failed run also emails you.
        log.error("no surf data from any source — leaving previous renders in place")
        return 2

    # One copy of the data per frame (friends: no bookings, their own home weather).
    homes: dict = {}
    per_frame = []
    for f in frames:
        home_rows_f, hw = None, []
        if f["home"]:
            key = (f["home"]["lat"], f["home"]["lon"])
            if key not in homes:
                homes[key] = fetch_home(f["home"])
            home_rows_f, hw = homes[key]
        fdata = fr.frame_data(data, f, home_block(f["home"], home_rows_f or [], data["spots"], now, tz(settings))
                              if f["home"] else None, hw)
        # this frame's Flight widgets only (no network in --sample)
        fkeys = flights.collect(store, f["prefix"])
        if fkeys:
            fdata = dict(fdata)
            fdata["flights"] = flights.lookup(fkeys, store, now.date(), None if a.sample else session,
                                              api_key="" if a.sample else None)
        store.put(f["prefix"] + "data/data.json", json.dumps(fdata, separators=(",", ":")).encode(), "application/json")
        per_frame.append((f, fdata))

    if not a.no_render:
        from .render import Renderer
        failed_all: list[str] = []
        r = Renderer(strict=a.strict)
        try:
            for f, fdata in per_frame:
                idx, failed = render_all(store, fdata, settings, a.only, a.strict, frame=f, renderer=r)
                log.info("[%s] rendered %d layouts (edge margin %d px)", f["id"], len(idx) - len(failed), f["shrink_px"])
                failed_all += [f"{f['id']}/{x}" for x in failed]
        finally:
            r.close()
        log.info("rendered %d frame(s) in %.1fs", len(per_frame), time.time() - t0)
        if failed_all and a.strict:
            log.error("layouts failed: %s", ", ".join(failed_all))
            return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
