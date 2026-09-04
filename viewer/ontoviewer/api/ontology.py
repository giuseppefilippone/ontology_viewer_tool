"""GET/POST API: ontology header & metrics, workspace open/remove, UI config, index status/rebuild, uploads.

Routes (see ``ontoviewer.api`` and ``ontoviewer.http``):
    GET  /api/overview          → api_overview (wrapped in a lambda: takes no argument)
    GET  /api/ontology          → api_ontology
    GET  /api/workspace         → api_workspace
    POST /api/workspace/open    → ws_open
    POST /api/workspace/remove  → ws_remove
    GET  /api/ui_config         → api_ui_config
    POST /api/ui_config         → ui_config_save
    GET  /api/index_status      → api_index_status
    POST /api/reindex           → api_reindex (called directly by ``ontoviewer.http``)
    GET  /api/pick_file         → api_pick_file
    POST /api/upload            → handle_upload (multipart, called directly by ``ontoviewer.http``)
    GET  /api/changes           → api_changes
    GET  /api/graph_of          → api_graph_of

Module state: ``REBUILD`` holds the handle of the background ``indexer.py`` subprocess started by
this server (there is at most one), ``ONTOLOGY_CACHE`` memoises the /api/ontology payload.
"""

import json
import pathlib
import re
import shutil
import sqlite3
import subprocess
import sys
import cgi

from ontoviewer import config, editor, indexer, store, workspace
from ontoviewer.store import db, short

REBUILD = {"proc": None}  # background index build (subprocess handle)
ONTOLOGY_CACHE = {}  # /api/ontology payload cached per index mtime


def api_overview():
    """Counts for the landing page: entities per kind, statements, module files.

    Takes no parameter.  Returns {"kinds": {kind: n}, "statements": n, "modules": [file…]} or
    {"empty": True} when the index has no tables yet (first start, build still running).
    """
    try:
        kinds = dict(db().execute("SELECT kind, COUNT(*) FROM nodes WHERE kind IS NOT NULL GROUP BY kind").fetchall())
        n_stmt = db().execute("SELECT COUNT(*) FROM stmt").fetchone()[0]
        graphs = [g for (g,) in db().execute("SELECT DISTINCT graph FROM stmt").fetchall()]
        return {"kinds": kinds, "statements": n_stmt, "modules": graphs}
    except sqlite3.OperationalError:
        return {"empty": True}


def api_ontology(q):
    """OWL API-style 'Active ontology' data: modules, imports, annotations, metrics.

    No query parameters.  The payload is cached in ``ONTOLOGY_CACHE`` keyed by the index mtime
    (a rebuild or a save invalidates it; workspace switches clear it explicitly).

    Returns {"ontologies": [{"iri", "file", "imports": [iri…], "annotations": [{"pred", "piri",
    "value"}…]}…], "metrics": {file: {metric name: value}}, "per_module": [{"file",
    "statements"}…], "prefixes": {file: [(prefix, namespace)…]}} — ``metrics`` are the
    OWL API-style counts computed at index time (``indexer.compute_metrics``).
    """
    if ONTOLOGY_CACHE.get("db_mtime") == store.DB.stat().st_mtime:
        return ONTOLOGY_CACHE["data"]
    c = db()
    onts = []
    for r in c.execute("SELECT * FROM nodes WHERE kind='ontology' ORDER BY iri").fetchall():
        imports, notes, version = [], [], None
        # header statements of the owl:Ontology node: owl:imports targets on one side, literal
        # annotations (versionInfo, comment…) on the other; other IRI objects are ignored
        for row in c.execute(
            """SELECT p.iri AS piri, n.iri AS oiri, s.o_lit FROM stmt s
                   JOIN nodes p ON p.id=s.p LEFT JOIN nodes n ON n.id=s.o_id
                   WHERE s.s=?""",
            (r["id"],),
        ).fetchall():
            pname = short(row["piri"])
            if pname == "imports":
                imports.append(row["oiri"])
            elif pname == "versionIRI":
                version = row["oiri"]  # owl:versionIRI (at most one)
            elif row["o_lit"] is not None:
                notes.append({"pred": pname, "piri": row["piri"], "value": row["o_lit"]})
        # the file of an ontology node = the module holding its header statements
        graph = c.execute("SELECT graph FROM stmt WHERE s=? LIMIT 1", (r["id"],)).fetchone()
        onts.append(
            {
                "iri": r["iri"],
                "file": graph["graph"] if graph else None,
                "imports": imports,
                "annotations": notes,
                "version": version,
            }
        )
    metrics = {}  # file -> {metric name: value}, computed at index time (OWL API style)
    for g, name, value in c.execute("SELECT graph, name, value FROM metrics").fetchall():
        metrics.setdefault(g, {})[name] = value
    per_module = [
        {"file": g, "statements": n}
        for g, n in c.execute("SELECT graph, COUNT(*) FROM stmt GROUP BY graph ORDER BY graph").fetchall()
    ]
    # namespace prefixes from each file's RDF/XML header (OWL API "Ontology prefixes"): the xmlns
    # attributes found before the <owl:Ontology element, i.e. on <?xml/<!DOCTYPE/<rdf:RDF only
    prefixes = {}
    for o in onts:
        if not o["file"]:
            continue
        head = (indexer.ONT_DIR / o["file"]).read_text(errors="replace")[:16000]
        head = head.split("<owl:Ontology", 1)[0]
        prefixes[o["file"]] = sorted(
            [(m.group(1) or "", m.group(2)) for m in re.finditer(r'xmlns(?::([\w.-]+))?="([^"]+)"', head)]
        )
    data = {"ontologies": onts, "metrics": metrics, "per_module": per_module, "prefixes": prefixes}
    ONTOLOGY_CACHE.update({"db_mtime": store.DB.stat().st_mtime, "data": data})
    return data


