"""Compare Open-Meteo's past swell with Surfline's surf heights for the same days,
and fit a per-spot height formula from them.

Usage (from the surf-frame folder):
    python -m pipeline.calibrate saunton            # every calibration/saunton-*.csv
    python -m pipeline.calibrate rest_bay
    python -m pipeline.calibrate calibration/saunton-2026-09.csv   # one file

The CSVs hold Surfline's daily ranges copied from its forecast history, one row per day:
    date,min_ft,max_ft,plus          e.g.  2026-09-04,3,4,1   ("3-4ft+")
Lines starting with # are notes. The spot is the part of the file name before the
first "-" (saunton-2026-09.csv -> saunton); all files in one run must be the same spot.

What it does:
  1. Fetches Open-Meteo marine hourly data for the dates in the files (one request per
     run of consecutive dates). Uses the PEAK swell period when Open-Meteo provides it
     (that's what Surfline shows); otherwise the mean period, and says so.
     UNVERIFIED: the variable name swell_wave_peak_period and how far back the marine
     archive goes. If either fails, the output says so.
  2. For each day, takes the hour with the biggest swell between 06:00 and 20:00 UK time.
  3. Compares three formulas for the top of the surf range:
       now  - what the frame uses now: the spot's [spots.<key>.surf_model] from settings,
              or the old generic formula if it has none. Once coefficients fitted on
              these same days are in settings, "now" is scored on data it was fitted
              to, so it will look a little better than A/B's unseen-week figures.
       A    - top = swell x (a + b x period)
       B    - A plus a term for how far the swell direction is off the beach's facing
  4. Tests A and B honestly: each week is predicted by a formula fitted WITHOUT that
     week (leave-one-week-out), so the "typical miss" is what to expect on new days.
  5. Shows what the data covers and what it's still missing, and writes every number
     to calibration/results/<spot>-compare.csv.

Read-only: nothing in settings is changed; it prints a block you can paste in. Surfline shows whole-foot bands, so about
+/-0.5 ft is the best any formula can look against it.
"""
from __future__ import annotations

import argparse
import csv
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

from .sources.openmeteo import MARINE, angle_off, estimate_surf_m, surf_model
from .util import M_TO_FT, ROOT, http_session, load_settings, tz

HOURS = range(6, 21)  # 06:00-20:00 local: roughly when you'd surf
CAL_DIR = ROOT / "calibration"
BASE_VARS = ["wave_height", "wave_period", "swell_wave_height", "swell_wave_period", "swell_wave_direction"]
PEAK_VARS = ["swell_wave_peak_period", "wave_peak_period"]


# ------------------------------------------------------------------ input
def find_files(args: list[str]) -> list[Path]:
    files: list[Path] = []
    for a in args:
        p = Path(a)
        if p.suffix.lower() == ".csv":
            files.append(p if p.is_absolute() else (Path.cwd() / p))
        else:  # a spot name
            files += sorted(CAL_DIR.glob(f"{a}-*.csv"))
    files = [f for f in files if not f.stem.endswith("-compare")]
    if not files:
        sys.exit(f"No calibration CSVs found for {' '.join(args)} (looked in {CAL_DIR})")
    return files


def read_surfline(files: list[Path]) -> list[dict]:
    rows: dict = {}
    for path in files:
        with open(path, newline="", encoding="utf-8") as f:
            for r in csv.DictReader(line for line in f if not line.lstrip().startswith("#")):
                if not (r.get("date") or "").strip():
                    continue
                d = date.fromisoformat(r["date"].strip())
                row = {"date": d, "min_ft": float(r["min_ft"]), "max_ft": float(r["max_ft"]),
                       "plus": str(r.get("plus", "")).strip() in ("1", "+", "yes", "true"), "file": path.name}
                if d in rows and (rows[d]["max_ft"], rows[d]["plus"]) != (row["max_ft"], row["plus"]):
                    print(f"  note: {d} appears twice with different values ({rows[d]['file']}, {path.name}); using {path.name}")
                rows[d] = row
    if not rows:
        sys.exit("The CSVs have no rows.")
    return [rows[d] for d in sorted(rows)]


