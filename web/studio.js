/* Surf Frame Studio — gallery + widget editor.
 * Talks only to its own origin (/api/*). Behind Cloudflare Access in the cloud;
 * served by pipeline/devserver.py locally. No innerHTML anywhere. */
(function () {
  "use strict";
  const SF = window.SurfFrame;
  const { CELL, COLS, ROWS, WIDGETS } = SF;
  const $ = id => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

  const state = { selected: null, layouts: [], renders: {}, data: null, renderNow: false,
    layout: null, sel: null, undo: [], dirty: false, scale: 1,
    frame: null, frames: [], admin: false, hidden: [], settings: { shrink_px: 0, home: null, button_layout: "wave-map" } };
  const FRAME_KEY = "sf-frame";
  try { state.frame = localStorage.getItem(FRAME_KEY) || null; } catch (_) { /* private mode */ }

  // ------------------------------------------------------------------ api
  async function api(path, opts = {}) {
    const init = { method: opts.method || "GET", credentials: "same-origin", headers: {} };
    if (opts.body !== undefined) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(opts.body); }
    // Every call except the admin ones is about one frame: say which.
    let url = "/api/" + path;
    if (state.frame && !path.startsWith("admin/")) url += (url.includes("?") ? "&" : "?") + "frame=" + encodeURIComponent(state.frame);
    const r = await fetch(url, init);
    if (!r.ok) {
      let msg = r.status + " " + r.statusText;
      try { const j = await r.json(); if (j.error) msg = j.error; } catch (_) { /* ignore */ }
      throw new Error(msg);
    }
    const ct = r.headers.get("content-type") || "";
    return ct.includes("json") ? r.json() : r;
  }

  let toastT;
  function toast(msg, err) {
    const t = $("toast"); t.textContent = msg; t.className = "toast show" + (err ? " err" : "");
    clearTimeout(toastT); toastT = setTimeout(() => { t.className = "toast" + (err ? " err" : ""); }, 2600);
  }

  // ------------------------------------------------------------------ status
  function renderStatus() {
    const s = $("status"); s.textContent = "";
    const d = state.data;
    if (!d) { s.textContent = "No forecast data yet — run a render."; return; }
    s.appendChild(document.createTextNode(`Data ${d.today.dow3} ${d.today.day} ${d.today.mon3} ${d.generated} · `));
    (d.spot_order || []).forEach((k, i) => {
      const sp = d.spots[k]; if (!sp) return;
      const bad = sp.source !== "surfline";
      const span = el("span", bad ? "warn" : "", `${sp.name}: ${sp.source || "none"}${sp.tides ? " / tides " + sp.tides.source : ""}`);
      if (sp.warnings && sp.warnings.length) span.title = sp.warnings.join("\n");
      s.appendChild(span);
      if (i < d.spot_order.length - 1) s.appendChild(document.createTextNode(" · "));
    });
    if (d.bookings && !state.hidden.includes("booking")) s.appendChild(document.createTextNode(` · ${d.bookings.length} Wave booking${d.bookings.length === 1 ? "" : "s"}`));
    $("btn-render").hidden = !state.renderNow;
  }

  async function loadState() {
    let st;
    try { st = await api("state"); }
    catch (e) {
      // A remembered frame you no longer have access to: fall back to your default one.
      if (!state.frame) throw e;
      state.frame = null; st = await api("state");
    }
    Object.assign(state, { selected: st.selected, layouts: st.layouts, renders: st.renders || {}, renderNow: !!st.render_now,
      frame: st.frame || null, frames: st.frames || [], admin: !!st.admin, hidden: st.hidden_widgets || [],
      settings: st.settings || { shrink_px: 0, home: null, button_layout: "wave-map" } });
    try { if (state.frame) localStorage.setItem(FRAME_KEY, state.frame); } catch (_) { /* private mode */ }
    try { state.data = await api("data"); } catch (_) { state.data = null; }
    renderFramePicker();
    renderStatus();
  }

  // ------------------------------------------------------------------ frames
  function frameName(id) { const f = state.frames.find(x => x.id === id); return f ? f.name : id; }
  function renderFramePicker() {
    const sel = $("frame-pick"); sel.textContent = "";
    state.frames.forEach(f => { const o = el("option", "", f.name); o.value = f.id; if (f.id === state.frame) o.selected = true; sel.appendChild(o); });
    $("frame-pick-wrap").hidden = state.frames.length < 2;
    $("btn-friends").hidden = !state.admin;
    document.title = state.frames.length > 1 ? `Surf Frame Studio · ${frameName(state.frame)}` : "Surf Frame Studio";
  }
  $("frame-pick").addEventListener("change", async e => {
    if (!$("view-editor").hidden) {
      if (state.dirty && !confirm("Discard unsaved changes?")) { e.target.value = state.frame; return; }
      state.dirty = false; closeStaging(); state.layout = null; $("view-editor").hidden = true; $("view-gallery").hidden = false;
    }
    state.frame = e.target.value;
    try { await loadState(); renderGallery(); toast("Now editing: " + frameName(state.frame)); } catch (err) { toast(err.message, true); }
  });

  // Frame settings: edge margin (tight mounts) and home town.
  function openSettings() {
    const st = state.settings || {}; const n = st.shrink_px || 0;
    $("fs-frame-name").textContent = state.frames.length > 1 ? "For: " + frameName(state.frame) : "";
    const preset = [0, 1, 2, 3].includes(n) ? String(n) : "custom";
    document.querySelectorAll('input[name="fs-shrink"]').forEach(r => { r.checked = r.value === preset; });
    $("fs-shrink-custom").value = preset === "custom" ? n : "";
    $("fs-shrink-custom").disabled = preset !== "custom";
    const h = st.home;
    $("fs-home-name").value = h ? h.name : ""; $("fs-home-lat").value = h ? h.lat : ""; $("fs-home-lon").value = h ? h.lon : "";
    $("fs-home-note").textContent = h ? "" : (state.frame === "main" ? "Blank = the home in settings.toml." : "Blank = no home: the weather widgets use a surf spot.");
    // KEY3 button: any of this frame's layouts, or nothing
    const sel = $("fs-button"); sel.textContent = "";
    const opt = (value, text) => { const o = document.createElement("option"); o.value = value; o.textContent = text; sel.appendChild(o); };
    opt("", "Nothing (the button just refreshes)");
    state.layouts.forEach(l => opt(l.id, l.name || l.id));
    const cur = st.button_layout === undefined || st.button_layout === null ? "wave-map" : st.button_layout;
    if (cur && !state.layouts.some(l => l.id === cur)) opt(cur, cur + " (not added yet)");
    sel.value = cur;
    $("settings-dlg").hidden = false;
  }
  document.querySelectorAll('input[name="fs-shrink"]').forEach(r => r.addEventListener("change", () => {
    const custom = document.querySelector('input[name="fs-shrink"]:checked').value === "custom";
    $("fs-shrink-custom").disabled = !custom;
    if (custom) { if ($("fs-shrink-custom").value === "") $("fs-shrink-custom").value = 4; $("fs-shrink-custom").focus(); }
  }));
  async function saveSettings() {
    const pick = (document.querySelector('input[name="fs-shrink"]:checked') || {}).value || "0";
    const n = pick === "custom" ? Number($("fs-shrink-custom").value) : Number(pick);
    if (!Number.isInteger(n) || n < 0 || n > 20) return toast("Edge margin: a whole number from 0 to 20", true);
    const name = $("fs-home-name").value.trim(), lat = $("fs-home-lat").value.trim(), lon = $("fs-home-lon").value.trim();
    let home = null;
    if (name || lat || lon) {
      if (!name || !lat || !lon) return toast("Home: fill in all three boxes, or clear all three", true);
      home = { name, lat: Number(lat.replace(",", ".")), lon: Number(lon.replace(",", ".")) };
    }
    try {
      const r = await api("settings", { method: "PUT", body: { shrink_px: n, home, button_layout: $("fs-button").value } });
      state.settings = r.settings; $("settings-dlg").hidden = true;
      toast("Saved — it shows on the frame after the next render");
    } catch (e) { toast(e.message, true); }
  }
  $("btn-frame-settings").addEventListener("click", openSettings);
  $("fs-save").addEventListener("click", saveSettings);
  $("fs-close").addEventListener("click", () => { $("settings-dlg").hidden = true; });
  $("settings-dlg").addEventListener("click", e => { if (e.target.id === "settings-dlg") $("settings-dlg").hidden = true; });

  // Friends' frames (admins only).
  let frEditing = null;
  const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  async function openFriends() {
    $("friends-dlg").hidden = false; resetFriendForm();
    await loadFriends();
  }
  async function loadFriends() {
    const list = $("fr-list"); list.textContent = "Loading…";
    let j;
    try { j = await api("admin/frames"); } catch (e) { list.textContent = ""; return toast(e.message, true); }
    const warn = [];
    if (!j.secret_ok) warn.push("FRAME_SECRET isn't set on the studio Worker (or is shorter than 32 characters), so no server addresses can be made. See the admin guide, step 2.");
    if (!j.img_origin) warn.push("The studio can't work out the frame Worker's address. Set FRAME_IMG_ORIGIN in workers/studio/wrangler.toml.");
    $("fr-warn").hidden = !warn.length; $("fr-warn").textContent = warn.join(" ");
    list.textContent = "";
    if (!j.frames.length) list.appendChild(el("p", "muted small", "No friends' frames yet."));
    j.frames.forEach(f => {
      const item = el("div", "fr-item");
      const top = el("div", "fr-top");
      top.appendChild(el("span", "fr-name", `${f.name}`));
      top.appendChild(el("span", "muted small", `ID ${f.id}${f.created ? " · added " + f.created : ""}`));
      item.appendChild(top);
      item.appendChild(el("div", "small", "Logs in with: " + f.emails.join(", ")));
      if (f.server) {
        const row = el("div", "fr-addr");
        const inp = el("input"); inp.type = "text"; inp.readOnly = true; inp.value = f.server; inp.setAttribute("aria-label", `Server address for ${f.name}`);
        inp.addEventListener("focus", () => inp.select());
        const copy = el("button", "small", "Copy address");
        copy.addEventListener("click", async () => {
          try { await navigator.clipboard.writeText(f.server); toast("Copied — send it to " + f.name); }
          catch (_) { inp.focus(); inp.select(); toast("Press Ctrl+C to copy"); }
        });
        row.appendChild(inp); row.appendChild(copy); item.appendChild(row);
      }
      const acts = el("div", "insp-acts");
      const open = el("button", "small", "Open their studio");
      open.addEventListener("click", async () => { $("friends-dlg").hidden = true; $("frame-pick").value = f.id; $("frame-pick").dispatchEvent(new Event("change")); });
      const edit = el("button", "small", "Edit");
      edit.addEventListener("click", () => {
        frEditing = f.id; $("fr-form-title").textContent = "Edit " + f.name;
        $("fr-name").value = f.name; $("fr-id").value = f.id; $("fr-id").disabled = true; $("fr-emails").value = f.emails.join(", ");
        $("fr-save").textContent = "Save changes"; $("fr-cancel").hidden = false; $("fr-name").focus();
      });
      const del = el("button", "small danger ghost", "Remove");
      del.addEventListener("click", async () => {
        if (!confirm(`Remove ${f.name}'s frame? Their layouts and pictures are deleted and the frame stops updating. This can't be undone.`)) return;
        try { await api("admin/frames/" + f.id, { method: "DELETE" }); toast("Removed"); await loadState(); await loadFriends(); }
        catch (e) { toast(e.message, true); }
      });
      [open, edit, del].forEach(b => acts.appendChild(b));
      item.appendChild(acts);
      list.appendChild(item);
    });
  }
  function resetFriendForm() {
    frEditing = null; $("fr-form-title").textContent = "Add a frame";
    ["fr-name", "fr-id", "fr-emails"].forEach(id => { $(id).value = ""; }); $("fr-id").disabled = false;
    $("fr-save").textContent = "Add frame"; $("fr-cancel").hidden = true;
  }
  $("fr-name").addEventListener("input", () => { if (!frEditing && !$("fr-id").dataset.touched) $("fr-id").value = slug($("fr-name").value); });
  $("fr-id").addEventListener("input", () => { $("fr-id").dataset.touched = $("fr-id").value ? "1" : ""; });
  $("fr-save").addEventListener("click", async () => {
    const id = frEditing || $("fr-id").value.trim();
    const body = { name: $("fr-name").value.trim(), emails: $("fr-emails").value };
    try {
      await api("admin/frames/" + encodeURIComponent(id), { method: "PUT", body });
      toast(frEditing ? "Saved" : "Added — copy the server address below and send it with the setup guide");
      resetFriendForm(); delete $("fr-id").dataset.touched;
      await loadState(); await loadFriends();
    } catch (e) { toast(e.message, true); }
  });
  $("fr-cancel").addEventListener("click", resetFriendForm);
  $("btn-friends").addEventListener("click", openFriends);
  $("fr-close").addEventListener("click", () => { $("friends-dlg").hidden = true; });
  $("friends-dlg").addEventListener("click", e => { if (e.target.id === "friends-dlg") $("friends-dlg").hidden = true; });

  // ------------------------------------------------------------------ gallery
  function fmtTs(ts) {
    if (!ts) return "not rendered yet";
    const d = new Date(ts * 1000);
    return d.toLocaleString("en-GB", { timeZone: "Europe/London", weekday: "short", hour: "2-digit", minute: "2-digit" });
  }

  function renderGallery() {
    const g = $("gallery"); g.textContent = "";
    state.layouts.forEach(l => {
      const r = state.renders[l.id];
      const card = el("div", "card" + (l.id === state.selected ? " selected" : ""));
      if (r) {
        const img = el("img", "thumb"); img.alt = l.name; img.loading = "lazy";
        img.src = `/api/renders/${encodeURIComponent(l.id)}-thumb.png?v=${r.ts}`;
        img.addEventListener("click", () => lightbox(`/api/renders/${encodeURIComponent(l.id)}.png?v=${r.ts}`));
        card.appendChild(img);
      } else card.appendChild(el("div", "thumb none", "Not rendered yet"));
      const meta = el("div", "meta");
      const nm = el("div", "nm", l.name);
      if (l.id === state.selected) nm.appendChild(el("span", "badge", "On frame"));
      meta.appendChild(nm);
      meta.appendChild(el("div", "ts", fmtTs(r && r.ts)));
      card.appendChild(meta);
      const acts = el("div", "acts");
      const show = el("button", l.id === state.selected ? "" : "primary", l.id === state.selected ? "Showing" : "Show on frame");
      show.disabled = l.id === state.selected;
      show.addEventListener("click", () => select(l.id));
      const edit = el("button", "", "Edit"); edit.addEventListener("click", () => openEditor(l.id));
      const dup = el("button", "", "Duplicate"); dup.addEventListener("click", () => duplicate(l.id));
      const del = el("button", "danger ghost", "Delete"); del.disabled = l.id === state.selected;
      del.title = l.id === state.selected ? "Choose another layout for the frame first" : "";
      del.addEventListener("click", () => remove(l.id, l.name));
      [show, edit, dup, del].forEach(b => acts.appendChild(b));
      card.appendChild(acts);
      g.appendChild(card);
    });
  }

  function lightbox(src) {
    const lb = el("div", "lightbox"); const img = el("img"); img.src = src; img.alt = "Full-size render";
    const k = realScale();
    if (k) {
      // Exactly the physical size of the real e-ink display on this screen.
      lb.classList.add("real");
      img.style.width = (800 * k) + "px"; img.style.height = (480 * k) + "px";
      img.style.imageRendering = k >= 1 ? "pixelated" : "auto";
      lb.appendChild(el("div", "real-tag", "Real size"));
    }
    lb.appendChild(img); lb.addEventListener("click", () => lb.remove()); document.body.appendChild(lb);
  }

  // ------------------------------------------------------------------ real size
  // The panel's visible area is 163.2 mm wide for 800 pixels (Seeed 7.5" UC8179 panel).
  const PANEL_MM_W = 163.2;
  function loadDisplay() {
    try { const d = JSON.parse(localStorage.getItem("sf-display") || "null"); return d && d.diag > 0 && d.w > 0 && d.h > 0 ? d : null; }
    catch (_) { return null; }
  }
  function saveDisplay(d) { try { if (d) localStorage.setItem("sf-display", JSON.stringify(d)); else localStorage.removeItem("sf-display"); } catch (_) { /* private mode */ } }
  // CSS pixels per millimetre on this screen (accounts for Windows/mac scaling via devicePixelRatio;
  // browser zoom also changes devicePixelRatio, so keep the page at 100% zoom).
  function cssPxPerMm(d) { return Math.hypot(d.w, d.h) / d.diag / 25.4 / (window.devicePixelRatio || 1); }
  function realScale() { const d = loadDisplay(); return d ? PANEL_MM_W * cssPxPerMm(d) / 800 : null; }

  function openDisplayDialog() {
    const d = loadDisplay() || {};
    $("dd-diag").value = d.diag || "";
    $("dd-w").value = d.w || Math.round(screen.width * (window.devicePixelRatio || 1));
    $("dd-h").value = d.h || Math.round(screen.height * (window.devicePixelRatio || 1));
    $("display-dlg").hidden = false;
    updateDisplayInfo();
    $("dd-diag").focus();
  }
  function readDialog() {
    const v = { diag: parseFloat($("dd-diag").value), w: parseInt($("dd-w").value, 10), h: parseInt($("dd-h").value, 10) };
    return v.diag > 0 && v.w > 0 && v.h > 0 ? v : null;
  }
  function updateDisplayInfo() {
    const v = readDialog(), card = $("dd-card");
    if (!v) { $("dd-info").textContent = "Resolution is pre-filled from this screen; check it against your display settings."; card.style.width = "85.6mm"; card.style.height = "54mm"; return; }
    const mm = cssPxPerMm(v);
    card.style.width = (85.6 * mm) + "px"; card.style.height = (53.98 * mm) + "px";
    $("dd-info").textContent = `${Math.round(Math.hypot(v.w, v.h) / v.diag)} pixels per inch · display scaling ${Math.round((window.devicePixelRatio || 1) * 100)}% · the frame preview will measure 163 × 98 mm on this screen.`;
  }
  ["dd-diag", "dd-w", "dd-h"].forEach(id => $(id).addEventListener("input", updateDisplayInfo));
  $("btn-display").addEventListener("click", openDisplayDialog);
  $("dd-close").addEventListener("click", () => { $("display-dlg").hidden = true; });
  $("dd-clear").addEventListener("click", () => { saveDisplay(null); $("tg-real").checked = false; $("display-dlg").hidden = true; fit(); toast("Screen size cleared"); });
  $("dd-save").addEventListener("click", () => {
    const v = readDialog(); if (!v) return toast("Fill in all three boxes", true);
    saveDisplay(v); $("display-dlg").hidden = true; $("tg-real").checked = true;
    if (!$("view-editor").hidden) fit();
    toast("Saved — renders now open at real size");
  });
  $("display-dlg").addEventListener("click", e => { if (e.target.id === "display-dlg") $("display-dlg").hidden = true; });

  async function select(id) {
    try { await api("select", { method: "POST", body: { layout: id } }); state.selected = id; renderGallery();
      toast("The frame will show this at its next wake-up"); } catch (e) { toast(e.message, true); }
  }
  function uniqueId(base) {
    let b = base.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "layout";
    if (!/^[a-z0-9]/.test(b)) b = "l" + b;
    let id = b, n = 2; const ids = new Set(state.layouts.map(l => l.id));
    while (ids.has(id)) id = `${b}-${n++}`;
    return id;
  }
  async function duplicate(id) {
    try {
      const l = await api("layouts/" + id);
      l.id = uniqueId(l.id + "-copy"); l.name = (l.name + " copy").slice(0, 60);
      await api("layouts/" + l.id, { method: "PUT", body: l });
      await loadState(); renderGallery(); toast("Duplicated — it renders on the next run");
    } catch (e) { toast(e.message, true); }
  }
  async function remove(id, name) {
    if (!confirm(`Delete "${name}"?`)) return;
    try { await api("layouts/" + id, { method: "DELETE" }); await loadState(); renderGallery(); } catch (e) { toast(e.message, true); }
  }
  async function newLayout() {
    const id = uniqueId("layout");
    const spot = state.data ? state.data.spot_order[0] : "saunton";
    const l = { id, name: "New layout", spot, mode: "4grey", threshold: 160, invert: false,
      widgets: [{ id: "w1", type: "header", x: 0, y: 0, w: 40, h: 3, props: {} }] };
    try { await api("layouts/" + id, { method: "PUT", body: l }); await loadState(); openEditor(id); } catch (e) { toast(e.message, true); }
  }

  // ------------------------------------------------------------------ editor
  const DEMO = () => state.data || { today: { dow: "Day", dow3: "Day", day: 1, month: "Month", mon3: "Mon", iso: "" }, spots: {}, spot_order: [], bookings: [], units: { wind: "mph" } };

  async function openEditor(id) {
    try { state.layout = await api("layouts/" + id); } catch (e) { return toast(e.message, true); }
    state.sel = null; state.undo = []; state.dirty = false;
    $("view-gallery").hidden = true; $("view-editor").hidden = false;
    $("layout-name").value = state.layout.name || "";
    buildPalette(); fit(); redrawAll(); renderInspector();
    window.scrollTo(0, 0);
  }
  function closeEditor() {
    if (state.dirty && !confirm("Discard unsaved changes?")) return;
    closeStaging();
    state.layout = null; $("view-editor").hidden = true; $("view-gallery").hidden = false;
    loadState().then(renderGallery);
  }

  function snapshot() { state.undo.push(JSON.stringify(state.layout)); if (state.undo.length > 60) state.undo.shift(); state.dirty = true; }
  function undo() {
    const s = state.undo.pop(); if (!s) return;
    state.layout = JSON.parse(s); if (state.sel && !findW(state.sel)) state.sel = null;
    $("layout-name").value = state.layout.name; redrawAll(); renderInspector();
  }
  const findW = id => state.layout.widgets.find(w => w.id === id);

  // Palette: one row per widget, with a detail drop-down. Clicking a widget opens the
  // staging area (preview + size + options) rather than dropping it straight on the canvas.
  const DETAIL_LABELS = { min: "Minimal", std: "Standard", full: "Full" };
  const hasDetail = def => (def.props || []).some(p => p.key === "detail");
  state.palDetail = {};
  function buildPalette() {
    const p = $("palette"); p.textContent = "";
    Object.entries(WIDGETS).forEach(([type, def]) => {
      if (state.hidden.includes(type)) return;   // e.g. The Wave widgets on a friend's frame
      const row = el("div", "prow"); row.dataset.type = type;
      const b = el("button", "padd", def.name);
      b.appendChild(el("span", "pcount"));
      b.addEventListener("click", () => openStaging(type));
      row.appendChild(b);
      if (hasDetail(def)) {
        const sel = selectEl(["min", "std", "full"], state.palDetail[type] || "full", ["Min", "Std", "Full"]);
        sel.className = "pdet"; sel.title = "How much detail the widget shows";
        sel.setAttribute("aria-label", def.name + " detail");
        sel.addEventListener("change", () => { state.palDetail[type] = sel.value; });
        row.appendChild(sel);
      }
      p.appendChild(row);
    });
    markPalette();
  }
  // Widgets already on the layout are shown green (with a count if used more than once).
  function markPalette() {
    if (!state.layout) return;
    const counts = {};
    state.layout.widgets.forEach(w => { counts[w.type] = (counts[w.type] || 0) + 1; });
    document.querySelectorAll("#palette .prow").forEach(r => {
      const n = counts[r.dataset.type] || 0;
      const b = r.querySelector(".padd");
      r.classList.toggle("used", n > 0);
      b.title = n ? `On this layout${n > 1 ? " ×" + n : ""} — click to preview and add another` : "Preview and add to layout";
      b.querySelector(".pcount").textContent = n > 1 ? "×" + n : n ? "✓" : "";
    });
  }

  function occupied(except) {
    const g = Array.from({ length: ROWS }, () => new Array(COLS).fill(false));
    state.layout.widgets.forEach(w => { if (w.id === except) return;
      for (let y = w.y; y < w.y + w.h; y++) for (let x = w.x; x < w.x + w.w; x++) if (g[y]) g[y][x] = true; });
    return g;
  }
  function freeSpot(wd, ht) {
    const g = occupied();
    for (let y = 0; y + ht <= ROWS; y++) for (let x = 0; x + wd <= COLS; x++) {
      let ok = true;
      for (let yy = y; yy < y + ht && ok; yy++) for (let xx = x; xx < x + wd; xx++) if (g[yy][xx]) { ok = false; break; }
      if (ok) return { x, y };
    }
    return null;
  }
  // ------------------------------------------------------------------ staging area
  // A new widget is shown on its own first, so you can see what's on it, set its size
  // and options, and only then place it — in the first free space big enough for it.
  let stg = null;
  function openStaging(type) {
    const def = WIDGETS[type];
    const props = {};
    if (hasDetail(def)) props.detail = state.palDetail[type] || "full";
    stg = { type, w: def.def.w, h: def.def.h, props };
    $("stg-title").textContent = "Add: " + def.name;
    $("stg-w").min = def.min.w; $("stg-w").max = COLS;
    $("stg-h").min = def.min.h; $("stg-h").max = ROWS;
    $("staging").hidden = false;
    drawStaging(); renderStagingProps();
    $("stg-add").focus();
  }
  function closeStaging() { stg = null; $("staging").hidden = true; $("stg-frame").textContent = ""; }
  function stagingScale() {
    const real = $("tg-real").checked ? realScale() : null;
    return real || Math.max(0.6, Math.min(1.25, state.scale));
  }
  function drawStaging() {
    if (!stg) return;
    const k = stagingScale();
    const fr = $("stg-frame"), wrap = $("stg-canvas");
    fr.textContent = "";
    fr.className = "frame stg-frame" + (state.layout.invert ? " inverted" : "");
    fr.style.width = stg.w * CELL + "px"; fr.style.height = stg.h * CELL + "px";
    fr.style.transform = `scale(${k})`;
    wrap.style.width = Math.ceil(stg.w * CELL * k) + "px"; wrap.style.height = Math.ceil(stg.h * CELL * k) + "px";
    const box = el("div"); fr.appendChild(box);
    SF.renderWidget(box, { id: "stage", type: stg.type, x: 0, y: 0, w: stg.w, h: stg.h, props: stg.props }, state.layout, DEMO());
    $("stg-w").value = stg.w; $("stg-h").value = stg.h;
    const pos = freeSpot(stg.w, stg.h);
    const info = $("stg-info");
    info.classList.toggle("warn", !pos);
    info.textContent = pos
      ? `${stg.w} × ${stg.h} squares — it will go in the first free space big enough (column ${pos.x + 1}, row ${pos.y + 1}).`
      : `No free space ${stg.w} × ${stg.h} squares on the layout. Make it smaller, or add it anyway: it goes where it covers the least, outlined orange until you move it.`;
    $("stg-add").textContent = pos ? "Add to layout" : "Add anyway (overlapping)";
  }
  function renderStagingProps() {
    const box = $("stg-props"); box.textContent = "";
    const def = WIDGETS[stg.type];
    propFields(box, def, Object.assign(SF.widgetDefaults(stg.type), stg.props), (key, val) => {
      stg.props[key] = val; drawStaging();
    });
  }
  function setStagingSize(w, h) {
    const def = WIDGETS[stg.type];
    stg.w = Math.max(def.min.w, Math.min(COLS, w | 0 || stg.w));
    stg.h = Math.max(def.min.h, Math.min(ROWS, h | 0 || stg.h));
    drawStaging();
  }
  // No gap big enough: the position that covers the fewest squares of other widgets.
  function leastOverlap(wd, ht) {
    const g = occupied(); let best = { x: 0, y: 0 }, bestN = Infinity;
    for (let y = 0; y + ht <= ROWS; y++) for (let x = 0; x + wd <= COLS; x++) {
      let n = 0;
      for (let yy = y; yy < y + ht; yy++) for (let xx = x; xx < x + wd; xx++) if (g[yy][xx]) n++;
      if (n < bestN) { bestN = n; best = { x, y }; }
    }
    return best;
  }
  function commitStaging() {
    if (!stg) return;
    const pos = freeSpot(stg.w, stg.h) || leastOverlap(stg.w, stg.h);
    snapshot();
    let n = 1; const ids = new Set(state.layout.widgets.map(x => x.id)); while (ids.has("w" + n)) n++;
    const nw = { id: "w" + n, type: stg.type, x: Math.min(pos.x, COLS - stg.w), y: Math.min(pos.y, ROWS - stg.h), w: stg.w, h: stg.h, props: { ...stg.props } };
    state.layout.widgets.push(nw); state.sel = nw.id;
    closeStaging(); redrawAll(); renderInspector();
    toast(`Added ${WIDGETS[nw.type].name}`);
  }
  // resize handle in the staging area
  (function () {
    let d = null;
    const hd = $("stg-handle");
    hd.addEventListener("pointerdown", ev => {
      if (!stg) return;
      d = { sx: ev.clientX, sy: ev.clientY, w: stg.w, h: stg.h };
      hd.setPointerCapture(ev.pointerId); ev.preventDefault();
    });
    hd.addEventListener("pointermove", ev => {
      if (!d) return;
      const k = stagingScale();
      const w = d.w + Math.round((ev.clientX - d.sx) / k / CELL), h = d.h + Math.round((ev.clientY - d.sy) / k / CELL);
      if (w !== stg.w || h !== stg.h) setStagingSize(w, h);
    });
    hd.addEventListener("pointerup", () => { d = null; });
  })();

  function overlaps(a, b) { return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h; }

  // Automatic widgets (a Flight set to "show automatically"): the editor previews the layout
  // with them showing (toggle "Flight showing") or as it looks the rest of the time.
  const isAutoW = w => w.type === "flight" && w.props && w.props.auto;
  const hasAuto = () => !!state.layout && state.layout.widgets.some(isAutoW);
  const previewAuto = () => (hasAuto() ? $("tg-auto").checked : undefined);
  function effective() { return SF.effectiveWidgets(state.layout, DEMO(), { previewAuto: previewAuto() }); }

  function redrawAll() {
    const canvas = $("canvas");
    $("tg-auto-wrap").hidden = !hasAuto();
    SF.renderLayout(canvas, state.layout, DEMO(), { previewAuto: previewAuto() });
    drawOverlay();
    applyPreview();
  }
  function redrawOne(w) {
    if (hasAuto()) return redrawAll();   // other widgets' sizes may depend on it
    const box = $("canvas").querySelector(`[data-id="${CSS.escape(w.id)}"]`);
    if (box) SF.renderWidget(box, w, state.layout, DEMO()); else redrawAll();
    drawOverlay();
  }

  function drawOverlay() {
    markPalette();
    const ov = $("overlay"); ov.textContent = "";
    const eff = {}; effective().forEach(e => { eff[e.id] = e; });
    state.layout.widgets.forEach(w0 => {
      const e = eff[w0.id];
      if (e && e.hidden && !isAutoW(w0)) return;
      // a hidden automatic widget is still shown (dashed) at its corner so you can select it
      const w = e ? Object.assign({}, w0, isAutoW(w0) ? { x: COLS - w0.w, y: ROWS - w0.h } : { x: e.x, y: e.y, w: e.w, h: e.h }) : w0;
      const d = el("div", "ov" + (w.id === state.sel ? " sel" : ""));
      if (!isAutoW(w0) && !(e && e.adjusted) && state.layout.widgets.some(o => o !== w0 && !isAutoW(o) && overlaps(o, w0))) d.classList.add("clash");
      if (e && e.adjusted) { d.classList.add("locked"); d.title = "Made smaller while the flight shows. Untick \"Flight showing\" to edit it."; }
      if (isAutoW(w0) && e && e.hidden) d.classList.add("ghost");
      d.style.left = w.x * CELL + "px"; d.style.top = w.y * CELL + "px";
      d.style.width = w.w * CELL + "px"; d.style.height = w.h * CELL + "px";
      d.dataset.id = w.id;
      d.appendChild(el("div", "tag", `${WIDGETS[w.type].name} · ${w.w}×${w.h}${isAutoW(w0) ? " · automatic" : ""}`));
      ["se", "e", "s"].forEach(k => { const hd = el("div", "hd " + k); hd.dataset.h = k; d.appendChild(hd); });
      d.addEventListener("pointerdown", onDown);
      ov.appendChild(d);
    });
  }

  function markSel() {
    $("overlay").querySelectorAll(".ov").forEach(o => o.classList.toggle("sel", o.dataset.id === state.sel));
  }

  // drag / resize ----------------------------------------------------------
  let drag = null;
  function onDown(ev) {
    if (ev.button !== 0) return;
    const id = ev.currentTarget.dataset.id; const w = findW(id);
    if (state.sel !== id) { state.sel = id; markSel(); renderInspector(); }
    const mode = ev.target.dataset.h || "move";
    drag = { id, mode, sx: ev.clientX, sy: ev.clientY, o: { ...w }, moved: false };
    ev.currentTarget.setPointerCapture(ev.pointerId);
    ev.currentTarget.addEventListener("pointermove", onMove);
    ev.currentTarget.addEventListener("pointerup", onUp, { once: true });
    ev.preventDefault();
  }
  function onMove(ev) {
    if (!drag) return;
    const w = findW(drag.id); const def = WIDGETS[w.type];
    if (isAutoW(w) && drag.mode === "move") return;   // it always sits in the bottom-right corner
    const dx = Math.round((ev.clientX - drag.sx) / state.scale / CELL);
    const dy = Math.round((ev.clientY - drag.sy) / state.scale / CELL);
    const n = { ...drag.o };
    if (drag.mode === "move") {
      n.x = Math.max(0, Math.min(COLS - n.w, drag.o.x + dx)); n.y = Math.max(0, Math.min(ROWS - n.h, drag.o.y + dy));
    } else {
      if (drag.mode !== "s") n.w = Math.max(def.min.w, Math.min(COLS - n.x, drag.o.w + dx));
      if (drag.mode !== "e") n.h = Math.max(def.min.h, Math.min(ROWS - n.y, drag.o.h + dy));
    }
    if (n.x !== w.x || n.y !== w.y || n.w !== w.w || n.h !== w.h) {
      if (!drag.moved) { snapshot(); drag.moved = true; }
      Object.assign(w, { x: n.x, y: n.y, w: n.w, h: n.h });
      if (hasAuto()) { SF.renderLayout($("canvas"), state.layout, DEMO(), { previewAuto: previewAuto() }); applyPreview(); }
      else { const box = $("canvas").querySelector(`[data-id="${CSS.escape(w.id)}"]`); if (box) SF.renderWidget(box, w, state.layout, DEMO()); }
      const o = ev.currentTarget;
      if (isAutoW(w)) { w.x = COLS - w.w; w.y = ROWS - w.h; }
      o.style.left = w.x * CELL + "px"; o.style.top = w.y * CELL + "px";
      o.style.width = w.w * CELL + "px"; o.style.height = w.h * CELL + "px";
      const tag = o.querySelector(".tag"); if (tag) tag.textContent = `${WIDGETS[w.type].name} · ${w.w}×${w.h}`;
      syncGeo(w);
    }
  }
  function onUp(ev) {
    ev.currentTarget.removeEventListener("pointermove", onMove);
    drag = null; drawOverlay();
  }

  // keyboard ---------------------------------------------------------------
  document.addEventListener("keydown", ev => {
    if ($("view-editor").hidden) return;
    if (stg) {
      if (ev.key === "Escape") closeStaging();
      else if (ev.key === "Enter" && document.activeElement.tagName !== "SELECT") { ev.preventDefault(); commitStaging(); }
      return;
    }
    const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName);
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "z" && !typing) { ev.preventDefault(); return undo(); }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") { ev.preventDefault(); return save(false); }
    if (typing || !state.sel) return;
    const w = findW(state.sel); if (!w) return;
    const def = WIDGETS[w.type];
    if (ev.key === "Delete" || ev.key === "Backspace") { ev.preventDefault(); return deleteSel(); }
    if (ev.key === "Escape") { state.sel = null; drawOverlay(); return renderInspector(); }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "d") { ev.preventDefault(); return duplicateSel(); }
    const k = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[ev.key];
    if (!k) return;
    ev.preventDefault(); snapshot();
    if (ev.shiftKey) {
      w.w = Math.max(def.min.w, Math.min(COLS - w.x, w.w + k[0])); w.h = Math.max(def.min.h, Math.min(ROWS - w.y, w.h + k[1]));
    } else {
      w.x = Math.max(0, Math.min(COLS - w.w, w.x + k[0])); w.y = Math.max(0, Math.min(ROWS - w.h, w.y + k[1]));
    }
    redrawOne(w); syncGeo(w);
  });

  function deleteSel() {
    snapshot(); state.layout.widgets = state.layout.widgets.filter(w => w.id !== state.sel);
    state.sel = null; redrawAll(); renderInspector();
  }
  function duplicateSel() {
    const w = findW(state.sel); const pos = freeSpot(w.w, w.h);
    if (!pos) return toast("No free space for a copy", true);
    snapshot(); let n = 1; const ids = new Set(state.layout.widgets.map(x => x.id)); while (ids.has("w" + n)) n++;
    const c = JSON.parse(JSON.stringify(w)); Object.assign(c, { id: "w" + n, x: pos.x, y: pos.y });
    state.layout.widgets.push(c); state.sel = c.id; redrawAll(); renderInspector();
  }

  // inspector --------------------------------------------------------------
  function field(label, input, full) {
    const f = el("div", "field" + (full ? " full" : "")); const l = el("label", "", label);
    f.appendChild(l); f.appendChild(input); return f;
  }
  function selectEl(options, value, labels) {
    const s = el("select");
    options.forEach((o, i) => { const op = el("option", "", labels ? labels[i] : o); op.value = o; if (String(o) === String(value)) op.selected = true; s.appendChild(op); });
    return s;
  }
  function spotOptions() {
    const d = DEMO(); const keys = d.spot_order.length ? d.spot_order : ["saunton", "rest_bay"];
    return { keys, labels: keys.map(k => (d.spots[k] && d.spots[k].name) || k) };
  }

  function renderInspector() {
    const ins = $("inspector"); ins.textContent = "";
    if (!state.layout) return;
    const w = state.sel && findW(state.sel);
    if (!w) return renderLayoutSettings(ins);
    const def = WIDGETS[w.type];
    ins.appendChild(el("h3", "", def.name));
    const geo = el("div", "geo"); geo.id = "geo";
    [["x", 0, COLS - 1], ["y", 0, ROWS - 1], ["w", def.min.w, COLS], ["h", def.min.h, ROWS]].forEach(([k, mn, mx]) => {
      const lab = el("label", "", k.toUpperCase()); const inp = el("input"); inp.type = "number"; inp.min = mn; inp.max = mx; inp.value = w[k]; inp.dataset.k = k;
      if (isAutoW(w) && (k === "x" || k === "y")) { inp.disabled = true; inp.title = "Automatic: always the bottom-right corner"; }
      inp.addEventListener("change", () => {
        snapshot(); let v = parseInt(inp.value, 10); if (isNaN(v)) v = w[k];
        w[k] = Math.max(mn, Math.min(mx, v));
        w.x = Math.min(w.x, COLS - w.w); w.y = Math.min(w.y, ROWS - w.h);
        w.w = Math.min(w.w, COLS - w.x); w.h = Math.min(w.h, ROWS - w.y);
        redrawOne(w); syncGeo(w);
      });
      lab.appendChild(inp); geo.appendChild(lab);
    });
    ins.appendChild(geo);
    const props = Object.assign(SF.widgetDefaults(w.type), w.props || {});
    const setProp = (key, val) => { snapshot(); w.props = w.props || {}; w.props[key] = val; redrawOne(w); };

    const frame = selectEl(["default", "box", "none", "inverse"], (w.props && w.props.frame) || "default",
      [`Default (${def.frame || "box"})`, "Box", "No border", "Inverted"]);
    frame.addEventListener("change", () => { if (frame.value === "default") { snapshot(); delete w.props.frame; redrawOne(w); } else setProp("frame", frame.value); });
    ins.appendChild(field("Style", frame));

    propFields(ins, def, props, setProp, (key, val) => { w.props = w.props || {}; w.props[key] = val; state.dirty = true; redrawOne(w); });
    const acts = el("div", "insp-acts");
    const dup = el("button", "", "Duplicate"); dup.addEventListener("click", duplicateSel);
    const del = el("button", "danger", "Remove"); del.addEventListener("click", deleteSel);
    acts.appendChild(dup); acts.appendChild(del);
    ins.appendChild(acts);
  }

  // Builds the option controls for a widget. onChange(key, value) for discrete changes;
  // onType (optional) for live typing in text boxes.
  function propFields(container, def, props, onChange, onType) {
    (def.props || []).forEach(p => {
      let input;
      if (p.type === "bool") {
        input = el("input"); input.type = "checkbox"; input.checked = !!props[p.key];
        input.addEventListener("change", () => onChange(p.key, input.checked));
      } else if (p.type === "select") {
        let val = props[p.key];
        if (p.key === "detail" && typeof val === "boolean") val = val ? "full" : "std";  // older layouts
        let labels = p.labels;
        if (p.key === "where") labels = ["Surf spot", "Home" + (DEMO().home ? ` (${DEMO().home.name})` : "")];
        input = selectEl(p.options, val, labels); input.addEventListener("change", () => onChange(p.key, input.value));
      } else if (p.type === "spot") {
        const so = spotOptions();
        input = selectEl(["default", ...so.keys], props[p.key] || "default", ["Layout default", ...so.labels]);
        input.addEventListener("change", () => onChange(p.key, input.value));
      } else if (p.type === "date") {
        input = el("input"); input.type = "date"; input.value = props[p.key] || "";
        input.addEventListener("change", () => onChange(p.key, input.value));
      } else if (p.type === "number") {
        input = el("input"); input.type = "number"; input.min = p.min; input.max = p.max; input.value = props[p.key];
        input.addEventListener("change", () => { const v = Math.max(p.min, Math.min(p.max, parseInt(input.value, 10) || p.default)); input.value = v; onChange(p.key, v); });
      } else {
        input = el("input"); input.type = "text"; input.maxLength = 200; input.value = props[p.key] || "";
        input.addEventListener("input", () => (onType || onChange)(p.key, input.value));
      }
      container.appendChild(field(p.label, input, p.type === "text"));
    });
  }

  function syncGeo(w) {
    const g = $("geo"); if (!g) return;
    g.querySelectorAll("input").forEach(i => { i.value = w[i.dataset.k]; });
  }

  function renderLayoutSettings(ins) {
    const L = state.layout;
    ins.appendChild(el("h3", "", "Layout settings"));
    ins.appendChild(el("p", "muted small", "Select a widget on the canvas to edit it."));
    const so = spotOptions();
    const spot = selectEl(so.keys, L.spot, so.labels);
    spot.addEventListener("change", () => { snapshot(); L.spot = spot.value; redrawAll(); });
    ins.appendChild(field("Default spot", spot));
    const mode = selectEl(["1bit", "4grey"], L.mode || "1bit", ["Black & white (1-bit)", "4 greys (smoother; needs 4-grey firmware)"]);
    mode.addEventListener("change", () => { snapshot(); L.mode = mode.value; applyPreview(); renderInspector(); });
    ins.appendChild(field("Output", mode));
    if ((L.mode || "1bit") === "1bit") {
      const thr = el("input"); thr.type = "range"; thr.min = 80; thr.max = 220; thr.value = L.threshold || 160;
      thr.addEventListener("input", () => { L.threshold = parseInt(thr.value, 10); state.dirty = true; applyPreview(); });
      thr.addEventListener("change", () => snapshot());
      ins.appendChild(field("Boldness", thr));
    }
    const inv = el("input"); inv.type = "checkbox"; inv.checked = !!L.invert;
    inv.addEventListener("change", () => { snapshot(); L.invert = inv.checked; redrawAll(); });
    ins.appendChild(field("Invert (white on black)", inv));
    ins.appendChild(el("hr", "sep"));
    ins.appendChild(el("p", "muted small", `ID: ${L.id} · ${L.widgets.length} widgets. Tick "E-ink preview" to see the thresholded result; the frame image comes from the next cloud render.`));
  }

  // ------------------------------------------------------------------ exact e-ink preview
  // Draws the layout at the panel's native 800x480 pixels (same HTML/CSS/fonts as the
  // cloud render, via an SVG snapshot of the page), then applies the SAME conversion
  // as pipeline/render.py: greyscale (ITU-R 601) then threshold, or nearest of 4 greys.
  let fontCss = null, previewTimer = null, previewBusy = false, previewAgain = false;

  async function frameCssWithFonts() {
    if (fontCss) return fontCss;
    let css = await (await fetch("frame.css", { credentials: "same-origin" })).text();
    const urls = [...new Set([...css.matchAll(/url\("([^"]+)"\)/g)].map(m => m[1]))];
    for (const u of urls) {
      const buf = await (await fetch(u, { credentials: "same-origin" })).arrayBuffer();
      let bin = ""; const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      css = css.split(`url("${u}")`).join(`url("data:font/woff2;base64,${btoa(bin)}")`);
    }
    fontCss = css;
    return css;
  }

  async function rasterise() {
    const css = await frameCssWithFonts();
    const html = new XMLSerializer().serializeToString($("canvas"));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="480"><foreignObject x="0" y="0" width="800" height="480"><div xmlns="http://www.w3.org/1999/xhtml"><style>${css.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</style>${html}</div></foreignObject></svg>`;
    // A data: URL (not blob:) keeps the canvas readable in Chromium browsers.
    const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    {
      const img = new Image();
      await new Promise((ok, bad) => { img.onload = ok; img.onerror = () => bad(new Error("snapshot failed")); img.src = url; });
      if (img.decode) await img.decode().catch(() => {});
      const cv = $("eink"), cx = cv.getContext("2d", { willReadFrequently: true });
      cx.fillStyle = "#fff"; cx.fillRect(0, 0, 800, 480);
      cx.drawImage(img, 0, 0, 800, 480);
      const id = cx.getImageData(0, 0, 800, 480), d = id.data;
      const four = state.layout.mode === "4grey", thr = state.layout.threshold || 160;
      for (let i = 0; i < d.length; i += 4) {
        const L = Math.floor((d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000);
        const v = four ? [0, 85, 170, 255].reduce((a, b) => (Math.abs(b - L) < Math.abs(a - L) ? b : a)) : (L >= thr ? 255 : 0);
        d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
      }
      cx.putImageData(id, 0, 0);
    }
  }

  async function runPreview() {
    if (previewBusy) { previewAgain = true; return; }
    previewBusy = true;
    try {
      await document.fonts.ready;
      await rasterise();
      $("stage").classList.add("eink"); $("eink").hidden = false;
    } catch (e) {
      $("tg-eink").checked = false; hidePreview();
      toast("This browser can't draw the exact preview (" + e.message + "). Try Chrome or Edge.", true);
    } finally {
      previewBusy = false;
      if (previewAgain) { previewAgain = false; schedulePreview(); }
    }
  }
  function hidePreview() { $("stage").classList.remove("eink"); $("eink").hidden = true; }
  function schedulePreview() {
    if (!$("tg-eink").checked || !state.layout) return hidePreview();
    clearTimeout(previewTimer); previewTimer = setTimeout(runPreview, 120);
  }
  function applyPreview() { schedulePreview(); }
  // Any change to the drawn frame (drag, resize, property edits) refreshes the preview.
  new MutationObserver(() => { if ($("tg-eink").checked) schedulePreview(); })
    .observe($("canvas"), { subtree: true, childList: true, attributes: true, characterData: true });


  function fit() {
    const wrap = $("stage-wrap"), st = $("stage");
    const avail = wrap.clientWidth - 24;
    const real = $("tg-real").checked ? realScale() : null;
    wrap.classList.toggle("real", !!real);
    // The E-ink pixels toggle never changes the scale: the box stays at real size (or fit
    // size) either way. Only the drawing of the pixels changes: hard-edged blocks when each
    // panel pixel covers at least 1.5 screen pixels, smoothed below that so 1 px gaps show
    // as light grey lines instead of vanishing at uneven scales.
    const scale = real || Math.min(1.25, Math.max(0.3, avail / 800));
    const dpr = window.devicePixelRatio || 1;
    state.scale = scale;
    st.style.transform = `scale(${state.scale})`;
    $("eink").style.imageRendering = scale * dpr >= 1.5 ? "pixelated" : "auto";
    st.style.marginBottom = (480 * state.scale - 480 + 12) + "px";
    st.style.marginRight = (800 * state.scale - 800 + 12) + "px";
  }
  window.addEventListener("resize", () => { if (!$("view-editor").hidden) { fit(); drawStaging(); } });

  async function save(show) {
    const L = state.layout;
    L.name = ($("layout-name").value || "Untitled").slice(0, 60);
    if (!ID_RE.test(L.id)) return toast("Bad layout id", true);
    try {
      await api("layouts/" + L.id, { method: "PUT", body: L });
      state.dirty = false;
      if (show) { await api("select", { method: "POST", body: { layout: L.id } }); state.selected = L.id; }
      toast(show ? "Saved — the frame switches after the next render" : "Saved");
    } catch (e) { toast(e.message, true); }
  }

  // ------------------------------------------------------------------ wiring
  $("btn-new").addEventListener("click", newLayout);
  $("stg-add").addEventListener("click", commitStaging);
  $("stg-cancel").addEventListener("click", closeStaging);
  $("staging").addEventListener("pointerdown", e => { if (e.target.id === "staging") closeStaging(); });
  $("stg-w").addEventListener("change", () => setStagingSize(parseInt($("stg-w").value, 10), stg.h));
  $("stg-h").addEventListener("change", () => setStagingSize(stg.w, parseInt($("stg-h").value, 10)));
  document.querySelectorAll("[data-stg]").forEach(b => b.addEventListener("click", () => {
    const [dw, dh] = b.dataset.stg.split(",").map(Number); setStagingSize(stg.w + dw, stg.h + dh);
  }));
  $("stg-def").addEventListener("click", () => { const d = WIDGETS[stg.type].def; setStagingSize(d.w, d.h); });
  $("btn-back").addEventListener("click", closeEditor);
  $("btn-undo").addEventListener("click", undo);
  $("btn-save").addEventListener("click", () => save(false));
  $("btn-save-show").addEventListener("click", () => save(true));
  $("layout-name").addEventListener("input", () => { state.dirty = true; });
  $("tg-grid").addEventListener("change", e => { $("grid").hidden = !e.target.checked; });
  $("tg-eink").addEventListener("change", () => { fit(); applyPreview(); });
  $("tg-auto").addEventListener("change", () => { if (state.layout) { redrawAll(); renderInspector(); } });
  $("tg-real").checked = !!loadDisplay();
  $("tg-real").addEventListener("change", e => {
    if (e.target.checked && !loadDisplay()) { e.target.checked = false; return openDisplayDialog(); }
    fit();
  });
  $("overlay").addEventListener("pointerdown", e => { if (e.target.id === "overlay") { state.sel = null; drawOverlay(); renderInspector(); } });
  $("btn-render").addEventListener("click", async () => {
    try { await api("render-now", { method: "POST", body: {} }); toast("Render started — refresh in a couple of minutes"); }
    catch (e) { toast(e.message, true); }
  });
  window.addEventListener("beforeunload", e => { if (state.dirty) { e.preventDefault(); e.returnValue = ""; } });

  document.fonts.ready.then(() => loadState()).then(renderGallery).catch(e => {
    $("status").textContent = "Couldn't load: " + e.message;
  });
})();
