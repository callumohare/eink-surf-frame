# E-ink surf frame — forecast display for the TRMNL 7.5" DIY kit

A framed e-ink screen on your desk that shows the surf forecast for your beaches: surf height,
swell, wind, tides, light, wetsuit and board picks, a multi-day outlook, a wave-height map and
more, in layouts you design yourself. It updates every 3 hours, runs on free cloud tiers, and
nothing at home stays switched on.

**New here? Start with the step-by-step guide: [`docs/SETUP-GUIDE.pdf`](docs/SETUP-GUIDE.pdf).**
It assumes no coding experience and takes about 3–4 hours spread over a few sessions, plus
building the frame. The rest of this README is the technical reference.

Hardware: the Seeed **TRMNL 7.5" (OG) DIY Kit**, running TRMNL's own open-source firmware
pointed at your own server (no TRMNL account or licence needed). Licence: MIT (see `LICENSE`).

How it works: renders the 800×480 e-ink image every 3 hours in the cloud, with a private web
**studio** where you can see every layout rendered with live data, pick which one the frame
shows, and edit layouts like phone-home-screen widgets (drag, resize, add, remove, per-widget
settings).

```
GitHub Actions (private repo, every 3 h)             Cloudflare
┌────────────────────────────────────────┐           ┌─────────────────────────────────────┐
│ NOAA waves┐                            │           │ R2 bucket "surf-frame" (private)    │
│ Open-Meteo├─► data.json ─► Chromium ───┼─ S3 API ─►│  layouts/  state/  data/  renders/  │
│ ADMIRALTY ┘   (spot logic,   renders   │           │        ▲                   │        │
│ Gmail IMAP ─► Wave bookings  each      │           │        │ read/write        │ read   │
│               wetsuit, board layout)   │           │  surf-frame-studio   surf-frame-img │
└────────────────────────────────────────┘           │  (behind Access)     (token URL)    │
                                                     └────────┬───────────────────┬────────┘
                                          you, in a browser ◄─┘       e-ink frame ◄┘
```

* **One renderer, two places.** `web/render-core.js` draws the widgets in your browser
  (the editor is WYSIWYG) and in headless Chromium in the cloud job. Pillow then
  quantises to 1-bit (default) or 4 greys.
* **Gallery = selection.** Every layout is rendered every run. The frame's URL always
  serves whichever layout is selected, so switching is instant and needs no reflash.
* **Nothing at home stays on.** GitHub Actions + Cloudflare free tiers.

## What's on the frame (widgets)

| Widget | Shows |
|---|---|
| Date & header | Date; first light, sunrise, sunset, last light (outline icon = first/last light, solid = sunrise/sunset; rise/set drop first if tight); moon; spot and "Updated HH:MM" at Full |
| Surf height & rating | Surf range in feet (or metres, see below), body-height text, 5-block rating. "ft est." when it comes from the Open-Meteo estimate |
| Swell | Up to 3 swells: height, period, direction arrow, compass + degrees |
| Wind | Speed, gust, direction arrow, offshore/cross/onshore, optional next-hours strip |
| Tide times / Tide chart | HW/LW times & heights (today, optionally tomorrow); curve on a fixed per-spot scale, so neaps look small next to springs — chart shows 24, 48 or 72 hours from midnight today (Hours option) |
| Surf & wind chart | 24/48/72 h bars (solid = min, outline = max), night shading, hour marks along the bottom, then wind arrows with the speed beside each (filled = offshore/cross-off; wind needs 6+ rows) |
| Wind by hour | Wind for the session day's 06–21 h slots: arrow + speed, gusts at Full. Fits 11 × 4 (8 × 4 shows the middle 4 hours) |
| Sun & light | First light, sunrise, sunset, last light (civil twilight) |
| Water temp + wetsuit / Wetsuit | Sea temp and 3/2 vs 4.5/3.5 hooded, with the reason; the suit model fits down to 8×4 at Full |
| Board & fins | From `config/board_fin_rules.json` + the modifiers in the guide |
| Best windows | Best daylight windows today (or tomorrow after last light) |
| Multi-day outlook | 3–7 days: range with the morning wind beside it (arrow + mph), rating, optional weather icon, first/last light at Full. With Surfline on, days past its range are Open-Meteo estimates marked "~" |
| The Wave booking | Next session(s): date, time, setting. Options: blank when none booked; invert (white on black) on the day of a session |
| Flight | Flight number + date → airport codes with a plane between them, date and departure time, days to go, arrival time; terminal/status/airline at Full. Optional "show automatically" N days/weeks before: it then takes the bottom-right corner at its own size and the widget there shrinks (e.g. outlook 40×5 → 32×5), and disappears after the flight day. Details come from AeroDataBox if `AERODATABOX_KEY` is set (cached in `cache/flights/`), or from the widget's own From/To/Departs/Arrives boxes (these always win) |
| Wave map | NOAA GFS-Wave significant wave height around the UK at the next 3-hourly time after the render: four shades (levels adapt to the day, e.g. 0–1 / 1–2 / 2–3 / 3+ m), contour labels, arrows for which way the waves are travelling, the coastline and the surf spots. Free, no key; the last good map is reused for up to 6 h if NOAA is unreachable. Area in `[map]` in settings.toml. Starter layout "Wave map" = header + full-size map |
| All spots summary | One line per spot (the "display output suggestion" from the guide) |
| Text note, Credits & status | Free text; data sources and credits |