def api_workspace(q):
    """Current workspace and the recently opened ones.

    No query parameters.  Returns {"current": {"dir", "files"}, "recent": [{"dir", "files"}…],
    "db_exists": bool} (``db_exists``: an index for the current workspace is on disk).
    """
    ws = workspace.load()
    return {"current": ws, "recent": workspace.load_recent(), "db_exists": store.DB.exists()}


def ws_open(c, p):
    """Open another ontology (entry file path(s)); resolve its import closure and
    build its index on the fly if not cached.

    Payload: "paths": [file path…] or "path": a single file path (the directory of the first one
    is the workspace directory; imports are resolved through its catalog-v001.xml and headers).
    Raises FileNotFoundError (→ HTTP 400) for a missing path.  ``c`` — a connection to the index
    of the workspace being left — is not used.

    Side effects: data/workspace.json and data/recent.json rewritten, ``indexer`` globals
    refreshed, ``ONTOLOGY_CACHE`` cleared, a background index build started when the new
    workspace has no index yet.

    Returns {"workspace": {"dir", "files"}, "unresolved_imports": [iri…], "index_exists": bool,
    "reindex_started": bool}.
    """
    paths = p.get("paths") or [p["path"]]
    ws, unresolved = workspace.resolve(paths)
    workspace.save(ws)
    indexer.refresh()
    ONTOLOGY_CACHE.clear()
    started = False
    if not store.DB.exists():
        started = api_reindex().get("started", False)
    return {
        "workspace": ws,
        "unresolved_imports": unresolved,
        "index_exists": store.DB.exists(),
        "reindex_started": started,
    }


