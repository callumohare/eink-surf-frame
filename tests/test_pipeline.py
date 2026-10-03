"""Run: python -m pytest -q  (or python -m unittest discover tests)"""
import email
import math
import unittest
from email import policy
from datetime import date, datetime, timezone
from pathlib import Path

from pipeline import bookings, gear, tides
from pipeline.util import load_rules, load_settings, wind_type_from_facing
from pipeline.validate import Invalid, validate_layout

FIX = Path(__file__).parent / "fixtures"
RULES, SETTINGS = load_rules(), load_settings()
Q = SETTINGS["quiver"]
FT = 1 / 3.28084


class Quiver(unittest.TestCase):
    def q(self, ft, period=10, wind="cross-off", spot="saunton"):
        return gear.choose_quiver(RULES, spot, ft * FT, period, wind, Q)

    def test_bands(self):
        self.assertEqual(self.q(1.5)["board_short"], "Flow Stik")
        self.assertEqual(self.q(1.5)["fins"], "Performer quad M")
        self.assertEqual(self.q(3)["fins"], "MR twins + trailer")
        self.assertEqual(self.q(4.5)["fins"], "Performer thruster L")
        self.assertEqual(self.q(6)["board_short"], "Flow Stik")
        self.assertTrue(self.q(6)["screws"])

    def test_rest_bay_same_as_saunton(self):
        self.assertEqual(self.q(3, spot="rest_bay"), self.q(3))

    def test_punchy_prefers_thruster(self):
        self.assertEqual(self.q(4.5, period=14)["fins"], "Performer thruster L")

    def test_clean_alt_only_when_clean(self):
        self.assertEqual(self.q(4.5, wind="offshore")["alt"], "MR twins + trailer")
        self.assertIsNone(self.q(4.5, wind="cross")["alt"])

    def test_weak_near_boundary_drops_band(self):
        r = self.q(4.1, period=7, wind="onshore")
        self.assertEqual(r["fins"], "MR twins + trailer")  # 2-4 ft band

    def test_no_twin_at_5ft(self):
        self.assertNotEqual(self.q(5.5, period=7, wind="onshore")["fins"], "MR twins + trailer")

    def test_wave_sessions(self):
        m = SETTINGS["bookings"]["setting_rules"]
        self.assertEqual(gear.choose_wave_session(RULES, "Advanced", m)["board_short"], "BP Mini")
        self.assertEqual(gear.choose_wave_session(RULES, "Advanced Plus", m)["fins"], "Quad: Performer L fronts + M rears")
        self.assertIsNone(gear.choose_wave_session(RULES, "Play in the Bay", m))


class Wetsuit(unittest.TestCase):
    W = SETTINGS["wetsuit"]

    def test_cold(self):
        self.assertEqual(gear.choose_wetsuit(12.0, 10, 5, "mph", self.W)["key"], "4_5_hooded")

    def test_warm(self):
        self.assertEqual(gear.choose_wetsuit(17.0, 15, 5, "mph", self.W)["key"], "3_2")

    def test_marginal_windy(self):
        self.assertEqual(gear.choose_wetsuit(14.5, 15, 20, "mph", self.W)["key"], "4_5_hooded")
        self.assertEqual(gear.choose_wetsuit(14.5, 15, 5, "mph", self.W)["key"], "3_2")

    def test_unknown_water_errs_warm(self):
        self.assertEqual(gear.choose_wetsuit(None, None, None, "mph", self.W)["key"], "4_5_hooded")


