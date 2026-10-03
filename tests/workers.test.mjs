// Offline tests for both Workers with an in-memory R2 and a self-signed Access JWT.
// Run: node tests/workers.test.mjs
import assert from "node:assert/strict";
import { generateKeyPairSync, createSign, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

// Workers-only API used by frame-img
if (!crypto.subtle.timingSafeEqual) {
  crypto.subtle.timingSafeEqual = (a, b) => a.byteLength === b.byteLength && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

class MemR2 {
  constructor() { this.m = new Map(); this.etags = new Map(); }
  obj(key) {
    const v = this.m.get(key); if (v === undefined) return null;
    return { key, size: v.length, body: v, json: async () => JSON.parse(new TextDecoder().decode(v)), text: async () => new TextDecoder().decode(v) };
  }
  async get(k) { return this.obj(k); }
  async head(k) { return this.m.has(k) ? { key: k, etag: this.etags.get(k) } : null; }
  async put(k, v) {
    this.m.set(k, typeof v === "string" ? new TextEncoder().encode(v) : new Uint8Array(v));
    this.etags = this.etags || new Map(); this.etags.set(k, "e" + Math.random().toString(16).slice(2, 14));
  }
  async delete(keys) { [].concat(keys).forEach(k => this.m.delete(k)); }
  async list({ prefix }) { return { objects: [...this.m.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })), truncated: false }; }
}

const TEAM = "test.cloudflareaccess.com", AUD = "aud123";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256" };
const b64u = b => Buffer.from(b).toString("base64url");
function jwt(payload, kid = "k1") {
  const head = b64u(JSON.stringify({ alg: "RS256", kid }));
  const body = b64u(JSON.stringify(payload));
  const sig = createSign("RSA-SHA256").update(head + "." + body).sign(privateKey);
  return `${head}.${body}.${b64u(sig)}`;
}
globalThis.fetch = async (url) => {
  if (String(url) === `https://${TEAM}/cdn-cgi/access/certs`) return new Response(JSON.stringify({ keys: [jwk] }));
  throw new Error("unexpected fetch " + url);
};

const now = Math.floor(Date.now() / 1000);
const good = jwt({ aud: [AUD], iss: `https://${TEAM}`, exp: now + 600, email: "me@example.com" });

// ---------------------------------------------------------------- studio
const studio = (await import("../workers/studio/src/index.js")).default;
const bucket = new MemR2();
const env = { BUCKET: bucket, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ALLOWED_EMAILS: "me@example.com",
  ASSETS: { fetch: async req => new Response("asset " + new URL(req.url).pathname) } };
