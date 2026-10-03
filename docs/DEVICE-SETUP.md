# Surf Frame — device setup (Seeed TRMNL 7.5" OG DIY kit)

Everything needed to get the kit from the box to showing your forecast, apart from the
Cloudflare/GitHub cloud setup in `README.md` (do that first). About an hour, plus a day of
bench testing before it goes into the frame.

**How it works:** the kit runs **TRMNL's own open-source firmware**, pointed at your
`surf-frame-img` Worker instead of trmnl.app. You don't build any firmware and you don't
need a TRMNL licence or account. Every few hours the frame wakes, asks the Worker what to
show, downloads the picture (4 greys for 4-grey layouts), draws it and goes back to sleep.

Checked against the firmware source (usetrmnl/trmnl-firmware, 21 Sep 2026) and Seeed's wiki.
Not yet tried on your kit. Anything marked **(check)** is worth confirming as you go.

---

## 0. Have ready

- [ ] The kit: XIAO ePaper driver board, 7.5" panel, FPC extension cable + adapter, 2000 mAh battery, antenna.
- [ ] A **data** USB-C cable. Many cables are charge-only; if the PC doesn't see the board, swap the cable first.
- [ ] A Windows PC with **Chrome or Edge** (the flasher uses Web Serial; Firefox can't).
- [ ] Your phone (to set up the frame's Wi-Fi).
- [ ] The cloud setup from `README.md` done: the render workflow has run at least once and
      `surf-frame-img` is deployed with `DEVICE_TOKEN` set.
- [ ] A terminal in your `surf-frame` folder with Node 20+ (for `npx wrangler`).
- [ ] Router admin access (for the guest network).

---

## 1. Update the Worker (the new TRMNL endpoints)

The Worker gained the TRMNL device API on 28 Sep. Get it live:

1. Commit and push to `main`. The `deploy-websites` workflow tests and deploys both Workers,
   and `render` re-publishes the images (4-grey layouts are now 2-bit PNGs).
   Or deploy by hand: `cd workers\frame-img` → `npx wrangler deploy`.
2. Note the Worker's address. It's printed by `wrangler deploy`, or in the Cloudflare
   dashboard under **Workers & Pages → surf-frame-img → Settings → Domains & Routes**. It
   looks like `https://surf-frame-img.<your-subdomain>.workers.dev`.
3. Quick check in a browser:
   - `https://surf-frame-img.<sub>.workers.dev/frame/<DEVICE_TOKEN>.png` → your forecast picture.
   - `https://surf-frame-img.<sub>.workers.dev/api/display` → `Not found` (no key, as it should be).

Keep the Worker's live log open for the rest of the setup. It's where the frame's MAC
address, battery and signal show up:

```
cd workers\frame-img
npx wrangler tail surf-frame-img --format pretty
```

(Or Cloudflare dashboard → **Workers & Pages → surf-frame-img → Logs**; `observability` is on.)

---

## 2. Give the frame its own Wi-Fi (guest / IoT network)

The TRMNL firmware talks HTTPS but **doesn't check the server's certificate**, so keep the
frame away from your main devices.

1. In your router: enable a **guest** (or IoT) network on **2.4 GHz** (the ESP32-S3 has no 5 GHz).
2. Security **WPA2** (or WPA2/WPA3 mixed) with its own strong password.
3. Turn on **client isolation** (often "Allow guests to see each other" = off) and turn off
   "Allow access to local network".
4. If the router only offers a combined 2.4 + 5 GHz name, that's usually fine. If the frame
   won't join, split the bands or make a 2.4 GHz-only guest SSID.

---

## 3. Bench test the hardware (before any frame work)

Do this on a table with the parts loose. The panel's ribbon is fragile: don't fold it, and
don't lift the panel by it.

1. **Power switch OFF.**
2. **Antenna:** clip it onto the board's antenna socket (small round U.FL connector); press
   straight down until it clicks.
3. **Panel ribbon (FPC):** open the connector's latch on the driver board (flip it up gently).
   Slide the ribbon in with the **metal contacts facing UP**, all the way, square. Close the
   latch. The wrong way round gives a blank screen, not damage, but be gentle.
   Test with the ribbon **plugged straight into the board**, without the extension, first.
4. **Battery:** plug the JST lead in (red to +, black to −; it only fits one way). Check the
   lead isn't pinched.
5. Leave the switch off for now; USB power is enough for flashing.

### Panel label

The sticker on the ribbon (`HT075A04**662061C517`) looks like the maker's part/batch code.
It doesn't match any public datasheet I could find, so it doesn't pin down the exact panel.
It doesn't need to: Seeed ships one panel with this kit (UC8179 controller, Waveshare 7.5"
V2 type), and the firmware reads the controller's own ID at start-up. After pairing, the
Worker log shows it as `"panel_rev": "…"` on every check-in. Write that down alongside the
sticker; it's the reliable identifier.

---

## 4. Flash the TRMNL firmware

1. Plug the board into the PC with the data cable.
2. Open **https://trmnl.com/flash** in Chrome or Edge.
3. **Select your device:** choose the Seeed 7.5" OG DIY kit build. The firmware's build name
   is `TRMNL_7inch5_OG_DIY_Kit`; the flasher's label may read slightly differently **(check)**.
   Seeed says to use **firmware 1.5.12 or newer**; take the newest offered.
4. Click **Connect** and pick **USB JTAG/serial debug unit (COMx)**.
5. Choose **Install**. If asked, allow erasing the device. It takes 1–2 minutes. Don't unplug.
6. **If the board isn't listed or the install fails:** unplug, **hold BOOT**, plug the USB
   back in while holding it, release BOOT, then Connect again. (Also try another cable/port.)
7. When it finishes, the panel should refresh (flashing black/white is normal) and show
   TRMNL's Wi-Fi setup screen. **That proves panel, ribbon and board.**
   Blank panel? Power off, re-seat the ribbon (metal up, fully in, latch closed) and press RESET.

---

## 5. Connect it to Wi-Fi and to your server

1. On your phone, join the Wi-Fi network **`TRMNL`** (no password). The setup page should
   open by itself; if not, browse to **http://4.3.2.1**.
2. Choose your **guest network** and enter its password.
3. Tap **Advanced → Custom Server → Yes** (TRMNL's wording; labels may differ slightly by version **(check)**) and enter your Worker's address exactly:
   `https://surf-frame-img.<your-subdomain>.workers.dev`
   - **no trailing slash**, nothing after `.dev`, and it must start with `https://`.
4. Save / Connect. The page may flash the frame's **MAC address** for a second or two; note
   it if you catch it (not essential).
5. The frame joins Wi-Fi and calls your Worker. It's **refused** this first time, because its
   MAC isn't on the list yet. The screen shows a "not registered" message, and the
   `wrangler tail` window shows:
   ```
   {"event":"setup_refused","mac":"A1B2C3D4E5F6","model":"xiao_epaper_display","fw":"1.x.x"}
   ```
   (Nothing in the log? See Troubleshooting: Wi-Fi or server address.)

---

## 6. Register the frame and pair

1. Copy the `mac` value from that log line and add it as a Worker secret:
   ```
   cd workers\frame-img
   npx wrangler secret put DEVICE_MACS
   ```
   Paste the MAC (colons optional) and press Enter. This takes effect immediately.
2. Press **RESET** on the board (or press **KEY3**, the button next to RESET, once). If you do nothing, it retries by itself within about 5 minutes.
3. The log should now show:
   ```
   {"event":"setup_ok","mac":"…D4E5F6","fw":"…","panel_rev":"…"}
   {"event":"display","mac":"…D4E5F6","battery_v":"4.1","rssi":"-58","panel_rev":"…","next_s":5400}
   ```
   The screen briefly shows the setup screen with **SURF**, then your selected layout.
4. **Check the greys:** the starter layouts are all set to "4 greys". The ratings bars, tide
   curve fill and chart shading should show two distinct greys. A 4-grey update is a full
   refresh, so a few seconds of black/white flashing is normal. To compare with black and
   white, set a layout to "Black & white (1-bit)" in the studio, press **Render now**, then
   press KEY3 on the frame.

`next_s` is how long it will sleep: until 25 minutes after the next 3-hourly render. In UK
summer time the frame updates at about **01:32, 04:32, 07:32, 10:32, 13:32, 16:32, 19:32
and 22:32** (an hour earlier in winter, because the schedule is in UTC).

---

## 7. Leave it on the bench for a day

Before building it into the frame:

- [ ] Switch the **power switch ON** and unplug USB. It should keep updating on battery.
- [ ] Watch for check-ins at the times above (dashboard **Logs** keeps history; `wrangler tail`
      only shows live).
- [ ] Note `battery_v` each time. Full is about 4.1–4.2 V. Recharge (USB-C) when it gets
      to about 3.5 V. Seeed rates about 3 months at 6-hourly, so expect roughly 6 weeks at 3-hourly
      (4-grey full refreshes use a bit more).
- [ ] Note `rssi`. Better than about −70 is comfortable. Worse than −80 means move the
      frame or antenna.
- [ ] Press **KEY3** once: it should fetch and redraw straight away (handy after "Render now").

---

## 8. Build it into the frame

From the project context: 8×6" desk frame, bevelled mount with a 162 × 97 mm opening,
offset to the panel's active area (the ribbon edge has the wider blank "chin").

1. **Panel into the mount:** lay the mount face down on a soft cloth. Place the panel face
   down with the ribbon edge on the side you planned for the chin, and centre the
   **active area** (not the glass) in the opening. Before fixing, power it up once to check
   the image is square in the window.
2. **Fix the panel** with thin tape at the edges of the glass (Kapton or low-tack), not glue.
   Don't press on the panel face or bend it; the glass is thin.
3. **Backing board:** feed the ribbon through a slot or around the edge of the backing board
   without a sharp fold. If it won't reach the board comfortably, use the **FPC extension
   cable + adapter**: same rule, metal contacts **up** at each connector. Re-test the screen
   after adding it before you close up.
4. **Driver board** on the back of the backing board: small self-adhesive standoffs or
   foam pads. Keep **USB-C reachable** for charging and the **power switch, RESET and KEY3**
   reachable (or at least reachable by opening the back).
5. **Battery:** foam tape, flat, not squeezed by the frame back, away from sharp screw points
   and off anything warm. Don't pierce, crush or bend a Li-ion pouch.
6. **Antenna:** stick the flat antenna to the backing board as high and as far from the
   battery and metal as you can. If the signal is poor, bring it outside the frame back.
7. Close up, stand it on the desk, press KEY3, and check the image and the next check-in.

---

## Buttons (TRMNL firmware)

| Button | Press | Does |
| --- | --- | --- |
| **RESET** | click | Restart (then fetches and draws). |
| **KEY3** (next to RESET) | click | Wake and refresh now. |
| KEY3 | hold ~1–5 s | "Double-click" action (nothing useful with this server). |
| KEY3 | hold **5 s** | Forget Wi-Fi and start the `TRMNL` setup hotspot again (change network or server address). |
| KEY3 | hold **15 s** | Full soft reset: wipes all its settings (Wi-Fi, key **and the custom server address**) and restarts into setup. Redo steps 5–6 (the MAC stays registered, so it pairs straight away). |
| **BOOT** | hold while plugging in USB | Flashing mode (only for re-flashing). |
| KEY1 / KEY2 | — | Not used by the TRMNL firmware. |

---

## Troubleshooting

| What you see | Likely cause → fix |
| --- | --- |
| PC doesn't see the board / flasher lists nothing | Charge-only cable, or not in flashing mode → other cable; hold BOOT while plugging in. |
| Panel stays blank after flashing | Ribbon upside down or not fully in → metal side **up**, fully in, latch closed, RESET. |
| `TRMNL` hotspot never appears | Already has Wi-Fi saved → hold KEY3 5 s. |
| Joins Wi-Fi but nothing in the Worker log | Wrong server address (trailing `/`, typo, `http://`), or guest network blocks the internet → re-enter via KEY3 5 s. |
| Screen says "not registered" after you added the MAC | It retries every 5 minutes → press RESET or KEY3 to go now. Check the MAC in `DEVICE_MACS` matches the log exactly. |
| Log shows `display_bad_token` | You rotated `DEVICE_TOKEN`. It re-pairs by itself on the next wake, or press RESET. |
| Picture never changes | The render hasn't produced a new image (check the `render` workflow), or it's asleep until `next_s` → press KEY3. |
| Only black and white, no greys | The selected layout is "Black & white (1-bit)" → set "4 greys" in the studio and Render now. |
| Faint ghosting | Normal on e-ink between full refreshes. 4-grey updates are always full refreshes, which clear it. |
| Weak signal errors | Move the antenna outside the frame back or the frame nearer the router. |

---

## Security checklist

- [ ] Frame on the guest/IoT network with client isolation (the firmware doesn't verify TLS certificates).
- [ ] `DEVICE_TOKEN` is 32+ random characters, only in the Worker secret (never in the repo).
- [ ] `DEVICE_MACS` lists only your frame.
- [ ] MFA on Cloudflare and GitHub.
- [ ] The Worker never offers firmware updates; the frame only changes firmware when you
      re-flash it over USB yourself.

**Rotating the key:** `npx wrangler secret put DEVICE_TOKEN` with a new value. The frame
is told to re-pair on its next wake and picks up the new key by itself.
**Retiring a frame:** remove its MAC from `DEVICE_MACS` and rotate `DEVICE_TOKEN`.

## Updating the firmware later

Only if you need a fix: plug in over USB, use https://trmnl.com/flash again (choose the same
build), then repeat steps 5–6. Nothing updates over the air. Read the firmware's release
notes first; it's third-party code.