class Bookings(unittest.TestCase):
    def test_synthetic_email(self):
        raw = (FIX / "wave_confirmation_synthetic.eml").read_bytes()
        cfg = dict(SETTINGS["bookings"], require_dkim=False)
        res = bookings.process_raw_messages([raw], cfg, date(2026, 9, 27), [])
        self.assertEqual(res, [{"date": "2026-10-03", "start": "08:00", "end": "09:00",
                                "setting": "Advanced Plus", "cancelled": False}])

    def test_unsigned_mail_refused_when_dkim_required(self):
        raw = (FIX / "wave_confirmation_synthetic.eml").read_bytes()
        cfg = dict(SETTINGS["bookings"], require_dkim=True)
        try:
            res = bookings.process_raw_messages([raw], cfg, date(2026, 9, 27), [])
            self.assertEqual(res, [])
        except RuntimeError:
            pass  # dkimpy not installed locally: fails closed

    def test_wrong_sender_ignored(self):
        raw = (FIX / "wave_confirmation_synthetic.eml").read_bytes().replace(b"thewave.com>", b"evil.com>", 1)
        cfg = dict(SETTINGS["bookings"], require_dkim=False)
        self.assertEqual(bookings.process_raw_messages([raw], cfg, date(2026, 9, 27), []), [])

    def test_cancellation_removes(self):
        raw = (FIX / "wave_confirmation_synthetic.eml").read_bytes()
        cancel = raw.replace(b"Subject: Your booking is confirmed", b"Subject: Booking cancelled") \
                    .replace(b"19:02:11", b"21:02:11")
        cfg = dict(SETTINGS["bookings"], require_dkim=False)
        self.assertEqual(bookings.process_raw_messages([raw, cancel], cfg, date(2026, 9, 27), []), [])

    def test_html_used_when_plain_part_is_a_stub(self):
        from email.message import EmailMessage
        m = EmailMessage()
        m["From"] = "The Wave <bookings@thewave.com>"
        m["Subject"] = "Order Confirmation 123"
        m["Date"] = "Sun, 20 Sep 2026 19:02:11 +0100"
        m.set_content("An HTML viewer is required to see this message")
        m.add_alternative("<html><body><table><tr><td>Advanced Plus</td></tr>"
                          "<tr><td>Saturday 3rd October 2026</td><td>08:00 - 09:00</td></tr>"
                          "</table><p>Thanks for your booking</p></body></html>", subtype="html")
        self.assertIn("Advanced Plus", bookings.message_text(m))
        cfg = dict(SETTINGS["bookings"], require_dkim=False)
        res = bookings.process_raw_messages([m.as_bytes()], cfg, date(2026, 9, 27), [])
        self.assertEqual(res, [{"date": "2026-10-03", "start": "08:00", "end": "09:00",
                                "setting": "Advanced Plus", "cancelled": False}])

    @staticmethod
    def _pdf(lines):
        """Minimal one-page PDF with the given text lines (Helvetica)."""
        esc = lambda x: x.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        stream = "BT /F1 11 Tf 50 750 Td 14 TL " + " ".join(f"({esc(l)}) Tj T*" for l in lines) + " ET"
        objs = ["<< /Type /Catalog /Pages 2 0 R >>",
                "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R "
                "/Resources << /Font << /F1 5 0 R >> >> >>",
                f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream",
                "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
        out, offs = "%PDF-1.4\n", []
        for i, o in enumerate(objs, 1):
            offs.append(len(out))
            out += f"{i} 0 obj\n{o}\nendobj\n"
        x = len(out)
        out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n" + "".join(f"{o:010d} 00000 n \n" for o in offs)
        out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{x}\n%%EOF\n"
        return out.encode("latin-1")

    def test_booking_read_from_pdf_attachment(self):
        try:
            import pypdf  # noqa: F401
        except ImportError:
            self.skipTest("pypdf not installed")
        from email.message import EmailMessage
        m = EmailMessage()
        m["From"] = "The Wave <noreply@thewave.com>"
        m["Subject"] = "Order Confirmation 123456"
        m["Date"] = "Sun, 20 Sep 2026 19:02:11 +0100"
        m.set_content("An HTML viewer is required to see this message")
        m.add_alternative("<p>Your surf session is booked. Please check the attached file for your "
                          "booking details, including date and time.</p>", subtype="html")
        m.add_attachment(self._pdf(["Sales receipt", "Advanced Plus", "Saturday 3rd October 2026",
                                    "08:00 - 09:00", "Total 0.00"]),
                         maintype="application", subtype="pdf", filename="receipt.pdf")
        self.assertIn("Advanced Plus", bookings.message_text(m))
        cfg = dict(SETTINGS["bookings"], require_dkim=False)
        res = bookings.process_raw_messages([m.as_bytes()], cfg, date(2026, 9, 27), [])
        self.assertEqual(res, [{"date": "2026-10-03", "start": "08:00", "end": "09:00",
                                "setting": "Advanced Plus", "cancelled": False}])

    def test_dkim_checked_as_of_receipt_not_now(self):
        try:
            import dkim
            from cryptography.hazmat.primitives import serialization
            from cryptography.hazmat.primitives.asymmetric import rsa
        except ImportError:
            self.skipTest("dkimpy/cryptography not installed")
        import base64
        import time as _time
        from unittest import mock
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        priv = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL,
                                 serialization.NoEncryption())
        pub = base64.b64encode(key.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)).decode()
        txt = ("v=DKIM1; k=rsa; p=" + pub).encode()
        # dkimpy checks both t= (not in the future) and x= (not expired) against time.time().
        # It can't sign with x=, so this uses t=: a signature made "3 days from now" fails a
        # check as of now but passes as of when it was received, the same mechanism that
        # makes Mailgun's expired x= signatures pass as of receipt.
        signed_at = int(_time.time()) + 3 * 86400
        body = (b"From: The Wave <noreply@thewave.com>\r\nSubject: Order Confirmation 1\r\n"
                b"Date: Sun, 20 Sep 2026 12:26:40 +0000\r\n\r\nYour surf session is booked.\r\n")
        with mock.patch("time.time", return_value=float(signed_at)):
            sig = dkim.sign(body, b"mta", b"thewave.com", priv, include_headers=[b"from", b"subject", b"date"])
        raw = sig + body
        orig = dkim.DKIM.verify
        with mock.patch.object(dkim.DKIM, "verify", lambda self, idx=0, dnsfunc=None:
                               orig(self, idx=idx, dnsfunc=lambda *_a, **_k: txt)):
            self.assertFalse(bookings.dkim_ok(raw, ["thewave.com"]), "checked as of now: fails")
            self.assertTrue(bookings.dkim_ok(raw, ["thewave.com"], at=signed_at + 3600), "as of receipt: passes")
            self.assertFalse(bookings.dkim_ok(raw, ["evil.com"], at=signed_at + 3600), "wrong signer")
            self.assertFalse(bookings.dkim_ok(raw.replace(b"booked", b"b00ked"), ["thewave.com"],
                                              at=signed_at + 3600), "tampered body")
            rep = bookings.dkim_report(raw, ["thewave.com"], at=signed_at + 3600)
            self.assertEqual([(r["d"], r["s"], r["verifies"]) for r in rep], [("thewave.com", "mta", True)])
        self.assertLess(_time.time(), signed_at, "time.time() restored after the check")

    @staticmethod
    def _cal_email(ics: str, subject="Order Confirmation 123456"):
        from email.message import EmailMessage
        m = EmailMessage()
        m["From"] = "The Wave <noreply@thewave.com>"
        m["Subject"] = subject
        m["Date"] = "Tue, 22 Sep 2026 14:13:00 +0100"
        m.set_content("An HTML viewer is required to see this message")
        m.add_alternative("<p>Please check the attached file for your booking details, "
                          "including date and time.</p>", subtype="html")
        m.add_attachment(ics.encode(), maintype="text", subtype="calendar", disposition="inline")
        return m.as_bytes()

    def test_booking_from_calendar_invite(self):
        cfg = dict(SETTINGS["bookings"], require_dkim=False)
        utc = ("BEGIN:VCALENDAR\r\nMETHOD:PUBLISH\r\nBEGIN:VEVENT\r\nDTSTART:20261003T070000Z\r\n"
               "DTEND:20261003T075900Z\r\nSUMMARY:The Wave - Advanced Plus \r\n (Lake)\r\n"
               "ORGANIZER;CN=The Wave:mailto:x@thewave.com\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")
        res = bookings.process_raw_messages([self._cal_email(utc)], cfg, date(2026, 9, 27), [])
        self.assertEqual(res, [{"date": "2026-10-03", "start": "08:00", "end": "09:00",
                                "setting": "Advanced Plus", "cancelled": False}], "UTC -> BST")
        winter = utc.replace("20261003T070000Z", "20261107T090000Z").replace("20261003T080000Z", "20261107T100000Z")
        res = bookings.process_raw_messages([self._cal_email(winter)], cfg, date(2026, 9, 27), [])
        self.assertEqual((res[0]["date"], res[0]["start"]), ("2026-11-07", "09:00"), "UTC -> GMT")
        tzid = ("BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART;TZID=Europe/London:20261010T173000\n"
                "DTEND;TZID=Europe/London:20261010T183000\nSUMMARY:Expert Turns\nEND:VEVENT\nEND:VCALENDAR\n")
        res = bookings.process_raw_messages([self._cal_email(tzid)], cfg, date(2026, 9, 27), [])
        self.assertEqual(res, [{"date": "2026-10-10", "start": "17:30", "end": "18:30",
                                "setting": "Expert Turns", "cancelled": False}])
        other = tzid.replace("Expert Turns", "Lake session")
        self.assertEqual(bookings.process_raw_messages([self._cal_email(other)], cfg, date(2026, 9, 27), [])[0]["setting"],
                         "Lake session", "unknown session names are kept as written")
        cancel = tzid.replace("BEGIN:VEVENT", "METHOD:CANCEL\nBEGIN:VEVENT")
        both = [self._cal_email(tzid), self._cal_email(cancel).replace(b"14:13:00", b"18:13:00")]
        self.assertEqual(bookings.process_raw_messages(both, cfg, date(2026, 9, 27), []), [], "cancelled")
        self.assertIn("DTSTART;TZID=Europe/London:20261010T173000",
                      bookings.calendar_outline(email.message_from_bytes(self._cal_email(tzid), policy=policy.default)))

    def test_text_variants(self):
        sent = datetime(2026, 9, 20, tzinfo=timezone.utc)
        t = "Expert Turns\nFri 9 Oct 2026\n5pm - 6pm"
        self.assertEqual(bookings.parse_booking_text(t, "Booking confirmed", sent)[0]["start"], "17:00")
        t2 = "Your Advanced session on 10/10/2026 at 7:30am"
        r = bookings.parse_booking_text(t2, "Booking", sent)[0]
        self.assertEqual((r["date"], r["start"], r["setting"]), ("2026-10-10", "07:30", "Advanced"))


