"""Render layouts to e-ink images with headless Chromium.

The same web/render-core.js draws the widgets here and in the studio editor,
so what you see while editing is what the frame gets. Chromium's anti-aliased
output is then quantised with Pillow to 1-bit or 4 greys. 4-grey pictures are saved as
2-bit greyscale PNGs: the TRMNL firmware draws 2-bit PNGs in its 4-grey mode (and 1-bit
PNGs in black and white with a faster partial refresh).
"""
from __future__ import annotations

import io
import json
import struct
import zlib
from pathlib import Path

from PIL import Image

WEB = Path(__file__).resolve().parent.parent / "web"
ORIGIN = "https://frame.render.invalid"
W, H = 800, 480


def quantise(img: Image.Image, mode: str, threshold: int, invert: bool = False) -> Image.Image:
    g = img.convert("L")
    if invert:
        g = g.point(lambda v: 255 - v)
    if mode == "4grey":
        return g.point(lambda v: min((0, 85, 170, 255), key=lambda L: abs(L - v)))
    return g.point(lambda v: 255 if v >= threshold else 0).convert("1", dither=Image.Dither.NONE)


def _png(img: Image.Image) -> bytes:
    b = io.BytesIO()
    img.save(b, "PNG", optimize=True)
    return b.getvalue()


def _png_grey2(img: Image.Image) -> bytes:
    """4-level "L" image -> 2-bit greyscale PNG (bit depth 2, colour type 0).
    Pillow can't write 2-bit greyscale, so the chunks are built here. 0 = black, 3 = white."""
    g = img.convert("L")
    w, h = g.size
    px = g.tobytes()
    lut = bytes(min(3, (v + 42) // 85) for v in range(256))  # 0/85/170/255 -> 0/1/2/3
    q = px.translate(lut)
    rows = bytearray()
    for y in range(h):
        rows.append(0)  # filter: none (zlib does the work on flat e-ink art)
        r = q[y * w:(y + 1) * w] + b"\x00" * (-w % 4)
        rows += bytes((r[i] << 6) | (r[i + 1] << 4) | (r[i + 2] << 2) | r[i + 3] for i in range(0, len(r), 4))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 2, 0, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b""))


def _bmp(img: Image.Image) -> bytes:
    b = io.BytesIO()
    img.convert("1").save(b, "BMP")
    return b.getvalue()


class Renderer:
    def __init__(self, strict: bool = False):
        self.strict = strict
        from playwright.sync_api import sync_playwright
        self._pw = sync_playwright().start()
        # No network needed: fonts are self-hosted in web/fonts and data is injected.
        self._browser = self._pw.chromium.launch(args=["--font-render-hinting=none"])
        self._ctx = self._browser.new_context(viewport={"width": W, "height": H},
                                              device_scale_factor=1)
        # Serve web/ from a fake origin and refuse every other request, so the
        # render never touches the network (fonts are self-hosted in web/fonts).
        self._ctx.route("**/*", self._serve)
        self._page = self._ctx.new_page()
        self._errors: list[str] = []
        self._page.on("pageerror", lambda e: self._errors.append(str(e)))
        # Widget errors are caught inside the page (the widget shows "Widget error");
        # in strict mode they fail the render so a broken change never ships.
        self._page.on("console", lambda m: self._errors.append("widget: " + m.text)
                      if self.strict and m.type == "error" else None)
        self._page.goto(f"{ORIGIN}/frame.html")

    @staticmethod
    def _serve(route):
        url = route.request.url
        if not url.startswith(ORIGIN + "/"):
            return route.abort()
        rel = url[len(ORIGIN) + 1:].split("?")[0]
        p = (WEB / rel).resolve()
        if WEB not in p.parents or not p.is_file():
            return route.fulfill(status=404, body="")
        ctype = {".html": "text/html", ".js": "text/javascript", ".css": "text/css",
                 ".woff2": "font/woff2"}.get(p.suffix, "application/octet-stream")
        route.fulfill(status=200, body=p.read_bytes(), headers={"content-type": ctype})

    def render(self, layout: dict, data: dict, default_threshold: int = 160, shrink: int = 0) -> dict[str, bytes]:
        """shrink: pixels of white margin on every edge (for a tight mount). The whole
        picture is drawn smaller by the browser — text and lines stay sharp — rather than
        resizing the finished image."""
        self._errors.clear()
        shrink = max(0, min(20, int(shrink or 0)))
        self._page.evaluate("([l, d, o]) => window.renderFrame(l, d, o)", [layout, data, {"shrink": shrink}])
        if self._errors:
            raise RuntimeError("render error: " + "; ".join(self._errors))
        shot = self._page.screenshot(clip={"x": 0, "y": 0, "width": W, "height": H}, type="png")
        raw = Image.open(io.BytesIO(shot))
        thr = int(layout.get("threshold") or default_threshold)
        inv = False  # layout.invert is applied by the page itself (CSS), don't flip twice
        one = quantise(raw, "1bit", thr, inv)
        grey = quantise(raw, "4grey", thr, inv)
        primary = grey if layout.get("mode") == "4grey" else one
        thumb = grey.resize((400, 240), Image.Resampling.LANCZOS)
        grey2 = _png_grey2(grey)
        return {"png": grey2 if primary is grey else _png(one), "bmp": _bmp(one), "grey": grey2,
                "thumb": _png(thumb)}

    def close(self):
        self._browser.close()
        self._pw.stop()


if __name__ == "__main__":  # quick manual test: python -m pipeline.render layout.json data.json out.png
    import sys
    r = Renderer()
    out = r.render(json.loads(Path(sys.argv[1]).read_text()), json.loads(Path(sys.argv[2]).read_text()))
    Path(sys.argv[3]).write_bytes(out["png"])
    r.close()
