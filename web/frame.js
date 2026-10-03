/* Entry point for the headless render (pipeline/render.py calls window.renderFrame). */
(function () {
  "use strict";
  const FONT_FACES = ['400 20px "Inter"', '600 20px "Inter"', '700 20px "Inter"', '800 20px "Inter"',
    '500 20px "Barlow Condensed"', '600 20px "Barlow Condensed"', '700 20px "Barlow Condensed"'];
  const frames = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  // opts.shrink: pixels of white margin on every edge, for a frame mount that covers the
  // panel's outer pixels. The layout is drawn at full size, then scaled down by the browser
  // (so text is rasterised at the smaller size, not blurred) and moved in by that margin.
  window.renderFrame = async function (layout, data, opts) {
    await Promise.all(FONT_FACES.map(f => document.fonts.load(f)));
    const root = document.getElementById("root");
    const n = Math.max(0, Math.min(20, Math.floor((opts && opts.shrink) || 0)));
    root.style.transformOrigin = "0 0";
    root.style.transform = n ? `translate(${n}px, ${n}px) scale(${(800 - 2 * n) / 800}, ${(480 - 2 * n) / 480})` : "";
    window.SurfFrame.renderLayout(root, layout, data);
    await document.fonts.ready;
    await frames();
    return true;
  };
})();
