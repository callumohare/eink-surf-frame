"""Wave map: NOAA GFS-Wave significant wave height and direction, pre-drawn for the
Wave map widget.

Everything is projected here (Mercator, 800 map units across the [map] box in
settings.toml) so the widget only scales and draws:
    bands   three filled areas, height >= each level (the widget shades them in greys)
    land    coastline from Natural Earth (pipeline/data/land.json)
    labels  a few contour labels per level ("2m")
    arrows  direction the waves are travelling, on a regular grid over the sea
    spots   the surf spots in settings.toml

Shown time: the next 3-hourly slot after the render (a render at 09:07 UTC shows 12:00 UTC).
If NOAA can't be reached the last good map is reused while it's under 6 hours old.
"""
from __future__ import annotations

import json
import logging
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

log = logging.getLogger("surf")

LAND_FILE = Path(__file__).parent / "data" / "land.json"
CACHE_KEY = "cache/wavemap.json"
MAP_W = 800                      # map units across the box (the widget scales to fit)
STEPS = (0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0)
REUSE_HOURS = 6
DEFAULT_BOX = {"west": -28.0, "east": 14.0, "south": 47.65, "north": 60.5}


# ------------------------------------------------------------------ projection
def merc(lat):
    return np.log(np.tan(np.pi / 4 + np.radians(lat) / 2))


class Proj:
    def __init__(self, box: dict):
        self.west, self.east = float(box["west"]), float(box["east"])
        self.south, self.north = float(box["south"]), float(box["north"])
        if not (self.west < self.east and self.south < self.north and -80 < self.south and self.north < 80):
            raise ValueError("bad [map] box")
        self.k = MAP_W / math.radians(self.east - self.west)
        self.top = float(merc(self.north))
        self.h = int(round(self.k * (self.top - float(merc(self.south)))))

    def x(self, lon):
        return np.radians(np.asarray(lon, dtype=float) - self.west) * self.k

    def y(self, lat):
        return (self.top - merc(np.asarray(lat, dtype=float))) * self.k

    def lon(self, x):
        return self.west + np.degrees(np.asarray(x, dtype=float) / self.k)

    def lat(self, y):
        return np.degrees(2 * np.arctan(np.exp(self.top - np.asarray(y, dtype=float) / self.k)) - np.pi / 2)


def next_slot(now: datetime) -> datetime:
    """The next 3-hourly time (00, 03, ... UTC) strictly after `now`."""
    u = now.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
    return u - timedelta(hours=u.hour % 3) + timedelta(hours=3)


