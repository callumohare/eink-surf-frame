"""Sun times computed locally (no API): first light = civil dawn (sun 6° below
horizon), last light = civil dusk. This matches the usual UK surf-forecast
definition of first/last light."""
from __future__ import annotations

from datetime import date
from zoneinfo import ZoneInfo

from astral import LocationInfo
from astral.sun import sun


def sun_times(lat: float, lon: float, day: date, zone: ZoneInfo) -> dict:
    loc = LocationInfo(latitude=lat, longitude=lon, timezone=str(zone))
    s = sun(loc.observer, date=day, tzinfo=zone, dawn_dusk_depression=6)
    return {
        "first_light": s["dawn"], "sunrise": s["sunrise"],
        "sunset": s["sunset"], "last_light": s["dusk"],
    }
