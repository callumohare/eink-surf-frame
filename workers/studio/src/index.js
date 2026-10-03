/**
 * surf-frame-studio — gallery + layout editor + small JSON API over R2.
 *
 * Defence in depth:
 *  1. Cloudflare Access sits in front of the whole Worker (enable it on the
 *     Worker's "Access" tab — see README). Unauthenticated requests never arrive.
 *     The Access policy must list every email that may log in (yours + friends').
 *  2. This code independently verifies the Access JWT (Cf-Access-Jwt-Assertion):
 *     RS256 signature against your team's certs, issuer, audience (AUD tag),
 *     expiry. Fails closed if not configured. Then:
 *       - emails in ALLOWED_EMAILS are admins: every frame, plus the Frames page;
 *       - emails listed on a friend frame (state/frames.json) see that frame only.
 *     (ctx.access is not available here because the Worker serves static
 *     assets — Cloudflare's docs say the assets router doesn't pass it on.)
 *  3. Every request, including static files, goes through this check
 *     (assets.run_worker_first = true).
 *  4. Mutations need a same-origin Origin header and a JSON content type (CSRF).
 *  5. Layouts are schema-validated; keys are never built from unchecked input.
 *     Every frame's files live under its own prefix (../../shared/frames.js).
 *  6. Strict CSP; the UI never uses innerHTML.
 *
 * Env (wrangler.toml [vars]): ACCESS_TEAM_DOMAIN, ACCESS_AUD, ALLOWED_EMAILS, GH_REPO, GH_REF,
 *   MAIN_FRAME_NAME, FRAME_IMG_ORIGIN (optional; worked out from this Worker's address if blank)
 * Secrets: GH_TOKEN (fine-grained PAT, this repo only, Actions: read & write) for Render now
 *   and the scheduled renders; FRAME_SECRET (same value as on surf-frame-img) for friend frames.
 *
 * Scheduled renders: a Cloudflare Cron Trigger (wrangler.toml [triggers]) calls
 * scheduled() below, which starts render.yml through the same GitHub API call as
 * "Render now". GitHub's own schedule stays in render.yml as a backup; it skips the
 * work if the data is already fresh (pipeline/fresh.py). Cron runs aren't HTTP
 * requests, so Access isn't involved; they can only start the one workflow.
 */
import { ID_RE, Invalid, validateLayout } from "./validate.js";
import { FRAME_ID_RE, MAIN, MAIN_ONLY_WIDGETS, MAX_FRAMES, REGISTRY_KEY, loadRegistry, pairCode,
  prefixFor, secretOk } from "../../shared/frames.js";

const RENDER_FILE_RE = /^[a-z0-9][a-z0-9-]{0,39}(-thumb|-grey)?\.(png|bmp)$/;
const EMAIL_RE = /^[^\s@,<>"]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/;
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; " +
  "img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const RENDER_COOLDOWN_S = 60;   // guards against double clicks; a busy render is checked separately
const RUN_BUSY = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);
const MAX_SHRINK = 20;

function secure(resp) {
  const r = new Response(resp.body, resp);
  r.headers.set("Content-Security-Policy", CSP);
  r.headers.set("X-Content-Type-Options", "nosniff");
  r.headers.set("Referrer-Policy", "no-referrer");
  r.headers.set("X-Frame-Options", "DENY");
  r.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  r.headers.set("Cross-Origin-Resource-Policy", "same-origin");
  r.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  r.headers.set("Strict-Transport-Security", "max-age=31536000");
  if (!r.headers.has("Cache-Control")) r.headers.set("Cache-Control", "no-store");
  return r;
}
const json = (obj, status = 200) => secure(new Response(JSON.stringify(obj), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }));

// ------------------------------------------------------------------ Access JWT
const b64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), c => c.charCodeAt(0));
let certCache = { at: 0, keys: [] };

async function accessKeys(team) {
  if (Date.now() - certCache.at < 3600_000 && certCache.keys.length) return certCache.keys;
  const r = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error("certs fetch failed");
  const j = await r.json();
  certCache = { at: Date.now(), keys: j.keys || [] };
  return certCache.keys;
}