class Layouts(unittest.TestCase):
    def test_starter_layouts_are_valid(self):
        import json
        root = Path(__file__).resolve().parent.parent / "layouts"
        files = sorted(root.glob("*.json"))
        self.assertTrue(files)
        for f in files:
            with self.subTest(layout=f.name):
                data = json.loads(f.read_text())
                self.assertEqual(data["id"], f.stem)
                validate_layout(f.stem, data)


class Storage(unittest.TestCase):
    def test_relative_folder_and_slash_keys(self):
        import os, tempfile
        from pipeline.storage import LocalStorage
        with tempfile.TemporaryDirectory() as d:
            old = os.getcwd()
            os.chdir(d)
            try:
                st = LocalStorage("out")          # relative, as the guide uses it
                st.put("layouts/a.json", b"{}")
                self.assertEqual(st.list("layouts/"), ["layouts/a.json"])
                self.assertEqual(st.get("layouts/a.json"), b"{}")
            finally:
                os.chdir(old)


class Misc(unittest.TestCase):
    def test_wind_type(self):
        self.assertEqual(wind_type_from_facing(95, 275), "offshore")
        self.assertEqual(wind_type_from_facing(275, 275), "onshore")
        self.assertEqual(wind_type_from_facing(5, 275), "cross")

    def test_tide_curve_hits_events(self):
        ev = [{"ts": 0, "type": "LOW", "height_m": 1.0}, {"ts": 22356, "type": "HIGH", "height_m": 8.0}]
        c = tides.curve(ev, 0, 22356, 22356)
        self.assertAlmostEqual(c[0]["h"], 1.0)
        self.assertAlmostEqual(c[-1]["h"], 8.0)

    def test_validate(self):
        good = {"name": "x", "spot": "saunton", "widgets": [{"id": "w1", "type": "surf", "x": 0, "y": 0, "w": 10, "h": 5}]}
        self.assertEqual(validate_layout("ok", good)["widgets"][0]["props"], {})
        for bad in ({**good, "widgets": [{**good["widgets"][0], "x": 35}]},
                    {**good, "threshold": True},
                    {**good, "widgets": [{**good["widgets"][0], "props": {"a<b": 1}}]}):
            with self.assertRaises(Invalid):
                validate_layout("ok", bad)
        with self.assertRaises(Invalid):
            validate_layout("../x", good)


