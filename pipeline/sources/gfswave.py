"""NOAA GFS-Wave (WAVEWATCH III): significant wave height and peak wave direction on a
regular 0.25° grid, for the Wave map widget.

Where from: NOAA's public GFS bucket on AWS Open Data (no key, no sign-up):
    https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.YYYYMMDD/HH/wave/gridded/
        gfswave.tHHz.global.0p25.fFFF.grib2  (+ .idx listing where each field starts)
Only the two fields we need are downloaded, with HTTP Range requests from the .idx.
The 0.16° grid would be sharper but stops at 52.5°N, so it misses most of the UK.

Model runs at 00/06/12/18 UTC, hourly steps to +120 h; each run appears a few hours
after its nominal time, so we try the newest run first and fall back to older ones.

UNVERIFIED here (the build sandbox can't reach NOAA): the bucket path and file names,
the .idx line format, and that DIRPW is the direction waves come FROM (the WMO/GRIB
convention). Checked against NOAA's docs only — the first real render will show it.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

import numpy as np

log = logging.getLogger("surf")

BASE = "https://noaa-gfs-bdp-pds.s3.amazonaws.com"
GRID = "global.0p25"
FIELDS = ("HTSGW", "DIRPW")        # significant height (m), primary wave direction (deg, from)
MAX_HOURS = 120
MAX_FIELD_BYTES = 20 * 1024 * 1024  # a global 0.25° field is ~1-2 MB; refuse anything silly


def file_url(cycle: datetime, fh: int) -> str:
    return (f"{BASE}/gfs.{cycle:%Y%m%d}/{cycle:%H}/wave/gridded/"
            f"gfswave.t{cycle:%H}z.{GRID}.f{fh:03d}.grib2")


def candidate_runs(now_utc: datetime, valid_utc: datetime, tries: int = 4) -> list[tuple[datetime, int]]:
    """(run time, forecast hour) pairs to try, newest run first."""
    base = now_utc.replace(minute=0, second=0, microsecond=0)
    base -= timedelta(hours=base.hour % 6)
    out = []
    for k in range(tries):
        cyc = base - timedelta(hours=6 * k)
        fh = int(round((valid_utc - cyc).total_seconds() / 3600))
        if 0 <= fh <= MAX_HOURS:
            out.append((cyc, fh))
    return out


def parse_idx(text: str, size_hint: int | None = None) -> dict[str, tuple[int, int | None]]:
    """{"HTSGW": (start, end_inclusive_or_None), ...} for the surface fields we want.
    .idx lines look like  "3:123456:d=2026100212:HTSGW:surface:3 hour fcst:"."""
    rows = []
    for line in text.splitlines():
        parts = line.split(":")
        if len(parts) >= 5 and parts[1].isdigit():
            rows.append((int(parts[1]), parts[3], parts[4]))
    out = {}
    for i, (start, var, level) in enumerate(rows):
        if var in FIELDS and level == "surface" and var not in out:
            end = rows[i + 1][0] - 1 if i + 1 < len(rows) else None
            out[var] = (start, end)
    return out


def decode(msg: bytes) -> dict:
    """One GRIB2 message -> {"lats": 1-D ascending, "lons": 1-D -180..180 ascending,
    "values": 2-D [lat, lon] float with NaN for land/missing}."""
    import eccodes
    gid = eccodes.codes_new_from_message(msg)
    try:
        get = lambda k: eccodes.codes_get(gid, k)  # noqa: E731
        if get("gridType") != "regular_ll":
            raise ValueError(f"unexpected grid {get('gridType')}")
        ni, nj = get("Ni"), get("Nj")
        lat0, lon0 = get("latitudeOfFirstGridPointInDegrees"), get("longitudeOfFirstGridPointInDegrees")
        dlat, dlon = get("jDirectionIncrementInDegrees"), get("iDirectionIncrementInDegrees")
        jpos, ineg = get("jScansPositively"), get("iScansNegatively")
        vals = np.array(eccodes.codes_get_values(gid), dtype=float)
        if get("bitmapPresent"):
            vals[vals == get("missingValue")] = np.nan
    finally:
        eccodes.codes_release(gid)
    grid = vals.reshape(nj, ni)
    lats = lat0 + (1 if jpos else -1) * dlat * np.arange(nj)
    lons = lon0 + (-1 if ineg else 1) * dlon * np.arange(ni)
    if not jpos:
        grid, lats = grid[::-1], lats[::-1]
    if ineg:
        grid, lons = grid[:, ::-1], lons[::-1]
    lons = ((lons + 180) % 360) - 180          # 0..360 -> -180..180, then sort
    order = np.argsort(lons, kind="stable")
    return {"lats": lats, "lons": lons[order], "values": grid[:, order]}


def subset(field: dict, west: float, south: float, east: float, north: float, margin: float = 1.0) -> dict:
    la, lo = field["lats"], field["lons"]
    ri = np.where((la >= south - margin) & (la <= north + margin))[0]
    ci = np.where((lo >= west - margin) & (lo <= east + margin))[0]
    return {"lats": la[ri], "lons": lo[ci], "values": field["values"][np.ix_(ri, ci)]}


def fetch(now_utc: datetime, valid_utc: datetime, box: tuple[float, float, float, float], session) -> dict | None:
    """Height + direction around `box` (west, south, east, north) at `valid_utc`, or None.
    Never raises: the map just keeps its last good copy."""
    for cyc, fh in candidate_runs(now_utc, valid_utc):
        url = file_url(cyc, fh)
        try:
            r = session.get(url + ".idx", timeout=20)
            if r.status_code != 200:
                continue
            spans = parse_idx(r.text)
            if not all(f in spans for f in FIELDS):
                log.warning("wave map: %s.idx lacks %s", url.rsplit("/", 1)[-1], FIELDS)
                continue
            out = {}
            for var in FIELDS:
                a, b = spans[var]
                rng = f"bytes={a}-{'' if b is None else b}"
                g = session.get(url, headers={"Range": rng}, timeout=60)
                if g.status_code not in (200, 206) or len(g.content) > MAX_FIELD_BYTES:
                    raise ValueError(f"HTTP {g.status_code}, {len(g.content)} bytes")
                out[var] = subset(decode(g.content), *box)
            if out["HTSGW"]["values"].shape != out["DIRPW"]["values"].shape:
                raise ValueError("height and direction grids differ")
            log.info("wave map: GFS-Wave %sZ run +%dh", cyc.strftime("%Y-%m-%d %H"), fh)
            return {"lats": out["HTSGW"]["lats"], "lons": out["HTSGW"]["lons"],
                    "hs": out["HTSGW"]["values"], "dir": out["DIRPW"]["values"],
                    "run": cyc.replace(tzinfo=timezone.utc), "valid": valid_utc}
        except Exception as e:  # noqa: BLE001
            log.warning("wave map: %s failed (%s: %s)", url.rsplit("/", 1)[-1], type(e).__name__, str(e)[:120])
    return None