Wind arrows have a tail (a short shaft behind the head); swell arrows don't.

Surf and swell heights are in **feet** by default (`units.wave` in `config/settings.toml`;
set it to `"m"` for metres). Tides are in metres. The board rules work on the top of the
range in feet. Wind defaults to **mph**. All times are Europe/London.

## Local use (design layouts on your laptop)

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m playwright install chromium
python -m pipeline.main --sample --out out     # synthetic data, no network, renders out/renders/*.png
python -m pipeline.devserver --out out --sample # studio at http://127.0.0.1:8787
python -m pipeline.main --out out               # same, with live data (set env vars below)
python -m unittest discover -s tests -t .       # Python tests
node tests/workers.test.mjs                     # Worker tests (Access JWT, token, validation)
```

## Cloud setup (one-off, ~45 min)

### 1. Cloudflare (MFA on the account first)
1. **R2 → Create bucket** `surf-frame`. Leave public access **off** (no r2.dev URL, no custom domain).
2. **R2 → Manage API tokens → Create** — *Object Read & Write*, **this bucket only**. Note the
   Access Key ID, Secret and your Account ID.
3. **Zero Trust** (free plan): set it up if you haven't, and add an identity method
   (One-time PIN to your email is fine; GitHub/Google work too).
4. Deploy the Workers (Node 20+):
   ```bash
   cd workers/frame-img && npx wrangler deploy
   python -c "import secrets; print(secrets.token_urlsafe(32))"   # device token
   npx wrangler secret put DEVICE_TOKEN
   cd ../studio && npx wrangler deploy
   ```
5. **Workers & Pages → surf-frame-studio → Access → Protect this Worker behind Access →
   All traffic**, policy: *Emails* = your address. Then in **Zero Trust → Access →
   Applications** open that app and copy its **Application Audience (AUD) tag**.
6. Edit `workers/studio/wrangler.toml` `[vars]`: `ACCESS_TEAM_DOMAIN`
   (`<team>.cloudflareaccess.com`), `ACCESS_AUD`, `ALLOWED_EMAILS`, `GH_REPO`, then
   `npx wrangler deploy` again. The Worker **refuses everything** until these are set.
7. Leave **surf-frame-img public**. If you ever turn on "Protect all Workers", add a
   Worker-level bypass for it (the ESP32 can't log in).

### 2. GitHub (private repo, MFA on)
1. Make your own **private** copy: on this repo's GitHub page click **Use this template → Create a
   new repository → Private** (private repos don't hit the 60-day schedule pause).
2. **Settings → Environments → New environment** `production`; restrict it to `main`.
   Add secrets: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`,
   `ADMIRALTY_KEY`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`.
3. **Settings → Secrets and variables → Actions → Variables → New repository variable**
   `SURF_FRAME_READY` = `true`. Until it exists the render and deploy workflows do nothing.
4. **Actions → render → Run workflow** once. Then open the studio URL.
5. Optional **Render now** button: fine-grained PAT, *only this repo*, *Actions: Read and
   write*, 90-day expiry → `cd workers/studio && npx wrangler secret put GH_TOKEN`.
   The Worker rate-limits it to once per 5 minutes.

Minutes: ~2–3 min per run × 8/day ≈ 600–700 of the 2,000 free private-repo minutes a month.

### 3. ADMIRALTY tide stations
```bash
ADMIRALTY_KEY=... python -m pipeline.find_station             # 5 nearest stations to each spot
```
Put the IDs in `config/settings.toml` (`admiralty_station`). Until then tides fall back to
Open-Meteo sea level (heights relative to MSL, not chart datum).

### 4. The Wave booking emails (Gmail → dedicated Gmail → IMAP)
1. Create a **new Gmail account** just for this. Turn on 2-Step Verification, then create an
   **app password** at myaccount.google.com/apppasswords → `GMAIL_USER` / `GMAIL_APP_PASSWORD`.
   Nothing else ever goes to this inbox, so the credential can only read booking mail.
2. In **your** Gmail: Settings → See all settings → **Forwarding and POP/IMAP → Add a
   forwarding address** → the new address → confirm with the code sent there. Leave the
   global setting on *Disable forwarding* — you only want the filter below.
3. Create a filter: **From** `thewave.com` (check the real sender first — the booking system
   may use another domain; update `sender_domains` to match) → **Forward it to** the new address.
4. Test the parser on a real confirmation: in Gmail, ⋮ → *Download message* → then
   `python -m pipeline.bookings --parse ~/Downloads/booking.eml`. That also checks DKIM.

Only date, start/end time and the wave setting are stored — no names, references or prices.
Mail must come from an allow-listed domain **and** carry a valid DKIM signature for it, so
a spoofed email can't put fake sessions on the frame. Gmail filters don't forward mail that
arrived before the filter existed, and manually forwarding breaks DKIM — so the first
booking to appear will be the next one you make.

## Automatic updates

Four GitHub workflows keep everything hands-off once set up:

| Workflow | Runs when | Does |
|---|---|---|
| `test` | every pull request; before every render/deploy triggered by a change | Python + Worker tests, renders every layout with sample data in strict mode, uploads the preview PNGs |
| `render` | every 3 h, after changes to `pipeline/`, `web/`, `config/`, `layouts/`, by hand, or "Render now" | fetch → render → upload (tests first unless it's a scheduled run) |
| `deploy-websites` | after changes to `workers/` or `web/` on `main` | tests, then `wrangler deploy` for both Workers, using a token held only in the `cloudflare-deploy` environment |
| Dependabot (optional) | weekly | rename `.github/dependabot.example.yml` to `dependabot.yml` for weekly update pull requests |

So a change is: pull request → green tests + preview pictures → merge → live within minutes.
The deploy token (Cloudflare "Edit Cloudflare Workers" template, your account only) lives in a
separate environment the render job never sees. GitHub Free doesn't offer branch protection on
private repos, so nothing *forces* the tests to pass before a merge: only merge green PRs.

## Pointing the frame at it (TRMNL firmware)

The Seeed TRMNL 7.5" kit runs TRMNL's own open-source firmware, pointed at the
`surf-frame-img` Worker instead of trmnl.app. No firmware is built here, and no TRMNL
licence is needed. The firmware wakes, asks the Worker what to show, downloads the picture,
draws it (2-bit PNG -> 4 greys, full refresh; 1-bit PNG -> black and white, partial
refresh) and sleeps until a little after the next scheduled render.

Worker side (once):

```
cd workers/frame-img
npx wrangler secret put DEVICE_TOKEN     # if not set already: python -c "import secrets; print(secrets.token_urlsafe(32))"
npx wrangler deploy                      # or push to main and let deploy-websites do it
```

Device side: **follow [`docs/DEVICE-SETUP.md`](docs/DEVICE-SETUP.md)** (guest Wi-Fi, bench test,
flashing, Custom Server, registering the MAC in `DEVICE_MACS`, checks, fitting into the frame,
buttons, troubleshooting). Short version: flash from https://trmnl.com/flash, join the `TRMNL`
hotspot, Advanced -> Custom Server -> `https://surf-frame-img.<sub>.workers.dev` (no trailing
slash), copy the MAC from the `setup_refused` log line into `wrangler secret put DEVICE_MACS`,
press RESET.