if __name__ == "__main__":
    unittest.main()


class TideScale(unittest.TestCase):
    def test_fixed_scale_covers_config_and_data(self):
        from pipeline.main import tide_scale
        ev = [{"height_m": 1.4}, {"height_m": 7.6}]
        self.assertEqual(tide_scale(ev, 9.0, "CD"), {"min": 0.0, "max": 9.0})
        # a bigger tide than configured still fits (scale grows, never clips)
        self.assertEqual(tide_scale([{"height_m": 9.3}], 9.0, "CD")["max"], 9.5)
        # neap and spring days use the SAME scale
        self.assertEqual(tide_scale([{"height_m": 3.0}, {"height_m": 5.0}], 9.0, "CD"),
                         tide_scale(ev, 9.0, "CD"))

    def test_msl_scale_is_symmetric(self):
        from pipeline.main import tide_scale
        s = tide_scale([{"height_m": -3.2}, {"height_m": 3.4}], 9.0, "MSL")
        self.assertEqual(s["min"], -s["max"])
        self.assertGreaterEqual(s["max"], 4.5)


class OutlookExtension(unittest.TestCase):
    def test_days_past_surfline_are_marked_estimated(self):
        from zoneinfo import ZoneInfo
        from pipeline import main
        from pipeline.sample import sample_raws
        settings, rules = load_settings(), load_rules()
        now = datetime(2026, 9, 27, 9, 0, tzinfo=ZoneInfo("Europe/London"))
        raws = sample_raws(settings, now)
        key = next(iter(settings["spots"]))
        spot = main.build_spot(key, settings["spots"][key], raws[key], settings, rules, now)
        out = spot["outlook"]
        self.assertEqual(len(out), settings["forecast"]["outlook_days"])
        self.assertEqual([d["est"] for d in out[:5]], [False] * 5)
        self.assertTrue(all(d["est"] for d in out[5:]))
        self.assertIsNotNone(out[-1]["surf_max_m"])


class TideDays(unittest.TestCase):
    """The tide chart's Hours option (24/48/72) needs three local days of tide data."""

    def test_three_days_across_the_clock_change(self):
        from zoneinfo import ZoneInfo
        from pipeline import main
        from pipeline.sample import sample_raws
        settings, rules = load_settings(), load_rules()
        # Clocks go back at 02:00 on Sun 25 Oct 2026, so Sunday is 25 hours long.
        now = datetime(2026, 10, 24, 9, 0, tzinfo=ZoneInfo("Europe/London"))
        raws = sample_raws(settings, now)
        key = next(iter(settings["spots"]))
        t = main.build_spot(key, settings["spots"][key], raws[key], settings, rules, now)["tides"]
        days = t["days"]
        self.assertEqual([d["dow"] for d in days], ["SAT", "SUN", "MON"])
        self.assertEqual([d["end"] - d["start"] for d in days], [86400, 90000, 86400])
        self.assertEqual([days[i]["end"] for i in range(2)], [days[i + 1]["start"] for i in range(2)])
        self.assertEqual((t["day_start"], t["day_end"]), (days[0]["start"], days[0]["end"]))
        self.assertEqual((t["curve"][0]["ts"], t["curve"][-1]["ts"]), (days[0]["start"], days[-1]["end"]))
        self.assertEqual({e["day"] for e in t["events"]}, {0, 1, 2})
        for e in t["events"]:
            dd = days[e["day"]]
            self.assertTrue(dd["start"] <= e["ts"] < dd["end"])