const O = "https://studio.example.workers.dev";
const req = (path, { method = "GET", token = good, body, origin = O } = {}) => {
  const h = new Headers();
  if (token) h.set("Cf-Access-Jwt-Assertion", token);
  if (body !== undefined) { h.set("Content-Type", "application/json"); h.set("Origin", origin); }
  else if (method !== "GET") h.set("Origin", origin);
  return new Request(O + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
};

let r = await studio.fetch(req("/api/state", { token: null }), env);
assert.equal(r.status, 403, "no token -> 403");
r = await studio.fetch(req("/api/state", { token: jwt({ aud: [AUD], iss: `https://${TEAM}`, exp: now + 600, email: "evil@example.com" }) }), env);
assert.equal(r.status, 403, "wrong email -> 403");
r = await studio.fetch(req("/api/state", { token: jwt({ aud: ["other"], iss: `https://${TEAM}`, exp: now + 600, email: "me@example.com" }) }), env);
assert.equal(r.status, 403, "wrong aud -> 403");
r = await studio.fetch(req("/api/state", { token: jwt({ aud: [AUD], iss: `https://${TEAM}`, exp: now - 600, email: "me@example.com" }) }), env);
assert.equal(r.status, 403, "expired -> 403");
const tampered = good.split("."); tampered[1] = b64u(JSON.stringify({ aud: [AUD], iss: `https://${TEAM}`, exp: now + 600, email: "me@example.com", x: 1 }));
r = await studio.fetch(req("/api/state", { token: tampered.join(".") }), env);
assert.equal(r.status, 403, "tampered -> 403");
r = await studio.fetch(req("/"), env);
assert.equal(await r.text(), "asset /studio.html", "root serves studio.html");
assert.match(r.headers.get("Content-Security-Policy"), /default-src 'self'/);

const layout = JSON.parse(readFileSync(new URL("../layouts/classic.json", import.meta.url)));
r = await studio.fetch(req("/api/layouts/classic", { method: "PUT", body: layout, origin: "https://evil.example" }), env);
assert.equal(r.status, 403, "cross-origin PUT -> 403");
r = await studio.fetch(req("/api/layouts/classic", { method: "PUT", body: layout }), env);
assert.equal(r.status, 200, "PUT ok");
r = await studio.fetch(req("/api/layouts/..%2Fstate", { method: "PUT", body: layout }), env);
assert.equal(r.status, 400, "path traversal id rejected");
r = await studio.fetch(req("/api/layouts/bad", { method: "PUT", body: { ...layout, widgets: [{ id: "a", type: "surf", x: 39, y: 0, w: 5, h: 2 }] } }), env);
assert.equal(r.status, 400, "out of bounds rejected");
r = await studio.fetch(req("/api/select", { method: "POST", body: { layout: "nope" } }), env);
assert.equal(r.status, 400, "select unknown rejected");
r = await studio.fetch(req("/api/select", { method: "POST", body: { layout: "classic" } }), env);
assert.equal(r.status, 200);
r = await studio.fetch(req("/api/layouts/classic", { method: "DELETE" }), env);
assert.equal(r.status, 409, "cannot delete selected");
r = await studio.fetch(req("/api/state"), env);
const st = await r.json();
assert.equal(st.selected, "classic"); assert.equal(st.layouts.length, 1);
r = await studio.fetch(req("/api/renders/..%2F..%2Fdata.png"), env);
assert.equal(r.status, 400, "render path traversal rejected");
// render-now: one at a time, checked against GitHub, plus a 1-minute double-click guard
{
  const calls = []; let busy = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("/actions/workflows/render.yml/runs")) {
      calls.push("list");
      return new Response(JSON.stringify({ workflow_runs: busy ? [{ status: "in_progress" }] : [{ status: "completed" }] }));
    }
    if (u.includes("/actions/workflows/render.yml/dispatches")) {
      calls.push("dispatch:" + (init.method || "GET"));
      return new Response(null, { status: 204 });
    }
    return origFetch(url, init);
  };
  const renv = { ...env, GH_TOKEN: "t", GH_REPO: "me/surf-frame" };
  busy = true;
  r = await studio.fetch(req("/api/render-now", { method: "POST", body: {} }), renv);
  assert.equal(r.status, 429, "busy render -> 429");
  assert.match((await r.json()).error, /already running/);
  assert.ok(!calls.includes("dispatch:POST"), "no dispatch while busy");
  busy = false;
  r = await studio.fetch(req("/api/render-now", { method: "POST", body: {} }), renv);
  assert.equal(r.status, 202, "idle -> dispatched");
  assert.ok(calls.includes("dispatch:POST"));
  r = await studio.fetch(req("/api/render-now", { method: "POST", body: {} }), renv);
  assert.equal(r.status, 429, "double click within a minute -> 429");
  await bucket.put("state/render-request.json", JSON.stringify({ ts: Math.floor(Date.now() / 1000) - 61 }));
  r = await studio.fetch(req("/api/render-now", { method: "POST", body: {} }), renv);
  assert.equal(r.status, 202, "after a minute, and nothing running -> allowed (no 5-minute wait)");
  r = await studio.fetch(req("/api/render-now", { method: "POST", body: {}, origin: "https://evil.example" }), renv);
  assert.equal(r.status, 403, "cross-origin render-now -> 403");
  // Cloudflare Cron Trigger: dispatches when idle, holds off while a render is running
  const before = calls.filter(c => c === "dispatch:POST").length;
  busy = true;
  await studio.scheduled({ cron: "7 */3 * * *" }, renv);
  assert.equal(calls.filter(c => c === "dispatch:POST").length, before, "cron: no dispatch while busy");
  busy = false;
  await studio.scheduled({ cron: "7 */3 * * *" }, renv);
  assert.equal(calls.filter(c => c === "dispatch:POST").length, before + 1, "cron: dispatched when idle");
  await studio.scheduled({ cron: "7 */3 * * *" }, env);   // no GH_TOKEN: logs and does nothing
  assert.equal(calls.filter(c => c === "dispatch:POST").length, before + 1, "cron: nothing without GH_TOKEN");
  globalThis.fetch = origFetch;
}
console.log("studio: all checks passed");