Layouts set to **4 greys** in the studio go to the frame as 2-bit greyscale PNGs; **black & white**
layouts as 1-bit PNGs.

**KEY3 button (no firmware change):** pressing it wakes the frame, the firmware tells the Worker why
it woke (`Update-Source: EXT1`, or `EXT0` / `button` depending on the chip), and the Worker
switches between the normal layout and the **button layout** (Frame settings → Button; default the
"Wave map" starter, or "Nothing"). Press again to go back; the next scheduled wake always goes back.
Works on friends' frames too. The Worker keeps one tiny file per frame (`state/button.json`) to
remember which picture is showing.

Device API (checked against the usetrmnl/trmnl-firmware source, Sep 2026):

| Call | Auth | Answer |
| --- | --- | --- |
| `GET /api/setup` (`ID: <MAC>`) | MAC must be in `DEVICE_MACS` | `api_key` = `DEVICE_TOKEN`, `friendly_id` "SURF", white setup logo |
| `GET /api/display` | `Access-Token` header | `status 0`, `image_url`, `filename` (changes with every render, so the frame only redraws when the picture changed), `refresh_rate` |
| `GET /api/image/<filename>.png` | `Access-Token` header | the selected layout's PNG |
| `POST /api/log` | `Access-Token` header | firmware logs -> Workers Logs |
| `GET /api/setup-logo.bmp` | none (the firmware fetches it without a key) | plain white 800x480 1-bit BMP |

