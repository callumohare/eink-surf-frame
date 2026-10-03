"""Local studio for designing layouts on your laptop (no cloud needed).

    python -m pipeline.main --sample --out out      # once, to create data + renders
    python -m pipeline.devserver --out out          # then open http://127.0.0.1:8787

Implements the same /api/* as the Cloudflare studio Worker, backed by the
local `out/` folder. Binds to 127.0.0.1 only and has no authentication, so
don't expose it. "Render now" runs the pipeline locally (add --sample to use
synthetic data).
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import re
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from .frames import clean_settings
from .storage import LocalStorage
from .validate import ID_RE, Invalid, validate_layout

WEB = Path(__file__).resolve().parent.parent / "web"
RENDER_FILE_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}(-thumb|-grey)?\.(png|bmp)$")
CSP = ("default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; "
       "img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")


def make_handler(store: LocalStorage, out: str, sample: bool):
    render_lock = threading.Lock()

    class H(BaseHTTPRequestHandler):
        server_version = "surf-frame-dev"

        def log_message(self, fmt, *args):  # quieter
            sys.stderr.write("dev: " + fmt % args + "\n")

        # -- helpers
        def _send(self, code, body=b"", ctype="application/json", extra=None):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", CSP)
            self.send_header("Referrer-Policy", "no-referrer")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _json(self, code, obj):
            self._send(code, json.dumps(obj).encode())

        def _body(self):
            n = int(self.headers.get("Content-Length") or 0)
            if n > 64_000:
                raise Invalid("body too large")
            if "application/json" not in (self.headers.get("Content-Type") or ""):
                raise Invalid("expected JSON")
            return json.loads(self.rfile.read(n) or b"null")

        def _same_origin(self):
            o = self.headers.get("Origin")
            return o is None or o == f"http://{self.headers.get('Host')}"

        # -- routes
        def do_GET(self):
            path = urlparse(self.path).path
            if path.startswith("/api/"):
                return self._api_get(path[5:])
            rel = "studio.html" if path in ("/", "") else path.lstrip("/")
            p = (WEB / rel).resolve()
            if WEB not in p.parents or not p.is_file():
                return self._send(404, b"not found", "text/plain")
            ctype = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
            if p.suffix == ".woff2":
                ctype = "font/woff2"
            self._send(200, p.read_bytes(), ctype)

        do_HEAD = do_GET

        def _api_get(self, route):
            if route == "state":
                layouts = []
                for k in store.list("layouts/"):
                    if k.endswith(".json"):
                        lid = k.split("/")[-1][:-5]
                        try:
                            layouts.append({"id": lid, "name": json.loads(store.get(k)).get("name", lid)})
                        except ValueError:
                            continue
                sel = json.loads(store.get("state/selected.json") or b"{}").get("layout")
                renders = json.loads(store.get("renders/index.json") or b"{}")
                settings = clean_settings(json.loads(store.get("state/frame-settings.json") or b"{}"))
                return self._json(200, {"selected": sel, "layouts": layouts, "renders": renders, "render_now": True,
                                        "frame": "main", "frames": [{"id": "main", "name": "My frame (local)"}],
                                        "admin": False, "hidden_widgets": [], "settings": settings})
            if route == "settings":
                return self._json(200, clean_settings(json.loads(store.get("state/frame-settings.json") or b"{}")))
            if route == "data":
                d = store.get("data/data.json")
                return self._send(200, d, "application/json") if d else self._json(404, {"error": "no data yet"})
            if route.startswith("layouts/"):
                lid = route[8:]
                if not ID_RE.match(lid):
                    return self._json(400, {"error": "bad id"})
                d = store.get(f"layouts/{lid}.json")
                return self._send(200, d) if d else self._json(404, {"error": "not found"})
            if route.startswith("renders/"):
                f = route[8:]
                if not RENDER_FILE_RE.match(f):
                    return self._json(400, {"error": "bad file"})
                d = store.get(f"renders/{f}")
                if not d:
                    return self._json(404, {"error": "not found"})
                return self._send(200, d, "image/png" if f.endswith(".png") else "image/bmp")
            return self._json(404, {"error": "unknown route"})

        def do_PUT(self):
            path = urlparse(self.path).path
            if not self._same_origin():
                return self._json(403, {"error": "bad origin"})
            if path == "/api/settings":
                try:
                    body = self._body()
                except (Invalid, ValueError) as e:
                    return self._json(400, {"error": str(e)})
                s = (body or {}).get("shrink_px", 0)
                if not isinstance(s, int) or isinstance(s, bool) or not 0 <= s <= 20:
                    return self._json(400, {"error": "edge margin must be a whole number from 0 to 20"})
                clean = clean_settings(body)
                store.put("state/frame-settings.json", json.dumps(clean).encode(), "application/json")
                return self._json(200, {"ok": True, "settings": clean})
            if not path.startswith("/api/layouts/"):
                return self._json(404, {"error": "unknown route"})
            lid = path[len("/api/layouts/"):]
            try:
                clean = validate_layout(lid, self._body())
            except (Invalid, ValueError) as e:
                return self._json(400, {"error": str(e)})
            store.put(f"layouts/{lid}.json", json.dumps(clean, indent=2).encode(), "application/json")
            self._json(200, {"ok": True})

        def do_DELETE(self):
            path = urlparse(self.path).path
            if not self._same_origin():
                return self._json(403, {"error": "bad origin"})
            lid = path[len("/api/layouts/"):] if path.startswith("/api/layouts/") else ""
            if not ID_RE.match(lid):
                return self._json(400, {"error": "bad id"})
            sel = json.loads(store.get("state/selected.json") or b"{}").get("layout")
            if lid == sel:
                return self._json(409, {"error": "that layout is on the frame — choose another first"})
            p = store.root / "layouts" / f"{lid}.json"
            if p.exists():
                p.unlink()
            for suffix in (".png", ".bmp", "-grey.png", "-thumb.png"):
                q = store.root / "renders" / f"{lid}{suffix}"
                if q.exists():
                    q.unlink()
            self._json(200, {"ok": True})

        def do_POST(self):
            path = urlparse(self.path).path
            if not self._same_origin():
                return self._json(403, {"error": "bad origin"})
            try:
                body = self._body()
            except (Invalid, ValueError) as e:
                return self._json(400, {"error": str(e)})
            if path == "/api/select":
                lid = (body or {}).get("layout", "")
                if not ID_RE.match(lid) or store.get(f"layouts/{lid}.json") is None:
                    return self._json(400, {"error": "unknown layout"})
                store.put("state/selected.json", json.dumps({"layout": lid}).encode(), "application/json")
                return self._json(200, {"ok": True})
            if path == "/api/render-now":
                if not render_lock.acquire(blocking=False):
                    return self._json(409, {"error": "a render is already running"})

                def run():
                    try:
                        cmd = [sys.executable, "-m", "pipeline.main", "--storage", "local", "--out", out]
                        if sample:
                            cmd.append("--sample")
                        subprocess.run(cmd, cwd=WEB.parent, check=False)
                    finally:
                        render_lock.release()
                threading.Thread(target=run, daemon=True).start()
                return self._json(202, {"ok": True})
            return self._json(404, {"error": "unknown route"})

    return H


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="out")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--sample", action="store_true", help="'Render now' uses synthetic data")
    a = ap.parse_args()
    store = LocalStorage(a.out)
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), make_handler(store, a.out, a.sample))
    print(f"Surf Frame studio on http://127.0.0.1:{a.port}  (Ctrl+C to stop)")
    srv.serve_forever()


if __name__ == "__main__":
    main()