def date_runs(dates: list[date], gap: int = 3) -> list[tuple[date, date]]:
    runs, start, prev = [], dates[0], dates[0]
    for d in dates[1:]:
        if (d - prev).days > gap:
            runs.append((start, prev)); start = d
        prev = d
    runs.append((start, prev))
    return runs


# ------------------------------------------------------------------ Open-Meteo
def _fetch(session, lat, lon, start, end, zone, variables):
    r = session.get(MARINE, params={
        "latitude": lat, "longitude": lon, "cell_selection": "sea",
        "start_date": start.isoformat(), "end_date": end.isoformat(),
        "timezone": str(zone), "timeformat": "unixtime", "hourly": ",".join(variables),
    }, timeout=60)
    try:
        j = r.json()
    except ValueError:
        return None, f"HTTP {r.status_code} (not JSON)"
    if r.status_code != 200 or j.get("error"):
        return None, f"HTTP {r.status_code}: {j.get('reason')}"
    return j["hourly"], None


def fetch_days(spot: dict, dates: list[date], zone) -> tuple[dict, bool]:
    """-> ({date: biggest-swell hour}, peak_period_used)"""
    s = http_session()
    by_day: dict = {}
    peak_ok = True
    for start, end in date_runs(dates):
        h, err = _fetch(s, spot["lat"], spot["lon"], start, end, zone, BASE_VARS + (PEAK_VARS if peak_ok else []))
        if h is None and peak_ok:
            peak_ok = False  # most likely the peak-period variables aren't offered
            h, err2 = _fetch(s, spot["lat"], spot["lon"], start, end, zone, BASE_VARS)
            if h is not None:
                print(f"  note: peak period not available ({err}); using mean period")
            err = err2
        if h is None:
            print(f"  Open-Meteo failed for {start} to {end}: {err}")
            continue
        for i, t in enumerate(h["time"]):
            dt = datetime.fromtimestamp(int(t), zone)
            if dt.hour not in HOURS:
                continue
            hs, src = h["swell_wave_height"][i], "swell"
            per = (h.get("swell_wave_peak_period") or [None] * (i + 1))[i] or h["swell_wave_period"][i]
            if hs is None:
                hs, src = h["wave_height"][i], "total"
                per = (h.get("wave_peak_period") or [None] * (i + 1))[i] or h["wave_period"][i]
            if hs is None:
                continue
            row = {"hs": hs, "per": per, "dir": h["swell_wave_direction"][i], "src": src, "hour": dt.hour}
            best = by_day.get(dt.date())
            if best is None or hs > best["hs"]:
                by_day[dt.date()] = row
    return by_day, peak_ok


# ------------------------------------------------------------------ fitting
def solve(features: list[list[float]], ys: list[float]) -> list[float] | None:
    """Least squares via normal equations + Gaussian elimination (tiny problems only)."""
    n = len(features[0]) if features else 0
    if len(features) <= n:
        return None
    A = [[sum(f[i] * f[j] for f in features) for j in range(n)] + [sum(f[i] * y for f, y in zip(features, ys))]
         for i in range(n)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(A[r][c]))
        if abs(A[p][c]) < 1e-12:
            return None
        A[c], A[p] = A[p], A[c]
        for r in range(n):
            if r != c:
                k = A[r][c] / A[c][c]
                A[r] = [x - k * y for x, y in zip(A[r], A[c])]
    return [A[i][n] / A[i][i] for i in range(n)]


def feats(model: str, d: dict) -> list[float]:
    hs, t = d["hs"], d["per"]
    if model == "A":
        return [hs, hs * t]
    return [hs, hs * t, hs * abs(d["off"]) / 90]  # B


def predict(coef: list[float], model: str, d: dict) -> float:
    return sum(c * f for c, f in zip(coef, feats(model, d)))


def week_of(d: date) -> tuple[int, int]:
    return d.isocalendar()[:2]