A known MAC with an out-of-date key (after rotating `DEVICE_TOKEN`) is told to re-pair; it then
picks up the new key by itself. The server never offers a firmware update.

**Fallback: ESPHome.** The plain URL `/frame/<DEVICE_TOKEN>.png` (or `.bmp`) still works,
e.g. for a browser check or ESPHome. ESPHome's 7.50inV2 driver is 1-bit only. Minimal
pieces, **unverified against current ESPHome docs**:

```yaml
http_request:
  verify_ssl: true             # keep TLS verification on
online_image:
  - id: forecast
    url: !secret frame_url     # the token URL above, kept in secrets.yaml
    format: PNG                # or BMP
    type: BINARY
    on_download_finished:
      - component.update: epaper
```

## Friends' frames

Friends can run their own frame on this setup: same forecast, their own layouts, chosen by
them in the studio. They buy the same kit, flash TRMNL's firmware and type in a server
address you send them — you never need to handle the frame. See the setup guide's appendix.

- **One-off (you):** `npx wrangler secret put FRAME_SECRET` on **both** Workers, with the same
  32+ random characters (`python -c "import secrets; print(secrets.token_hex(24))"`).
- **Per friend (you):** Studio → *Friends' frames* → add their name and login email → copy
  the server address `https://surf-frame-img.<you>.workers.dev/f/<id>/<code>`. Then add the
  same email to the Cloudflare Access policy for the studio. The frame appears at the next render
  (or press Render now).
- **What they get:** their own `frames/<id>/` in the bucket (layouts, selection, renders, data),
  the frame picker hidden, and the Frame settings dialog (edge margin, home town for weather).
  Their data never contains your Wave bookings, your home, your board picks or your wetsuit
  model names; The Wave and Board & fins widgets are hidden for them. Starter layouts named
  after The Wave aren't copied to them.