# ------------------------------------------------------------------ geometry helpers
def rdp(pts: np.ndarray, tol: float) -> np.ndarray:
    """Ramer-Douglas-Peucker simplification (iterative)."""
    n = len(pts)
    if n < 3:
        return pts
    keep = np.zeros(n, dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        p, q = pts[a], pts[b]
        seg = q - p
        seg_len = math.hypot(*seg)
        mid = pts[a + 1:b]
        if seg_len == 0:
            d = np.hypot(*(mid - p).T)
        else:
            d = np.abs(seg[0] * (mid[:, 1] - p[1]) - seg[1] * (mid[:, 0] - p[0])) / seg_len
        i = int(np.argmax(d))
        if d[i] > tol:
            m = a + 1 + i
            keep[m] = True
            stack += [(a, m), (m, b)]
    return pts[keep]


def _num(v: float) -> str:
    s = f"{v:.1f}"
    return s[:-2] if s.endswith(".0") else s


def ring_path(pts: np.ndarray) -> str:
    return "M" + " ".join(f"{_num(x)} {_num(y)}" for x, y in pts) + "Z"


def fill_land(z: np.ndarray, iters: int = 6) -> np.ndarray:
    """Spread sea values a few cells into land, so the shaded bands run under the
    coastline (which is drawn on top) instead of stopping short of it."""
    z = z.copy()
    for _ in range(iters):
        nan = np.isnan(z)
        if not nan.any():
            break
        pad = np.pad(z, 1, constant_values=np.nan)
        nb = np.stack([pad[:-2, 1:-1], pad[2:, 1:-1], pad[1:-1, :-2], pad[1:-1, 2:]])
        cnt = (~np.isnan(nb)).sum(axis=0)
        mean = np.where(cnt > 0, np.nansum(nb, axis=0) / np.maximum(cnt, 1), np.nan)
        z = np.where(nan & (cnt > 0), mean, z)
    return z


def land_path(proj: Proj, tol: float = 0.6) -> str:
    rings = json.loads(LAND_FILE.read_text(encoding="utf-8"))["rings"]
    pad = 40
    parts = []
    for r in rings:
        a = np.array(r, dtype=float)
        pts = np.column_stack([proj.x(a[:, 0]), proj.y(a[:, 1])])
        lo, hi = pts.min(axis=0), pts.max(axis=0)
        if hi[0] < -pad or lo[0] > MAP_W + pad or hi[1] < -pad or lo[1] > proj.h + pad:
            continue
        if (hi - lo).max() < 2:
            continue                                   # smaller than a couple of pixels
        pts = rdp(pts, tol)
        if len(pts) >= 3:
            parts.append(ring_path(pts))
    return "".join(parts)


def pick_step(hs_max: float) -> float:
    """Level spacing so the darkest band (3 steps and up) covers the bigger seas of the day."""
    for s in STEPS:
        if 3 * s >= 0.6 * hs_max:
            return s
    return STEPS[-1]


def fmt_level(v: float) -> str:
    return (f"{v:.1f}".rstrip("0").rstrip(".")) + "m"


# ------------------------------------------------------------------ build
def build_block(grid: dict, proj: Proj, spots: dict, zone, arrow_px: int = 40) -> dict:
    from contourpy import contour_generator
    lats, lons = np.asarray(grid["lats"], float), np.asarray(grid["lons"], float)
    hs, dr = np.asarray(grid["hs"], float), np.asarray(grid["dir"], float)
    xs, ys = proj.x(lons), proj.y(lats)
    sea = ~np.isnan(hs)
    inview = (xs[None, :] >= 0) & (xs[None, :] <= MAP_W) & (ys[:, None] >= 0) & (ys[:, None] <= proj.h) & sea
    hs_max = float(np.nanmax(np.where(inview, hs, np.nan))) if inview.any() else 0.0
    step = pick_step(hs_max)
    levels = [round(step * i, 2) for i in (1, 2, 3)]

    z = fill_land(hs)
    gen = contour_generator(x=xs, y=ys, z=np.ma.masked_invalid(z), fill_type="OuterCode", line_type="Separate")
    bands = []
    for lv in levels:
        pts_list, codes_list = gen.filled(lv, 1e6)
        d = []
        for pts, codes in zip(pts_list, codes_list):
            starts = list(np.where(codes == 1)[0]) + [len(codes)]
            for a, b in zip(starts[:-1], starts[1:]):
                ring = rdp(np.asarray(pts[a:b], float), 0.5)
                if len(ring) >= 3:
                    d.append(ring_path(ring))
        bands.append("".join(d))

    def cell(x, y):
        """Nearest grid cell (row, col) for a map position."""
        i = int(np.abs(lats - float(proj.lat(y))).argmin())
        j = int(np.abs(lons - float(proj.lon(x))).argmin())
        return i, j

    def is_sea(i, j, ring=1):
        sl = sea[max(0, i - ring):i + ring + 1, max(0, j - ring):j + ring + 1]
        return bool(sl.all())

    def band_at(v):
        return int(sum(bool(v >= lv) for lv in levels))

    # contour labels: a few per level, away from edges, land, the title corner and each other
    labels = []
    for lv in levels:
        cands = []
        for line in gen.lines(lv):
            line = np.asarray(line, float)
            if len(line) < 6:
                continue
            seg = np.hypot(*np.diff(line, axis=0).T)
            total = float(seg.sum())
            if total < 70:
                continue
            cum = np.concatenate([[0], np.cumsum(seg)])
            for f in ((0.5,) if total < 300 else (0.25, 0.5, 0.75)):
                k = int(np.searchsorted(cum, f * total))
                cands.append((total, line[min(k, len(line) - 1)]))
        cands.sort(key=lambda c: -c[0])
        n = 0
        for _, (x, y) in cands:
            if n >= 3 or not (24 <= x <= MAP_W - 24 and 14 <= y <= proj.h - 14):
                continue
            if x < 250 and y < 70:
                continue                                # the widget's title box
            i, j = cell(x, y)
            if not is_sea(i, j):
                continue
            if any(math.hypot(x - a, y - b) < 110 for a, b, _ in labels):
                continue
            labels.append((round(float(x), 1), round(float(y), 1), fmt_level(lv)))
            n += 1

    arrows = []
    half = arrow_px / 2
    for y in np.arange(half, proj.h, arrow_px):
        for x in np.arange(half, MAP_W, arrow_px):
            i, j = cell(x, y)
            if not is_sea(i, j) or np.isnan(dr[i, j]):
                continue
            arrows.append([round(float(x)), round(float(y)), int(round(float(dr[i, j]))) % 360, band_at(hs[i, j])])

    spot_pts = []
    for key, sp in spots.items():
        try:
            x, y = float(proj.x(sp["lon"])), float(proj.y(sp["lat"]))
        except (KeyError, TypeError, ValueError):
            continue
        if 0 <= x <= MAP_W and 0 <= y <= proj.h:
            spot_pts.append([round(x, 1), round(y, 1), sp.get("name", key)])

    run, valid = grid["run"], grid["valid"]
    local = valid.astimezone(zone)
    return {
        "w": MAP_W, "h": proj.h,
        "valid_ts": int(valid.timestamp()), "valid": local.strftime("%a %H:%M"),
        "run": run.strftime("%HZ %d %b"),
        "step": step, "levels": levels, "unit": "m", "max": round(hs_max, 1),
        "bands": bands, "land": land_path(proj),
        "labels": [list(lb) for lb in labels], "arrows": arrows, "arrow_spacing": arrow_px, "spots": spot_pts,
        "source": "NOAA GFS-Wave", "stale": False,
    }


def sample_grid(proj: Proj, now: datetime) -> dict:
    """A made-up but realistic sea state (no network): a big Atlantic swell west of
    Ireland easing towards the Channel, smaller in the North Sea. Land cells are NaN."""
    from PIL import Image, ImageDraw
    lats = np.arange(math.floor(proj.south) - 1, math.ceil(proj.north) + 1.001, 0.25)
    lons = np.arange(math.floor(proj.west) - 1, math.ceil(proj.east) + 1.001, 0.25)
    LO, LA = np.meshgrid(lons, lats)
    hs = (0.7 + 4.2 * np.exp(-(((LO + 17) / 7) ** 2 + ((LA - 55.5) / 3.5) ** 2))
          + 1.6 * np.exp(-(((LO + 9) / 8) ** 2 + ((LA - 47.5) / 3) ** 2))
          - 0.45 * np.clip((LO + 2) / 8, 0, 1))
    dr = (255 + 25 * np.sin(np.radians((LA - 50) * 20)) + 0.8 * (LO + 10)) % 360
    # rasterise the coastline onto the grid for a land mask
    img = Image.new("1", (len(lons), len(lats)), 0)
    drw = ImageDraw.Draw(img)
    for r in json.loads(LAND_FILE.read_text(encoding="utf-8"))["rings"]:
        drw.polygon([((lo - lons[0]) / 0.25, (la - lats[0]) / 0.25) for lo, la in r], fill=1)
    land = np.array(img, dtype=bool)
    hs[land] = np.nan
    dr[land] = np.nan
    valid = next_slot(now)
    return {"lats": lats, "lons": lons, "hs": hs, "dir": dr,
            "run": valid - timedelta(hours=9), "valid": valid}


def build(store, settings: dict, now: datetime, session, zone, sample: bool = False) -> dict | None:
    """The map block for data.json, or None. Never raises."""
    try:
        cfg = settings.get("map") or {}
        if cfg.get("enabled", True) is False:
            return None
        proj = Proj({k: cfg.get(k, v) for k, v in DEFAULT_BOX.items()})
        arrow_px = int(cfg.get("arrow_spacing", 40))
        if sample:
            grid = sample_grid(proj, now)
        else:
            from .sources import gfswave
            grid = gfswave.fetch(now.astimezone(timezone.utc), next_slot(now),
                                 (proj.west, proj.south, proj.east, proj.north), session)
        if grid is not None:
            block = build_block(grid, proj, settings.get("spots") or {}, zone, arrow_px)
            if not sample:
                store.put(CACHE_KEY, json.dumps(block, separators=(",", ":")).encode(), "application/json")
            return block
    except Exception as e:  # noqa: BLE001
        log.warning("wave map failed (%s: %s)", type(e).__name__, str(e)[:160])
    # no new map: reuse the last good one while it's recent
    try:
        old = json.loads(store.get(CACHE_KEY) or b"null")
        if isinstance(old, dict) and old.get("valid_ts", 0) >= now.timestamp() - REUSE_HOURS * 3600:
            old["stale"] = True
            log.info("wave map: reusing the %s map", old.get("valid"))
            return old
    except ValueError:
        pass
    return None
