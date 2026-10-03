/* Surf Frame — shared widget renderer.
 *
 * Used by BOTH the studio editor (live, in your browser) and the cloud render
 * (headless Chromium in GitHub Actions), so the editor is WYSIWYG.
 *
 * Rules that keep this safe and deterministic:
 *  - Never uses innerHTML: all text goes in via textContent (data from Surfline
 *    and from email is untrusted).
 *  - Never uses Date() local-time methods: the pipeline pre-formats every time
 *    in Europe/London, because the cloud browser runs in UTC.
 *  - Styles are set through the CSSOM (el.style), which a strict CSP allows.
 *  - Pure black/white drawing with pixel patterns for shading, so 1-bit output
 *    stays crisp on e-ink.
 */
(function (global) {
  "use strict";

  const CELL = 20, COLS = 40, ROWS = 24, INSET = 4;
  const SVGNS = "http://www.w3.org/2000/svg";

  // ------------------------------------------------------------------ helpers
  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function s(tag, attrs, text) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs || {}) e.setAttribute(k, attrs[k]);
    if (text !== undefined) e.textContent = String(text);
    return e;
  }
  function add(parent, ...kids) { kids.forEach(k => k && parent.appendChild(k)); return parent; }
  const fmt1 = v => (v === null || v === undefined || isNaN(v)) ? "–" : (Math.round(v * 10) / 10).toFixed(1);
  const fmt0 = v => (v === null || v === undefined || isNaN(v)) ? "–" : String(Math.round(v));
  function range(min, max) {
    if (max === null || max === undefined) return "–";
    if (min === null || min === undefined || Math.abs(max - min) < 0.05) return fmt1(max);
    return fmt1(min) + "–" + fmt1(max);
  }
  // Wave heights: the pipeline stores metres; data.units.wave says how to show them.
  const FT = 3.28084;
  const isFt = ctx => ((ctx.data.units || {}).wave || "m") === "ft";
  const hUnit = ctx => (isFt(ctx) ? "ft" : "m");
  function surfRange(ctx, min, max) {
    if (!isFt(ctx)) return range(min, max);
    if (max === null || max === undefined) return "–";
    const hi = Math.round(max * FT), lo = min === null || min === undefined ? hi : Math.round(min * FT);
    if (hi < 1) return "<1";
    return lo >= hi ? String(hi) : `${Math.max(lo, 0)}–${hi}`;
  }
  const swellH = (ctx, m) => (isFt(ctx) ? fmt1(m * FT) + "ft" : fmt1(m) + "m");
  const WIND_LABEL = { "offshore": "Offshore", "cross-off": "Cross-off", "cross": "Cross-shore",
    "cross-on": "Cross-on", "onshore": "Onshore", "glassy": "Glassy" };
  const windUnit = u => ({ mph: "mph", kph: "km/h", kts: "kts" }[u] || u);

  function defs(svg) {
    // 1-bit friendly shading patterns (integer pixel grid)
    const d = s("defs");
    const diag = s("pattern", { id: "p-diag", width: 4, height: 4, patternUnits: "userSpaceOnUse" });
    for (let i = 0; i < 4; i++) diag.appendChild(s("rect", { x: i, y: 3 - i, width: 1, height: 1, fill: "#000" }));
    const dots = s("pattern", { id: "p-dots", width: 3, height: 3, patternUnits: "userSpaceOnUse" });
    dots.appendChild(s("rect", { x: 1, y: 1, width: 1, height: 1, fill: "#000" }));
    const light = s("pattern", { id: "p-light", width: 4, height: 4, patternUnits: "userSpaceOnUse" });
    light.appendChild(s("rect", { x: 0, y: 0, width: 1, height: 1, fill: "#000" }));
    light.appendChild(s("rect", { x: 2, y: 2, width: 1, height: 1, fill: "#000" }));
    const half = s("pattern", { id: "p-half", width: 2, height: 2, patternUnits: "userSpaceOnUse" });
    half.appendChild(s("rect", { x: 0, y: 0, width: 1, height: 1, fill: "#000" }));
    half.appendChild(s("rect", { x: 1, y: 1, width: 1, height: 1, fill: "#000" }));
    add(d, diag, dots, light, half);
    svg.appendChild(d);
  }
  function svgBox(w, hgt) {
    const v = s("svg", { width: w, height: hgt, viewBox: `0 0 ${w} ${hgt}`, "shape-rendering": "crispEdges" });
    defs(v);
    return v;
  }

  // arrow pointing in the direction of travel (meteorological "from" + 180).
  // Swell arrows are a plain head; WIND arrows (tail = true) have a shorter head on a
  // solid shaft, so the two can't be confused. filled === false draws a hollow head
  // (used for onshore-ish wind).
  function arrow(fromDeg, size, filled, tail) {
    const v = s("svg", { width: size, height: size, viewBox: "-10 -10 20 20", class: tail ? "arrow warrow" : "arrow" });
    if (fromDeg === null || fromDeg === undefined) return v;
    const g = s("g", { transform: `rotate(${(fromDeg + 180) % 360})` });
    const fill = filled === false ? "#fff" : "#000";
    if (tail) {
      g.appendChild(s("rect", { x: -1.5, y: -2, width: 3, height: 11.5, fill: "#000" }));
      g.appendChild(s("path", { d: "M0,-9.5 L6.5,2.5 L0,-0.5 L-6.5,2.5 Z", fill, stroke: "#000", "stroke-width": 1.6, "stroke-linejoin": "round" }));
    } else {
      g.appendChild(s("path", { d: "M0,-9 L6,5 L0,2 L-6,5 Z", fill, stroke: "#000", "stroke-width": 1.6, "stroke-linejoin": "round" }));
    }
    v.appendChild(g);
    return v;
  }
  // Wind: filled head for offshore / cross-off / glassy, hollow for everything else.
  const windGood = t => t === "offshore" || t === "cross-off" || t === "glassy";
  const windArrow = (dir, size, type) => arrow(dir, size, type === undefined ? true : windGood(type), true);

  // First/last light icon: a half sun sitting on the horizon with a chevron
  // pointing up (first light) or down (last light). Solid shapes on a 16-unit
  // grid so it stays legible in 1-bit at ~12-16 px.
  // sun = true: sunrise/sunset (solid half sun); otherwise first/last light (outline half
  // sun), so the two pairs are easy to tell apart when both are shown.
  function lightIcon(up, size, sun) {
    // Designed on a 16x16 pixel grid (drawn 1:1 at 16 px): chevron on top, a clear gap,
    // then a half sun on a 2-px horizon. Reads in 1-bit and 4-grey.
    const v = s("svg", { width: size, height: size, viewBox: "0 0 16 16", class: "licon" });
    v.appendChild(s("rect", { x: 0, y: 14, width: 16, height: 2, fill: "currentColor", "shape-rendering": "crispEdges" }));
    v.appendChild(sun ? s("path", { d: "M3 14 A5 5 0 0 1 13 14 Z", fill: "currentColor" })
      : s("path", { d: "M4 14 A4 4 0 0 1 12 14", fill: "none", stroke: "currentColor", "stroke-width": 2 }));
    v.appendChild(s("path", {
      d: up ? "M4 6 L8 2 L12 6" : "M4 2 L8 6 L12 2",
      fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "square", "stroke-linejoin": "miter",
    }));
    return v;
  }


  function ratingBar(score, cls) {
    const bar = h("div", "rbar " + (cls || ""));
    const n = score === null || score === undefined ? 0 : Math.round(score);
    for (let i = 0; i < 5; i++) bar.appendChild(h("span", i < n ? "on" : ""));
    return bar;
  }

  function title(text, extra) {
    const t = h("div", "wt");
    t.dataset.drop = "3";  // in a really cramped box the title goes before the data does
    t.appendChild(h("span", "", text));
    if (extra) { const x = h("span", "wt-x", extra); x.dataset.drop = "1"; t.appendChild(x); }
    return t;
  }

  function spotOf(ctx) {
    const key = ctx.props.spot && ctx.props.spot !== "default" ? ctx.props.spot : ctx.layout.spot;
    return (ctx.data.spots || {})[key] || (ctx.data.spots || {})[(ctx.data.spot_order || [])[0]] || null;
  }

  // Show this widget white-on-black (whatever its Style setting says).
  function invertBox(el) {
    const box = el.parentElement;
    if (!box) return;
    box.classList.remove("f-box", "f-none", "f-inverse");
    box.classList.add("f-inverse");
  }

  function missing(el, msg) { el.appendChild(h("div", "missing", msg || "No data")); }


  // ---------------------------------------------------------------- weather & moon icons
  // Solid shapes on a 24-unit grid with 2-unit strokes: they survive 1-bit conversion.
  function cloudShape(g, dx, dy, k, outline) {
    const c = (cx, cy, r) => s("circle", { cx: dx + cx * k, cy: dy + cy * k, r: r * k, fill: "currentColor" });
    const parts = [c(8, 14, 5), c(13.5, 10.5, 6), c(18.5, 14.5, 4.5),
      s("rect", { x: dx + 3 * k, y: dy + 14 * k, width: 19 * k, height: 5 * k, rx: 2.5 * k, fill: "currentColor" })];
    if (outline) {  // white halo so a cloud reads in front of a sun
      const halo = s("g", { stroke: "#fff", "stroke-width": 3.5, fill: "#fff" });
      parts.forEach(p => { const q = p.cloneNode(); q.setAttribute("fill", "#fff"); halo.appendChild(q); });
      g.appendChild(halo);
    }
    parts.forEach(p => g.appendChild(p));
  }
  function sunShape(g, cx, cy, r, rays) {
    g.appendChild(s("circle", { cx, cy, r, fill: "currentColor" }));
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4, r1 = r + 2.2, r2 = r + rays;
      g.appendChild(s("line", { x1: cx + Math.cos(a) * r1, y1: cy + Math.sin(a) * r1, x2: cx + Math.cos(a) * r2, y2: cy + Math.sin(a) * r2,
        stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round" }));
    }
  }
  function wxIcon(kind, size) {
    const v = s("svg", { width: size, height: size, viewBox: "0 0 24 24", class: "wx" });
    const g = s("g"); v.appendChild(g);
    const drops = (n, dot) => {
      for (let i = 0; i < n; i++) {
        const x = 7 + i * 5;
        g.appendChild(dot ? s("circle", { cx: x, cy: 21, r: 1.4, fill: "currentColor" })
          : s("line", { x1: x + 1.5, y1: 18.5, x2: x - 0.5, y2: 23, stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round" }));
      }
    };
    switch (kind) {
      case "sun": sunShape(g, 12, 12, 5, 4.5); break;
      case "partly": sunShape(g, 8, 8, 3.6, 3); cloudShape(g, 3, 5, 0.85, true); break;
      case "cloud": cloudShape(g, 0, 1, 1, false); break;
      case "fog":
        [7, 11, 15, 19].forEach((y, i) => g.appendChild(s("line", { x1: i % 2 ? 5 : 2, x2: i % 2 ? 22 : 19, y1: y, y2: y, stroke: "currentColor", "stroke-width": 2.2, "stroke-linecap": "round" })));
        break;
      case "drizzle": cloudShape(g, 0, -3, 0.95, false); drops(3, true); break;
      case "rain": cloudShape(g, 0, -3, 0.95, false); drops(3, false); break;
      case "showers": sunShape(g, 17, 5, 2.8, 2.4); cloudShape(g, -1, -2, 0.85, true); drops(3, false); break;
      case "snow":
        cloudShape(g, 0, -3, 0.95, false);
        [7, 12, 17].forEach(x => { g.appendChild(s("line", { x1: x - 2, x2: x + 2, y1: 21, y2: 21, stroke: "currentColor", "stroke-width": 1.8 }));
          g.appendChild(s("line", { x1: x, x2: x, y1: 19, y2: 23, stroke: "currentColor", "stroke-width": 1.8 })); });
        break;
      case "thunder":
        cloudShape(g, 0, -3, 0.95, false);
        g.appendChild(s("path", { d: "M13 15 L8 21 L11.5 21 L10 24 L16 18 L12.5 18 L14 15 Z", fill: "currentColor", stroke: "#fff", "stroke-width": 1 }));
        break;
      default: cloudShape(g, 0, 1, 1, false);
    }
    return v;
  }
  // Moon: dark disc with the lit part drawn white (northern hemisphere: waxing = lit on the right).
  // onDark: for white-on-black areas (the header) — the lit part is drawn in the text
  // colour and the dark part left black, so a full moon still looks full.
  function moonIcon(m, size, onDark) {
    const v = s("svg", { width: size, height: size, viewBox: "0 0 24 24", class: "wx" });
    const cx = 12, cy = 12, r = 10, k = m.illum;
    const lit = onDark ? "currentColor" : "#fff";
    v.appendChild(s("circle", { cx, cy, r, fill: onDark ? "none" : "currentColor" }));
    if (k > 0.02) {
      const rx = Math.max(0.01, r * Math.abs(1 - 2 * k));
      let d;
      if (m.waxing) d = `M${cx},${cy - r} A${r},${r} 0 0 1 ${cx},${cy + r} A${rx},${r} 0 0 ${k < 0.5 ? 0 : 1} ${cx},${cy - r} Z`;
      else d = `M${cx},${cy - r} A${r},${r} 0 0 0 ${cx},${cy + r} A${rx},${r} 0 0 ${k < 0.5 ? 1 : 0} ${cx},${cy - r} Z`;
      v.appendChild(s("path", { d, fill: lit }));
    }
    v.appendChild(s("circle", { cx, cy, r: r - 0.1, fill: "none", stroke: "currentColor", "stroke-width": 2 }));
    return v;
  }
  const deg = v => (v === null || v === undefined ? "–" : Math.round(v) + "°");

  // ------------------------------------------------------------------ widgets
  const SPOT_PROP = { key: "spot", label: "Spot", type: "spot", default: "default" };
  // Every data widget has a "detail" level. Saved widgets without one render as "full"
  // (or as close as possible to their old on/off options — see legacy()).
  const DETAIL = { key: "detail", label: "Detail", type: "select", options: ["min", "std", "full"],
    labels: ["Minimal", "Standard", "Full"], default: "full" };
  const LV = { min: 0, std: 1, full: 2 };
  function lvl(ctx) {
    const v = ctx.props.detail;
    if (v === true) return 2;
    if (v === false) return 1;
    return v in LV ? LV[v] : 2;
  }
  // Mark an element as optional: if the widget still doesn't fit at the smallest text
  // size, optional elements are removed (priority 1 first) instead of being cut off.
  function opt(e, p, group) {
    if (e) { e.dataset.drop = String(p || 1); if (group) e.dataset.dg = group; }
    return e;
  }
  const W = {};
  const WHERE_PROP = { key: "where", label: "Location", type: "select", options: ["spot", "home"],
    labels: ["Surf spot", "Home"], default: "spot" };
  // Weather for the widget's chosen place: a surf spot, or [home] from settings.
  function wxSource(ctx) {
    if (ctx.props.where === "home") {
      const hm = ctx.data.home;
      return hm ? { name: hm.name, w: hm.weather, day: hm.session_day } : { name: "Home", w: null, day: null };
    }
    const sp = spotOf(ctx);
    return sp ? { name: sp.name, w: sp.weather, day: sp.session_day } : { name: "", w: null, day: null };
  }

  W.header = {
    name: "Date & header", def: { w: 40, h: 3 }, min: { w: 10, h: 2 }, frame: "inverse",
    props: [DETAIL, { key: "dateStyle", label: "Date", type: "select", options: ["long", "short"], default: "long" }, SPOT_PROP],
    legacy: p => (p.showLight === false ? "min" : p.showSpot === false || p.showUpdated === false ? "std" : null),
    render(el, ctx) {
      const L = lvl(ctx);
      const t = ctx.data.today || {};
      const date = ctx.props.dateStyle === "short"
        ? `${t.dow3} ${t.day} ${t.mon3}` : `${t.dow} ${t.day} ${t.month}`;
      const row = h("div", "hdr");
      row.appendChild(h("div", "hdr-date", date));
      const sp = spotOf(ctx);
      if (L >= 1 && sp && sp.sun) {
        const light = opt(h("div", "hdr-light"), 3);
        const isz = Math.max(14, Math.round(ctx.px(16)));
        // first light, sunrise, sunset, last light; sunrise/sunset go first if it's tight
        [[true, sp.sun.first_light, false], [true, sp.sun.sunrise, true], [false, sp.sun.sunset, true],
          [false, sp.sun.last_light, false]].forEach(([up, v, sun]) => {
          const c = h("div", "hl" + (sun ? " hl-sun" : ""));
          add(c, lightIcon(up, isz, sun), h("span", "hl-v", v || "–"));
          light.appendChild(sun ? opt(c, 2, "hsun") : c);
        });
        if (ctx.data.moon) {
          const mc = h("div", "hl hmoon");
          mc.appendChild(moonIcon(ctx.data.moon, isz + 2, (ctx.props.frame || "inverse") === "inverse"));
          light.appendChild(mc);
        }
        row.appendChild(light);
      }
      if (L >= 2) {
        const right = opt(h("div", "hdr-r"), 1);
        if (sp) right.appendChild(h("div", "hdr-spot", sp.name));
        right.appendChild(h("div", "hdr-upd", "Updated " + (ctx.data.generated || "–")));
        row.appendChild(right);
      }
      el.appendChild(row);
    },
  };

  W.surf = {
    name: "Surf height & rating", def: { w: 12, h: 8 }, min: { w: 6, h: 4 },
    props: [DETAIL, SPOT_PROP],
    legacy: p => (p.showHuman === false ? "std" : null),
    render(el, ctx) {
      const L = lvl(ctx);
      const sp = spotOf(ctx); const n = sp && sp.now;
      el.appendChild(title("Surf", sp && L >= 1 ? sp.name : ""));
      if (!n) return missing(el);
      const big = h("div", "big");
      big.appendChild(h("span", "num", surfRange(ctx, n.surf_min, n.surf_max)));
      big.appendChild(h("span", "unit", hUnit(ctx) + (sp.source === "open-meteo" ? " est." : "")));
      el.appendChild(big);
      if (L >= 2 && n.human) el.appendChild(opt(h("div", "sub", n.human), 1));
      if (L >= 1) {
        const r = opt(h("div", "rrow"), 2);
        add(r, ratingBar(n.score), opt(h("span", "rlabel", n.label), 1));
        el.appendChild(r);
      }
    },
  };

  W.swell = {
    name: "Swell", def: { w: 12, h: 6 }, min: { w: 7, h: 3 },
    props: [DETAIL, SPOT_PROP, { key: "count", label: "Swells shown", type: "number", min: 1, max: 3, default: 2 }],
    render(el, ctx) {
      const L = lvl(ctx);
      const sp = spotOf(ctx); const n = sp && sp.now;
      el.appendChild(title("Swell"));
      if (!n || !n.swells || !n.swells.length) return missing(el);
      const list = h("div", "rows");
      n.swells.slice(0, L === 0 ? 1 : ctx.props.count || 2).forEach((sw, i) => {
        const r = h("div", "srow" + (i === 0 ? " primary" : ""));
        add(r, arrow(sw.dir, Math.round(ctx.px(i === 0 ? 26 : 18))),
          h("span", "sv", swellH(ctx, sw.h)), h("span", "sv", (sw.per || "–") + "s"));
        if (L >= 1) r.appendChild(opt(h("span", "sd", L >= 2 ? `${sw.cmp} ${fmt0(sw.dir)}°` : sw.cmp), 1, "sd"));
        list.appendChild(i ? opt(r, 2) : r);
      });
      el.appendChild(list);
    },
  };

  W.wind = {
    name: "Wind", def: { w: 10, h: 7 }, min: { w: 6, h: 4 },
    props: [DETAIL, SPOT_PROP],
    legacy: p => (p.strip === false || p.showGust === false ? "std" : null),
    render(el, ctx) {
      const L = lvl(ctx);
      const sp = spotOf(ctx); const n = sp && sp.now;
      const u = windUnit(ctx.data.units && ctx.data.units.wind);
      el.appendChild(title("Wind"));
      if (!n || !n.wind) return missing(el);
      const w = n.wind;
      const main = h("div", "wmain");
      add(main, windArrow(w.dir, Math.round(ctx.px(40)), w.type));
      const txt = h("div", "wtxt");
      const big = h("div", "big");
      add(big, h("span", "num", fmt0(w.speed)), h("span", "unit", u));
      txt.appendChild(big);
      const typ = WIND_LABEL[w.type] || w.type || "";
      const compact = ctx.box.h < 5 * CELL;  // short box: fold the wind type into the sub line
      if (L >= 1) {
        txt.appendChild(opt(h("div", "sub", `${w.cmp}${w.gust ? " · gust " + w.gust : ""}${compact && typ ? " · " + typ : ""}`), 1));
      }
      add(main, txt);
      el.appendChild(main);
      if (L >= 1 && !compact && typ) el.appendChild(opt(h("div", "wtype", typ), 2));
      if (L >= 2 && sp.chart) {
        const pts = sp.chart.points.filter(p => p.ts > n.ts && (p.ts - n.ts) % (3 * 3600) === 0).slice(0, 4);
        if (pts.length && ctx.box.h >= 7 * CELL - 2 * INSET) {
          const st = opt(h("div", "wstrip"), 1);
          pts.forEach(p => {
            const c = h("div", "wcell");
            add(c, h("span", "wt-t", p.t), windArrow(p.wd, Math.round(ctx.px(14)), p.wt), h("span", "wt-s", fmt0(p.ws)));
            st.appendChild(c);
          });
          el.appendChild(st);
        }
      }
    },
  };

  W.tide_times = {
    name: "Tide times", def: { w: 9, h: 7 }, min: { w: 6, h: 4 },
    props: [DETAIL, SPOT_PROP],
    legacy: p => (p.tomorrow ? "full" : "std"),
    render(el, ctx) {
      const L = lvl(ctx);
      const sp = spotOf(ctx); const t = sp && sp.tides;
      el.appendChild(title("Tides", L >= 1 && t && t.range_today ? `${fmt1(t.range_today)} m range` : ""));
      if (!t || !t.events.length) return missing(el);
      const list = h("div", "rows tides");
      let divided = false;
      t.events.filter(e => e.day === 0 || (L >= 2 && e.day === 1)).forEach(e => {
        if (e.day && !divided) { list.appendChild(opt(h("div", "tdiv", "Tomorrow"), 1)); divided = true; }
        const r = h("div", "trow" + (e.day ? " tmrw" : "") + (L === 0 ? " noh" : ""));
        add(r, h("span", "tk", e.type === "HIGH" ? "HW" : "LW"), h("span", "tt", e.t));
        if (L >= 1) r.appendChild(opt(h("span", "th", e.h !== null ? fmt1(e.h) + "m" : ""), 2, "th"));
        list.appendChild(e.day ? opt(r, 1) : list.children.length >= 2 ? opt(r, 2) : r);
      });
      el.appendChild(list);
    },
  };

  W.tide_chart = {
    name: "Tide chart", def: { w: 14, h: 6 }, min: { w: 8, h: 4 },
    props: [DETAIL, SPOT_PROP, { key: "hours", label: "Hours", type: "select", options: ["24", "48", "72"], default: "24" }],
    legacy: p => (p.labels === false ? "min" : null),
    render(el, ctx) {
      const L = lvl(ctx);
      const sp = spotOf(ctx); const t = sp && sp.tides;
      if (!t || !t.curve.length) { el.appendChild(title("Tide")); return missing(el); }
      // Hours from midnight today. `days` (from the pipeline) has each local day's exact
      // bounds; older data only has today, so it falls back to one day.
      const nd = Math.max(1, Math.round(parseInt(ctx.props.hours || "24", 10) / 24));
      const days = t.days && t.days.length ? t.days.slice(0, nd) : [{ start: t.day_start, end: t.day_end, dow: "" }];
      const start = days[0].start, end = days[days.length - 1].end;
      const multi = days.length > 1;
      const curve = t.curve.filter(p => p.ts >= start && p.ts <= end);
      if (curve.length < 2) { el.appendChild(title("Tide")); return missing(el); }
      const W_ = Math.floor(ctx.box.w), H_ = Math.floor(ctx.box.h);
      const fs = Math.max(12, Math.round(ctx.px(11)));
      const labels = L >= 1 && H_ >= 3 * fs;
      const head = L >= 2 && H_ >= 4 * fs;
      const pad = { l: 4, r: 4, t: (head ? fs + 4 : 2) + (labels ? fs + 4 : 2), b: Math.round(ctx.px(14)) + 2 };
      const v = svgBox(W_, H_);
      // Fixed scale for the spot (pipeline sets it from the biggest tides), so a neap
      // day looks small and a spring day fills the box — it never "bottoms out".
      const hs = curve.map(p => p.h);
      const sc = t.scale || {};
      const lo = Math.min(sc.min !== undefined ? sc.min : Math.min(...hs), ...hs);
      const hi = Math.max(sc.max !== undefined ? sc.max : Math.max(...hs), ...hs);
      const X = ts => pad.l + (ts - start) / (end - start) * (W_ - pad.l - pad.r);
      const Y = hh => pad.t + (1 - (hh - lo) / ((hi - lo) || 1)) * (H_ - pad.t - pad.b);
      let d = "";
      curve.forEach((p, i) => { d += (i ? "L" : "M") + X(p.ts).toFixed(1) + "," + Y(p.h).toFixed(1); });
      const base = H_ - pad.b;
      v.appendChild(s("path", { d: d + `L${X(curve[curve.length - 1].ts)},${base}L${X(curve[0].ts)},${base}Z`, fill: "url(#p-diag)" }));
      v.appendChild(s("path", { d, fill: "none", stroke: "#000", "stroke-width": 2.5, "shape-rendering": "geometricPrecision" }));
      v.appendChild(s("line", { x1: pad.l, x2: W_ - pad.r, y1: base, y2: base, stroke: "#000", "stroke-width": 1 }));
      // faint line at the top of the scale so the "full" height is visible
      v.appendChild(s("line", { x1: pad.l, x2: W_ - pad.r, y1: Math.round(Y(hi)), y2: Math.round(Y(hi)), stroke: "#000", "stroke-dasharray": "1,3" }));
      // Local clock hour within a day: on a clock-change day (23 or 25 h) hours from
      // 03:00 on move by the hour gained or lost.
      const atHour = (dd, hr) => dd.start + hr * 3600 + (hr >= 3 ? (dd.end - dd.start) - 86400 : 0);
      const axisText = (x, txt, bold) => v.appendChild(s("text", { x, y: H_ - 1, "font-size": fs, "text-anchor": "middle",
        class: bold ? "svgt b" : "svgt", "paint-order": "stroke", stroke: "#fff", "stroke-width": 3 }, txt));
      const tickAt = x => v.appendChild(s("line", { x1: x, x2: x, y1: base, y2: base + 4, stroke: "#000" }));
      if (!multi) {
        [6, 12, 18].forEach(hr => { const x = X(atHour(days[0], hr)); tickAt(x); axisText(x, String(hr).padStart(2, "0")); });
      } else {
        // More than one day: a divider at each midnight, the day's name under its middle,
        // and 06 / 18 either side when there's room (ticks every 6 hours regardless).
        const dayW = X(days[0].end) - X(days[0].start);
        const short = dayW < fs * 2.6;
        const nameW = (short ? 1 : 3) * fs * 0.72, hourW = fs * 1.3;
        const hoursFit = dayW / 4 >= nameW / 2 + hourW / 2 + 4;
        days.forEach((dd, i) => {
          if (i > 0) {
            const x = Math.round(X(dd.start));
            v.appendChild(s("rect", { x, y: pad.t, width: 1, height: Math.round(base) - pad.t + 4, fill: "#000" }));
          }
          [6, 12, 18].forEach(hr => {
            const x = X(atHour(dd, hr));
            if (hr === 12) { axisText(x, short ? dd.dow.slice(0, 1) : dd.dow, true); return; }
            tickAt(x);
            if (hoursFit) axisText(x, String(hr).padStart(2, "0"));
          });
        });
      }
      if (labels) {
        // HW/LW times above the curve. Over several days, if they don't all fit, only
        // the high waters are labelled (evenly spaced rather than a random-looking subset).
        const tw = fs * 2.7;  // approx width of "HH:MM"
        const evs = t.events.filter(e => e.ts >= start && e.ts < end && e.h !== null);
        const place = list => {
          const out = []; let lastX = -1e9;
          list.forEach(e => {
            const x = Math.min(W_ - tw / 2, Math.max(tw / 2, X(e.ts)));
            if (x - lastX < tw + 4) return;  // no room: skip rather than overlap
            lastX = x; out.push([e, x]);
          });
          return out;
        };
        let placed = place(evs);
        if (multi && placed.length < evs.length) placed = place(evs.filter(e => e.type === "HIGH"));
        placed.forEach(([e, x]) => {
          // Sit the label clear of the curve across the label's whole width, so a low-water
          // time never runs into the rising line either side of the trough.
          const x0 = x - tw / 2 - 3, x1 = x + tw / 2 + 3;
          const top = Math.min(Y(e.h), ...curve.filter(p => X(p.ts) >= x0 && X(p.ts) <= x1).map(p => Y(p.h)));
          const y = Math.round(top - 5);
          v.appendChild(s("text", { x, y: Math.max((head ? fs + 4 : 0) + fs, y), "font-size": fs, "text-anchor": "middle", class: "svgt b", "paint-order": "stroke", stroke: "#fff", "stroke-width": 3 }, e.t));
        });
      }
      if (head) {
        // Today's range only when the chart is just today (over several days it'd be ambiguous).
        const txt = !multi && W_ > 11 * fs && t.range_today ? `TIDE · ${fmt1(t.range_today)}M RANGE` : multi ? `TIDE · ${days.length * 24}H` : "TIDE";
        v.appendChild(s("text", { x: pad.l, y: fs + 1, "font-size": fs, class: "svgt b", "paint-order": "stroke", stroke: "#fff", "stroke-width": 3 }, txt));
      }
      el.appendChild(v);
    },
  };

  W.surf_chart = {
    name: "Surf & wind chart", def: { w: 26, h: 9 }, min: { w: 12, h: 5 },
    props: [DETAIL, SPOT_PROP, { key: "hours", label: "Hours", type: "select", options: ["24", "48", "72"], default: "48" }],
    legacy: p => (p.winds === false ? "min" : null),
    render(el, ctx) {
      const L = lvl(ctx);
      const sp = spotOf(ctx); const c = sp && sp.chart;
      if (!c || !c.points.length) { el.appendChild(title("Forecast")); return missing(el); }
      const hours = parseInt(ctx.props.hours || "48", 10);
      const start = c.start;
      let pts = c.points.filter(p => p.ts >= start && p.ts < start + hours * 3600 && p.max !== null);
      const W_ = Math.floor(ctx.box.w), H_ = Math.floor(ctx.box.h);
      const fs = Math.max(12, Math.round(ctx.px(11)));
      // Below the bars: the time axis (hours), then a row of wind arrows with the speed beside
      // each arrow. Row heights come from the real glyph sizes so nothing overlaps.
      const times = H_ >= 60;
      const winds = L >= 1 && H_ >= 90;
      const asz = Math.max(13, Math.round(ctx.px(15)));  // wind arrow size
      const timeH = times ? fs + 3 : 0;
      const windH = winds ? Math.max(asz, fs) + 4 : 0;
      const pad = { l: Math.round(ctx.px(24)), r: 3, t: fs + 4, b: timeH + windH + 3 };
      const v = svgBox(W_, H_);
      const k = isFt(ctx) ? FT : 1, un = hUnit(ctx);
      const maxV = isFt(ctx) ? Math.max(3, Math.ceil(Math.max(...pts.map(p => p.max * k))))
        : Math.max(1, Math.ceil(Math.max(...pts.map(p => p.max)) * 2) / 2);
      // Whole-pixel bar grid: every bar is the same width with a real white gap, so bars
      // never merge on the panel. If bars would be under 3 px, neighbours are combined.
      const step0 = pts.length > 1 ? pts[1].ts - pts[0].ts : 3600;
      const avail = W_ - pad.l - pad.r;
      const k0 = Math.max(1, Math.ceil(3 * (hours * 3600 / step0) / avail));
      if (k0 > 1) {
        const g = [];
        for (let i = 0; i < pts.length; i += k0) {
          const grp = pts.slice(i, i + k0);
          g.push(Object.assign({}, grp[0], { max: Math.max(...grp.map(p => p.max)),
            min: Math.max(...grp.map(p => (p.min !== null ? p.min : p.max))) }));
        }
        pts = g;
      }
      const step = step0 * k0;
      const nSlots = Math.ceil(hours * 3600 / step);
      const slot = Math.max(2, Math.floor(avail / nSlots));
      const gap = slot >= 6 ? 2 : 1;
      const end = start + nSlots * step;
      const X = ts => Math.round(pad.l + (ts - start) / step * slot);
      const base = H_ - pad.b;
      const Y = m => pad.t + (1 - m / maxV) * (base - pad.t);
      // night shading (whole pixels; drawn on the slot grid)
      let nightFrom = start;
      (c.daylight || []).forEach(dl => {
        if (dl.start > nightFrom) v.appendChild(s("rect", { x: X(nightFrom), y: pad.t, width: Math.max(0, X(Math.min(dl.start, end)) - X(nightFrom)), height: base - pad.t, fill: "url(#p-light)" }));
        nightFrom = Math.max(nightFrom, dl.end);
      });
      if (nightFrom < end) v.appendChild(s("rect", { x: X(nightFrom), y: pad.t, width: X(end) - X(nightFrom), height: base - pad.t, fill: "url(#p-light)" }));
      // y grid
      let tick = isFt(ctx) ? (maxV > 8 ? 2 : 1) : (maxV > 2 ? 1 : 0.5);
      while (Y(0) - Y(tick) < fs + 2 && tick < maxV) tick *= 2;  // short chart: fewer, evenly spaced labels
      for (let m = tick; m <= maxV + 0.001; m += tick) {
        const y = Math.round(Y(m));
        v.appendChild(s("line", { x1: pad.l, x2: X(end), y1: y, y2: y, stroke: "#000", "stroke-dasharray": "1,3" }));
        v.appendChild(s("text", { x: pad.l - 3, y: y + fs / 3, "font-size": fs, "text-anchor": "end", class: "svgt", "paint-order": "stroke", stroke: "#fff", "stroke-width": 3 }, m + un));
      }
      // bars
      const bw = slot - gap;
      pts.forEach(p => {
        const x = Math.round(X(p.ts));
        const yMax = Math.round(Y(p.max * k)), yMin = Math.round(Y((p.min !== null ? p.min : p.max) * k));
        if (yMin - yMax >= 2) v.appendChild(s("rect", { x: x + 0.5, y: yMax + 0.5, width: bw - 1, height: yMin - yMax, fill: "#fff", stroke: "#000", "stroke-width": 1 }));
        v.appendChild(s("rect", { x, y: yMin, width: bw, height: Math.max(0, base - yMin), fill: "#000" }));
      });
      v.appendChild(s("rect", { x: pad.l, y: Math.round(base), width: X(end) - pad.l, height: 1, fill: "#000" }));
      // day separators + labels (labels only where a whole label fits in the day's width)
      const dayW = X(start + 86400) - X(start);
      let labelEnd = 0;
      for (let d = start; d < end; d += 86400) {
        const x = Math.round(X(d));
        // divider drawn in the white gap before the day's first bar, 1 px wide
        if (d > start) v.appendChild(s("rect", { x: x - gap, y: 0, width: 1, height: Math.round(base) + 1, fill: "#000" }));
        const o = (sp.outlook || []).find(o => Math.abs(new Date(o.date + "T12:00:00Z").getTime() / 1000 - (d + 43200)) < 50000);
        const room = Math.min(dayW, X(end) - x);
        const lab = o ? (room > fs * 5 ? `${o.dow.toUpperCase()} ${o.day}` : o.dow.toUpperCase()) : "";
        if (lab && room > lab.length * fs * 0.72 + 6) {
          v.appendChild(s("text", { x: x + 4, y: fs, "font-size": fs, class: "svgt b", "paint-order": "stroke", stroke: "#fff", "stroke-width": 3 }, lab));
          labelEnd = x + 4 + lab.length * fs * 0.72;
        }
      }
      const nm = sp.name.toUpperCase() + (sp.source === "open-meteo" ? " (EST.)" : "");
      if (L >= 2 && X(end) - 2 - nm.length * fs * 0.78 > labelEnd + 8)  // only if it won't collide with a day label
        v.appendChild(s("text", { x: X(end) - 2, y: fs, "font-size": fs, "text-anchor": "end", class: "svgt b", "paint-order": "stroke", stroke: "#fff", "stroke-width": 3 }, nm));
      // time axis + wind: the same marks, every 3, 6, 12 or 24 hours — the smallest step
      // whose labels and arrow-plus-number groups don't run into each other
      if (times || winds) {
        const perHour = slot / (step / 3600);
        const numW = fs * 1.15;                              // two narrow digits
        const need = Math.max(times ? fs * 1.4 + 6 : 0, winds ? asz + 2 + numW + 8 : 0);
        const every = [3, 6, 12, 24].find(e => e * perHour >= need && e >= step / 3600) || 24;
        const hourOf = p => parseInt(String(p.t || "").slice(0, 2), 10);
        const yT = Math.round(base) + 2 + fs - 2;            // baseline of the hour labels
        const yW = Math.round(base) + 2 + timeH + 1;         // top of the wind row
        pts.filter(p => !isNaN(hourOf(p)) && hourOf(p) % every === 0).forEach(p => {
          const cx = Math.round(X(p.ts) + bw / 2);
          if (cx - fs * 0.7 < 0 || cx > X(end)) return;
          if (times) {
            v.appendChild(s("rect", { x: cx, y: Math.round(base) + 1, width: 1, height: 2, fill: "#000" }));
            v.appendChild(s("text", { x: cx, y: yT, "font-size": fs, "text-anchor": "middle", class: "svgt" }, String(p.t).slice(0, 2)));
          }
          if (winds && p.wd !== null && p.wd !== undefined) {
            const num = fmt0(p.ws);
            const gw = asz + 2 + num.length * fs * 0.58;
            const x0 = Math.round(cx - gw / 2);
            const a = windArrow(p.wd, asz, p.wt);
            const a2 = s("svg", { x: x0, y: yW + Math.round((Math.max(asz, fs) - asz) / 2), width: asz, height: asz, viewBox: "-10 -10 20 20" });
            while (a.firstChild) a2.appendChild(a.firstChild);
            v.appendChild(a2);
            v.appendChild(s("text", { x: x0 + asz + 2, y: yW + Math.round(Math.max(asz, fs) / 2 + fs * 0.36), "font-size": fs, class: "svgt b" }, num));
          }
        });
      }
      el.appendChild(v);
    },
  };

  W.sun = {
    name: "Sun & light", def: { w: 12, h: 5 }, min: { w: 6, h: 3 },
    props: [DETAIL, SPOT_PROP, { key: "day", label: "Day", type: "select", options: ["today", "tomorrow"], default: "today" }],
    render(el, ctx) {
      const L = lvl(ctx);
      const sp = spotOf(ctx);
      const sun = sp && (ctx.props.day === "tomorrow" ? sp.sun_tomorrow : sp.sun);
      el.appendChild(title(ctx.props.day === "tomorrow" ? "Light · tomorrow" : "Light",
        L >= 2 && sp && sp.day_length && ctx.props.day !== "tomorrow" ? sp.day_length.hm + " of daylight" : ""));
      if (ctx.box.w / ctx.box.h > 3.2 && L >= 1) el.parentElement.dataset.wide = "1";
      if (!sun) return missing(el);
      const g = h("div", "sungrid");
      const narrow = ctx.box.w < (L === 0 ? 150 : 190);
      const K = narrow ? ["First", "Rise", "Set", "Last"] : ["First light", "Sunrise", "Sunset", "Last light"];
      const items = L === 0 ? [[K[0], sun.first_light], [K[3], sun.last_light]]
        : [[K[0], sun.first_light], [K[1], sun.sunrise], [K[2], sun.sunset], [K[3], sun.last_light]];
      items.forEach(([k, val], i) => {
        const c = h("div", "sc"); add(c, h("span", "sk", k), h("span", "sv2", val || "–"));
        g.appendChild(items.length === 4 && (i === 1 || i === 2) ? opt(c, 2, "rs") : c);  // rise/set go first
      });
      el.appendChild(g);
    },
  };

  W.water = {
    name: "Water temp + wetsuit", def: { w: 10, h: 6 }, min: { w: 6, h: 3 },
    props: [DETAIL, SPOT_PROP],
    legacy: p => (p.showWetsuit === false ? "min" : null),
    render(el, ctx) {
      const L = lvl(ctx);
      const sp = spotOf(ctx);
      el.appendChild(title("Water"));
      if (!sp || sp.water_c === null || sp.water_c === undefined) return missing(el);
      const big = h("div", "big");
      add(big, h("span", "num", fmt1(sp.water_c)), h("span", "unit", "°C"));
      const ws = L >= 1 && sp.wetsuit;
      const hood = ws && sp.wetsuit.key !== "3_2";
      // Model name without the thickness, e.g. "Xcel Comp X hooded" (Full detail only).
      const model = ws && L >= 2 ? String(sp.wetsuit.suit || "").replace(/^\s*[\d.]+\/[\d.]+\s*/, "") : "";
      if (ws && ctx.box.h < 78) {
        // Short box (4 rows or fewer): the suit sits beside the temperature on two short
        // lines, and at Full the model name (e.g. "Xcel Comp+") goes under the thickness in
        // the same column ("hooded" is left off there — "+ hood" already says it). In a really
        // tight box the "WATER" title goes first, then the model name, then the suit details.
        const row = h("div", "wsrow");
        const side = opt(h("div", "wsside"), 2);
        add(side, h("div", "sub strong", hood ? "4.5/3.5" : "3/2"), h("div", "sub strong", hood ? "+ hood" : "suit"));
        if (model) {
          el.firstChild.dataset.drop = "1";
          side.appendChild(opt(h("div", "note wmodel", model.replace(/\s+hooded\s*$/i, "")), 2));
        }
        add(row, big, side);
        el.appendChild(row);
        return;
      }
      el.appendChild(big);
      if (ws) {
        // The recommendation itself stays; the model name is the first thing to go.
        el.appendChild(opt(h("div", "sub strong", hood ? "4.5/3.5 + hood" : "3/2 suit"), 2));
        if (model) el.appendChild(opt(h("div", "note", model), 1));
      }
    },
  };

  W.wetsuit = {
    name: "Wetsuit", def: { w: 10, h: 5 }, min: { w: 6, h: 3 },
    props: [DETAIL, SPOT_PROP],
    legacy: p => (p.reason === false ? "std" : null),
    render(el, ctx) {
      const L = lvl(ctx);
      const sp = spotOf(ctx); const ws = sp && sp.wetsuit;
      el.appendChild(title("Wetsuit", L >= 1 ? "Today" : ""));
      if (!ws) return missing(el);
      el.appendChild(h("div", "mid", ws.key === "3_2" ? "3/2" : "4.5/3.5 hood"));
      if (L >= 1) el.appendChild(opt(h("div", "sub", ws.suit), 2));
      if (L >= 2 && ws.reason) el.appendChild(opt(h("div", "note", ws.reason), 1));
    },
  };

  W.quiver = {
    name: "Board & fins", def: { w: 14, h: 7 }, min: { w: 8, h: 4 },
    props: [DETAIL, SPOT_PROP],
    render(el, ctx) {
      const L = lvl(ctx);
      const sp = spotOf(ctx); const q = sp && sp.quiver;
      el.appendChild(title("Board", sp && L >= 1 ? "Today" + (q ? " · " + (isFt(ctx) && q.band_ft ? q.band_ft : q.band) : "") : ""));
      if (!q) return missing(el);
      el.appendChild(h("div", "mid", q.board_short));
      if (L >= 1) el.appendChild(opt(h("div", "sub strong", q.fins), 2));
      if (L >= 2 && q.alt)
        el.appendChild(opt(h("div", "note", "alt: " + (q.alt_board ? q.alt_board.split(" ").slice(0, 3).join(" ") + " + " : "") + q.alt), 1));
    },
  };

  W.best_windows = {
    name: "Best windows", def: { w: 12, h: 5 }, min: { w: 7, h: 3 },
    props: [DETAIL, SPOT_PROP],
    render(el, ctx) {
      const L = lvl(ctx);
      const sp = spotOf(ctx);
      el.appendChild(title("Best " + (sp ? sp.session_day.label.toLowerCase() : "")));
      if (!sp) return missing(el);
      if (!sp.best_windows.length) return el.appendChild(h("div", "sub", "No standout window"));
      const list = h("div", "rows");
      sp.best_windows.slice(0, L === 0 ? 1 : 9).forEach((w, i) => {
        const r = h("div", "brow");
        r.appendChild(h("span", "bt", `${w.start}–${w.end}`));
        if (L >= 1) r.appendChild(ratingBar(w.score, "sm"));
        if (L >= 2) r.appendChild(opt(h("span", "bl", w.label), 1, "bl"));
        list.appendChild(i ? opt(r, 2) : r);
      });
      el.appendChild(list);
    },
  };

  W.outlook = {
    name: "Multi-day outlook", def: { w: 40, h: 6 }, min: { w: 12, h: 4 },
    props: [DETAIL, SPOT_PROP, { key: "days", label: "Days", type: "number", min: 3, max: 7, default: 5 },
      { key: "skipToday", label: "Start tomorrow", type: "bool", default: false },
      { key: "weather", label: "Weather icon", type: "bool", default: false }],
    legacy: p => (p.light === false ? "std" : null),
    render(el, ctx) {
      const L = lvl(ctx);
      const sp = spotOf(ctx);
      if (!sp || !sp.outlook.length) { el.appendChild(title("Outlook")); return missing(el); }
      const u = windUnit(ctx.data.units && ctx.data.units.wind);
      const days = sp.outlook.slice(ctx.props.skipToday ? 1 : 0).slice(0, ctx.props.days || 5);
      const row = h("div", "olook");
      const colW = ctx.box.w / days.length;
      days.forEach(d => {
        const c = h("div", "oday" + (d.date === ctx.data.today.iso ? " today" : ""));
        const od = h("div", "od", colW < 52 ? d.dow.slice(0, 2) : `${d.dow} ${d.day}`);
        const wd = ctx.props.weather && sp.weather && (sp.weather.days || []).find(x => x.date === d.date);
        if (wd) { const hd = h("div", "od-row"); add(hd, od, opt(wxIcon(wd.kind, 18), 2, "owx")); c.appendChild(hd); } else c.appendChild(od);
        // "~" marks days beyond Surfline's range, estimated from the Open-Meteo swell model.
        const range = (d.est ? "~" : "") + surfRange(ctx, d.surf_min_m, d.surf_max_m) + hUnit(ctx);
        const part = d.am && d.am.wind_speed !== null ? d.am : d.pm;
        const showLight = L >= 2 && d.first_light;
        // First/last light: icon and text sized from the column width (two icons + "06:42" twice)
        // so the row never runs into the day separators in narrow columns.
        const lfs = Math.max(10, Math.min(Math.round(ctx.px(12)), Math.floor((colW - 14) / 6.2)));
        const isz = Math.max(10, Math.min(colW < 125 ? 13 : 16, Math.round(lfs * 1.15)));
        const lightBits = () => [lightIcon(true, isz), h("span", "", d.first_light), lightIcon(false, isz), h("span", "", d.last_light)];
        // Wind sits to the right of the height: direction arrow (filled = offshore/cross-off)
        // and the speed as a bare number (mph by default; other units keep their label).
        const showWind = L >= 1 && part && part.wind_speed !== null && part.wind_speed !== undefined;
        const heightRow = () => {
          const r = h("div", "or-row");
          r.appendChild(h("div", "or", range));
          if (showWind) {
            const w = opt(h("div", "ow"), 2, "ow");
            add(w, windArrow(part.wind_dir, Math.max(13, Math.round(ctx.px(colW < 125 ? 15 : 18))), part.wind_type),
              h("span", "", `${fmt0(part.wind_speed)}${u === "mph" ? "" : " " + u}`));
            r.appendChild(w);
          }
          return r;
        };
        c.appendChild(heightRow());
        if (L >= 1) c.appendChild(opt(ratingBar(d.score, "sm"), 3, "orb"));
        if (showLight) {
          const lt = opt(h("div", "olight"), 1, "ol");
          lt.style.fontSize = lfs + "px";
          add(lt, ...lightBits());
          c.appendChild(lt);
        }
        row.appendChild(c);
      });
      el.appendChild(row);
    },
  };

  W.booking = {
    name: "The Wave booking", def: { w: 14, h: 6 }, min: { w: 8, h: 3 },
    props: [DETAIL, { key: "count", label: "Bookings shown", type: "number", min: 1, max: 4, default: 1 },
      { key: "hideIfNone", label: "Blank when none booked", type: "bool", default: false },
      { key: "invertOnDay", label: "Invert on the day of a session", type: "bool", default: false }],
    render(el, ctx) {
      const L = lvl(ctx);
      const b = (ctx.data.bookings || []).slice(0, ctx.props.count || 1);
      if (!b.length && ctx.props.hideIfNone) { el.classList.add("empty"); return; }
      if (ctx.props.invertOnDay && b.length && b[0].date === ctx.data.today.iso) invertBox(el);
      el.appendChild(title("The Wave"));
      if (!b.length) return el.appendChild(h("div", "sub", "No sessions booked"));
      b.forEach((x, i) => {
        const isToday = x.date === ctx.data.today.iso;
        const time = L >= 2 && x.end && ctx.box.w > 250 ? `${x.start}–${x.end}` : x.start;
        const when = `${isToday ? "Today" : x.dow + " " + x.day + " " + x.mon} · ${time}`;
        el.appendChild(i ? opt(h("div", "sub strong", when), 2) : h("div", "mid", when));
        if (L >= 1) el.appendChild(opt(h("div", "sub", x.setting), i ? 2 : 1));
      });
    },
  };

  W.spots_compare = {
    name: "All spots summary", def: { w: 40, h: 4 }, min: { w: 16, h: 3 },
    props: [DETAIL],
    legacy: p => (p.gear === false ? "std" : null),
    render(el, ctx) {
      const L = lvl(ctx);
      const list = h("div", "rows cmp");
      (ctx.data.spot_order || []).forEach(k => {
        const sp = ctx.data.spots[k]; if (!sp) return;
        const r = h("div", "crow");
        const n = sp.now || {};
        add(r, h("span", "cn", sp.name), h("span", "cr", surfRange(ctx, n.surf_min, n.surf_max) + hUnit(ctx)));
        if (L >= 1) {
          r.appendChild(opt(ratingBar(n.score, "sm"), 3, "crb"));
          if (n.wind) r.appendChild(opt(h("span", "cw", `${fmt0(n.wind.speed)} ${n.wind.cmp} ${WIND_LABEL[n.wind.type] || ""}`), 2, "cw"));
        }
        if (L >= 2 && sp.quiver) r.appendChild(opt(h("span", "cg", `${sp.quiver.board_short} · ${sp.quiver.fins}`), 1, "cg"));
        list.appendChild(r);
      });
      el.appendChild(list);
    },
  };

  W.text = {
    name: "Text note", def: { w: 10, h: 3 }, min: { w: 3, h: 2 },
    props: [{ key: "text", label: "Text", type: "text", default: "Surf's up" },
      { key: "size", label: "Size", type: "select", options: ["small", "medium", "large"], default: "medium" },
      { key: "align", label: "Align", type: "select", options: ["left", "center", "right"], default: "center" }],
    render(el, ctx) {
      const t = h("div", "free " + (ctx.props.size || "medium"), (ctx.props.text || "").slice(0, 200));
      t.style.textAlign = ctx.props.align || "center";
      el.appendChild(t);
    },
  };

  // Wave map (NOAA GFS-Wave): significant wave height in four shades, contour labels,
  // arrows showing which way the waves are travelling, the coastline and the surf spots.
  // The pipeline projects everything into an 800-wide map (data.wave_map); this scales it
  // to fill the box (trimming the edges if the box is a different shape) and draws the
  // text and arrows at their real size so they stay crisp.
  let mapSeq = 0;
  W.wave_map = {
    name: "Wave map", def: { w: 40, h: 21 }, min: { w: 12, h: 8 },
    props: [DETAIL],
    render(el, ctx) {
      const L = lvl(ctx);
      const m = ctx.data && ctx.data.wave_map;
      if (!m || !Array.isArray(m.bands)) { el.style.padding = "8px"; el.appendChild(title("Wave map")); return missing(el, "No wave map yet"); }
      const W_ = Math.floor(el.clientWidth), H_ = Math.floor(el.clientHeight);
      const k = Math.max(W_ / m.w, H_ / m.h);
      const ox = (W_ - m.w * k) / 2, oy = (H_ - m.h * k) / 2;
      const X = x => ox + x * k, Y = y => oy + y * k;
      const fs = Math.max(12, Math.round(ctx.px(12)));
      const v = svgBox(W_, H_);
      v.setAttribute("shape-rendering", "geometricPrecision");
      el.appendChild(v);  // in the page now, so text can be measured below

      // Fill patterns in screen pixels (the map itself is drawn scaled by k).
      const id = "wm" + (++mapSeq);
      const pat = (name, cells) => {
        const p = s("pattern", { id: `${id}-${name}`, width: cells.n, height: cells.n, patternUnits: "userSpaceOnUse",
          patternTransform: `translate(${(-ox / k).toFixed(3)},${(-oy / k).toFixed(3)}) scale(${(1 / k).toFixed(5)})` });
        p.appendChild(s("rect", { x: 0, y: 0, width: cells.n, height: cells.n, fill: "#fff" }));
        cells.px.forEach(([x, y]) => p.appendChild(s("rect", { x, y, width: 1, height: 1, fill: "#000" })));
        return p;
      };
      const d = s("defs");
      // 1-bit: land is a light stipple, so the first sea shade uses diagonal lines instead
      add(d, pat("dots", { n: 3, px: [[1, 1]] }), pat("diag", { n: 4, px: [[0, 3], [1, 2], [2, 1], [3, 0]] }),
        pat("half", { n: 2, px: [[0, 0], [1, 1]] }));
      v.appendChild(d);
      const grey4 = !!(ctx.layout && ctx.layout.mode === "4grey");
      const shade = grey4 ? ["#fff", "#aaa", "#555", "#000"] : ["#fff", `url(#${id}-diag)`, `url(#${id}-half)`, "#000"];

      const g = s("g", { transform: `translate(${ox.toFixed(2)},${oy.toFixed(2)}) scale(${k.toFixed(5)})` });
      g.appendChild(s("rect", { x: 0, y: 0, width: m.w, height: m.h, fill: shade[0] }));
      m.bands.forEach((dd, i) => { if (dd) g.appendChild(s("path", { d: dd, fill: shade[i + 1], "fill-rule": "evenodd" })); });
      if (m.land) {
        g.appendChild(s("path", { d: m.land, fill: `url(#${id}-dots)` }));
        g.appendChild(s("path", { d: m.land, fill: "none", stroke: "#000", "stroke-width": 1.3, "vector-effect": "non-scaling-stroke", "stroke-linejoin": "round" }));
      }
      v.appendChild(g);

      // Title + key, top-left. Measured, then a white box drawn behind it.
      const lv = m.levels || [];
      const n = x => String(Math.round(x * 10) / 10);
      const head = s("g");
      const t1 = s("text", { x: 8, y: 6 + fs, "font-size": Math.round(fs * 1.15), class: "svgt b" },
        `WAVES · ${String(m.valid || "").toUpperCase()}${m.stale ? " (OLD)" : ""}`);
      head.appendChild(t1);
      let yy = 6 + fs;
      if (L >= 1 && lv.length === 3) {
        yy += Math.round(fs * 1.35);
        const keys = [`0–${n(lv[0])}`, `${n(lv[0])}–${n(lv[1])}`, `${n(lv[1])}–${n(lv[2])}`, `${n(lv[2])}+ m`];
        let x = 8;
        keys.forEach((txt, i) => {
          const sw = Math.round(fs * 0.9);
          head.appendChild(s("rect", { x: x + 0.5, y: yy - sw + 1.5, width: sw, height: sw, fill: shade[i], stroke: "#000", "stroke-width": 1 }));
          const tt = s("text", { x: x + sw + 3, y: yy, "font-size": fs, class: "svgt" }, txt);
          head.appendChild(tt);
          v.appendChild(head);
          x += sw + 3 + tt.getComputedTextLength() + 7;
        });
      }
      if (L >= 2) {
        yy += Math.round(fs * 1.25);
        head.appendChild(s("text", { x: 8, y: yy, "font-size": Math.max(11, Math.round(fs * 0.85)), class: "svgt" }, `${m.source || "NOAA"} · ${m.run || ""} run`));
      }
      v.appendChild(head);
      const bb = head.getBBox();
      const hbW = Math.ceil(bb.x + bb.width + 8), hbH = Math.ceil(bb.y + bb.height + 6);
      v.insertBefore(s("rect", { x: 0.5, y: 0.5, width: hbW, height: hbH, fill: "#fff", stroke: "#000", "stroke-width": 1.5, rx: 4 }), head);

      const clearOfHead = (x, y, r) => !(x < hbW + r && y < hbH + r);
      const inBox = (x, y, r) => x >= r && y >= r && x <= W_ - r && y <= H_ - r;
      if (L >= 1) {
        // arrows: direction of travel ("from" + 180), white on the two dark shades
        const asz = Math.max(10, Math.round(ctx.px(13)));
        // keep arrows at least ~30 px apart on a small map (every 2nd or 3rd one)
        const sp = m.arrow_spacing || 40, stride = Math.max(1, Math.ceil(30 / (sp * k)));
        (m.arrows || []).forEach(([ax, ay, dir, b]) => {
          if (Math.round(ax / sp - 0.5) % stride || Math.round(ay / sp - 0.5) % stride) return;
          const x = X(ax), y = Y(ay);
          if (!inBox(x, y, asz / 2) || !clearOfHead(x, y, asz / 2)) return;
          const col = b >= 2 ? "#fff" : "#000";
          v.appendChild(s("path", { d: "M0,-9 L6,5 L0,2 L-6,5 Z", fill: col,
            transform: `translate(${x.toFixed(1)},${y.toFixed(1)}) scale(${(asz / 20).toFixed(3)}) rotate(${(dir + 180) % 360})` }));
        });
        // contour labels, black on a white halo so they read on every shade
        (m.labels || []).forEach(([lx, ly, txt]) => {
          const x = X(lx), y = Y(ly);
          if (!inBox(x, y, fs * 1.4) || !clearOfHead(x, y, fs * 1.4)) return;
          v.appendChild(s("text", { x: x.toFixed(1), y: (y + fs / 3).toFixed(1), "font-size": fs, "text-anchor": "middle",
            class: "svgt b", "paint-order": "stroke", stroke: "#fff", "stroke-width": 4, "stroke-linejoin": "round" }, txt));
        });
      }
      if (L >= 2) {
        (m.spots || []).forEach(([sx, sy]) => {
          const x = X(sx), y = Y(sy);
          if (!inBox(x, y, 4)) return;
          v.appendChild(s("circle", { cx: x.toFixed(1), cy: y.toFixed(1), r: 3.5, fill: "#000", stroke: "#fff", "stroke-width": 1.5 }));
        });
      }
    },
  };

  // Test pattern for checking the frame really shows 4 greys: four solid bands at exactly
  // the renderer's grey levels (0/85/170/255 -> 2-bit values 0-3). On a 1-bit frame the
  // two middle bands collapse into black and white.
  W.greytest = {
    name: "Grey test (4 bands)", def: { w: 40, h: 24 }, min: { w: 8, h: 4 }, frame: "none",
    props: [],
    render(el) {
      const bands = [["#000000", "#ffffff", "BLACK", "0"], ["#555555", "#ffffff", "DARK GREY", "1"],
        ["#aaaaaa", "#000000", "LIGHT GREY", "2"], ["#ffffff", "#000000", "WHITE", "3"]];
      const row = h("div", "gtest");
      row.style.display = "flex"; row.style.height = "100%"; row.style.width = "100%";
      bands.forEach(([bg, fg, label, n]) => {
        const b = h("div", "gband");
        b.style.flex = "1"; b.style.background = bg; b.style.color = fg;
        b.style.display = "flex"; b.style.flexDirection = "column";
        b.style.alignItems = "center"; b.style.justifyContent = "center";
        b.style.border = "2px solid #000";
        const t = h("div", "", label);
        t.style.fontWeight = "800"; t.style.fontSize = "22px";
        const v = h("div", "", n);
        v.style.fontFamily = '"Barlow Condensed", sans-serif'; v.style.fontWeight = "700"; v.style.fontSize = "64px";
        add(b, t, v);
        row.appendChild(b);
      });
      el.appendChild(row);
    },
  };

  W.weather = {
    name: "Weather", def: { w: 12, h: 7 }, min: { w: 7, h: 4 },
    props: [DETAIL, WHERE_PROP, SPOT_PROP],
    legacy: p => (p.details === false ? "std" : null),
    render(el, ctx) {
      const L = lvl(ctx);
      const src = wxSource(ctx); const w = src.w;
      el.appendChild(title("Weather", L >= 1 ? src.name : ""));
      if (!w || !w.now) return missing(el);
      const row = h("div", "wxrow");
      add(row, wxIcon(w.now.kind, Math.round(ctx.px(44))));
      const big = h("div", "big"); add(big, h("span", "num", deg(w.now.temp)), h("span", "unit", "C"));
      row.appendChild(big);
      el.appendChild(row);
      if (L >= 1) el.appendChild(opt(h("div", "sub", `${w.now.label} · feels ${deg(w.now.feels)}`), 2));
      if (L >= 2 && w.today) {
        const t = w.today;
        el.appendChild(opt(h("div", "note", `H ${deg(t.max)} L ${deg(t.min)} · rain ${t.pop ?? "–"}% · UV ${t.uv ?? "–"}`), 1));
      }
    },
  };

  W.weather_hours = {
    name: "Weather by hour", def: { w: 20, h: 5 }, min: { w: 10, h: 4 },
    props: [DETAIL, WHERE_PROP, SPOT_PROP],
    legacy: p => (p.rain === false ? "std" : null),
    render(el, ctx) {
      const L = lvl(ctx);
      const src = wxSource(ctx); const w = src.w;
      const label = src.day ? src.day.label : "";
      el.appendChild(title(src.name ? "Weather · " + src.name : "Weather", L >= 1 ? label : ""));
      if (!w || !w.hours || !w.hours.length) return missing(el);
      // Short boxes (4 rows): the temperature sits beside the icon instead of under it, so
      // it still fits. The temperature is kept over the title when space runs out.
      const short = ctx.box.h < 70;
      const row = h("div", "wxhours");
      w.hours.forEach(hr => {
        const c = h("div", "wxh");
        c.appendChild(h("span", "wxh-t", hr.t.slice(0, 2)));
        const icon = wxIcon(hr.kind, short ? Math.max(18, Math.round(ctx.px(18))) : Math.max(20, Math.round(ctx.px(22))));
        const temp = L >= 1 ? h("span", "wxh-v", deg(hr.temp)) : null;
        if (short && temp) { const r = h("div", "wxh-row"); add(r, icon, temp); c.appendChild(r); }
        else { c.appendChild(icon); if (temp) c.appendChild(temp); }
        if (L >= 2 && hr.pop !== null && hr.pop !== undefined) c.appendChild(opt(h("span", "wxh-p", hr.pop + "%"), 1, "hp"));
        row.appendChild(c);
      });
      el.appendChild(row);
    },
  };

  // Wind for the session day's 06-21h slots (same hours as Weather by hour): time, then the
  // wind arrow with the speed beside it; gusts underneath at Full. Fits down to 8 x 4.
  W.wind_hours = {
    name: "Wind by hour", def: { w: 16, h: 5 }, min: { w: 8, h: 4 },
    props: [DETAIL, SPOT_PROP],
    render(el, ctx) {
      const L = lvl(ctx);
      const sp = spotOf(ctx);
      const u = windUnit(ctx.data.units && ctx.data.units.wind);
      el.appendChild(title("Wind", L >= 1 && sp ? (sp.session_day ? sp.session_day.label : "") + (u === "mph" ? "" : " · " + u) : ""));
      let hrs = sp && sp.wind_hours;
      if (!hrs || !hrs.length) return missing(el);
      // narrow box: the middle hours only (about 30 px per column keeps arrow + number legible)
      const fit = Math.max(2, Math.min(hrs.length, Math.floor(ctx.box.w / 30)));
      if (fit < hrs.length) { const a = Math.floor((hrs.length - fit) / 2); hrs = hrs.slice(a, a + fit); }
      const row = h("div", "wxhours");
      const colW = ctx.box.w / hrs.length;
      const asz = Math.max(12, Math.min(Math.round(ctx.px(16)), Math.floor(colW * 0.42)));
      hrs.forEach(hr => {
        const c = h("div", "wxh");
        c.appendChild(h("span", "wxh-t", hr.t.slice(0, 2)));
        const r = h("div", "wxh-row wdh");
        add(r, windArrow(hr.wd, asz, hr.wt), h("span", "wxh-v", fmt0(hr.ws)));
        c.appendChild(r);
        if (L >= 2 && hr.wg !== null && hr.wg !== undefined) c.appendChild(opt(h("span", "wxh-p", "g" + fmt0(hr.wg)), 1, "wg"));
        row.appendChild(c);
      });
      el.appendChild(row);
    },
  };

  // ---------------------------------------------------------------- flight
  // A flight you type in (number + date). Airports and times come from the flight lookup in
  // the pipeline (data.flights), or from the optional fields if you fill them in yourself
  // (anything you type wins). Set to "show automatically", it stays off the frame until N
  // days/weeks before the flight, then takes the bottom-right corner (see effectiveWidgets).
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const DOW3 = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MON3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const flightNo = v => String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  const dayNum = iso => Math.round(Date.parse(iso + "T00:00:00Z") / 864e5);   // UTC parse: no local time
  function dayLabel(iso) {
    const d = new Date(iso + "T12:00:00Z");
    return `${DOW3[d.getUTCDay()]} ${d.getUTCDate()} ${MON3[d.getUTCMonth()]}`;
  }
  function flightInfo(props, data) {
    const num = flightNo(props.flight), date = String(props.date || "");
    const f = ((data.flights || {})[num + "_" + date]) || {};
    const own = v => String(v || "").trim();
    return {
      num, date, ok: !!num && DATE_RE.test(date),
      from: (own(props.from) || f.from || "").toUpperCase().slice(0, 4),
      to: (own(props.to) || f.to || "").toUpperCase().slice(0, 4),
      dep: own(props.dep) || f.dep || "", arr: own(props.arr) || f.arr || "",
      depDate: f.dep_date || date, arrDate: f.arr_date || "",
      terminal: f.terminal || "", status: f.status || "", airline: f.airline || "",
    };
  }
  // null = not automatic; otherwise whether the widget is showing today
  function flightAuto(props, data) {
    if (!props || !props.auto) return null;
    const date = String(props.date || "");
    if (!DATE_RE.test(date) || !data.today || !data.today.iso) return false;
    const n = Math.max(0, parseInt(props.before, 10) || 0) * (props.unit === "weeks" ? 7 : 1);
    const d = dayNum(date) - dayNum(data.today.iso);
    return d >= 0 && d <= n;
  }
  // Top-down plane pointing right, on a 24-unit grid with solid shapes (1-bit friendly).
  function planeIcon(size) {
    const v = s("svg", { width: size, height: size, viewBox: "0 0 24 24", class: "plane" });
    v.appendChild(s("path", { fill: "currentColor", d:
      "M21.5 12c0-.9-1-1.3-2.2-1.3H15L9.3 3.5H7.2l2.7 7.2H5.3L3.6 8.4H2.2l1 3.6-1 3.6h1.4l1.7-2.3h4.6l-2.7 7.2h2.1L15 13.3h4.3c1.2 0 2.2-.4 2.2-1.3z" }));
    return v;
  }
  W.flight = {
    name: "Flight", def: { w: 8, h: 5 }, min: { w: 6, h: 3 },
    auto: w => w.props || {},   // see flightAuto / effectiveWidgets
    props: [DETAIL,
      { key: "flight", label: "Flight number (e.g. BA2490)", type: "text", default: "" },
      { key: "date", label: "Departure date", type: "date", default: "" },
      { key: "auto", label: "Show automatically before the flight", type: "bool", default: false },
      { key: "before", label: "Show from … before", type: "number", min: 1, max: 52, default: 7 },
      { key: "unit", label: "Days or weeks", type: "select", options: ["days", "weeks"], labels: ["Days", "Weeks"], default: "days" },
      { key: "from", label: "From airport (optional, e.g. BRS)", type: "text", default: "" },
      { key: "to", label: "To airport (optional)", type: "text", default: "" },
      { key: "dep", label: "Departs (optional, HH:MM local)", type: "text", default: "" },
      { key: "arr", label: "Arrives (optional, HH:MM local)", type: "text", default: "" }],
    render(el, ctx) {
      const L = lvl(ctx);
      const f = flightInfo(ctx.props, ctx.data);
      el.appendChild(title("Flight", f.num));
      if (!f.ok) return missing(el, "Set the flight number and date");
      const route = h("div", "fl-route");
      add(route, h("span", "fl-code", f.from || "–"), planeIcon(Math.round(ctx.px(22))), h("span", "fl-code", f.to || "–"));
      el.appendChild(route);
      el.appendChild(h("div", "sub strong", dayLabel(f.depDate) + (f.dep ? " · " + f.dep : "")));
      if (L >= 1) {
        const days = dayNum(f.date) - dayNum(ctx.data.today.iso);
        const when = days === 0 ? "Today" : days === 1 ? "Tomorrow" : days > 1 ? `In ${days} days` : "";
        const arr = f.arr ? "arr " + f.arr + (f.arrDate && f.arrDate !== f.depDate ? " +1" : "") : "";
        const line = [when, arr].filter(Boolean).join(" · ");
        if (line) el.appendChild(opt(h("div", "note", line), 2));
      }
      if (L >= 2) {
        const more = [f.terminal ? "T" + f.terminal : "", f.status && f.status !== "Expected" && f.status !== "Unknown" ? f.status : "", f.airline]
          .filter(Boolean).join(" · ");
        if (more) el.appendChild(opt(h("div", "note", more), 1));
      }
    },
  };

  W.weather_week = {
    name: "Weather week", def: { w: 24, h: 5 }, min: { w: 12, h: 4 },
    props: [DETAIL, WHERE_PROP, SPOT_PROP, { key: "days", label: "Days", type: "number", min: 3, max: 7, default: 7 }],
    render(el, ctx) {
      const L = lvl(ctx);
      const w = wxSource(ctx).w;
      if (!w || !w.days || !w.days.length) { el.appendChild(title("Weather")); return missing(el); }
      const row = h("div", "wxhours");
      w.days.slice(0, ctx.props.days || 7).forEach(d => {
        const c = h("div", "wxh" + (d.date === ctx.data.today.iso ? " today" : ""));
        add(c, h("span", "wxh-t", d.dow.toUpperCase()), wxIcon(d.kind, Math.max(20, Math.round(ctx.px(22)))));
        if (L >= 1) c.appendChild(opt(h("span", "wxh-v", deg(d.max)), 2, "dv"));
        if (L >= 2) c.appendChild(opt(h("span", "wxh-p", deg(d.min)), 1, "dp"));
        row.appendChild(c);
      });
      el.appendChild(row);
    },
  };

  W.moon = {
    name: "Moon & tide size", def: { w: 12, h: 6 }, min: { w: 8, h: 4 },
    props: [DETAIL, SPOT_PROP],
    render(el, ctx) {
      const L = lvl(ctx);
      const m = ctx.data.moon; const sp = spotOf(ctx);
      el.appendChild(title("Moon"));
      if (!m) return missing(el);
      const row = h("div", "wxrow");
      const txt = h("div", "stack");
      txt.appendChild(h("div", "sub strong", m.name));
      if (L >= 1) txt.appendChild(opt(h("div", "sub", m.tides || "Mid-cycle tides"), 2));
      add(row, moonIcon(m, Math.round(ctx.px(46)), ctx.props.frame === "inverse"), txt);
      el.appendChild(row);
      if (L >= 2) {
        const bits = [];
        if (sp && sp.tides && sp.tides.range_today) bits.push(`${fmt1(sp.tides.range_today)} m range today`);
        if (m.next) bits.push(`${m.next.what} ${m.next.dow} ${m.next.day}`);
        if (bits.length) el.appendChild(opt(h("div", "note", bits.join(" · ")), 1));
      }
    },
  };

  // Just the moon: no words, fills its box. Nice as a small corner ornament.
  W.moon_icon = {
    name: "Moon (picture only)", def: { w: 4, h: 4 }, min: { w: 2, h: 2 }, frame: "none",
    props: [],
    render(el, ctx) {
      const m = ctx.data.moon;
      if (!m) return missing(el, "–");
      el.classList.add("center");
      el.appendChild(moonIcon(m, Math.max(12, Math.floor(Math.min(ctx.box.w, ctx.box.h))), ctx.props.frame === "inverse"));
    },
  };

  W.best_day = {
    name: "Best day this week", def: { w: 12, h: 6 }, min: { w: 8, h: 4 },
    props: [DETAIL, SPOT_PROP],
    render(el, ctx) {
      const L = lvl(ctx);
      const sp = spotOf(ctx);
      el.appendChild(title("Best day", sp && L >= 1 ? sp.name : ""));
      if (!sp || !sp.outlook || !sp.outlook.length) return missing(el);
      const best = sp.outlook.reduce((a, b) => ((b.score || 0) > (a.score || 0) + 0.05 ||
        (Math.abs((b.score || 0) - (a.score || 0)) <= 0.05 && (b.surf_max_m || 0) > (a.surf_max_m || 0)) ? b : a));
      const isToday = best.date === ctx.data.today.iso;
      el.appendChild(h("div", "mid", isToday ? "Today" : `${best.dow} ${best.day}`));
      if (L >= 1) {
        const r = opt(h("div", "rrow"), 2);
        add(r, h("span", "sub strong", surfRange(ctx, best.surf_min_m, best.surf_max_m) + hUnit(ctx)), ratingBar(best.score, "sm"));
        if (L >= 2) r.appendChild(opt(h("span", "rlabel", best.label), 1));
        el.appendChild(r);
      }
      const part = best.am && best.am.wind_speed !== null ? best.am : best.pm;
      if (L >= 2 && part) el.appendChild(opt(h("div", "note", `Morning wind ${fmt0(part.wind_speed)} ${windUnit(ctx.data.units && ctx.data.units.wind)} ${WIND_LABEL[part.wind_type] || ""}`), 1));
    },
  };

  W.best_spot = {
    name: "Which beach?", def: { w: 14, h: 6 }, min: { w: 10, h: 4 },
    props: [DETAIL],
    render(el, ctx) {
      const L = lvl(ctx);
      const d = ctx.data;
      el.appendChild(title("Which beach", L >= 1 ? "Today" : ""));
      const spots = (d.spot_order || []).map(k => d.spots[k]).filter(Boolean);
      if (!spots.length) return missing(el);
      const score = sp => (sp.outlook && sp.outlook[0] && sp.outlook[0].score) || 0;
      const top = spots.reduce((a, b) => (score(b) > score(a) ? b : a));
      const list = h("div", "rows");
      spots.forEach(sp => {
        const r = h("div", "bsrow" + (sp === top && score(top) >= 1 ? " top" : ""));
        const win = sp.best_windows && sp.best_windows[0];
        const o = sp.outlook && sp.outlook[0];
        r.appendChild(h("span", "bs-n", sp.name));
        if (L >= 1) r.appendChild(opt(ratingBar(score(sp), "sm"), 2, "brb"));
        if (L >= 2)
          r.appendChild(opt(h("span", "bs-w", win ? `${win.start}–${win.end}` : (o ? surfRange(ctx, o.surf_min_m, o.surf_max_m) + hUnit(ctx) : "")), 1, "bsw"));
        list.appendChild(r);
      });
      el.appendChild(list);
    },
  };

  W.daylight = {
    name: "Day length", def: { w: 10, h: 5 }, min: { w: 6, h: 3 },
    props: [DETAIL, SPOT_PROP],
    render(el, ctx) {
      const L = lvl(ctx);
      const sp = spotOf(ctx); const dl = sp && sp.day_length;
      el.appendChild(title("Daylight"));
      if (!dl) return missing(el);
      el.appendChild(h("div", "mid", dl.hm));
      if (L >= 1 && dl.change) el.appendChild(opt(h("div", "sub", `${dl.change > 0 ? "+" : "−"}${Math.abs(dl.change)} min on yesterday`), 2));
      if (L >= 2 && sp.sun) el.appendChild(opt(h("div", "note", `${sp.sun.sunrise} – ${sp.sun.sunset}`), 1));
    },
  };

  W.countdown = {
    name: "Wave countdown", def: { w: 10, h: 6 }, min: { w: 6, h: 4 },
    props: [DETAIL],
    render(el, ctx) {
      const L = lvl(ctx);
      const b = (ctx.data.bookings || [])[0];
      el.appendChild(title("The Wave"));
      if (!b) return el.appendChild(h("div", "sub", "No sessions booked"));
      const days = Math.round((Date.parse(b.date) - Date.parse(ctx.data.today.iso)) / 864e5);
      const big = h("div", "big");
      if (days <= 0) add(big, h("span", "num", "Today"));
      else add(big, h("span", "num", String(days)), h("span", "unit", days === 1 ? "day" : "days"));
      el.appendChild(big);
      if (L >= 1) el.appendChild(opt(h("div", "sub", b.setting), 2));
      if (L >= 2) el.appendChild(opt(h("div", "note", `${b.dow} ${b.day} ${b.mon} · ${b.start}`), 1));
    },
  };

  W.credits = {
    name: "Credits & status", def: { w: 40, h: 1 }, min: { w: 10, h: 1 }, frame: "none",
    props: [],
    render(el, ctx) {
      const srcs = (ctx.data.spot_order || []).map(k => ctx.data.spots[k]).filter(Boolean)
        .map(sp => `${sp.name}: ${sp.source || "no data"}`);
      el.appendChild(h("div", "credit line", [...(ctx.data.credits || []), ...srcs].join(" · ")));
    },
  };

  // ------------------------------------------------------------------ layout
  function widgetDefaults(type) {
    const def = W[type]; const p = {};
    (def.props || []).forEach(x => { p[x.key] = x.default; });
    return p;
  }

  // Does anything poke outside the widget (or right up against its border)?
  function overflowing(inner) {
    if (inner.scrollHeight > inner.clientHeight + 1 || inner.scrollWidth > inner.clientWidth + 1) return true;
    const r = inner.getBoundingClientRect();
    if (!r.width) return false;
    const k = r.width / inner.offsetWidth;  // studio canvas may be CSS-scaled
    const cs = getComputedStyle(inner);
    // Content may use the padding, but must stay at least 2 px clear of the border.
    const right = r.right - Math.min(2, parseFloat(cs.paddingRight)) * k + 0.5;
    const bottom = r.bottom - Math.min(2, parseFloat(cs.paddingBottom)) * k + 0.5;
    for (const e of inner.querySelectorAll("*")) {
      if (e.namespaceURI === SVGNS && e.tagName !== "svg") continue;
      const b = e.getBoundingClientRect();
      if (b.width && (b.right > right || b.bottom > bottom)) return true;
      // also text spilling out of its own row (e.g. past the end of a black highlight bar)
      const pr = e.parentElement !== inner && e.parentElement.getBoundingClientRect();
      if (pr && b.width && b.right > pr.right + 0.5) return true;
    }
    return false;
  }
  // Remove optional elements, least important first, until the content fits.
  // Elements sharing a group (e.g. every row's height column) go together.
  function dropUntilFits(inner) {
    for (let p = 1; p <= 3 && overflowing(inner); p++) {
      const opts = Array.from(inner.querySelectorAll(`[data-drop="${p}"]`)).reverse();
      for (const e of opts) {
        if (!e.isConnected) continue;
        if (e.dataset.dg) inner.querySelectorAll(`[data-dg="${e.dataset.dg}"]`).forEach(x => x.remove());
        else e.remove();
        if (!overflowing(inner)) return;
      }
    }
  }

  function renderWidget(box, w, layout, data) {
    const def = W[w.type];
    box.textContent = "";
    delete box.dataset.wide;
    box.className = "w w-" + w.type;
    const frame = (w.props && w.props.frame) || def.frame || "box";
    box.classList.add("f-" + frame);
    const px = { w: w.w * CELL - 2 * INSET, h: w.h * CELL - 2 * INSET };
    box.style.left = (w.x * CELL + INSET) + "px";
    box.style.top = (w.y * CELL + INSET) + "px";
    box.style.width = px.w + "px";
    box.style.height = px.h + "px";
    // scale factor relative to the widget's default size -> fonts & glyphs grow with the box
    const sc = Math.max(0.7, Math.min(2.4, Math.min((w.w) / def.def.w, (w.h) / def.def.h) ** 0.75));
    const props = Object.assign(widgetDefaults(w.type), w.props || {});
    if ((!w.props || w.props.detail === undefined) && def.legacy) {
      const l = def.legacy(w.props || {});
      if (l) props.detail = l;
    }
    // Draw, then shrink the scale until the content fits (auto-fit). If it still doesn't
    // fit, optional parts are dropped whole — text is never cut off with "…".
    let scale = sc;
    for (let attempt = 0; attempt < 12; attempt++) {
      box.textContent = "";
      box.style.setProperty("--s", scale.toFixed(3));
      const inner = h("div", "wi");
      box.appendChild(inner);
      const pad = Math.min(8 * scale, 10);
      const ctx = {
        data, layout, props,
        box: { w: px.w - 2 * pad, h: px.h - 2 * pad },
        px: n => n * scale,
      };
      try {
        def.render(inner, ctx);
      } catch (e) {
        inner.textContent = "";
        missing(inner, "Widget error");
        if (global.console) console.error(w.type, e);
        return;
      }
      if (!box.isConnected) return;  // can't measure yet
      if (!overflowing(inner)) return;
      const last = scale <= 0.5;
      // below ~80% of the natural size, prefer dropping optional bits over shrinking further
      if (last || scale <= sc * 0.8) {
        dropUntilFits(inner);
        if (!overflowing(inner) || last) return;
      }
      scale = Math.max(0.5, scale * 0.9);
    }
  }

  // Widgets that appear by themselves (a Flight set to "show automatically"): while off they
  // aren't drawn and everything else keeps its saved size. While on, the widget takes the
  // bottom-right corner at its own size, and each widget it would cover gives way: narrower
  // if it starts left of it, shorter if it starts above it, otherwise hidden.
  // opts.previewAuto: true/false forces automatic widgets on/off (studio preview); left out,
  // they follow their dates (the cloud render).
  function effectiveWidgets(layout, data, opts) {
    const out = (layout.widgets || []).filter(w => W[w.type]).map(w => Object.assign({}, w));
    const isAuto = w => W[w.type].auto && flightAuto(W[w.type].auto(w), data) !== null;
    const autos = out.filter(isAuto);
    autos.forEach(a => {
      const forced = opts && typeof opts.previewAuto === "boolean" ? opts.previewAuto : null;
      if (!(forced !== null ? forced : flightAuto(W[a.type].auto(a), data))) { a.hidden = true; return; }
      a.x = COLS - a.w; a.y = ROWS - a.h; a.placed = true;
      out.forEach(o => {
        if (o === a || o.hidden || autos.includes(o)) return;
        if (!(o.x < a.x + a.w && a.x < o.x + o.w && o.y < a.y + a.h && a.y < o.y + o.h)) return;
        const mn = W[o.type].min;
        if (o.x < a.x && a.x - o.x >= mn.w) { o.w = a.x - o.x; o.adjusted = true; }
        else if (o.y < a.y && a.y - o.y >= mn.h) { o.h = a.y - o.y; o.adjusted = true; }
        else o.hidden = true;
      });
    });
    return out;
  }

  function renderLayout(root, layout, data, opts) {
    root.textContent = "";
    root.classList.add("frame");
    if (layout.invert) root.classList.add("inverted"); else root.classList.remove("inverted");
    const boxes = {};
    effectiveWidgets(layout, data, opts).forEach(w => {
      if (w.hidden) return;
      const b = h("div");
      b.dataset.id = w.id;
      root.appendChild(b);
      renderWidget(b, w, layout, data);
      boxes[w.id] = b;
    });
    return boxes;
  }

  global.SurfFrame = { CELL, COLS, ROWS, INSET, WIDGETS: W, renderLayout, renderWidget, widgetDefaults, effectiveWidgets };
})(window);
