"""Frames: the main frame (the owner's) plus friends' frames on the same setup.

Storage (same keys the Workers use — workers/shared/frames.js):
    <root>/...                      main frame: layouts/, state/, renders/, data/ as before
    state/frames.json               {"frames": [{"id", "name", "emails", "created"}]}  (studio admin)
    frames/<id>/layouts/<l>.json    a friend's layouts
    frames/<id>/state/selected.json what their frame shows
    frames/<id>/state/frame-settings.json   {"shrink_px": 0-20, "home": {name, lat, lon} | null,
                                             "button_layout": layout id | ""}  (KEY3; Workers only)
    frames/<id>/state/button.json   {"alt": bool} — KEY3 picture showing (written by surf-frame-img)
    frames/<id>/renders/...         their pictures
    frames/<id>/data/data.json      their copy of the forecast (no Wave bookings)

The main frame can have state/frame-settings.json too (edge margin, and a home that
overrides [home] in settings.toml).
"""
from __future__ import annotations

import copy
import json
import logging
import re

log = logging.getLogger("surf")

MAIN = "main"
FRAME_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,23}$")
MAX_FRAMES = 20
MAX_SHRINK = 20
# Only meaningful on the main frame: The Wave bookings come from the owner's inbox, and
# "Board & fins" picks from the owner's own boards. Keep in step with workers/shared/frames.js.
MAIN_ONLY_WIDGETS = ("booking", "countdown", "quiver")
# What a friend's copy of a starter layout gets instead of a main-only widget: the first of
# these that isn't already on the layout and fits the space.
SUBSTITUTES = [("wetsuit", 6, 3), ("water", 6, 3), ("daylight", 6, 3), ("moon", 6, 3), ("sun", 6, 3)]


def prefix_for(fid: str) -> str:
    return "" if fid == MAIN else f"frames/{fid}/"


def _read_json(store, key: str, fallback):
    raw = store.get(key)
    if not raw:
        return fallback
    try:
        return json.loads(raw)
    except ValueError:
        return fallback


LAYOUT_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
DEFAULT_BUTTON_LAYOUT = "wave-map"   # keep in step with the Workers


def clean_settings(obj) -> dict:
    """Frame settings as the studio saves them, re-checked (never trust stored JSON)."""
    out = {"shrink_px": 0, "home": None, "button_layout": DEFAULT_BUTTON_LAYOUT}
    if not isinstance(obj, dict):
        return out
    b = obj.get("button_layout", DEFAULT_BUTTON_LAYOUT)
    if b is None:
        b = DEFAULT_BUTTON_LAYOUT
    out["button_layout"] = b if isinstance(b, str) and (b == "" or LAYOUT_ID_RE.match(b)) else ""
    s = obj.get("shrink_px", 0)
    if isinstance(s, int) and not isinstance(s, bool) and 0 <= s <= MAX_SHRINK:
        out["shrink_px"] = s
    h = obj.get("home")
    if isinstance(h, dict):
        try:
            lat, lon = float(h["lat"]), float(h["lon"])
            name = str(h.get("name", "Home")).strip()[:40] or "Home"
            if -90 <= lat <= 90 and -180 <= lon <= 180:
                out["home"] = {"name": name, "lat": round(lat, 4), "lon": round(lon, 4)}
        except (KeyError, TypeError, ValueError):
            pass
    return out


def main_frame(settings_obj=None) -> dict:
    st = clean_settings(settings_obj)
    return {"id": MAIN, "prefix": "", "main": True, "shrink_px": st["shrink_px"], "home": st["home"]}


def load_frames(store) -> list[dict]:
    """The main frame first, then each listed friend frame, with its settings."""
    frames = [main_frame(_read_json(store, "state/frame-settings.json", {}))]
    reg = _read_json(store, "state/frames.json", {})
    seen = {MAIN}
    for f in (reg.get("frames") or [])[:MAX_FRAMES] if isinstance(reg, dict) else []:
        fid = f.get("id") if isinstance(f, dict) else None
        if not isinstance(fid, str) or not FRAME_ID_RE.match(fid) or fid in seen:
            continue
        seen.add(fid)
        pre = prefix_for(fid)
        st = clean_settings(_read_json(store, pre + "state/frame-settings.json", {}))
        frames.append({"id": fid, "prefix": pre, "main": False, "shrink_px": st["shrink_px"], "home": st["home"]})
    if len(frames) > 1:
        log.info("frames: %s", ", ".join(f["id"] for f in frames))
    return frames


def frame_data(data: dict, frame: dict, home: dict | None, home_warnings: list[str]) -> dict:
    """This frame's copy of data.json. Friends never get the bookings, the main frame's
    home weather or its warnings (which can mention the bookings inbox)."""
    if frame["main"]:
        if home is None:
            return data
        d = dict(data)
        d["home"] = home
        return d
    d = dict(data)
    # The owner's own kit stays off friends' frames: no board picks from their quiver, and a
    # plain wetsuit description instead of his suit's model name.
    spots = copy.deepcopy(data.get("spots") or {})
    for sp in spots.values():
        sp.pop("quiver", None)
        ws = sp.get("wetsuit")
        if isinstance(ws, dict):
            ws["suit"] = "3/2 wetsuit" if ws.get("key") == "3_2" else "4.5/3.5 + hood"
    d["spots"] = spots
    d["bookings"] = []
    d["home"] = home
    d["warnings"] = list(home_warnings)
    d["frame"] = frame["id"]
    return d


def _fits(w: dict, min_w: int, min_h: int) -> bool:
    return w["w"] >= min_w and w["h"] >= min_h


def friend_starter(layout: dict) -> dict | None:
    """A starter layout adapted for a friend's frame, or None to leave it out.
    Layouts built around The Wave (named after it, or with a countdown) are left out;
    a booking or "Board & fins" box becomes another useful widget of the same size."""
    types = {w["type"] for w in layout.get("widgets", [])}
    if "countdown" in types or re.search(r"\bthe wave\b|wave pool", str(layout.get("name", "")), re.I):
        return None
    out = copy.deepcopy(layout)
    used = set(types)
    kept = []
    for w in out.get("widgets", []):
        if w["type"] not in MAIN_ONLY_WIDGETS:
            kept.append(w)
            continue
        for t, mw, mh in SUBSTITUTES:
            if t not in used and _fits(w, mw, mh):
                used.add(t)
                w["type"] = t
                w["props"] = {k: v for k, v in (w.get("props") or {}).items() if k in ("detail", "spot", "frame")}
                kept.append(w)
                break
        # nothing suitable: the box is left empty
    out["widgets"] = kept
    return out
