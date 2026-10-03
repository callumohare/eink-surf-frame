"""Layout validation (mirrors workers/studio/src/validate.js — keep them in sync)."""
from __future__ import annotations

import re

ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
WID_RE = re.compile(r"^[a-z0-9]{1,12}$")
TYPE_RE = re.compile(r"^[a-z_]{1,30}$")
KEY_RE = re.compile(r"^[A-Za-z]{1,30}$")
SPOT_RE = re.compile(r"^[a-z_]{1,40}$")
COLS, ROWS = 40, 24


class Invalid(ValueError):
    pass


def validate_layout(lid: str, obj) -> dict:
    if not ID_RE.match(lid or ""):
        raise Invalid("bad layout id")
    if not isinstance(obj, dict):
        raise Invalid("layout must be an object")
    name = obj.get("name", "")
    if not isinstance(name, str) or len(name) > 60:
        raise Invalid("bad name")
    spot = obj.get("spot", "")
    if not isinstance(spot, str) or not SPOT_RE.match(spot):
        raise Invalid("bad spot")
    mode = obj.get("mode", "1bit")
    if mode not in ("1bit", "4grey"):
        raise Invalid("bad mode")
    thr = obj.get("threshold", 160)
    if not isinstance(thr, int) or isinstance(thr, bool) or not 40 <= thr <= 240:
        raise Invalid("bad threshold")
    inv = obj.get("invert", False)
    if not isinstance(inv, bool):
        raise Invalid("bad invert")
    ws = obj.get("widgets")
    if not isinstance(ws, list) or len(ws) > 40:
        raise Invalid("widgets must be a list of at most 40")
    clean, seen = [], set()
    for w in ws:
        if not isinstance(w, dict):
            raise Invalid("bad widget")
        wid, typ = w.get("id"), w.get("type")
        if not isinstance(wid, str) or not WID_RE.match(wid) or wid in seen:
            raise Invalid("bad widget id")
        seen.add(wid)
        if not isinstance(typ, str) or not TYPE_RE.match(typ):
            raise Invalid("bad widget type")
        g = {}
        for k, lo, hi in (("x", 0, COLS - 1), ("y", 0, ROWS - 1), ("w", 1, COLS), ("h", 1, ROWS)):
            v = w.get(k)
            if not isinstance(v, int) or isinstance(v, bool) or not lo <= v <= hi:
                raise Invalid(f"bad widget {k}")
            g[k] = v
        if g["x"] + g["w"] > COLS or g["y"] + g["h"] > ROWS:
            raise Invalid("widget out of bounds")
        props = w.get("props", {}) or {}
        if not isinstance(props, dict) or len(props) > 20:
            raise Invalid("bad props")
        cp = {}
        for k, v in props.items():
            if not isinstance(k, str) or not KEY_RE.match(k):
                raise Invalid("bad prop key")
            if isinstance(v, str):
                if len(v) > 200:
                    raise Invalid("prop too long")
            elif not isinstance(v, (bool, int, float)) or v != v:  # NaN check
                raise Invalid("bad prop value")
            cp[k] = v
        clean.append({"id": wid, "type": typ, **g, "props": cp})
    return {"id": lid, "name": name, "spot": spot, "mode": mode, "threshold": thr,
            "invert": inv, "widgets": clean}
