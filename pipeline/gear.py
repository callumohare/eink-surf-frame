"""Gear logic: wetsuit choice and board/fin choice (board_fin_rules.json)."""
from __future__ import annotations

from .util import M_TO_FT, wind_to

TWINLIKE = {"twin_trailer"}
QUADLIKE = {"perf_quad_M", "perf_quad_Lfront_Mrear"}
THRUSTER = {"perf_thruster_L", "carver_thruster_L"}
CLEAN_WIND = {"offshore", "cross-off", "glassy"}
POOR_WIND = {"onshore", "cross-on"}


# --------------------------------------------------------------------------- wetsuit
def choose_wetsuit(water_c: float | None, air_feels_c: float | None, wind: float | None,
                   wind_unit: str, cfg: dict) -> dict:
    hooded = {"key": "4_5_hooded", "suit": cfg["hooded_name"]}
    summer = {"key": "3_2", "suit": cfg["summer_name"]}
    if water_c is None:
        return {**hooded, "reason": "No water temp — erring warm"}
    wind_mph = wind_to(wind, wind_unit, "mph") if wind is not None else None
    lo = cfg["hooded_below_c"]
    if water_c < lo:
        return {**hooded, "reason": f"Water {water_c:.0f}°C"}
    if water_c < lo + cfg["marginal_band_c"]:
        if air_feels_c is not None and air_feels_c < cfg["cold_air_c"]:
            return {**hooded, "reason": f"Water {water_c:.0f}°C, air feels {air_feels_c:.0f}°C"}
        if wind_mph is not None and wind_mph >= cfg["windy_mph"]:
            return {**hooded, "reason": f"Water {water_c:.0f}°C, windy"}
    return {**summer, "reason": f"Water {water_c:.0f}°C"}


# --------------------------------------------------------------------------- quiver
def _bands(rules: dict, key: str) -> list[dict]:
    r = rules["rules"][key]
    while isinstance(r, str) and r.startswith("same_as:"):
        r = rules["rules"][r.split(":", 1)[1]]
    return r


def _band_label_m(b: dict) -> str:
    lo = b["min_ft"] / M_TO_FT
    hi = b["max_ft"] / M_TO_FT
    if b["min_ft"] <= 0:
        return f"< {hi:.1f} m"
    if b["max_ft"] >= 99:
        return f"{lo:.1f} m+"
    return f"{lo:.1f}–{hi:.1f} m"


def _band_label_ft(b: dict) -> str:
    if b["min_ft"] <= 0:
        return f"< {b['max_ft']:g} ft"
    if b["max_ft"] >= 99:
        return f"{b['min_ft']:g} ft+"
    return f"{b['min_ft']:g}–{b['max_ft']:g} ft"


def choose_quiver(rules: dict, rules_key: str, top_m: float | None, period_s: float | None,
                  wind_type: str | None, qcfg: dict) -> dict | None:
    if top_m is None:
        return None
    ft = top_m * M_TO_FT
    bands = _bands(rules, rules_key)
    idx = next((i for i, b in enumerate(bands) if b["min_ft"] <= ft < b["max_ft"]), len(bands) - 1)
    notes = []

    punchy = period_s is not None and period_s >= qcfg["punchy_period_s"]
    weak = (period_s is not None and period_s < qcfg["weak_period_s"]) or (wind_type in POOR_WIND)

    # Weak/mushy near a boundary -> choose the board for the smaller band.
    if weak and idx > 0 and ft - bands[idx]["min_ft"] < qcfg["boundary_margin_ft"]:
        idx -= 1
        notes.append("weak & near boundary → smaller band")

    b = bands[idx]
    board, fins, alt = b["board"], b["fins"], b.get("alt")
    alt_board = b.get("alt_board")

    # Conditional alternatives
    if b.get("alt_condition") == "clean" and wind_type not in CLEAN_WIND:
        alt = None
    if b.get("alt_condition") == "steep_hollow":
        notes.append("alt if steep/hollow take-offs")

    # Modifiers
    if punchy and fins not in THRUSTER and alt in THRUSTER:
        fins, alt = alt, fins
        notes.append(f"punchy ({period_s:.0f}s) → thruster")
    elif weak and fins in THRUSTER and alt in (TWINLIKE | QUADLIKE):
        fins, alt = alt, fins
        notes.append("soft/onshore → quad/twin")

    # Hard rules: no twin at 5ft+
    if ft >= 5 and fins in TWINLIKE:
        fins, alt = alt or "perf_thruster_L", None
    if ft >= 5 and alt in TWINLIKE:
        alt = None

    screws = ft >= 5
    fin_label = lambda k: rules["fin_setups"][k]["label"] if k else None  # noqa: E731
    return {
        "board": rules["boards"][board]["name"],
        "board_short": rules["boards"][board].get("short", rules["boards"][board]["name"]),
        "fins": fin_label(fins),
        "alt": fin_label(alt),
        "alt_board": rules["boards"][alt_board]["name"] if alt_board else None,
        "band": _band_label_m(b),
        "band_ft": _band_label_ft(b),
        "top_m": round(top_m, 2),
        "screws": screws,
        "notes": notes,
    }


def choose_wave_session(rules: dict, setting: str, setting_map: dict) -> dict | None:
    key = None
    for name, k in sorted(setting_map.items(), key=lambda kv: -len(kv[0])):
        if name.lower() == setting.lower():
            key = k
            break
    if key is None:
        return None
    r = rules["rules"]["the_wave"].get(key)
    if not r:
        return None
    return {
        "board": rules["boards"][r["board"]]["name"],
        "board_short": rules["boards"][r["board"]].get("short", rules["boards"][r["board"]]["name"]),
        "fins": rules["fin_setups"][r["fins"]]["label"],
        "alt": rules["fin_setups"][r["alt"]]["label"] if r.get("alt") else None,
        "level": key,
    }