class SurfModel(unittest.TestCase):
    """Per-spot Open-Meteo height formula ([spots.<key>.surf_model])."""

    def setUp(self):
        from pipeline.sources import openmeteo
        self.om = openmeteo
        self.spot = load_settings()["spots"]["saunton"]
        self.model = openmeteo.surf_model(self.spot)

    def test_saunton_has_model_rest_bay_falls_back(self):
        self.assertIsNotNone(self.model)
        self.assertIsNone(self.om.surf_model(load_settings()["spots"]["rest_bay"]))

    def test_matches_calibration_output(self):
        # 2025-01-01 in the calibrate run: 6.8 ft 10 s from 251 deg -> B about 7.5 ft
        hs = 6.8 / 3.28084
        lo, hi = self.om.estimate_surf_m(hs, 10, 251, self.model)
        self.assertAlmostEqual(hi * 3.28084, 7.5, delta=0.1)
        self.assertAlmostEqual(lo / hi, 0.65, delta=0.01)

    def test_angled_swell_is_smaller(self):
        straight = self.om.estimate_surf_m(1.0, 12, 275, self.model)[1]
        angled = self.om.estimate_surf_m(1.0, 12, 55, self.model)[1]  # NE, well behind the beach
        self.assertLess(angled, straight * 0.6)
        self.assertGreaterEqual(angled, 0)

    def test_no_model_keeps_generic_formula(self):
        self.assertEqual(self.om.estimate_surf_m(1.0, 10), (0.72, 1.1))

    def test_to_points_uses_peak_period_and_model(self):
        marine = [{"ts": 0, "swell_wave_height": 1.0, "swell_wave_period": 8.0,
                   "swell_wave_peak_period": 12.0, "swell_wave_direction": 275.0}]
        p = self.om.to_points(marine, [], self.model)[0]
        self.assertEqual(p["swells"][0]["period_s"], 12.0)
        self.assertAlmostEqual(p["surf_max_m"], round(1.1323 + 0.0097 * 12, 2), places=2)


class Fresh(unittest.TestCase):
    """Backup GitHub schedule skips when the Cloudflare-triggered render already ran."""

    def test_age_and_skip(self):
        import json, tempfile
        from pipeline.fresh import data_age_s, should_skip
        from pipeline.storage import LocalStorage
        with tempfile.TemporaryDirectory() as d:
            store = LocalStorage(d)
            self.assertIsNone(data_age_s(store))
            self.assertFalse(should_skip(None, 150), "no data -> render")
            store.put("data/data.json", json.dumps({"generated_ts": 1_000_000}).encode())
            self.assertEqual(data_age_s(store, now=1_000_000 + 600), 600)
            store.put("data/data.json", b"not json")
            self.assertIsNone(data_age_s(store), "unreadable data -> render")
        self.assertTrue(should_skip(30 * 60, 150))
        self.assertFalse(should_skip(150 * 60, 150))
        self.assertFalse(should_skip(4 * 3600, 150))
        self.assertFalse(should_skip(-3600, 150), "far-future timestamp -> render")


class Frames(unittest.TestCase):
    """Friends' frames: their data copy, starter layouts and settings."""

    def test_frame_data_scrubs_owners_things(self):
        from pipeline.frames import frame_data, main_frame
        data = {"bookings": [{"date": "2026-10-01"}], "home": {"name": "Hometown"}, "warnings": ["Bookings: IMAP4.error"],
                "spots": {"saunton": {"quiver": {"board_short": "Flow Stik"},
                                      "wetsuit": {"key": "3_2", "suit": "3/2 Xcel Comp+"}}}}
        friend = {"id": "jack", "prefix": "frames/jack/", "main": False, "shrink_px": 0, "home": None}
        d = frame_data(data, friend, None, [])
        self.assertEqual(d["bookings"], [])
        self.assertIsNone(d["home"])
        self.assertEqual(d["warnings"], [])
        self.assertNotIn("quiver", d["spots"]["saunton"])
        self.assertEqual(d["spots"]["saunton"]["wetsuit"]["suit"], "3/2 wetsuit")
        self.assertEqual(data["spots"]["saunton"]["wetsuit"]["suit"], "3/2 Xcel Comp+", "original untouched")
        self.assertIs(frame_data(data, main_frame(), None, []), data, "main frame unchanged")

    def test_friend_starters(self):
        import json
        from pipeline.frames import MAIN_ONLY_WIDGETS, friend_starter
        root = Path(__file__).resolve().parent.parent / "layouts"
        load = lambda n: json.loads((root / f"{n}.json").read_text(encoding="utf-8"))  # noqa: E731
        self.assertIsNone(friend_starter(load("wave-day")))
        self.assertIsNone(friend_starter(load("wave-pool-week")))
        for name in ("classic", "two-spots", "big-simple", "morning-glance", "tides-light", "dawn-patrol"):
            out = friend_starter(load(name))
            types = [w["type"] for w in out["widgets"]]
            self.assertFalse(set(types) & set(MAIN_ONLY_WIDGETS), name)
            self.assertEqual(len(types), len(set((w["x"], w["y"]) for w in out["widgets"])), name)
        self.assertEqual(len(friend_starter(load("classic"))["widgets"]), len(load("classic")["widgets"]),
                         "Board & fins box is replaced, not left empty")

    def test_settings_and_registry(self):
        import json, tempfile
        from pipeline.frames import clean_settings, load_frames
        from pipeline.storage import LocalStorage
        self.assertEqual(clean_settings({"shrink_px": 3}), {"shrink_px": 3, "home": None, "button_layout": "wave-map"})
        self.assertEqual(clean_settings({"button_layout": ""})["button_layout"], "", "button off")
        self.assertEqual(clean_settings({"button_layout": "../x"})["button_layout"], "", "bad id -> off")
        self.assertEqual(clean_settings({"shrink_px": 99})["shrink_px"], 0)
        self.assertEqual(clean_settings({"shrink_px": True})["shrink_px"], 0)
        self.assertIsNone(clean_settings({"home": {"name": "X", "lat": 95, "lon": 0}})["home"])
        with tempfile.TemporaryDirectory() as d:
            st = LocalStorage(d)
            self.assertEqual([f["id"] for f in load_frames(st)], ["main"])
            st.put("state/frames.json", json.dumps({"frames": [{"id": "jack"}, {"id": "../x"}, {"id": "main"},
                                                                {"id": "jack"}]}).encode())
            st.put("frames/jack/state/frame-settings.json", json.dumps({"shrink_px": 2}).encode())
            fs = load_frames(st)
            self.assertEqual([f["id"] for f in fs], ["main", "jack"], "bad, reserved and duplicate ids skipped")
            self.assertEqual((fs[1]["prefix"], fs[1]["shrink_px"], fs[1]["main"]), ("frames/jack/", 2, False))