async function verifyAccess(request, env) {
  const team = env.ACCESS_TEAM_DOMAIN, aud = env.ACCESS_AUD;
  if (!team || !aud || !env.ALLOWED_EMAILS) return { ok: false, why: "studio not configured" };
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return { ok: false, why: "no Access token" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, why: "bad token" };
  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64u(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64u(parts[1])));
  } catch (_) { return { ok: false, why: "bad token" }; }
  if (header.alg !== "RS256") return { ok: false, why: "bad alg" };
  const keys = await accessKeys(team);
  const jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) { certCache.at = 0; return { ok: false, why: "unknown key" }; }
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(parts[2]),
    new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!valid) return { ok: false, why: "bad signature" };
  const now = Math.floor(Date.now() / 1000);
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) return { ok: false, why: "wrong audience" };
  if (payload.iss !== `https://${team}`) return { ok: false, why: "wrong issuer" };
  if (!payload.exp || payload.exp < now - 30) return { ok: false, why: "expired" };
  if (payload.nbf && payload.nbf > now + 30) return { ok: false, why: "not yet valid" };
  const email = (payload.email || "").toLowerCase();
  if (!email) return { ok: false, why: "no email" };
  return { ok: true, email };
}

const emailList = s => String(s || "").toLowerCase().split(",").map(x => x.trim()).filter(Boolean);

/** Who is this, and which frames may they use? Admins get every frame. */
async function whoIs(env, email) {
  const admin = emailList(env.ALLOWED_EMAILS).includes(email);
  const reg = await loadRegistry(env.BUCKET);
  const friends = reg.frames.map(f => ({ id: f.id, name: f.name || f.id, emails: f.emails || [] }));
  const frames = admin
    ? [{ id: MAIN, name: env.MAIN_FRAME_NAME || "My frame" }, ...friends.map(f => ({ id: f.id, name: f.name }))]
    : friends.filter(f => f.emails.includes(email)).map(f => ({ id: f.id, name: f.name }));
  return { email, admin, frames, registry: reg };
}

// ------------------------------------------------------------------ R2 helpers
async function getJSON(env, key, fallback) {
  const o = await env.BUCKET.get(key);
  if (!o) return fallback;
  try { return await o.json(); } catch (_) { return fallback; }
}
const putJSON = (env, key, obj) => env.BUCKET.put(key, JSON.stringify(obj, null, 2),
  { httpMetadata: { contentType: "application/json" } });

