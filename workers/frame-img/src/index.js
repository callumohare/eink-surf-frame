/**
 * surf-frame-img — the ONLY public endpoint. Ways for a frame to get its picture:
 *
 * 1. TRMNL firmware (the Seeed TRMNL 7.5" kit). In the firmware's Wi-Fi portal set
 *    Advanced -> API server (Custom Server) to the frame's base address (no trailing slash):
 *      main frame:     https://<this Worker>
 *      friend frames:  https://<this Worker>/f/<frame id>/<pairing code>
 *    The firmware appends the API paths to that text (checked against
 *    usetrmnl/trmnl-firmware f310996, 29 Sep 2026: baseUrl + "/api/setup" etc., and it only
 *    sends ID / Access-Token to URLs that start with the base address):
 *      GET  <base>/api/setup    header ID: <MAC>            -> api_key, friendly_id
 *      GET  <base>/api/display  headers ID, Access-Token, Battery-Voltage, RSSI, FW-Version, ...
 *                               -> { status: 0, image_url, filename, refresh_rate, ... }
 *      GET  <base>/api/image/<filename>.png   (Access-Token header)
 *      POST <base>/api/log      firmware log upload
 *    Main frame: only MACs listed in DEVICE_MACS can pair; key = DEVICE_TOKEN.
 *    Friend frames: any MAC with the right pairing code in the address can pair; the key
 *    and the code are derived from FRAME_SECRET (see ../../shared/frames.js), and the frame
 *    must be listed in state/frames.json (deleting it in the studio switches it off).
 *    Keep base addresses under ~150 characters (the firmware builds the /api/log URL in a
 *    200-byte buffer).
 *
 * 2. Plain URL for the main frame (ESPHome, a browser check):  GET /frame/<DEVICE_TOKEN>.png|.bmp
 *
 * Each frame gets whichever layout is currently selected for it in the studio.
 * KEY3 button: a press wakes the frame (firmware sends Update-Source "EXT1", "EXT0" or
 * "button" depending on the chip) and switches between that layout and the frame's
 * button layout (Frame settings; default the "wave-map" starter). Any other wake — the
 * scheduled one, a power cycle — goes back to the normal layout.
 * - Tokens compared in constant time (SHA-256 both, then timingSafeEqual).
 * - Anything unexpected gets a bare 404 — no hints, no listing.
 * - R2: reads only, except one tiny file per frame (state/button.json: is the button
 *   picture showing?), written only after the device key checks out. Device telemetry
 *   (battery, signal, firmware version) goes to Workers Logs only.
 * - Optional per-IP rate limit if the RATE_LIMITER binding is configured.
 */
import { macAllowed, macHint, normMac, refreshSeconds } from "./device.js";
import { CODE_RE, FRAME_ID_RE, MAIN, deviceToken, loadRegistry, pairCode, prefixFor, secretOk } from "../../shared/frames.js";

const NOT_FOUND = () => new Response("Not found", { status: 404, headers: baseHeaders("text/plain") });

function baseHeaders(ctype) {
  return {
    "Content-Type": ctype,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'",
  };
}

const json = obj => new Response(JSON.stringify(obj), { headers: baseHeaders("application/json") });

async function tokenMatches(given, expected) {
  // Hash both so the comparison is fixed-length, then compare in constant time.
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given || "")),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

const PATH_RE = /^\/frame\/([A-Za-z0-9_-]{32,128})\.(png|bmp)$/;
const FRIEND_RE = /^\/f\/([a-z0-9][a-z0-9-]{1,23})\/([0-9a-f]{16})(\/api\/.*)$/;
const IMAGE_RE = /^\/api\/image\/([a-z0-9-]{1,40})\.png$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

async function readJSON(env, key) {
  const o = await env.BUCKET.get(key);
  if (!o) return null;
  try { return await o.json(); } catch (_) { return null; }
}

// KEY3: which layout the button switches to ("" in Frame settings = button off).
const DEFAULT_BUTTON_LAYOUT = "wave-map";
const BUTTON_SOURCES = new Set(["EXT0", "EXT1", "button"]);
async function buttonLayout(env, F) {
  const st = await readJSON(env, F.prefix + "state/frame-settings.json");
  const v = st && typeof st === "object" && "button_layout" in st ? st.button_layout : DEFAULT_BUTTON_LAYOUT;
  if (v === null || v === undefined) return DEFAULT_BUTTON_LAYOUT;
  return typeof v === "string" && ID_RE.test(v) ? v : null;
}
const BUTTON_KEY = F => F.prefix + "state/button.json";

