"""HTTP layer of the viewer: static front-end files, JSON routing of the GET/POST API,
file downloads and PDF responses.

GET  /, /index.html        → static/index.html
GET  /static/<path>        → static files (css, js)
GET  /api/export_file      → streamed download of a generated export (.fdl)
GET  /api/<route>          → ``ontoviewer.api.GET_ROUTES`` (query string → JSON)
POST /api/pdf              → LaTeX fragment compiled to PDF
POST /api/upload           → multipart upload of an ontology file
POST /api/reindex          → background rebuild of the index
POST /api/shutdown         → clean stop of the server (used by the header stop button and stop_viewer.sh)
POST /api/<route>          → ``ontoviewer.api.POST_ROUTES`` (JSON payload → JSON)

Entry point: ``serve(port)`` (called by ``server.py``).  The server binds to 127.0.0.1 only
and is threaded (one thread per connection), which is why ``ontoviewer.store`` keeps one
SQLite connection per thread.  Route handlers live in ``ontoviewer.api``; this module only
parses requests, opens/commits the editor connection for writing routes and serialises the
results.
"""

import json
import pathlib
import shutil
import subprocess
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from ontoviewer import api, bundle, config, editor, fdl_export, pdf, store
from ontoviewer.api import ontology

# content types of the static files; anything else is served as octet-stream
MIME = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8"}


def serve(port):
    """Start the local server (127.0.0.1 only), open the browser, block until Ctrl+C.

    If the index of the current workspace does not exist, a background build is launched
    first (``api.ontology.api_reindex``); the UI polls ``/api/index_status`` meanwhile.
    The browser is opened by a timer half a second later, once the server is listening.
    """
    if not store.DB.exists():
        print("index missing: build started in the background (see the bar at the top of the app)")
        ontology.api_reindex()
    try:  # keep static/app.min.js in sync with the readable sources (needs terser: `npm install`)
        if bundle.build():
            print("static/app.min.js rebuilt from static/js/*.js")
    except (FileNotFoundError, subprocess.CalledProcessError) as e:
        print("warning: JS bundle not rebuilt:", e, "(use ?dev=1 to load the readable sources)")
    global _SRV
    srv = _SRV = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    url = f"http://localhost:{port}"
    print("Ontology Viewer:", url, "(Ctrl+C to quit)")
    threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    srv.serve_forever()
    print("Ontology Viewer stopped.")


# the running server, set by serve(): /api/shutdown stops it from a request thread
_SRV = None


class Handler(BaseHTTPRequestHandler):
    """One request = one call of a route function; errors are returned as JSON ``{"error": …}``."""

    def _send(self, code, body, ctype="application/json", extra=None):
        """Write a complete response (status, headers, body).

        ``body`` must be bytes; ``extra`` is an optional dict of additional headers
        (e.g. ``Content-Disposition`` for downloads).
        """
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        """Dispatch a GET: front-end page, static asset, export download or JSON API route.

        API handlers get the parsed query string (``{name: [values]}``) and return a
        JSON-serialisable object.  Unknown paths (and static paths escaping ``static/``)
        get a plain-text 404.
        """
        u = urlparse(self.path)
        store.REQUEST.active = parse_qs(u.query).get("active", [None])[0]  # display names (prefixes)
        if u.path in ("/", "/index.html"):
            page = (config.STATIC_DIR / "index.html").read_text(encoding="utf-8")
            if "dev" in parse_qs(u.query):  # ?dev=1 → the readable sources instead of the minified bundle
                page = page.replace(bundle.script_tags(), bundle.script_tags(dev=True))
            self._send(200, page.encode("utf-8"), MIME[".html"])
        elif u.path.startswith("/static/"):
            f = (config.STATIC_DIR / u.path[len("/static/") :]).resolve()
            # path-traversal guard: the resolved file must be inside static/
            if config.STATIC_DIR.resolve() in f.parents and f.is_file():
                self._send(200, f.read_bytes(), MIME.get(f.suffix, "application/octet-stream"))
            else:
                self._send(404, b"not found", "text/plain")
        elif u.path == "/api/export_file":  # large export files (e.g. .fdl) streamed as a download
            # ?name=<file>: reduced to its basename so only files of the exports dir are reachable
            name = pathlib.Path(parse_qs(u.query).get("name", [""])[0]).name
            f = fdl_export.EXPORTS / name
            if not name or not f.is_file():
                self._send(404, b"not found", "text/plain")
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Disposition", f'attachment; filename="{name}"')
            self.send_header("Content-Length", str(f.stat().st_size))
            self.end_headers()
            with open(f, "rb") as fh:
                shutil.copyfileobj(fh, self.wfile, 1 << 20)  # 1 MB chunks, file never fully in memory
        elif u.path in api.GET_ROUTES:
            try:
                self._send(200, json.dumps(api.GET_ROUTES[u.path](parse_qs(u.query))).encode())
            except Exception as e:  # e.g. index missing or a module file moved: answer instead of dropping the socket
                self._send(500, json.dumps({"error": str(e)}).encode())
        else:
            self._send(404, b"not found", "text/plain")

    def do_POST(self):
        """Dispatch a POST: upload, PDF compilation, reindex or a JSON API route.

        Except for ``/api/upload`` (multipart, read by the handler itself) the body is a JSON
        object.  Routes of ``api.POST_ROUTES`` receive ``(connection, payload)``: the
        connection is an ``editor.connect()`` connection committed on success and always
        closed, or None for the routes listed in ``api.NO_CONNECTION``.  Any exception raised
        by a route is answered with status 400 and ``{"error": message}``.
        """
        path = urlparse(self.path).path
        n = int(self.headers.get("Content-Length") or 0)
        if path == "/api/upload":  # multipart: the handler reads the body itself
            try:
                res = ontology.handle_upload(self)
            except Exception as e:
                res = {"error": str(e)}
            self._send(200, json.dumps(res).encode())
            return
        try:
            payload = json.loads(self.rfile.read(n) or b"{}") if n else {}
            store.REQUEST.active = payload.get("active") if isinstance(payload, dict) else None
        except ValueError as e:  # malformed JSON body → 400 instead of a dropped connection
            self._send(400, json.dumps({"error": f"invalid JSON body: {e}"}).encode())
            return
        if path == "/api/pdf":
            try:
                data, err = pdf.compile_pdf(payload.get("tex") or "")
            except Exception as e:
                data, err = None, str(e)
            if data:
                name = payload.get("name") or "export"
                self._send(200, data, "application/pdf", {"Content-Disposition": f'attachment; filename="{name}.pdf"'})
            else:
                self._send(400, json.dumps({"error": err}).encode())
        elif path == "/api/reindex":
            self._send(200, json.dumps(ontology.api_reindex()).encode())
        elif path == "/api/shutdown":
            # answer first, then stop: shutdown() must run outside the request thread
            self._send(200, json.dumps({"ok": True}).encode())
            if _SRV:
                threading.Thread(target=_SRV.shutdown, daemon=True).start()
        elif path in api.POST_ROUTES:
            try:
                # routes that write to the index get a connection whose commit/close is handled here
                c = editor.connect() if path not in api.NO_CONNECTION else None
                try:
                    res = api.POST_ROUTES[path](c, payload)
                    if c:
                        c.commit()
                finally:
                    if c:
                        c.close()  # closing without commit rolls back a failed edit
                self._send(200, json.dumps(res).encode())
            except Exception as e:  # surfaced to the UI as a message
                self._send(400, json.dumps({"error": str(e)}).encode())
        else:
            self._send(404, b"not found", "text/plain")

    def log_message(self, *a):
        """Silence the default per-request logging."""