class WindHours(unittest.TestCase):
    """Wind by hour: the session day's 06-21h slots, same hours as the weather strip."""

    def test_slots(self):
        from datetime import datetime, date
        from zoneinfo import ZoneInfo
        from pipeline.main import wind_hours
        zone = ZoneInfo("Europe/London")
        day = date(2026, 9, 30)
        pts = []
        for hr in range(0, 24):
            ts = datetime(2026, 9, 30, hr, 0, tzinfo=zone).timestamp()
            pts.append({"ts": ts, "wind_speed": hr + 0.4, "wind_gust": None, "wind_dir": 200.0, "wind_type": "onshore"})
        pts.append({"ts": datetime(2026, 10, 1, 6, 0, tzinfo=zone).timestamp(), "wind_speed": 99})
        out = wind_hours(pts, zone, day)
        self.assertEqual([o["t"] for o in out], ["06:00", "09:00", "12:00", "15:00", "18:00", "21:00"])
        self.assertEqual(out[0]["ws"], 6)
        self.assertIsNone(out[0]["wg"])
        self.assertEqual(out[0]["wt"], "onshore")


class Flights(unittest.TestCase):
    """Flight widget lookups: keys, parsing an AeroDataBox-style response, caching."""

    SAMPLE = [{"number": "ZZ 1234", "status": "Expected",
               "departure": {"airport": {"iata": "LGW", "municipalityName": "London"},
                             "scheduledTime": {"utc": "2026-10-06 05:40Z", "local": "2026-10-06 06:40+01:00"}, "terminal": "1"},
               "arrival": {"airport": {"iata": "FAO", "municipalityName": "Faro"},
                           "scheduledTime": {"utc": "2026-10-06 09:55Z", "local": "2026-10-06 10:55+01:00"}},
               "airline": {"name": "Ryanair"}, "aircraft": {"model": "Boeing 737-800"}}]

    def test_key_and_parse(self):
        from pipeline.flights import flight_key, parse
        self.assertEqual(flight_key("zz 1234", "2026-10-06"), "ZZ1234_2026-10-06")
        self.assertIsNone(flight_key("hello", "2026-10-06"))
        self.assertIsNone(flight_key("ZZ1234", "6/10/26"))
        f = parse(self.SAMPLE, "2026-10-06")
        self.assertEqual((f["from"], f["to"], f["dep"], f["arr"], f["terminal"]), ("LGW", "FAO", "06:40", "10:55", "1"))
        self.assertEqual(parse([], "2026-10-06"), None)

    def test_collect_and_cache(self):
        import json, tempfile
        from datetime import date
        from pipeline.flights import collect, lookup
        from pipeline.storage import LocalStorage

        class R:
            status_code = 200
            def json(self): return Flights.SAMPLE

        class S:
            calls = 0
            def get(self, url, headers=None, timeout=None):
                S.calls += 1
                assert url.endswith("/flights/number/ZZ1234/2026-10-06") and headers["X-RapidAPI-Key"] == "k"
                return R()

        with tempfile.TemporaryDirectory() as d:
            st = LocalStorage(d)
            st.put("frames/jack/layouts/a.json", json.dumps({"widgets": [
                {"type": "flight", "props": {"flight": "ZZ1234", "date": "2026-10-06"}},
                {"type": "flight", "props": {"flight": "", "date": ""}}]}).encode())
            self.assertEqual(collect(st, "frames/jack/"), {"ZZ1234_2026-10-06"})
            self.assertEqual(collect(st, ""), set())
            out = lookup({"ZZ1234_2026-10-06"}, st, date(2026, 10, 2), S(), api_key="k")
            self.assertEqual(out["ZZ1234_2026-10-06"]["to"], "FAO")
            lookup({"ZZ1234_2026-10-06"}, st, date(2026, 10, 2), S(), api_key="k")
            self.assertEqual(S.calls, 1, "second run uses the cache")
            self.assertEqual(lookup({"ZZ1234_2026-10-06"}, st, date(2026, 10, 2), S(), api_key="")["ZZ1234_2026-10-06"]["from"], "LGW")


