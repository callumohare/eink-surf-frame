"""Session scoring, best windows and daily outlook.

Surfline's own rating is used when present. Otherwise a simple heuristic score
(0-5) tuned for an upper-intermediate on a 6'6"-6'10":
size (sweet spot ~0.6-1.8 m), swell period, and wind relative to the beach.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

RATING_LABELS = [(0.25, "Flat"), (0.75, "Very poor"), (1.4, "Poor"), (2.1, "Poor–fair"),
                 (2.9, "Fair"), (3.6, "Fair–good"), (4.25, "Good"), (4.7, "Very good"),
                 (9, "Epic")]

WIND_FACTOR = {"offshore": 1.0, "glassy": 1.0, "cross-off": 0.85, "cross": 0.6,
               "cross-on": 0.4, "onshore": 0.25}


def label_for(score: float | None) -> str:
    if score is None:
        return "–"
    return next(lbl for lim, lbl in RATING_LABELS if score < lim)


def heuristic_score(p: dict, wind_unit: str) -> float:
    hi = p.get("surf_max_m") or 0
    if hi < 0.25:
        return 0.0
    if hi < 0.6:
        size_f = (hi - 0.25) / 0.35 * 0.7
    elif hi <= 1.8:
        size_f = 1.0
    else:
        size_f = max(0.3, 1.0 - (hi - 1.8) * 0.4)
    per = (p.get("swells") or [{}])[0].get("period_s") or 8
    period_f = max(0.4, min(1.0, 0.4 + (per - 6) * 0.1))
    speed = p.get("wind_speed") or 0
    mph = speed * {"mph": 1, "kph": 0.621, "kts": 1.151}[wind_unit]
    wf = WIND_FACTOR.get(p.get("wind_type") or "cross", 0.6)
    if mph < 5:
        wf = max(wf, 0.9)  # glassy-ish whatever the direction
    elif mph > 15 and p.get("wind_type") not in ("offshore",):
        wf *= 0.7
    # 4.6 ceiling: the heuristic can't see sandbanks/crowds, so it never calls "Epic"
    return round(4.6 * size_f * period_f * (0.35 + 0.65 * wf), 2)


def best_windows(points: list[dict], start_ts: float, end_ts: float, zone: ZoneInfo,
                 max_windows: int = 2) -> list[dict]:
    """Contiguous daylight periods scoring near the day's best."""
    pts = [p for p in points if start_ts <= p["ts"] <= end_ts and p.get("score") is not None]
    if not pts:
        return []
    top = max(p["score"] for p in pts)
    if top < 1.0:
        return []
    cut = max(1.0, top - 0.6)
    windows, cur = [], None
    step = min((b["ts"] - a["ts"] for a, b in zip(pts, pts[1:])), default=3600)
    for p in pts:
        if p["score"] >= cut:
            if cur and p["ts"] - cur["end"] <= step:
                cur["end"] = p["ts"]
                cur["scores"].append(p["score"])
            else:
                cur = {"start": p["ts"], "end": p["ts"], "scores": [p["score"]]}
                windows.append(cur)
        else:
            cur = None
    out = []
    for w in sorted(windows, key=lambda w: -max(w["scores"]))[:max_windows]:
        end = min(w["end"] + step, end_ts)
        sc = round(sum(w["scores"]) / len(w["scores"]), 2)
        out.append({"start": datetime.fromtimestamp(w["start"], zone).strftime("%H:%M"),
                    "end": datetime.fromtimestamp(end, zone).strftime("%H:%M"),
                    "start_ts": w["start"], "score": sc, "label": label_for(sc)})
    return sorted(out, key=lambda w: w["start_ts"])


def daily_outlook(points: list[dict], sun_by_date: dict, zone: ZoneInfo, days: int) -> list[dict]:
    by_date: dict = {}
    for p in points:
        d = datetime.fromtimestamp(p["ts"], zone).date()
        by_date.setdefault(d, []).append(p)
    out = []
    for d in sorted(by_date)[:days]:
        sun = sun_by_date.get(d)
        pts = by_date[d]
        if sun:
            day_pts = [p for p in pts if sun["first_light"].timestamp() <= p["ts"] <= sun["last_light"].timestamp()]
            pts = day_pts or pts

        def part(lo, hi):
            sel = [p for p in pts if lo <= datetime.fromtimestamp(p["ts"], zone).hour < hi]
            if not sel:
                return None
            best = max(sel, key=lambda p: p.get("score") or 0)
            return {"score": best.get("score"), "label": label_for(best.get("score")),
                    "wind_speed": best.get("wind_speed"), "wind_dir": best.get("wind_dir"),
                    "wind_type": best.get("wind_type")}

        mins = [p["surf_min_m"] for p in pts if p.get("surf_min_m") is not None]
        maxs = [p["surf_max_m"] for p in pts if p.get("surf_max_m") is not None]
        scores = [p["score"] for p in pts if p.get("score") is not None]
        out.append({
            "date": d.isoformat(),
            "dow": d.strftime("%a"),
            "day": d.day,
            "surf_min_m": round(min(mins), 1) if mins else None,
            "surf_max_m": round(max(maxs), 1) if maxs else None,
            "score": max(scores) if scores else None,
            "label": label_for(max(scores) if scores else None),
            "am": part(5, 12), "pm": part(12, 21),
            "first_light": sun["first_light"].strftime("%H:%M") if sun else None,
            "last_light": sun["last_light"].strftime("%H:%M") if sun else None,
            # every point for this day is an Open-Meteo estimate (past Surfline's range)
            "est": all(p.get("est") for p in pts),
        })
    return out


def midnight(d, zone: ZoneInfo) -> float:
    return datetime(d.year, d.month, d.day, tzinfo=zone).timestamp()


def next_midnight(d, zone: ZoneInfo) -> float:
    n = d + timedelta(days=1)
    return datetime(n.year, n.month, n.day, tzinfo=zone).timestamp()