def ws_remove(c, p):
    """Drop one module from the workspace AND from its index without rebuilding: the
    module's rows are deleted, orphan nodes pruned, and the index file renamed to the
    key of the reduced workspace. The .owl file itself is untouched.

    Payload: "file": module file name.  Raises ValueError (→ HTTP 400) when the file is not in
    the workspace, when it is the only module, or while an index build is running.  ``c`` is
    None (``NO_CONNECTION``): the index is edited through a dedicated connection here.

    Side effects: rows of the module deleted from stmt/metrics/axiom_ann/bnode_refs, orphan
    nodes pruned, index file and its .axioms.json TBox cache renamed to the new workspace key,
    data/workspace.json rewritten, ``indexer`` globals refreshed, ``ONTOLOGY_CACHE`` and
    ``store.FUZZY_CACHE`` cleared.

    Returns {"workspace": {"dir", "files"}, "removed": file}.
    """
    fname = p["file"]
    ws = workspace.load()
    if fname not in ws["files"]:
        raise ValueError(f"{fname} is not part of the current workspace")
    if len(ws["files"]) == 1:
        raise ValueError("cannot remove the only module of the workspace")
    if indexer.build_running():
        raise ValueError("an index build is running: retry when it has finished")
    old_db = workspace.db_path(ws)
    new_ws = {"dir": ws["dir"], "files": [f for f in ws["files"] if f != fname]}
    new_db = workspace.db_path(new_ws)
    if old_db.exists():
        con = sqlite3.connect(old_db)
        for t in ("stmt", "metrics", "axiom_ann", "bnode_refs"):
            con.execute(f"DELETE FROM {t} WHERE graph=?", (fname,))
        # prune orphan nodes: no longer subject, predicate or object of any statement
        con.execute(
            """DELETE FROM nodes WHERE id NOT IN (SELECT s FROM stmt) AND id NOT IN (SELECT p FROM stmt)
                       AND id NOT IN (SELECT o_id FROM stmt WHERE o_id IS NOT NULL)"""
        )
        con.commit()
        con.close()
        # the index file is named after the workspace key (dir + files): move it, together with
        # the TBox disk cache, so that the reduced workspace finds it without a rebuild
        new_db.unlink(missing_ok=True)
        old_db.replace(new_db)
        cache = old_db.with_suffix(".axioms.json")
        if cache.exists():
            cache.replace(new_db.with_suffix(".axioms.json"))
    workspace.save(new_ws)
    indexer.refresh()
    ONTOLOGY_CACHE.clear()
    store.FUZZY_CACHE.clear()
    return {"workspace": new_ws, "removed": fname}


def api_ui_config(q):
    """Persisted UI preferences (tab order, sidebar width, flags) from data/ui_config.json.

    No query parameters.  Returns the stored JSON object, or {} when the file is missing or
    unreadable.
    """
    try:
        return json.load(open(config.UI_CONFIG)) if config.UI_CONFIG.exists() else {}
    except Exception:
        return {}


def ui_config_save(c, p):
    """Merge the allowed keys of the payload into data/ui_config.json.

    Payload keys taken into account: tab_order, entity_tab_order, count_annotations,
    sidebar_width, byclass_width, ent_tab ({entity kind: active tab of the entity view}); anything
    else is ignored.  ``c`` is None (``NO_CONNECTION``).
    Side effect: the file is rewritten.  Returns the complete configuration after the merge.
    """
    cfg = api_ui_config({})
    cfg.update(
        {
            k: v
            for k, v in p.items()
            if k in ("tab_order", "entity_tab_order", "count_annotations", "sidebar_width", "byclass_width", "ent_tab")
        }
    )
    json.dump(cfg, open(config.UI_CONFIG, "w"), indent=1)
    return cfg


def api_index_status(q):
    """State of the index of the current workspace, polled by the status bar.

    No query parameters.  Returns {"exists": bool, "stale": bool (a module file is newer than the
    index), "running": bool, "failed": bool (the last build started by this server exited with
    an error), "files": [{"name", "newer": bool}…], "log": last 2000 characters of
    data/build_index.log}.
    """
    indexer.refresh()
    p = REBUILD["proc"]
    # a build may also have been started outside this server (indexer.py CLI, previous server
    # instance): the file lock catches those, the Popen handle only ours
    running = (p is not None and p.poll() is None) or indexer.build_running()
    files = []
    db_t = store.DB.stat().st_mtime if store.DB.exists() else 0
    for f in indexer.FILES:
        fp = indexer.ONT_DIR / f
        if fp.exists():
            files.append({"name": f, "newer": fp.stat().st_mtime > db_t})
    log = config.BUILD_LOG.read_text(errors="replace")[-2000:] if config.BUILD_LOG.exists() else ""
    return {
        "exists": store.DB.exists(),
        "stale": indexer.stale(),
        "running": running,
        "failed": p is not None and not running and p.returncode != 0,
        "files": files,
        "log": log,
    }