// ---------------------------------------------------------------- frame-img
const img = (await import("../workers/frame-img/src/index.js")).default;
const TOKEN = "A".repeat(20) + "b".repeat(23);
const ienv = { BUCKET: bucket, DEVICE_TOKEN: TOKEN };
await bucket.put("renders/classic.png", new Uint8Array([137, 80, 78, 71]));
r = await img.fetch(new Request(`https://img.example/frame/${TOKEN}.png`), ienv);
assert.equal(r.status, 200); assert.equal(r.headers.get("Content-Type"), "image/png");
r = await img.fetch(new Request(`https://img.example/frame/${"A".repeat(43)}.png`), ienv);
assert.equal(r.status, 404, "wrong token -> 404");
r = await img.fetch(new Request(`https://img.example/frame/${TOKEN}.bmp`), ienv);
assert.equal(r.status, 404, "missing bmp -> 404");
r = await img.fetch(new Request(`https://img.example/frame/${TOKEN}.png`, { method: "POST" }), ienv);
assert.equal(r.status, 404, "POST -> 404");
r = await img.fetch(new Request(`https://img.example/`), ienv);
assert.equal(r.status, 404);
r = await img.fetch(new Request(`https://img.example/frame/${TOKEN}.png`), { ...ienv, DEVICE_TOKEN: "short" });
assert.equal(r.status, 404, "weak configured token refused");
console.log("frame-img: all checks passed");

