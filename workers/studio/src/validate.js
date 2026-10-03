// Layout validation — mirrors pipeline/validate.py. Keep the two in sync.
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const WID_RE = /^[a-z0-9]{1,12}$/;
const TYPE_RE = /^[a-z_]{1,30}$/;
const KEY_RE = /^[A-Za-z]{1,30}$/;
const SPOT_RE = /^[a-z_]{1,40}$/;
const COLS = 40, ROWS = 24;

export class Invalid extends Error {}

const isInt = v => Number.isInteger(v);

export function validateLayout(id, obj) {
  if (!ID_RE.test(id || "")) throw new Invalid("bad layout id");
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Invalid("layout must be an object");
  const name = obj.name ?? "";
  if (typeof name !== "string" || name.length > 60) throw new Invalid("bad name");
  const spot = obj.spot ?? "";
  if (typeof spot !== "string" || !SPOT_RE.test(spot)) throw new Invalid("bad spot");
  const mode = obj.mode ?? "1bit";
  if (mode !== "1bit" && mode !== "4grey") throw new Invalid("bad mode");
  const threshold = obj.threshold ?? 160;
  if (!isInt(threshold) || threshold < 40 || threshold > 240) throw new Invalid("bad threshold");
  const invert = obj.invert ?? false;
  if (typeof invert !== "boolean") throw new Invalid("bad invert");
  const ws = obj.widgets;
  if (!Array.isArray(ws) || ws.length > 40) throw new Invalid("widgets must be a list of at most 40");
  const seen = new Set();
  const widgets = ws.map(w => {
    if (!w || typeof w !== "object") throw new Invalid("bad widget");
    if (typeof w.id !== "string" || !WID_RE.test(w.id) || seen.has(w.id)) throw new Invalid("bad widget id");
    seen.add(w.id);
    if (typeof w.type !== "string" || !TYPE_RE.test(w.type)) throw new Invalid("bad widget type");
    const g = {};
    for (const [k, lo, hi] of [["x", 0, COLS - 1], ["y", 0, ROWS - 1], ["w", 1, COLS], ["h", 1, ROWS]]) {
      if (!isInt(w[k]) || w[k] < lo || w[k] > hi) throw new Invalid(`bad widget ${k}`);
      g[k] = w[k];
    }
    if (g.x + g.w > COLS || g.y + g.h > ROWS) throw new Invalid("widget out of bounds");
    const props = w.props ?? {};
    if (typeof props !== "object" || Array.isArray(props) || Object.keys(props).length > 20) throw new Invalid("bad props");
    const cp = {};
    for (const [k, v] of Object.entries(props)) {
      if (!KEY_RE.test(k)) throw new Invalid("bad prop key");
      if (typeof v === "string") { if (v.length > 200) throw new Invalid("prop too long"); }
      else if (typeof v !== "boolean" && !(typeof v === "number" && Number.isFinite(v))) throw new Invalid("bad prop value");
      cp[k] = v;
    }
    return { id: w.id, type: w.type, ...g, props: cp };
  });
  return { id, name, spot, mode, threshold, invert, widgets };
}