- **Removing one:** Friends' frames → Remove. Their files are deleted and their frame gets
  404s (it keeps its last picture). Also take their email off the Access policy.
- **Pairing:** the code in the address and the frame's key are both HMACs of `FRAME_SECRET`,
  so there is nothing per-friend to store. Changing `FRAME_SECRET` changes every friend's
  address — they'd have to type in the new one.
- **Edge margin** (Frame settings, any frame): 0–20 px of white border on every edge for tight
  mounts; the browser draws the whole layout smaller, so text stays sharp.

## Security notes

* **Public surface:** one Worker that answers `404` to everything except the exact
  token URL and the TRMNL device API (key in a header, SHA-256 + constant-time compare,
  pairing limited to listed MACs, read-only R2 use apart from the KEY3 state file written after the key check, optional per-IP rate limit). Rotate with
  `wrangler secret put DEVICE_TOKEN`; the frame re-pairs by itself.
* **TRMNL firmware and TLS:** the firmware talks HTTPS but calls `setInsecure()`, so it does
  **not check the server's certificate** (verified in `lib/trmnl/include/http_client.h`).
  Traffic is encrypted, but someone who can intercept the frame's network could impersonate
  the server: show it a different picture, or send it a firmware update URL (which the real
  Worker never does). Keep the frame on the guest/IoT network with client isolation. A MAC
  address isn't a secret, so the MAC allow-list only stops casual pairing; what it guards is a
  surf forecast image.
* **Studio:** Cloudflare Access in front, plus the Worker re-verifies the Access JWT
  (signature, `aud`, `iss`, `exp`, email allow-list) on every request including static files,
  same-origin check on writes, schema validation, strict CSP, no `innerHTML`, no preview URLs.
  Denials and changes are logged as JSON to Workers Logs.
* **Data stays private:** forecast data lives only in the private bucket and behind
  Access; the public URL serves only the rendered picture.
* **CI:** `permissions: contents: read`, secrets scoped to an environment, checkout without
  persisted credentials, Chromium refuses all network requests during rendering (fonts are
  self-hosted, data is injected).
* **Failure mode:** if every source fails, nothing is overwritten — the frame keeps the last
  good image, its "Updated" time goes stale, and the failed run emails you.

## Unverified details (check before relying on them)

* **Surfline** (off by default, `[sources] surfline` in settings): the code uses the endpoints
  Surfline's own website uses (community reverse-engineering, no official API). Check their terms
  of use before turning it on: they restrict automated access, and they've refused requests from
  GitHub since Sept 2026.
* **ADMIRALTY** `DateTime` is assumed to be UTC.
* **The Wave** sender domain and email format: parser built without a real sample.
* **TRMNL firmware:** API, image formats and PNG decoding were checked against the firmware
  source and work on a real kit (Sept 2026, 4 greys confirmed). The web-flasher label for the
  Seeed kit may differ slightly.
* **ESPHome** fallback snippet above.
* **NOAA GFS-Wave** (Wave map): bucket path/file names (`noaa-gfs-bdp-pds`, `gfswave.tHHz.global.0p25.fFFF.grib2`),
  the `.idx` format and DIRPW being the direction waves come *from* — taken from NOAA's docs, not fetched from
  the sandbox. If the arrows point away from the UK on a westerly swell, the direction is the other convention.
* **KEY3 button:** the `Update-Source` values were checked in the firmware source (`logging_parsers.cpp`),
  not yet on the real kit. The Worker logs show `"source"` and `"button_layout"` for every wake.
* **GitHub Action versions** (`checkout@v5`, `setup-python@v6`, `cache@v4`) — pin to SHAs.
* **Workers rate-limit binding** syntax (commented out in `workers/frame-img/wrangler.toml`).
* **Beach facing angles** (Saunton 275°, Rest Bay 250°) — only used on the Open-Meteo fallback.
* **Wetsuit thresholds** and the heuristic score are starting points — tune them in
  `config/settings.toml` after a few sessions.

Fonts: Inter and Barlow Condensed, SIL Open Font License (see `web/fonts/`).