// On /api/display: a button wake flips between the normal and the button layout; any
// other wake goes back to normal. Only writes when the answer changes.
async function updateButton(env, F, source) {
  const st = await readJSON(env, BUTTON_KEY(F));
  const was = !!(st && st.alt === true);
  let now = false;
  if (BUTTON_SOURCES.has(String(source || "")) && !was) {
    const alt = await buttonLayout(env, F);
    now = !!(alt && await env.BUCKET.head(`${F.prefix}renders/${alt}.png`));
  }
  if (now !== was) {
    await env.BUCKET.put(BUTTON_KEY(F), JSON.stringify({ alt: now, at: new Date().toISOString() }),
      { httpMetadata: { contentType: "application/json" } });
  }
  return now;
}

async function currentRender(env, F, ext) {
  let layout = null;
  const st = await readJSON(env, BUTTON_KEY(F));
  if (st && st.alt === true) {
    const alt = await buttonLayout(env, F);
    if (alt && await env.BUCKET.head(`${F.prefix}renders/${alt}.${ext}`)) layout = alt;
  }
  if (!layout) {
    const sel = await readJSON(env, F.prefix + "state/selected.json");
    layout = sel && sel.layout;
  }
  if (!layout || typeof layout !== "string" || !ID_RE.test(layout)) return null;
  return { layout, key: `${F.prefix}renders/${layout}.${ext}` };
}

async function serveRender(request, env, F, ext) {
  const cur = await currentRender(env, F, ext);
  if (!cur) return NOT_FOUND();
  const obj = await env.BUCKET.get(cur.key);
  if (!obj) return NOT_FOUND();
  const headers = baseHeaders(ext === "png" ? "image/png" : "image/bmp");  // TRMNL needs exactly image/png
  headers["Content-Length"] = String(obj.size);
  headers["X-Frame-Layout"] = cur.layout;
  return new Response(request.method === "HEAD" ? null : obj.body, { headers });
}

// ------------------------------------------------------------------ TRMNL device API
// F = the frame being served: { fid, prefix, token, base, friendly, pairAnyMac }
async function apiSetup(request, env, F) {
  const mac = request.headers.get("ID");
  if (!F.pairAnyMac && !macAllowed(mac, env)) {
    // Firmware shows "MAC not registered" and sleeps. The log line tells you what to add.
    console.log(JSON.stringify({ event: "setup_refused", mac: normMac(mac) || null,
      model: request.headers.get("Model"), fw: request.headers.get("FW-Version") }));
    return json({ status: 404, message: "Not registered with this server" });
  }
  console.log(JSON.stringify({ event: "setup_ok", frame: F.fid, mac: macHint(mac), fw: request.headers.get("FW-Version"),
    panel_rev: request.headers.get("Panel-Rev") }));
  return json({
    status: 200,
    api_key: F.token,
    friendly_id: F.friendly,
    // Fetched without credentials, so it must be public: a plain white 1-bit BMP.
    image_url: `${F.base}/api/setup-logo.bmp`,
    message: "Surf frame",
  });
}

async function apiDisplay(request, env, F) {
  const mac = request.headers.get("ID");
  const h = k => request.headers.get(k);
  const ok = await tokenMatches(h("Access-Token"), F.token);
  if (!ok) {
    console.log(JSON.stringify({ event: "display_bad_token", frame: F.fid, mac: macHint(mac) }));
    // A known device with an old key: status 500 makes the firmware forget its key and pair
    // again. Main frame: known = listed MAC. Friend frame: the address already carried the
    // right pairing code. Anyone else gets nothing.
    return (F.pairAnyMac || macAllowed(mac, env)) ? json({ status: 500 }) : NOT_FOUND();
  }
  const refresh = refreshSeconds(Date.now(), env);
  const button = await updateButton(env, F, h("Update-Source"));
  console.log(JSON.stringify({ event: "display", frame: F.fid, mac: macHint(mac), battery_v: h("Battery-Voltage"),
    rssi: h("RSSI"), fw: h("FW-Version"), model: h("Model"), panel_rev: h("Panel-Rev"), source: h("Update-Source"),
    wake_ms: h("Wake-Time"), cached: h("Image-Cached"), next_s: refresh, button_layout: button }));

  const cur = await currentRender(env, F, "png");
  const meta = cur && await env.BUCKET.head(cur.key);
  if (!meta) {
    // Nothing to show yet: keep whatever is on screen and try again at the next slot.
    // (No image_url means the firmware draws nothing new; 202 would make it poll every 5 s.)
    return json({ status: 0, refresh_rate: refresh, update_firmware: false, reset_firmware: false });
  }
  // The firmware caches by filename and only redraws when it changes, so the name must
  // change with the picture. Kept under SPIFFS's 31-character limit.
  const version = String(meta.etag || meta.uploaded?.getTime?.() || "0").replace(/[^a-z0-9]/gi, "").slice(0, 10).toLowerCase();
  const filename = `sf-${cur.layout.slice(0, 16)}-${version}`.replace(/-+$/, "");
  return json({
    status: 0,
    image_url: `${F.base}/api/image/${filename}.png`,
    filename,
    refresh_rate: refresh,
    update_firmware: false,   // this server never pushes firmware
    reset_firmware: false,
  });
}