def holdout(data: list[dict], model: str) -> dict | None:
    """Leave-one-week-out predictions (metres) keyed by date."""
    weeks = sorted({week_of(d["date"]) for d in data})
    if len(weeks) < 3:
        return None
    out = {}
    for w in weeks:
        train = [d for d in data if week_of(d["date"]) != w]
        coef = solve([feats(model, d) for d in train], [d["top_m"] for d in train])
        if coef is None:
            return None
        for d in data:
            if week_of(d["date"]) == w:
                out[d["date"]] = predict(coef, model, d)
    return out


def summary(errs_ft: list[float]) -> str:
    if not errs_ft:
        return "n/a"
    mean = sum(errs_ft) / len(errs_ft)
    mae = sum(abs(e) for e in errs_ft) / len(errs_ft)
    within = sum(abs(e) <= 0.5 for e in errs_ft) / len(errs_ft)
    return f"typical miss {mae:.1f} ft · average {mean:+.1f} ft · within ½ ft on {within:.0%} of days"


# ------------------------------------------------------------------ main
def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("what", nargs="+", help="spot name (saunton, rest_bay) or CSV file(s)")
    a = ap.parse_args()

    files = find_files(a.what)
    keys = {f.stem.split("-")[0] for f in files}
    if len(keys) != 1:
        sys.exit(f"Files are for more than one spot: {', '.join(sorted(keys))}")
    key = keys.pop()
    settings = load_settings()
    zone = tz(settings)
    spot = settings["spots"].get(key)
    if not spot:
        sys.exit(f"Unknown spot '{key}' (from the file name). Spots: {', '.join(settings['spots'])}")

    model = surf_model(spot)
    sl = read_surfline(files)
    print(f"\n{spot['name']}: {len(sl)} days from {len(files)} file(s), {sl[0]['date']} to {sl[-1]['date']}")
    om, peak = fetch_days(spot, [r["date"] for r in sl], zone)

    data = []
    for r in sl:
        o = om.get(r["date"])
        if not o or not o["per"]:
            continue
        top_ft = r["max_ft"] + (0.5 if r["plus"] else 0)  # "3-4ft+" ~ 4.5 at the top
        off = angle_off(o["dir"], spot["facing_deg"])
        data.append({**r, **o, "off": off if off is not None else 0.0, "top_ft": top_ft, "top_m": top_ft / M_TO_FT,
                     "now_ft": estimate_surf_m(o["hs"], o["per"], o["dir"], model)[1] * M_TO_FT})
    missing = len(sl) - len(data)
    if missing:
        print(f"  note: {missing} day(s) had no Open-Meteo data and were skipped")
    if len(data) < 5:
        sys.exit("Too few days with data to say anything.")

    ho = {m: holdout(data, m) for m in ("A", "B")}
    fits = {m: solve([feats(m, d) for d in data], [d["top_m"] for d in data]) for m in ("A", "B")}

    # ---- day table
    print(f"\n{'date':<11}{'Surfline':>9}{'swell':>17}{'off':>6}{'now':>6}{'A':>6}{'B':>6}   (tops in ft; A/B = predicted without that week)")
    for d in data:
        sl_txt = f"{d['min_ft']:g}-{d['max_ft']:g}{'+' if d['plus'] else ''}"
        swell = f"{d['hs'] * M_TO_FT:.1f}ft {d['per']:.0f}s {d['dir'] or 0:.0f}°"
        pa = f"{ho['A'][d['date']] * M_TO_FT:.1f}" if ho["A"] else "-"
        pb = f"{ho['B'][d['date']] * M_TO_FT:.1f}" if ho["B"] else "-"
        print(f"{d['date']!s:<11}{sl_txt:>9}{swell:>17}{d['off']:>+6.0f}{d['now_ft']:>6.1f}{pa:>6}{pb:>6}")

    # ---- scores
    now_err = [d["now_ft"] - d["top_ft"] for d in data]
    print(f"\nPeriod used: {'peak' if peak else 'mean (peak not available)'}")
    print(f"now: {summary(now_err)}   ({'settings surf_model' if model else 'generic formula, no surf_model in settings'})")
    errs = {}
    for m in ("A", "B"):
        if ho[m]:
            errs[m] = [ho[m][d["date"]] * M_TO_FT - d["top_ft"] for d in data]
            print(f"{m}:   {summary(errs[m])}   (tested on unseen weeks)")
        else:
            print(f"{m}:   can't be tested yet (needs 3+ different weeks" + (" and a spread of swell directions)" if m == "B" else ")"))
    for m, name in (("A", "top = swell × (a + b × period)"), ("B", "top = swell × (a + b × period + c × |off|/90)")):
        if fits[m]:
            print(f"  {m} fitted on all days: {name}: " + ", ".join(f"{k}={v:.4f}" for k, v in zip("abc", fits[m])))

    best_fit = min(errs, key=lambda m: sum(abs(e) for e in errs[m])) if errs else None
    if best_fit and fits[best_fit]:
        c = fits[best_fit] + [0.0] * (3 - len(fits[best_fit]))
        print(f"\n  To use {best_fit} on the frame, put this in config/settings.toml under [spots.{key}]:")
        print(f"    [spots.{key}.surf_model]\n    a = {c[0]:.4f}\n    b = {c[1]:.4f}\n    c = {c[2]:.4f}")

    # ---- where it goes wrong (best available formula)
    best = min(errs, key=lambda m: sum(abs(e) for e in errs[m])) if errs else None
    if best:
        print(f"\nWhere {best} misses (unseen weeks):")
        buckets = {
            "surf under 3 ft": lambda d: d["top_ft"] < 3, "surf 3-5 ft": lambda d: 3 <= d["top_ft"] < 5,
            "surf 5 ft+": lambda d: d["top_ft"] >= 5,
            "period under 9 s": lambda d: d["per"] < 9, "period 9-12 s": lambda d: 9 <= d["per"] < 12,
            "period 12 s+": lambda d: d["per"] >= 12,
            f"swell from south of {spot['facing_deg']}° by 15°+": lambda d: d["off"] <= -15,
            "swell within 15° of facing": lambda d: -15 < d["off"] < 15,
            f"swell from north of {spot['facing_deg']}° by 15°+": lambda d: d["off"] >= 15,
        }
        for label, test in buckets.items():
            e = [x for x, d in zip(errs[best], data) if test(d)]
            print(f"  {label:<34} {len(e):>3} days   " + (summary(e) if e else "no data yet"))

    # ---- coverage
    weeks = len({week_of(d["date"]) for d in data})
    big = sum(d["top_ft"] >= 6 for d in data)
    long_p = sum(d["per"] >= 12 for d in data)
    north = sum(d["off"] >= 15 for d in data)
    print(f"\nCoverage: {len(data)} days over {weeks} weeks · 6 ft+ days: {big} · 12 s+ days: {long_p} · "
          f"north-of-facing days: {north}")
    todo = []
    if weeks < 12: todo.append(f"more weeks (have {weeks}, aim for 12-26)")
    if big < 10: todo.append(f"more 6 ft+ days (have {big}, aim for 10+; winter months)")
    if long_p < 10: todo.append(f"more long-period days, 12 s+ (have {long_p}, aim for 10+)")
    if north < 10: todo.append(f"more swells from north of the beach's facing (have {north})")
    print("Still needed: " + ("; ".join(todo) if todo else "nothing obvious — the fit is worth trying on the frame"))

    # ---- save
    out_dir = CAL_DIR / "results"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{key}-compare.csv"
    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["date", "surfline_min_ft", "surfline_max_ft", "surfline_plus", "top_ft", "om_source", "om_hour",
                    "om_hs_m", "om_period_s", "period_kind", "om_dir_deg", "dir_vs_beach_deg", "now_ft",
                    "A_unseen_ft", "B_unseen_ft", "file"])
        for d in data:
            w.writerow([d["date"], d["min_ft"], d["max_ft"], int(d["plus"]), d["top_ft"], d["src"], d["hour"],
                        d["hs"], d["per"], "peak" if peak else "mean", d["dir"], round(d["off"]), round(d["now_ft"], 2),
                        round(ho["A"][d["date"]] * M_TO_FT, 2) if ho["A"] else "",
                        round(ho["B"][d["date"]] * M_TO_FT, 2) if ho["B"] else "", d["file"]])
    print(f"Saved {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
