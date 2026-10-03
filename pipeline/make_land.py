"""Build pipeline/data/land.json (the coastline for the Wave map) from Natural Earth.

One-off tool, run only if the map area moves outside the region below:
    pip install shapely
    (download ne_10m_land.geojson and ne_10m_minor_islands.geojson from
     https://github.com/nvkelso/natural-earth-vector/tree/master/geojson)
    python -m pipeline.make_land ne_10m_land.geojson ne_10m_minor_islands.geojson

Natural Earth is public domain. Output: {"region": [w, s, e, n], "rings": [[[lon, lat], ...], ...]}
— outer rings only (lakes are left as land), simplified to ~1 km, tiny islets dropped.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REGION = (-40.0, 35.0, 30.0, 67.0)   # west, south, east, north
TOLERANCE = 0.01                     # degrees (~1 km)
MIN_AREA = 0.0015                    # square degrees (~12 km²): smaller islets are dropped
OUT = Path(__file__).parent / "data" / "land.json"


def main(paths: list[str]) -> None:
    from shapely.geometry import box, shape
    from shapely.ops import unary_union
    clip = box(*REGION)
    geoms = []
    for p in paths:
        for f in json.loads(Path(p).read_text(encoding="utf-8"))["features"]:
            g = shape(f["geometry"])
            if g.intersects(clip):
                geoms.append(g.intersection(clip))
    land = unary_union(geoms).simplify(TOLERANCE, preserve_topology=True)
    polys = [land] if land.geom_type == "Polygon" else list(getattr(land, "geoms", []))
    rings = []
    for poly in polys:
        if poly.geom_type != "Polygon" or poly.area < MIN_AREA:
            continue
        rings.append([[round(x, 3), round(y, 3)] for x, y in poly.exterior.coords])
    rings.sort(key=len, reverse=True)
    OUT.write_text(json.dumps({"source": "Natural Earth 1:10m land (public domain)", "region": list(REGION),
                               "rings": rings}, separators=(",", ":")), encoding="utf-8")
    print(f"{OUT}: {len(rings)} rings, {sum(map(len, rings))} points, {OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main(sys.argv[1:])