def api_reindex():
    """Start ``indexer.py --force`` as a background subprocess (also used by ``ontoviewer.http``
    at start-up and after a save).

    Takes no parameter.  Side effects: the subprocess handle is stored in ``REBUILD["proc"]``;
    its stdout/stderr go to data/build_index.log (truncated at each start).  The subprocess
    writes the new index next to the old one and swaps it in when finished.

    Returns {"started": True} or {"started": False, "reason": "already running"}.
    """
    p = REBUILD["proc"]
    if (p is not None and p.poll() is None) or indexer.build_running():
        return {"started": False, "reason": "already running"}
    REBUILD["proc"] = subprocess.Popen(
        [sys.executable, "-u", "indexer.py", "--force"],
        cwd=config.VIEWER_DIR,
        stdout=open(config.BUILD_LOG, "w"),
        stderr=subprocess.STDOUT,
    )
    return {"started": True}


def api_pick_file(q):
    """Native macOS file dialog (the app runs locally): returns the chosen path, no upload.

    No query parameters.  Blocks the request for up to 300 s while the ``osascript`` dialog is
    open.  Returns {"path": str}, {"cancelled": True} when the dialog is dismissed, or
    {"error": …} on other platforms / on timeout.
    """
    if sys.platform != "darwin":
        return {"error": "system file dialog available only on macOS: paste the path instead"}
    script = (
        'POSIX path of (choose file with prompt "Choose the main .owl file" '
        'of type {"owl","rdf","xml","ttl","public.xml","public.data"})'
    )
    try:
        r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=300)
    except subprocess.TimeoutExpired:
        return {"error": "timeout"}
    if r.returncode != 0:
        return {"cancelled": True}
    return {"path": r.stdout.strip()}


def handle_upload(handler):
    """Classic browser upload (multipart) → saved under viewer/uploads/, then opened.

    ``handler`` is the ``BaseHTTPRequestHandler`` of the request: the multipart body is read
    here with ``cgi.FieldStorage`` (field name "file", one or more files), not by
    ``ontoviewer.http``.  Side effects: every uploaded file is written to data/uploads/ under
    its base name (overwriting), then ``ws_open`` is called on the first one — imports are
    resolved among the files of that directory, so upload the whole closure together.

    Returns the ``ws_open`` result, or {"error": "no file"} when the form carried no file.
    """
    env = {"REQUEST_METHOD": "POST", "CONTENT_TYPE": handler.headers.get("Content-Type", "")}
    form = cgi.FieldStorage(fp=handler.rfile, headers=handler.headers, environ=env)
    items = form["file"] if "file" in form else []
    items = items if isinstance(items, list) else [items]
    updir = config.UPLOADS_DIR
    updir.mkdir(exist_ok=True)
    saved = []
    for it in items:
        if not getattr(it, "filename", None):
            continue
        dest = updir / pathlib.Path(it.filename).name
        with open(dest, "wb") as f:
            shutil.copyfileobj(it.file, f)
        saved.append(dest)
    if not saved:
        return {"error": "no file"}
    return ws_open(None, {"paths": [str(saved[0])]})


def api_changes(q):
    """Pending (unsaved) edits of the journal, shown in the "changes" bar.

    No query parameters.  Returns {"changes": [row of the ``changes`` table as a dict…]} in
    insertion order (``editor.connect`` creates the table when missing).
    """
    c = editor.connect()
    try:
        return {"changes": editor.list_changes(c)}
    finally:
        c.close()


def api_graph_of(q):
    """Module file declaring an entity — where a new triple about it will be written by default.

    Query parameters:
        iri  entity IRI (default '')

    Returns {"graph": file name, or None when the entity is unknown}.
    """
    c = editor.connect()
    try:
        return {"graph": editor.declaring_graph(c, q.get("iri", [""])[0])}
    finally:
        c.close()


def api_ontology_iri(q):
    """Ontology IRI declared in the header of a local .owl file (import wizard, "local file" option).

    Query parameters: path (absolute path).  Returns {"iri", "file", "same_dir": the file lives in
    the workspace folder (so the import will resolve without a catalog entry)} or {"error": …}.
    """
    path = pathlib.Path(q.get("path", [""])[0]).expanduser()
    if not path.is_file():
        return {"error": f"file not found: {path}"}
    iri = workspace._ontology_iri(path)
    if not iri:
        return {"error": "no <owl:Ontology rdf:about=…> header found in the file"}
    return {"iri": iri, "file": path.name, "same_dir": path.resolve().parent == workspace.ont_dir().resolve()}