// ---------------------------------------------------------------- frame-img: TRMNL firmware API
{
  const { refreshSeconds, normMac } = await import("../workers/frame-img/src/device.js");
  const MAC = "a1:b2:c3:d4:e5:f6";
  const tenv = { ...ienv, DEVICE_MACS: "11:22:33:44:55:66, A1-B2-C3-D4-E5-F6" };
  const logs = []; const origLog = console.log; console.log = m => logs.push(m);
  const dev = (path, headers = {}, method = "GET", body) =>
    img.fetch(new Request(`https://img.example${path}`, { method, headers, body }), tenv);

  // setup: only listed MACs get the key
  r = await dev("/api/setup", { ID: "de:ad:be:ef:00:01" });
  let j = await r.json();
  assert.equal(j.status, 404, "unknown MAC refused"); assert.equal(j.api_key, undefined);
  assert.ok(logs.some(l => l.includes("setup_refused") && l.includes("DEADBEEF0001")), "refused MAC is logged in full");
  r = await dev("/api/setup", {});
  assert.equal((await r.json()).status, 404, "no MAC refused");
  r = await dev("/api/setup", { ID: MAC });
  j = await r.json();
  assert.equal(j.status, 200); assert.equal(j.api_key, TOKEN); assert.equal(j.friendly_id, "SURF");
  assert.equal(j.image_url, "https://img.example/api/setup-logo.bmp");
  assert.ok(!logs.some(l => l.includes("setup_ok") && l.includes("A1B2C3D4E5F6")), "paired MAC not logged in full");

  // setup logo: public, exactly what the firmware accepts (800x480 1-bit, 48062 bytes, black/white palette)
  r = await dev("/api/setup-logo.bmp");
  const bmp = new Uint8Array(await r.arrayBuffer());
  assert.equal(bmp.length, 48062); assert.equal(r.headers.get("Content-Type"), "image/bmp");
  const dv = new DataView(bmp.buffer);
  assert.deepEqual([bmp[0], bmp[1], dv.getUint32(18, true), dv.getUint32(22, true), dv.getUint16(28, true),
    dv.getUint32(34, true), dv.getUint32(46, true), dv.getUint32(10, true)], [66, 77, 800, 480, 1, 48000, 2, 62]);
  assert.deepEqual([...bmp.slice(54, 62)], [0, 0, 0, 0, 255, 255, 255, 0], "standard colour table");

  // display: needs the key
  r = await dev("/api/display", { ID: "de:ad:be:ef:00:01", "Access-Token": "x".repeat(43) });
  assert.equal(r.status, 404, "stranger with wrong key -> 404");
  r = await dev("/api/display", { ID: MAC, "Access-Token": "x".repeat(43) });
  assert.equal((await r.json()).status, 500, "known device with old key -> re-pair");
  r = await dev("/api/display", { ID: MAC, "Access-Token": TOKEN, "Battery-Voltage": "4.01", RSSI: "-61", "Panel-Rev": "00a1b2c3" });
  j = await r.json();
  assert.equal(j.status, 0); assert.equal(j.update_firmware, false); assert.equal(j.reset_firmware, false);
  assert.match(j.filename, /^sf-classic-[a-z0-9]+$/); assert.ok(j.filename.length <= 31, "fits SPIFFS name limit");
  assert.equal(j.image_url, `https://img.example/api/image/${j.filename}.png`);
  assert.ok(j.refresh_rate >= 120 && j.refresh_rate <= 3 * 3600 + 120);
  assert.ok(logs.some(l => l.includes('"battery_v":"4.01"') && l.includes('"panel_rev":"00a1b2c3"')), "telemetry logged");
  const first = j.filename;
  await bucket.put("renders/classic.png", new Uint8Array([137, 80, 78, 71, 1]));
  j = await (await dev("/api/display", { ID: MAC, "Access-Token": TOKEN })).json();
  assert.notEqual(j.filename, first, "new render -> new filename, so the firmware redraws");

  // image: key in header only
  r = await dev(new URL(j.image_url).pathname, { ID: MAC, "Access-Token": TOKEN });
  assert.equal(r.status, 200); assert.equal(r.headers.get("Content-Type"), "image/png");
  assert.equal((await r.arrayBuffer()).byteLength, 5);
  r = await dev(new URL(j.image_url).pathname, {});
  assert.equal(r.status, 404, "image without key -> 404");
  r = await dev("/api/image/../../state/selected.png", { "Access-Token": TOKEN });
  assert.equal(r.status, 404, "image path traversal -> 404");

  // nothing rendered yet: no image_url, no 202 (202 makes the firmware poll every 5 s)
  await bucket.delete("renders/classic.png");
  j = await (await dev("/api/display", { ID: MAC, "Access-Token": TOKEN })).json();
  assert.equal(j.status, 0); assert.equal(j.image_url, undefined); assert.ok(j.refresh_rate > 0);
  await bucket.put("renders/classic.png", new Uint8Array([137, 80, 78, 71]));

  // log: keyed, POST only
  r = await dev("/api/log", { ID: MAC, "Access-Token": TOKEN, "Content-Type": "application/json" }, "POST", JSON.stringify({ log: "hi" }));
  assert.equal(r.status, 200);
  r = await dev("/api/log", { ID: MAC }, "POST", "{}");
  assert.equal(r.status, 404, "log without key -> 404");
  r = await dev("/api/display", { ID: MAC, "Access-Token": TOKEN }, "POST", "{}");
  assert.equal(r.status, 404, "POST to display -> 404");
  r = await dev("/api/other", { "Access-Token": TOKEN });
  assert.equal(r.status, 404);
  r = await img.fetch(new Request("https://img.example/api/setup", { headers: { ID: MAC } }), { ...tenv, DEVICE_TOKEN: "short" });
  assert.equal(r.status, 404, "weak configured token: API off too");

  // KEY3: a button wake switches to the button layout (default the wave-map starter);
  // the next scheduled wake goes back; "" in Frame settings switches the button off.
  const disp = src => dev("/api/display", { ID: MAC, "Access-Token": TOKEN, "Update-Source": src }).then(x => x.json());
  await bucket.delete(["state/frame-settings.json", "state/button.json"]);
  j = await disp("EXT1");
  assert.match(j.filename, /^sf-classic-/, "no map rendered yet -> button changes nothing");
  assert.equal(bucket.m.has("state/button.json"), false, "and nothing is written");
  await bucket.put("renders/wave-map.png", new Uint8Array([137, 80, 78, 71, 7, 7]));
  j = await disp("EXT1");
  assert.match(j.filename, /^sf-wave-map-/, "button -> map");
  r = await dev(new URL(j.image_url).pathname, { "Access-Token": TOKEN });
  assert.equal((await r.arrayBuffer()).byteLength, 6, "the image served is the map");
  j = await disp("button");
  assert.match(j.filename, /^sf-classic-/, "button again -> back");
  j = await disp("EXT0");
  assert.match(j.filename, /^sf-wave-map-/, "EXT0 counts as the button too");
  j = await disp("timer");
  assert.match(j.filename, /^sf-classic-/, "scheduled wake -> back to normal");
  r = await dev(new URL(j.image_url).pathname, { "Access-Token": TOKEN });
  assert.equal((await r.arrayBuffer()).byteLength, 4, "and the image is the normal one");
  j = await disp("EXT1"); j = await disp("powercycle");
  assert.match(j.filename, /^sf-classic-/, "power cycle -> normal");
  await bucket.put("state/frame-settings.json", JSON.stringify({ shrink_px: 0, home: null, button_layout: "" }));
  j = await disp("EXT1");
  assert.match(j.filename, /^sf-classic-/, "button switched off in Frame settings");
  await bucket.put("state/frame-settings.json", JSON.stringify({ button_layout: "../../x" }));
  j = await disp("EXT1");
  assert.match(j.filename, /^sf-classic-/, "bad stored value -> off");
  await bucket.put("state/frame-settings.json", JSON.stringify({ button_layout: "classic2" }));
  await bucket.put("renders/classic2.png", new Uint8Array([137, 80, 78, 71, 2, 2, 2]));
  j = await disp("EXT1");
  assert.match(j.filename, /^sf-classic2-/, "any layout can be the button layout");
  await bucket.delete(["state/frame-settings.json", "state/button.json", "renders/wave-map.png", "renders/classic2.png"]);

  // wake timing: next render slot (xx:07 UTC every 3 h) + 25 min
  const at = iso => Date.parse(iso);
  assert.equal(refreshSeconds(at("2026-09-28T00:00:00Z")), 32 * 60, "00:00 -> 00:32");
  assert.equal(refreshSeconds(at("2026-09-28T00:32:00Z")), 3 * 3600, "exactly on target -> next slot");
  assert.equal(refreshSeconds(at("2026-09-28T00:31:00Z")), 3 * 3600 + 60, "1 min early -> skip to next slot");
  assert.equal(refreshSeconds(at("2026-09-28T02:00:00Z")), 3600 + 32 * 60, "02:00 -> 03:32");
  assert.equal(refreshSeconds(at("2026-09-28T22:40:00Z")), 3600 + 52 * 60, "22:40 -> 00:32 next day");
  assert.equal(refreshSeconds(at("2026-09-28T00:00:00Z"), { REFRESH_OFFSET_MIN: "10" }), 17 * 60, "offset setting");
  assert.equal(normMac("aa-bb-cc-dd-ee-ff"), "AABBCCDDEEFF");
  console.log = origLog;
  console.log("frame-img TRMNL API: all checks passed");
}

