"""Plugin manager: front-end plugins (JS / CSS / assets) installed from a zip.

A plugin is a directory under ``data/plugins/<name>/`` carrying a ``plugin.json`` manifest:

    {"name": "my-plugin", "version": "1.0", "description": "…",
     "js": ["my_views.js"], "css": ["my.css"]}

The listed files are injected into the page at start-up (main.js) after the core bundle, so
they can use every global helper and the ``registerView()`` hook; other files of the package
(images, data) are served under ``/plugins/<name>/…``.  See PLUGINS.md for the format.

Routes (see ``ontoviewer.api`` and ``ontoviewer.http``):
    GET  /api/plugins          → plugin_list
    POST /api/plugins/install  → handle_install (multipart zip, read directly by ``http.py``)
    POST /api/plugins/remove   → plugin_remove
"""

import cgi
import io
import json
import pathlib
import re
import shutil
import zipfile

from ontoviewer import config

# installed (custom) plugins live NEXT to the built-in ones: viewer/plugins/custom/<name>/
# (viewer/plugins/builtin/<id>/ ships with the repo; custom/ is git-ignored, per user)
PLUGINS_DIR = config.VIEWER_DIR / "plugins" / "custom"
BUILTIN_DIR = config.VIEWER_DIR / "plugins" / "builtin"
_legacy = config.DATA_DIR / "plugins"
if _legacy.is_dir() and any(_legacy.iterdir()):  # one-off migration from the old location
    PLUGINS_DIR.mkdir(parents=True, exist_ok=True)
    for _d in _legacy.iterdir():
        if _d.is_dir() and not (PLUGINS_DIR / _d.name).exists():
            shutil.move(str(_d), PLUGINS_DIR / _d.name)


# canonical order of the built-in views = default tab order (extra folders are appended)
BUILTIN_ORDER = ["ontology", "entities", "reasoner", "fuzzy", "axioms", "fdl", "graph", "byclass", "kg", "dlquery", "sparql", "rules", "help"]


def _entry(d, mf):
    """One plugin/package entry for the loader: js (readable) and js_min (when built)."""
    js = mf.get("js", [])
    js_min = []
    for f in js:
        m = d / (pathlib.Path(f).stem + ".min.js")
        js_min.append(m.name if m.is_file() else f)
    return {
        "name": d.name,
        "title": mf.get("title", d.name),
        "version": str(mf.get("version", "")),
        "description": mf.get("description", ""),
        "js": js,
        "js_min": js_min,
        "css": mf.get("css", []),
    }


def _scan(base, order=None):
    dirs = [d for d in base.iterdir() if d.is_dir() and (d / "plugin.json").is_file()] if base.is_dir() else []
    if order:
        rank = {n: i for i, n in enumerate(order)}
        dirs.sort(key=lambda d: (rank.get(d.name, len(order)), d.name))
    else:
        dirs.sort()
    out = []
    for d in dirs:
        try:
            out.append(_entry(d, json.load(open(d / "plugin.json"))))
        except Exception:
            continue
    return out


def plugin_list(q):
    """Every view package: the built-ins (plugins/builtin/, canonical order — DELETING a folder
    removes that view entirely; re-download it from the GitHub repository to restore it) and the
    installed plugins (plugins/custom/).  main.js loads them in this order, minified builds
    unless ?dev=1.  Returns {"builtin": […], "plugins": […]} with entries {"name", "title",
    "version", "description", "js", "js_min", "css"}.
    """
    return {"builtin": _scan(BUILTIN_DIR, BUILTIN_ORDER), "plugins": _scan(PLUGINS_DIR)}


def plugin_remove(c, p):
    """Uninstall one plugin: its directory is deleted — plugins/custom/<name>/ or, with
    "builtin": true, plugins/builtin/<name>/ (a deleted built-in view can be restored by
    re-downloading its folder from the GitHub repository).

    Payload: "name", optional "builtin".  ``c`` is None.  Raises FileNotFoundError when not installed.
    Returns {"removed": name}.
    """
    name = p["name"]
    if not re.fullmatch(r"[\w.-]+", name):
        raise ValueError("bad plugin name")
    d = (BUILTIN_DIR if p.get("builtin") else PLUGINS_DIR) / name
    if not (d.is_dir() and (d / "plugin.json").is_file()):
        raise FileNotFoundError(f"plugin {name} is not installed")
    shutil.rmtree(d)
    return {"removed": name, "builtin": bool(p.get("builtin"))}


def handle_install(handler):
    """Install a plugin from an uploaded zip (multipart field "file", read here like
    ``ontology.handle_upload``).

    The zip must carry ``plugin.json`` at its root (or inside a single top-level folder);
    the manifest's ``name`` names the target directory — reinstalling replaces it.  Every
    member is extracted under that directory with a zip-slip guard.
    Returns {"installed", "version", "js"} or raises (→ {"error"}).
    """
    env = {"REQUEST_METHOD": "POST", "CONTENT_TYPE": handler.headers.get("Content-Type", "")}
    form = cgi.FieldStorage(fp=handler.rfile, headers=handler.headers, environ=env)
    if "file" not in form or not getattr(form["file"], "filename", None):
        raise ValueError("no file")
    z = zipfile.ZipFile(io.BytesIO(form["file"].file.read()))
    names = z.namelist()
    mpath = next((n for n in names if n.endswith("plugin.json") and n.count("/") <= 1), None)
    if not mpath:
        raise ValueError("plugin.json not found at the root of the zip")
    prefix = mpath[: -len("plugin.json")]
    mf = json.loads(z.read(mpath).decode("utf-8"))
    name = mf.get("name") or mf.get("id") or ""  # "id" = the manifest key of PLUGIN_ARCHITECTURE_PLAN.md
    if not re.fullmatch(r"[\w.-]+", name):
        raise ValueError('plugin.json must carry a "name" of letters, digits, _ . -')
    dest = PLUGINS_DIR / name
    if dest.exists():
        shutil.rmtree(dest)  # reinstall = replace
    dest.mkdir(parents=True)
    for n in names:
        if not n.startswith(prefix) or n.endswith("/"):
            continue
        t = dest / n[len(prefix) :]
        if dest.resolve() not in t.resolve().parents:  # zip-slip guard
            raise ValueError("bad path in the zip: " + n)
        t.parent.mkdir(parents=True, exist_ok=True)
        t.write_bytes(z.read(n))
    # validate + minify the declared scripts (readable sources kept for ?dev=1 / debugging);
    # a missing file or a JavaScript syntax error rejects the install with a clear message
    import subprocess as _sp

    from ontoviewer import bundle as _bundle

    for f in mf.get("js", []):
        src = dest / f
        if not src.is_file():
            shutil.rmtree(dest)
            raise ValueError(f'plugin.json lists "{f}" but the zip does not contain it')
        try:
            _bundle.minify_file(src, dest / (pathlib.Path(f).stem + ".min.js"))
        except _sp.CalledProcessError as e:
            shutil.rmtree(dest)
            err = (e.stderr or b"").decode(errors="replace").strip().splitlines()
            raise ValueError(f'"{f}" has a JavaScript syntax error: {err[0] if err else "see terser"}')
    return {"installed": name, "version": str(mf.get("version", "")), "js": mf.get("js", [])}
