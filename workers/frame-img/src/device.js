// Helpers for the TRMNL device API (kept out of index.js, whose exports Cloudflare
// treats as Worker entry points).

// "aa:bb:cc:dd:ee:ff", "AA-BB-..." and "aabbccddeeff" all normalise to "AABBCCDDEEFF".
export const normMac = s => String(s || "").toUpperCase().replace(/[^0-9A-F]/g, "");
export const macAllowed = (mac, env) => {
  const m = normMac(mac);
  return m.length === 12 && String(env.DEVICE_MACS || "").split(/[\s,]+/).map(normMac).includes(m);
};
// For logs: enough to recognise your device, not the whole address.
export const macHint = mac => { const m = normMac(mac); return m.length === 12 ? `…${m.slice(6)}` : "(none)"; };

const intVar = (v, dflt, lo, hi) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
};

/**
 * Seconds until the frame should next wake: a little after the next scheduled render
 * (Cloudflare Cron Trigger "7 *\/3 * * *" UTC on the studio Worker), so each wake picks up a fresh
 * picture. REFRESH_HOURS / RENDER_MINUTE / REFRESH_OFFSET_MIN in wrangler.toml.
 */
export function refreshSeconds(nowMs, env = {}) {
  const hours = intVar(env.REFRESH_HOURS, 3, 1, 24);
  const minute = intVar(env.RENDER_MINUTE, 7, 0, 59);
  const offset = intVar(env.REFRESH_OFFSET_MIN, 25, 0, 120);
  const period = hours * 3600;
  const phase = ((minute + offset) * 60) % period;   // seconds past each UTC slot boundary
  const t = Math.floor(nowMs / 1000);
  let s = (phase - ((t % period) + period) % period + period) % period;
  if (s < 120) s += period;                          // don't wake twice in a row
  return s;
}