def _grib(var_number: int, fill) -> bytes:
    """A small global GRIB2 field laid out like GFS-Wave (lat 90 -> -90, lon 0 -> 358, 2°),
    with a bitmap for land. `fill(lat, lon)` gives each value (None = missing)."""
    import eccodes
    import numpy as np
    gid = eccodes.codes_grib_new_from_samples("regular_ll_sfc_grib2")
    try:
        for k, v in (("Ni", 180), ("Nj", 91), ("latitudeOfFirstGridPointInDegrees", 90.0),
                     ("longitudeOfFirstGridPointInDegrees", 0.0), ("latitudeOfLastGridPointInDegrees", -90.0),
                     ("longitudeOfLastGridPointInDegrees", 358.0), ("iDirectionIncrementInDegrees", 2.0),
                     ("jDirectionIncrementInDegrees", 2.0), ("discipline", 10), ("parameterCategory", 0),
                     ("parameterNumber", var_number), ("bitmapPresent", 1), ("missingValue", 9999)):
            eccodes.codes_set(gid, k, v)
        lats = 90 - 2 * np.arange(91)
        lons = 2 * np.arange(180)
        vals = [fill(la, lo if lo < 180 else lo - 360) for la in lats for lo in lons]
        eccodes.codes_set_values(gid, [9999 if v is None else v for v in vals])
        return eccodes.codes_get_message(gid)
    finally:
        eccodes.codes_release(gid)


class GfsWave(unittest.TestCase):
    """NOAA GFS-Wave download + GRIB2 decoding (no network: synthetic messages)."""

    def setUp(self):
        try:
            import eccodes  # noqa: F401  (not installed on Macs; the cloud render has it)
        except Exception:  # noqa: BLE001
            self.skipTest("eccodes not installed")
        from pipeline.sources import gfswave
        self.g = gfswave
        # height = 1 + lat/100 (so we can check positions); "land" north-east of 50N 0E
        self.hs = _grib(3, lambda la, lo: None if (la >= 50 and 0 <= lo <= 10) else round(1 + la / 100, 2))
        self.dr = _grib(10, lambda la, lo: None if (la >= 50 and 0 <= lo <= 10) else 270.0)

    def test_decode_orders_and_masks(self):
        f = self.g.decode(self.hs)
        self.assertEqual(f["lats"][0], -90); self.assertEqual(f["lats"][-1], 90)
        self.assertEqual(f["lons"][0], -180); self.assertEqual(f["lons"][-1], 178)
        i, j = list(f["lats"]).index(52), list(f["lons"]).index(-10)
        self.assertAlmostEqual(f["values"][i, j], 1.52, places=2)
        self.assertTrue(math.isnan(f["values"][i, list(f["lons"]).index(4)]), "land is NaN")
        s = self.g.subset(f, -28, 47.65, 14, 60.5)
        self.assertEqual((s["lons"][0], s["lons"][-1], s["lats"][0], s["lats"][-1]), (-28, 14, 48, 60))

    def test_runs_and_idx(self):
        from datetime import datetime, timezone
        now = datetime(2026, 10, 2, 15, 50, tzinfo=timezone.utc)
        runs = self.g.candidate_runs(now, datetime(2026, 10, 2, 18, tzinfo=timezone.utc))
        self.assertEqual([(c.hour, fh) for c, fh in runs], [(12, 6), (6, 12), (0, 18), (18, 24)])
        idx = ("1:0:d=2026100212:WIND:surface:6 hour fcst:\n2:100:d=2026100212:HTSGW:surface:6 hour fcst:\n"
               "3:250:d=2026100212:SWELL:1 in sequence:6 hour fcst:\n4:400:d=2026100212:DIRPW:surface:6 hour fcst:\n")
        self.assertEqual(self.g.parse_idx(idx), {"HTSGW": (100, 249), "DIRPW": (400, None)})

    def test_fetch_with_range_requests(self):
        from datetime import datetime, timezone
        blob = b"X" * 50 + self.hs + self.dr
        idx = (f"1:0:d=x:WIND:surface:a:\n2:50:d=x:HTSGW:surface:a:\n"
               f"3:{50 + len(self.hs)}:d=x:DIRPW:surface:a:\n")
        calls = []

        class R:
            def __init__(self, code, content=b"", text=""):
                self.status_code, self.content, self.text = code, content, text

        class S:
            def get(self, url, headers=None, timeout=None):
                calls.append(url.rsplit("/", 1)[-1])
                if "t12z" in url:
                    return R(404)                       # newest run not out yet
                if url.endswith(".idx"):
                    return R(200, text=idx)
                a, b = headers["Range"][6:].split("-")
                return R(206, blob[int(a):(int(b) + 1 if b else None)])

        now = datetime(2026, 10, 2, 15, 50, tzinfo=timezone.utc)
        got = self.g.fetch(now, datetime(2026, 10, 2, 18, tzinfo=timezone.utc), (-28, 47.65, 14, 60.5), S())
        self.assertIsNotNone(got)
        self.assertEqual(got["run"].hour, 6, "fell back to the 06Z run")
        self.assertIn("gfswave.t06z.global.0p25.f012.grib2", calls)
        self.assertEqual(got["hs"].shape, got["dir"].shape)
        self.assertEqual(self.g.fetch(now, datetime(2026, 10, 2, 18, tzinfo=timezone.utc), (-28, 47.65, 14, 60.5),
                                      type("Down", (), {"get": lambda *a, **k: R(503)})()), None)