// ---------------------------------------------------------------- friends' frames
{
  const { pairCode, deviceToken, prefixFor } = await import("../workers/shared/frames.js");
  const SECRET = "s".repeat(40);
  const fb = new MemR2();
  const logs = []; const origLog = console.log; console.log = m => logs.push(m);
  const senv = { ...env, BUCKET: fb, FRAME_SECRET: SECRET, ALLOWED_EMAILS: "me@example.com" };
  const SO = "https://surf-frame-studio.acct.workers.dev";
  const as = (email, path, { method = "GET", body } = {}) => {
    const h = new Headers({ "Cf-Access-Jwt-Assertion": jwt({ aud: [AUD], iss: `https://${TEAM}`, exp: now + 600, email }) });
    if (method !== "GET") h.set("Origin", SO);
    if (body !== undefined) h.set("Content-Type", "application/json");
    return studio.fetch(new Request(SO + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), senv);
  };
  assert.equal(prefixFor("main"), ""); assert.equal(prefixFor("jack"), "frames/jack/");

  // a friend can't get in until an admin adds their frame
  r = await as("jack@example.com", "/api/state");
  assert.equal(r.status, 403, "unknown email -> 403");
  r = await as("me@example.com", "/api/admin/frames/jack", { method: "PUT", body: { name: "Jack", emails: "Jack@Example.com, " } });
  assert.equal(r.status, 200);
  r = await as("me@example.com", "/api/admin/frames/main", { method: "PUT", body: { name: "x", emails: "a@b.co" } });
  assert.equal(r.status, 400, "'main' is reserved");
  r = await as("me@example.com", "/api/admin/frames/ok-id", { method: "PUT", body: { name: "x", emails: "not-an-email" } });
  assert.equal(r.status, 400, "bad email refused");
  r = await as("jack@example.com", "/api/admin/frames");
  assert.equal(r.status, 403, "friends aren't admins");

  // admin list shows the server address with the derived pairing code
  let j = await (await as("me@example.com", "/api/admin/frames")).json();
  const code = await pairCode(SECRET, "jack");
  assert.equal(j.frames[0].server, `https://surf-frame-img.acct.workers.dev/f/jack/${code}`);
  assert.equal(j.secret_ok, true);
  assert.ok(j.frames[0].server.length < 150, "fits the firmware's URL buffer");

  // friend sees only their own frame; admin sees both
  j = await (await as("jack@example.com", "/api/state")).json();
  assert.equal(j.frame, "jack"); assert.deepEqual(j.frames.map(f => f.id), ["jack"]); assert.equal(j.admin, false);
  assert.deepEqual(j.hidden_widgets, ["booking", "countdown", "quiver"]);
  r = await as("jack@example.com", "/api/state?frame=main");
  assert.equal(r.status, 403, "friend can't open the main frame");
  j = await (await as("me@example.com", "/api/state")).json();
  assert.deepEqual(j.frames.map(f => f.id), ["main", "jack"]); assert.equal(j.frame, "main");

  // friend's layouts and selection live under frames/jack/
  const lay = JSON.parse(readFileSync(new URL("../layouts/beach-showdown.json", import.meta.url)));
  r = await as("jack@example.com", "/api/layouts/mine", { method: "PUT", body: lay });
  assert.equal(r.status, 200);
  assert.ok(fb.m.has("frames/jack/layouts/mine.json") && !fb.m.has("layouts/mine.json"));
  r = await as("jack@example.com", "/api/layouts/wave", { method: "PUT", body: { ...lay, widgets: [{ id: "w1", type: "booking", x: 0, y: 0, w: 10, h: 5 }] } });
  assert.equal(r.status, 400, "The Wave widget refused on a friend's frame");
  r = await as("jack@example.com", "/api/select", { method: "POST", body: { layout: "mine" } });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(new TextDecoder().decode(fb.m.get("frames/jack/state/selected.json"))).layout, "mine");
  await fb.put("data/data.json", JSON.stringify({ bookings: [{ date: "x" }] }));
  r = await as("jack@example.com", "/api/data");
  assert.equal(r.status, 404, "friend never gets the main frame's data (bookings)");

  // settings: edge margin 0-20, optional home
  r = await as("jack@example.com", "/api/settings", { method: "PUT", body: { shrink_px: 3, home: { name: "Cardiff", lat: "51.48", lon: -3.18 } } });
  j = await r.json();
  assert.equal(r.status, 200); assert.deepEqual(j.settings, { shrink_px: 3, home: { name: "Cardiff", lat: 51.48, lon: -3.18 }, button_layout: "wave-map" });
  r = await as("jack@example.com", "/api/settings", { method: "PUT", body: { shrink_px: 3, home: null, button_layout: "" } });
  assert.equal((await r.json()).settings.button_layout, "", "button can be switched off");
  r = await as("jack@example.com", "/api/settings", { method: "PUT", body: { shrink_px: 3, button_layout: "../renders/x" } });
  assert.equal(r.status, 400, "bad button layout refused");
  r = await as("jack@example.com", "/api/settings", { method: "PUT", body: { shrink_px: 21 } });
  assert.equal(r.status, 400, "margin over 20 refused");
  r = await as("jack@example.com", "/api/settings", { method: "PUT", body: { shrink_px: 1.5 } });
  assert.equal(r.status, 400, "fractional margin refused");
  r = await as("jack@example.com", "/api/settings", { method: "PUT", body: { shrink_px: 0, home: { name: "X", lat: 91, lon: 0 } } });
  assert.equal(r.status, 400, "bad latitude refused");

  // the frame pairs itself from its server address — any MAC, right code
  const ienv2 = { BUCKET: fb, DEVICE_TOKEN: TOKEN, FRAME_SECRET: SECRET };
  const base = `https://img.example/f/jack/${code}`;
  const dev = (path, headers = {}, method = "GET", body) => img.fetch(new Request(base + path, { method, headers, body }), ienv2);
  j = await (await dev("/api/setup", { ID: "12:34:56:78:9a:bc" })).json();
  const tok = await deviceToken(SECRET, "jack");
  assert.equal(j.status, 200); assert.equal(j.api_key, tok); assert.notEqual(tok, TOKEN);
  assert.equal(j.image_url, `${base}/api/setup-logo.bmp`, "setup logo under the frame's own base");
  r = await img.fetch(new Request(`https://img.example/f/jack/${"0".repeat(16)}/api/setup`, { headers: { ID: "12:34:56:78:9a:bc" } }), ienv2);
  assert.equal(r.status, 404, "wrong pairing code -> 404");
  r = await img.fetch(new Request(`https://img.example/f/nobody/${await pairCode(SECRET, "nobody")}/api/setup`, { headers: { ID: "x" } }), ienv2);
  assert.equal(r.status, 404, "right code but frame not listed -> 404");
  r = await img.fetch(new Request(`${base}/api/setup`, { headers: { ID: "x" } }), { ...ienv2, FRAME_SECRET: "short" });
  assert.equal(r.status, 404, "no/weak FRAME_SECRET -> friends off");

  await fb.put("frames/jack/renders/mine.png", new Uint8Array([137, 80, 78, 71, 9]));
  j = await (await dev("/api/display", { ID: "12:34:56:78:9a:bc", "Access-Token": tok })).json();
  assert.equal(j.status, 0); assert.match(j.filename, /^sf-mine-/);
  assert.ok(j.image_url.startsWith(base + "/api/image/"), "image under the base, so the firmware sends the key");
  r = await img.fetch(new Request(j.image_url, { headers: { "Access-Token": tok } }), ienv2);
  assert.equal((await r.arrayBuffer()).byteLength, 5, "friend's own picture");
  r = await img.fetch(new Request(j.image_url, { headers: { "Access-Token": TOKEN } }), ienv2);
  assert.equal(r.status, 404, "main frame's key doesn't open a friend's picture");
  // KEY3 works on friends' frames too, with their own state file
  await fb.put("frames/jack/renders/wave-map.png", new Uint8Array([137, 80, 78, 71, 3, 3, 3, 3]));
  await fb.delete("frames/jack/state/frame-settings.json");
  j = await (await dev("/api/display", { ID: "12:34:56:78:9a:bc", "Access-Token": tok, "Update-Source": "EXT1" })).json();
  assert.match(j.filename, /^sf-wave-map-/, "friend's button -> their map");
  assert.ok(fb.m.has("frames/jack/state/button.json") && !fb.m.has("state/button.json"), "state kept per frame");
  j = await (await dev("/api/display", { ID: "12:34:56:78:9a:bc", "Access-Token": tok, "Update-Source": "timer" })).json();
  assert.match(j.filename, /^sf-mine-/, "friend's scheduled wake -> back");
  j = await (await dev("/api/display", { ID: "12:34:56:78:9a:bc", "Access-Token": "old" })).json();
  assert.equal(j.status, 500, "old key on the right address -> re-pair");
  r = await dev("/api/log", { "Access-Token": tok }, "POST", "{}");
  assert.equal(r.status, 200);
  r = await img.fetch(new Request(`https://img.example/api/display`, { headers: { ID: "x", "Access-Token": tok } }), ienv2);
  assert.equal(r.status, 404, "friend's key doesn't work on the main frame's address");

  // removing the frame deletes its files and switches the device off
  r = await as("me@example.com", "/api/admin/frames/jack", { method: "DELETE" });
  assert.equal(r.status, 200);
  assert.ok(![...fb.m.keys()].some(k => k.startsWith("frames/jack/")), "friend's files deleted");
  assert.ok(fb.m.has("data/data.json"), "main files untouched");
  r = await dev("/api/display", { ID: "x", "Access-Token": tok });
  assert.equal(r.status, 404, "removed frame -> 404");
  r = await as("jack@example.com", "/api/state");
  assert.equal(r.status, 403, "removed friend can't log in");
  console.log = origLog;
  console.log("friends' frames: all checks passed");
}
