"""Is the forecast data already fresh? Used by the *backup* GitHub schedule in
render.yml: the studio Worker's Cloudflare Cron Trigger normally starts the render
on time, and GitHub's late-running schedule then has nothing to do.

    python -m pipeline.fresh --storage r2 --max-age-min 150

Prints the data's age and, inside GitHub Actions, writes skip=true|false to
$GITHUB_OUTPUT. Always exits 0: if anything goes wrong reading the data, it says
"don't skip" so the render goes ahead (failing open towards fresh pictures).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

from .storage import make_storage


def data_age_s(store, now: float | None = None) -> float | None:
    """Seconds since data/data.json was generated, or None if unknown."""
    raw = store.get("data/data.json")
    if not raw:
        return None
    try:
        ts = int(json.loads(raw)["generated_ts"])
    except (ValueError, KeyError, TypeError):
        return None
    return (time.time() if now is None else now) - ts


def should_skip(age_s: float | None, max_age_min: int) -> bool:
    # A timestamp in the future (clock skew) counts as fresh only if it's close.
    return age_s is not None and -600 <= age_s < max_age_min * 60


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--storage", choices=["local", "r2"], default="local")
    ap.add_argument("--out", default="out", help="folder for --storage local")
    ap.add_argument("--max-age-min", type=int, default=150)
    a = ap.parse_args(argv)
    try:
        age = data_age_s(make_storage(a.storage, a.out))
    except Exception as e:  # noqa: BLE001 — never block a render on this check
        print(f"couldn't read data ({type(e).__name__}); rendering anyway")
        age = None
    skip = should_skip(age, a.max_age_min)
    if age is None:
        print("no data yet; rendering")
    else:
        print(f"data is {age / 60:.0f} min old; {'skipping — a render already ran' if skip else 'rendering'}")
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write(f"skip={'true' if skip else 'false'}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
