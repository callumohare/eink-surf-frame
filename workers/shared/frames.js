// Friend frames — shared by both Workers (wrangler bundles this relative import).
//
// "main" is the owner's own frame: its files stay at the bucket root (layouts/, state/,
// renders/, data/) exactly as before, and it pairs with DEVICE_MACS + DEVICE_TOKEN.
//
// Every other frame lives under frames/<id>/ in the same bucket and is listed in
// state/frames.json (written only by an admin in the studio). A friend frame pairs
// itself: its Custom Server address carries the frame id and a pairing code,
//     https://<surf-frame-img host>/f/<id>/<code>
// and both the code and the frame's device key are derived from the FRAME_SECRET
// Worker secret (HMAC-SHA256), so nothing per-frame is stored as a secret.
// Rotating FRAME_SECRET changes every friend's address; they must enter the new one.

export const MAIN = "main";
export const FRAME_ID_RE = /^[a-z0-9][a-z0-9-]{1,23}$/;   // "main" is reserved
export const CODE_RE = /^[0-9a-f]{16}$/;
export const MAX_FRAMES = 20;
export const REGISTRY_KEY = "state/frames.json";
// Widgets that only make sense for the main frame: The Wave bookings come from the owner's
// inbox and "Board & fins" suggests boards from the owner's quiver.
export const MAIN_ONLY_WIDGETS = ["booking", "countdown", "quiver"];

export const prefixFor = fid => (fid === MAIN ? "" : `frames/${fid}/`);

async function hmacHex(secret, msg) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
  return Array.from(sig, b => b.toString(16).padStart(2, "0")).join("");
}

/** 16 hex characters that go in the friend's Custom Server address. */
export async function pairCode(secret, fid) {
  return (await hmacHex(secret, "surf-frame:pair:" + fid)).slice(0, 16);
}

/** The frame's device key (the TRMNL firmware's api_key / Access-Token). */
export async function deviceToken(secret, fid) {
  return (await hmacHex(secret, "surf-frame:device:" + fid)).slice(0, 48);
}

/** The frame list, or an empty one. Never throws on bad JSON. */
export async function loadRegistry(bucket) {
  const o = await bucket.get(REGISTRY_KEY);
  if (!o) return { frames: [] };
  try {
    const j = await o.json();
    return { frames: Array.isArray(j.frames) ? j.frames.filter(f => f && FRAME_ID_RE.test(f.id) && f.id !== MAIN) : [] };
  } catch (_) {
    return { frames: [] };
  }
}

export const secretOk = secret => typeof secret === "string" && secret.length >= 32;