class WaveMap(unittest.TestCase):
    def test_next_slot(self):
        from datetime import datetime, timezone
        from zoneinfo import ZoneInfo
        from pipeline.wavemap import next_slot
        self.assertEqual(next_slot(datetime(2026, 10, 2, 9, 7, tzinfo=timezone.utc)).hour, 12)
        self.assertEqual(next_slot(datetime(2026, 10, 2, 12, 0, tzinfo=timezone.utc)).hour, 15, "strictly after")
        self.assertEqual(next_slot(datetime(2026, 10, 2, 23, 7, tzinfo=ZoneInfo("Europe/London"))).hour, 0)

    def test_projection_round_trip(self):
        from pipeline.wavemap import DEFAULT_BOX, MAP_W, Proj
        p = Proj(DEFAULT_BOX)
        self.assertAlmostEqual(float(p.x(DEFAULT_BOX["east"])), MAP_W)
        self.assertAlmostEqual(float(p.lat(p.y(51.1))), 51.1, places=6)
        self.assertTrue(400 <= p.h <= 440, "fits the 40x21 map under a header")

    def test_sample_block_and_reuse(self):
        import json as _json
        from datetime import datetime
        from zoneinfo import ZoneInfo
        from pipeline import wavemap
        from pipeline.storage import LocalStorage
        import tempfile
        settings = load_settings()
        now = datetime(2026, 10, 2, 16, 50, tzinfo=ZoneInfo("Europe/London"))
        z = ZoneInfo("Europe/London")
        b = wavemap.build(None, settings, now, None, z, sample=True)
        self.assertEqual(b["valid"], "Fri 19:00")
        self.assertEqual(len(b["bands"]), 3); self.assertTrue(all(b["bands"]))
        self.assertTrue(b["land"].startswith("M") and b["arrows"] and b["labels"])
        self.assertEqual([s[2] for s in b["spots"]], ["Saunton", "Rest Bay"])
        self.assertLess(len(_json.dumps(b)), 150_000)
        for x, y, d, band in b["arrows"]:
            self.assertTrue(0 <= x <= b["w"] and 0 <= y <= b["h"] and 0 <= d < 360 and 0 <= band <= 3)
        with tempfile.TemporaryDirectory() as tmp:
            st = LocalStorage(tmp)
            down = type("Down", (), {"get": lambda *a, **k: type("R", (), {"status_code": 503})()})()
            self.assertIsNone(wavemap.build(st, settings, now, down, z), "nothing cached yet")
            st.put(wavemap.CACHE_KEY, _json.dumps(b).encode())
            old = wavemap.build(st, settings, now, down, z)
            self.assertTrue(old["stale"], "last good map reused, marked old")
            from datetime import timedelta
            later = now + timedelta(hours=9)    # by 01:50 the 19:00 map is over 6 h old
            self.assertIsNone(wavemap.build(st, settings, later, down, z), "too old to reuse")


class SurflineOff(unittest.TestCase):
    """[sources] surfline = false (the default): Surfline is never contacted."""

    def test_gather_skips_surfline(self):
        from unittest import mock
        from pipeline import main
        from pipeline.sources import openmeteo, surfline
        settings = load_settings()
        self.assertFalse(settings["sources"]["surfline"])
        boom = mock.Mock(side_effect=AssertionError("Surfline was called"))
        with mock.patch.object(surfline, "fetch", boom), mock.patch.object(surfline, "fetch_tides", boom), \
                mock.patch.object(openmeteo, "fetch_marine", return_value=[]), \
                mock.patch.object(openmeteo, "fetch_weather", return_value=[]):
            raw = main.gather("saunton", settings["spots"]["saunton"], settings, None)
        boom.assert_not_called()
        self.assertFalse(any("Surfline" in w for w in raw["warnings"]), "no Surfline warning when it's off")
