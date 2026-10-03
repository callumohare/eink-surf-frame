"""Find ADMIRALTY station IDs near your spots.

Usage:
    ADMIRALTY_KEY=... python -m pipeline.find_station                # nearest 5 to each spot
    ADMIRALTY_KEY=... python -m pipeline.find_station porthcawl      # search by name
"""
from __future__ import annotations

import math
import os
import sys

from .sources.admiralty import list_stations
from .util import load_settings


def _km(a_lat, a_lon, b_lat, b_lon):
    p = math.pi / 180
    h = (math.sin((b_lat - a_lat) * p / 2) ** 2 +
         math.cos(a_lat * p) * math.cos(b_lat * p) * math.sin((b_lon - a_lon) * p / 2) ** 2)
    return 12742 * math.asin(math.sqrt(h))


def main():
    key = os.environ.get("ADMIRALTY_KEY")
    if not key:
        sys.exit("Set ADMIRALTY_KEY in your environment first.")
    stations = [s for s in list_stations(key) if s["lat"] is not None]
    if len(sys.argv) > 1:
        q = " ".join(sys.argv[1:]).lower()
        for s in stations:
            if q in (s["name"] or "").lower():
                print(f'{s["id"]:>6}  {s["name"]}  ({s["lat"]:.3f}, {s["lon"]:.3f})')
        return
    for key_, spot in load_settings()["spots"].items():
        print(f"\n{spot['name']} ({key_}):")
        near = sorted(stations, key=lambda s: _km(spot["lat"], spot["lon"], s["lat"], s["lon"]))[:5]
        for s in near:
            d = _km(spot["lat"], spot["lon"], s["lat"], s["lon"])
            print(f'  {s["id"]:>6}  {s["name"]:<28} {d:5.1f} km')


if __name__ == "__main__":
    main()