async function apiImage(request, env, F) {
  if (!(await tokenMatches(request.headers.get("Access-Token"), F.token))) return NOT_FOUND();
  return serveRender(request, env, F, "png");
}

async function apiLog(request, env, F) {
  if (!(await tokenMatches(request.headers.get("Access-Token"), F.token))) return NOT_FOUND();
  const len = parseInt(request.headers.get("Content-Length") || "0", 10);
  let text = "";
  if (len <= 32768) text = (await request.text()).slice(0, 4000);
  console.log(JSON.stringify({ event: "device_log", frame: F.fid, mac: macHint(request.headers.get("ID")), bytes: len, log: text }));
  return json({ status: 200 });
}

// 800x480 all-white 1-bit BMP (62-byte header + 48000 bytes): the firmware requires exactly
// 48062 bytes for a BMP setup logo, and draws the friendly ID and message over it.
let setupLogo = null;
function setupLogoBmp() {
  if (setupLogo) return setupLogo;
  const W = 800, H = 480, rowBytes = W / 8, size = 62 + rowBytes * H;
  const b = new Uint8Array(size);
  const v = new DataView(b.buffer);
  b[0] = 0x42; b[1] = 0x4d;                 // "BM"
  v.setUint32(2, size, true); v.setUint32(10, 62, true);
  v.setUint32(14, 40, true); v.setInt32(18, W, true); v.setInt32(22, H, true);
  v.setUint16(26, 1, true); v.setUint16(28, 1, true);  // planes, 1 bpp
  v.setUint32(34, rowBytes * H, true);
  v.setUint32(46, 2, true);                 // palette entries
  v.setUint32(54, 0x00000000, true);        // index 0 = black
  v.setUint32(58, 0x00ffffff, true);        // index 1 = white
  b.fill(0xff, 62);                         // every pixel white
  return (setupLogo = b);
}

// Routes under a frame's base address (p = the path after the base).
async function deviceApi(request, env, F, p) {
  if (p === "/api/setup") return apiSetup(request, env, F);
  if (p === "/api/display") return apiDisplay(request, env, F);
  if (p === "/api/log") return apiLog(request, env, F);
  if (p === "/api/setup-logo.bmp") {
    const body = setupLogoBmp();
    return new Response(request.method === "HEAD" ? null : body,
      { headers: { ...baseHeaders("image/bmp"), "Content-Length": String(body.length) } });
  }
  if (IMAGE_RE.test(p)) return apiImage(request, env, F);
  return NOT_FOUND();
}

// A friend frame: the pairing code must match, and the frame must still be listed.
async function friendFrame(env, origin, fid, code) {
  if (!secretOk(env.FRAME_SECRET) || !FRAME_ID_RE.test(fid) || fid === MAIN || !CODE_RE.test(code)) return null;
  if (!(await tokenMatches(code, await pairCode(env.FRAME_SECRET, fid)))) return null;
  const reg = await loadRegistry(env.BUCKET);
  if (!reg.frames.some(f => f.id === fid)) return null;
  return { fid, prefix: prefixFor(fid), token: await deviceToken(env.FRAME_SECRET, fid),
    base: `${origin}/f/${fid}/${code}`, friendly: "SURF", pairAnyMac: true };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    const isLog = p === "/api/log" || p.endsWith("/api/log");
    const methodOk = request.method === "GET" || request.method === "HEAD" || (request.method === "POST" && isLog);
    if (!methodOk) return NOT_FOUND();

    if (env.RATE_LIMITER) {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) return new Response("Slow down", { status: 429, headers: baseHeaders("text/plain") });
    }

    // Friend frames: /f/<id>/<code>/api/...
    const fm = FRIEND_RE.exec(p);
    if (fm) {
      const F = await friendFrame(env, url.origin, fm[1], fm[2]);
      if (!F) {
        if (p.endsWith("/api/setup")) console.log(JSON.stringify({ event: "friend_setup_refused", frame: fm[1] }));
        return NOT_FOUND();
      }
      return deviceApi(request, env, F, fm[3]);
    }

    // Main frame
    if (!env.DEVICE_TOKEN || env.DEVICE_TOKEN.length < 32) return NOT_FOUND();
    const F = { fid: MAIN, prefix: "", token: env.DEVICE_TOKEN, base: url.origin, friendly: "SURF", pairAnyMac: false };
    if (p.startsWith("/api/")) return deviceApi(request, env, F, p);
    const m = PATH_RE.exec(p);
    if (!m) return NOT_FOUND();
    if (!(await tokenMatches(m[1], env.DEVICE_TOKEN))) return NOT_FOUND();
    return serveRender(request, env, F, m[2]);
  },
};