async function listKeys(env, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await env.BUCKET.list({ prefix, cursor });
    out.push(...page.objects.map(o => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

async function listLayouts(env, P) {
  const out = [];
  const base = P + "layouts/";
  for (const k of await listKeys(env, base)) {
    const id = k.slice(base.length, -5);
    if (!k.endsWith(".json") || !ID_RE.test(id)) continue;
    const l = await getJSON(env, k, null);
    if (l) out.push({ id, name: l.name || id });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function readBody(request) {
  if (!(request.headers.get("Content-Type") || "").includes("application/json")) throw new Invalid("expected JSON");
  const text = await request.text();
  if (text.length > 64_000) throw new Invalid("body too large");
  try { return JSON.parse(text); } catch (_) { throw new Invalid("invalid JSON"); }
}

// ------------------------------------------------------------------ frame settings
// Per frame: how many pixels to shrink the picture by on every edge (for a tight mount),
// an optional home town for the weather widgets, and the layout the KEY3 button switches
// to ("" = button off; surf-frame-img reads this).
const DEFAULT_SETTINGS = { shrink_px: 0, home: null, button_layout: "wave-map" };

function cleanSettings(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Invalid("settings must be an object");
  const s = obj.shrink_px ?? 0;
  if (!Number.isInteger(s) || s < 0 || s > MAX_SHRINK) throw new Invalid(`edge margin must be a whole number from 0 to ${MAX_SHRINK}`);
  let home = null;
  if (obj.home != null) {
    const h = obj.home;
    if (typeof h !== "object" || Array.isArray(h)) throw new Invalid("bad home");
    const name = typeof h.name === "string" ? h.name.trim().slice(0, 40) : "";
    const lat = Number(h.lat), lon = Number(h.lon);
    if (!name) throw new Invalid("home needs a name");
    if (h.lat === "" || !Number.isFinite(lat) || lat < -90 || lat > 90) throw new Invalid("latitude must be a number between -90 and 90");
    if (h.lon === "" || !Number.isFinite(lon) || lon < -180 || lon > 180) throw new Invalid("longitude must be a number between -180 and 180");
    home = { name, lat: Math.round(lat * 10000) / 10000, lon: Math.round(lon * 10000) / 10000 };
  }
  let button_layout = obj.button_layout ?? DEFAULT_SETTINGS.button_layout;
  if (typeof button_layout !== "string" || (button_layout !== "" && !ID_RE.test(button_layout))) throw new Invalid("bad button layout");
  return { shrink_px: s, home, button_layout };
}

// ------------------------------------------------------------------ GitHub render
/**
 * Start render.yml on GitHub, one at a time: if a render is already queued or running,
 * don't stack another behind it (it would render the same data again).
 * Returns { ok, busy, status }.
 */
async function startRender(env) {
  const gh = { "Authorization": `Bearer ${env.GH_TOKEN}`, "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "surf-frame-studio" };
  const runs = await fetch(`https://api.github.com/repos/${env.GH_REPO}/actions/workflows/render.yml/runs?per_page=5`,
    { headers: gh }).catch(() => null);
  if (runs && runs.ok) {
    const j = await runs.json().catch(() => ({}));
    if ((j.workflow_runs || []).some(x => RUN_BUSY.has(x.status))) return { ok: false, busy: true, status: 0 };
  }
  const r = await fetch(`https://api.github.com/repos/${env.GH_REPO}/actions/workflows/render.yml/dispatches`, {
    method: "POST",
    headers: { ...gh, "Content-Type": "application/json" },
    body: JSON.stringify({ ref: env.GH_REF || "main" }),
  });
  return { ok: r.status === 204, busy: false, status: r.status };
}

// ------------------------------------------------------------------ admin: friend frames
// The frame Worker's address: FRAME_IMG_ORIGIN if set, otherwise this Worker's
// workers.dev address with "surf-frame-studio" swapped for "surf-frame-img".
function imgOrigin(env, url) {
  if (env.FRAME_IMG_ORIGIN) return String(env.FRAME_IMG_ORIGIN).replace(/\/+$/, "");
  if (url.hostname.startsWith("surf-frame-studio.")) return `https://${url.hostname.replace(/^surf-frame-studio\./, "surf-frame-img.")}`;
  return null;
}

async function adminFrames(env, url, reg) {
  const origin = imgOrigin(env, url);
  const ok = secretOk(env.FRAME_SECRET);
  const out = [];
  for (const f of reg.frames) {
    out.push({ id: f.id, name: f.name || f.id, emails: f.emails || [], created: f.created || null,
      server: ok && origin ? `${origin}/f/${f.id}/${await pairCode(env.FRAME_SECRET, f.id)}` : null });
  }
  return { frames: out, secret_ok: ok, img_origin: origin, max: MAX_FRAMES };
}

function cleanFrame(fid, body, existing) {
  if (!FRAME_ID_RE.test(fid) || fid === MAIN) throw new Invalid("frame id: 2–24 lower-case letters, numbers or dashes (not \"main\")");
  if (!body || typeof body !== "object") throw new Invalid("bad frame");
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 40) : "";
  if (!name) throw new Invalid("frame needs a name");
  const emails = (Array.isArray(body.emails) ? body.emails : emailList(body.emails))
    .map(e => String(e).trim().toLowerCase()).filter(Boolean);
  if (!emails.length || emails.length > 5) throw new Invalid("give 1–5 email addresses");
  for (const e of emails) if (!EMAIL_RE.test(e)) throw new Invalid(`not an email address: ${e}`);
  return { id: fid, name, emails: [...new Set(emails)], created: (existing && existing.created) || new Date().toISOString().slice(0, 10) };
}

// ------------------------------------------------------------------ API
async function api(request, env, route, url, who) {
  const m = request.method;
  if (m !== "GET" && m !== "HEAD") {
    const origin = request.headers.get("Origin");
    if (origin !== url.origin) return json({ error: "bad origin" }, 403);
  }

  // ---- admin only
  if (route === "admin/frames" || route.startsWith("admin/frames/")) {
    if (!who.admin) return json({ error: "admins only" }, 403);
    const reg = who.registry;
    if (route === "admin/frames" && m === "GET") return json(await adminFrames(env, url, reg));
    const fid = route.slice("admin/frames/".length);
    if (m === "PUT") {
      const existing = reg.frames.find(f => f.id === fid);
      if (!existing && reg.frames.length >= MAX_FRAMES) return json({ error: `${MAX_FRAMES} frames at most` }, 400);
      const clean = cleanFrame(fid, await readBody(request), existing);
      const frames = existing ? reg.frames.map(f => (f.id === fid ? clean : f)) : [...reg.frames, clean];
      await putJSON(env, REGISTRY_KEY, { frames });
      return json({ ok: true });
    }
    if (m === "DELETE") {
      if (!FRAME_ID_RE.test(fid) || fid === MAIN) return json({ error: "bad frame" }, 400);
      if (!reg.frames.some(f => f.id === fid)) return json({ error: "not found" }, 404);
      await putJSON(env, REGISTRY_KEY, { frames: reg.frames.filter(f => f.id !== fid) });
      const keys = await listKeys(env, prefixFor(fid));   // "frames/<id>/" — never the root
      for (let i = 0; i < keys.length; i += 900) await env.BUCKET.delete(keys.slice(i, i + 900));
      return json({ ok: true, deleted: keys.length });
    }
    return json({ error: "unknown route" }, 404);
  }

  // ---- everything else acts on one frame the user may use
  const fid = url.searchParams.get("frame") || (who.frames[0] && who.frames[0].id);
  if (!fid || !who.frames.some(f => f.id === fid)) return json({ error: "not your frame" }, 403);
  const P = prefixFor(fid);
  const hidden = fid === MAIN ? [] : MAIN_ONLY_WIDGETS;

  if (route === "state" && m === "GET") {
    const [layouts, sel, renders, settings] = await Promise.all([
      listLayouts(env, P), getJSON(env, P + "state/selected.json", {}), getJSON(env, P + "renders/index.json", {}),
      getJSON(env, P + "state/frame-settings.json", DEFAULT_SETTINGS)]);
    return json({ selected: sel.layout || null, layouts, renders, render_now: !!(env.GH_TOKEN && env.GH_REPO),
      frame: fid, frames: who.frames, admin: who.admin, email: who.email, hidden_widgets: hidden,
      settings: { ...DEFAULT_SETTINGS, ...settings } });
  }
  if (route === "data" && m === "GET") {
    const o = await env.BUCKET.get(P + "data/data.json");
    return o ? secure(new Response(o.body, { headers: { "Content-Type": "application/json" } })) : json({ error: "no data yet" }, 404);
  }
  if (route === "settings") {
    if (m === "GET") return json({ ...DEFAULT_SETTINGS, ...(await getJSON(env, P + "state/frame-settings.json", {})) });
    if (m === "PUT") {
      const clean = cleanSettings(await readBody(request));
      await putJSON(env, P + "state/frame-settings.json", clean);
      return json({ ok: true, settings: clean });
    }
  }
  if (route.startsWith("layouts/")) {
    const id = route.slice(8);
    if (!ID_RE.test(id)) return json({ error: "bad id" }, 400);
    if (m === "GET") {
      const o = await env.BUCKET.get(`${P}layouts/${id}.json`);
      return o ? secure(new Response(o.body, { headers: { "Content-Type": "application/json" } })) : json({ error: "not found" }, 404);
    }
    if (m === "PUT") {
      const existing = await listLayouts(env, P);
      if (existing.length >= 30 && !existing.some(l => l.id === id)) return json({ error: "too many layouts (30 max)" }, 400);
      const clean = validateLayout(id, await readBody(request));
      const bad = clean.widgets.find(w => hidden.includes(w.type));
      if (bad) return json({ error: `the "${bad.type}" widget is only available on the main frame` }, 400);
      await putJSON(env, `${P}layouts/${id}.json`, clean);
      return json({ ok: true });
    }
    if (m === "DELETE") {
      const sel = await getJSON(env, P + "state/selected.json", {});
      if (sel.layout === id) return json({ error: "that layout is on the frame — choose another first" }, 409);
      await env.BUCKET.delete([`${P}layouts/${id}.json`, `${P}renders/${id}.png`, `${P}renders/${id}.bmp`,
        `${P}renders/${id}-grey.png`, `${P}renders/${id}-thumb.png`]);
      return json({ ok: true });
    }
  }
  if (route.startsWith("renders/") && m === "GET") {
    const f = route.slice(8);
    if (!RENDER_FILE_RE.test(f)) return json({ error: "bad file" }, 400);
    const o = await env.BUCKET.get(`${P}renders/${f}`);
    if (!o) return json({ error: "not found" }, 404);
    return secure(new Response(o.body, { headers: {
      "Content-Type": f.endsWith(".png") ? "image/png" : "image/bmp", "Cache-Control": "private, max-age=300" } }));
  }
  if (route === "select" && m === "POST") {
    const body = await readBody(request);
    const id = body && body.layout;
    if (typeof id !== "string" || !ID_RE.test(id) || !(await env.BUCKET.head(`${P}layouts/${id}.json`)))
      return json({ error: "unknown layout" }, 400);
    await putJSON(env, P + "state/selected.json", { layout: id });
    return json({ ok: true });
  }
  if (route === "render-now" && m === "POST") {
    if (!env.GH_TOKEN || !env.GH_REPO) return json({ error: "render-now not configured" }, 501);
    const last = await getJSON(env, "state/render-request.json", {});
    const now = Math.floor(Date.now() / 1000);
    if (last.ts && now - last.ts < RENDER_COOLDOWN_S)
      return json({ error: "a render was just requested — give it a minute" }, 429);
    const res = await startRender(env);
    if (res.busy) return json({ error: "a render is already running — the picture updates when it finishes (2–3 min)" }, 429);
    if (!res.ok) return json({ error: `GitHub said ${res.status}` }, 502);
    await putJSON(env, "state/render-request.json", { ts: now });
    return json({ ok: true }, 202);
  }
  return json({ error: "unknown route" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let auth = await verifyAccess(request, env).catch(() => ({ ok: false, why: "auth error" }));
    let who = null;
    if (auth.ok) {
      who = await whoIs(env, auth.email).catch(() => null);
      if (!who || (!who.admin && !who.frames.length)) auth = { ok: false, why: "not allowed" };
    }
    if (!auth.ok) {
      console.log(JSON.stringify({ event: "denied", why: auth.why, path: url.pathname, ip: request.headers.get("CF-Connecting-IP") }));
      return secure(new Response("Forbidden", { status: 403, headers: { "Content-Type": "text/plain" } }));
    }
    try {
      if (url.pathname.startsWith("/api/")) {
        const resp = await api(request, env, url.pathname.slice(5), url, who);
        if (request.method !== "GET") console.log(JSON.stringify({ event: "change", who: who.email, method: request.method,
          path: url.pathname, frame: url.searchParams.get("frame"), status: resp.status }));
        return resp;
      }
      if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "method not allowed" }, 405);
      const assetUrl = new URL(url);
      if (url.pathname === "/" || url.pathname === "/index.html") assetUrl.pathname = "/studio.html";
      return secure(await env.ASSETS.fetch(new Request(assetUrl, request)));
    } catch (e) {
      if (e instanceof Invalid) return json({ error: e.message }, 400);
      console.log(JSON.stringify({ event: "error", message: String(e && e.message) }));
      return json({ error: "server error" }, 500);
    }
  },

  // Cloudflare Cron Trigger: start the scheduled render on time (GitHub's own schedule
  // runs late or not at all). Results go to Workers Logs.
  async scheduled(controller, env) {
    if (!env.GH_TOKEN || !env.GH_REPO) {
      console.log(JSON.stringify({ event: "cron_render", result: "not configured" }));
      return;
    }
    let res;
    try { res = await startRender(env); } catch (e) { res = { ok: false, busy: false, status: String(e && e.message) }; }
    const result = res.ok ? "dispatched" : res.busy ? "already running" : "failed";
    // A 401 here usually means the GH_TOKEN PAT has expired: GitHub's schedule is then the only trigger.
    console.log(JSON.stringify({ event: "cron_render", cron: controller && controller.cron, result, status: res.status }));
  },
};
