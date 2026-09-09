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
from xml.sax.saxutils import escape

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


# ontology formats other than RDF/XML accepted on open / upload (converted with rdflib)
FOREIGN_EXTS = {".ttl": "turtle", ".n3": "n3", ".nt": "nt", ".jsonld": "json-ld"}


def _ensure_rdfxml(path):
    """Import path for foreign serializations: the editor and the indexer work on RDF/XML files,
    so a Turtle / N3 / N-Triples / JSON-LD ontology is converted (rdflib) to an ``.owl`` sibling,
    which is then opened instead. RDF/XML inputs pass through untouched; the converted file is
    rewritten only when the source is newer. Returns the path to open.
    """
    p = pathlib.Path(path)
    fmt = FOREIGN_EXTS.get(p.suffix.lower())
    if not fmt:
        return str(path)
    import rdflib

    out = p.with_suffix(".owl")
    if not out.exists() or out.stat().st_mtime < p.stat().st_mtime:
        g = rdflib.Graph()
        g.parse(str(p), format=fmt)
        g.serialize(destination=str(out), format="xml")
    return str(out)


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
    if p.get("url"):  # File → Open from URL…: download into uploads/ first
        p = {**p, "path": str(_fetch_ontology(p["url"], config.UPLOADS_DIR))}
    paths = [_ensure_rdfxml(x) for x in (p.get("paths") or [p["path"]])]
    if p.get("add"):  # Open dialog "Add to the current workspace": one shared index (rebuilt)
        cur = workspace.load()
        paths = [str(pathlib.Path(cur["dir"]) / f) for f in cur["files"]] + paths
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

    Payload keys taken into account: tab_order, entity_tab_order, hidden_tabs /
    hidden_entity_tabs (main tabs / Entities sidebar views hidden from the Window menu),
    render_mode (+ legacy render_labels), reasoner_engine, reasoner_timeout, count_annotations,
    sidebar_width, byclass_width, ent_tab ({entity kind: active tab of the entity view});
    anything else is ignored.  ``c`` is None (``NO_CONNECTION``).
    Side effect: the file is rewritten.  Returns the complete configuration after the merge.
    """
    cfg = api_ui_config({})
    cfg.update(
        {
            k: v
            for k, v in p.items()
            if k
            in (
                "tab_order",
                "entity_tab_order",
                "hidden_tabs",
                "hidden_entity_tabs",
                "render_labels",
                "render_mode",
                "reasoner_engine",
                "reasoner_timeout",
                "count_annotations",
                "sidebar_width",
                "byclass_width",
                "ent_tab",
            )
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
        [sys.executable, "-u", "-m", "ontoviewer.indexer", "--force"],
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


def module_new(c, p):
    """Create an empty ontology module (RDF/XML skeleton) in the workspace and register it.

    Payload: "name" (file name, .owl appended when missing), optional "iri" (ontology IRI;
    default derived from the file name).  Raises ValueError for a bad name or an existing file.
    ``c`` is None (``NO_CONNECTION``): the file only becomes part of the index at the next
    rebuild (the index-status poller reports the workspace as stale).
    Side effects: the file is written, workspace.json / recent.json updated.
    Returns {"file", "iri"}.
    """
    name = (p.get("name") or "").strip()
    if not name.endswith(".owl"):
        name += ".owl"
    if not re.fullmatch(r"[\w.-]+\.owl", name):
        raise ValueError("file name must contain only letters, digits, _ . - and end in .owl")
    ws = workspace.load()
    f = pathlib.Path(ws["dir"]) / name
    if f.exists():
        raise ValueError(f"{name} already exists in the workspace")
    iri = (p.get("iri") or "").strip() or f"http://www.semanticweb.org/ontologies/{name[:-4]}"
    f.write_text(
        f"""<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns:owl="http://www.w3.org/2002/07/owl#"
         xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#"
         xml:base="{escape(iri)}">
  <owl:Ontology rdf:about="{escape(iri)}"/>
</rdf:RDF>
""",
        encoding="utf-8",
    )
    ws["files"].append(name)
    workspace.save(ws)
    return {"file": name, "iri": iri}


def api_serialize(c, p):
    """Serialize one workspace module with rdflib and stage it for download.

    Payload: "graph" (module file name), "fmt": turtle (default) | xml | nt | n3 | json-ld.
    ``c`` is None.
    Side effect: the full serialization is written to the exports dir (fetch it with
    GET /api/export_file?name=<name>).  Returns {"name", "triples", "text" (capped at 500 kB),
    "truncated"}.
    """
    fmt = p.get("fmt") or "turtle"
    exts = {"turtle": ".ttl", "xml": ".owl", "nt": ".nt", "n3": ".n3", "json-ld": ".jsonld"}
    if fmt not in exts:
        raise ValueError("fmt must be turtle | xml | nt | n3 | json-ld")
    import rdflib

    ws = workspace.load()
    f = pathlib.Path(ws["dir"]) / pathlib.Path(p["graph"]).name
    if not f.is_file():
        raise FileNotFoundError(f"{f.name} not found in the workspace")
    g = rdflib.Graph()
    g.parse(str(f))
    text = g.serialize(format=fmt)
    name = f.stem + exts[fmt]
    (config.EXPORTS_DIR / name).write_text(text, encoding="utf-8")
    cap = 500_000
    return {"name": name, "triples": len(g), "text": text[:cap], "truncated": len(text) > cap}


def api_diff(c, p):
    """Difference list between two ontology files of the workspace (BNode-safe: rdflib
    isomorphic comparison, Protégé's Ontology comparison → Difference list).

    Payload: "a" and "b" (file names of the workspace or of data/compare/; a module's
    ``<file>.bak`` backup written by Save is accepted too), or just "graph" = compare that
    module against its own .bak.  ``c`` is None.  Raises FileNotFoundError for a missing file.

    The differing triples are grouped by subject entity and classified like Protégé's
    Ontology Differences view: "created" (the subject only exists in A), "deleted" (only in
    B), "modified" (in both).  Returns {"a", "b", "b_time" (mtime of b), "counts": {created,
    deleted, modified}, "added_total" / "removed_total" (triples only in A / only in B),
    "entities": [{"name" (prefixed), "iri", "status", "new": [triple…], "baseline":
    [triple…] (N3, first 80 each), "new_total", "baseline_total"}…] (first 400, created →
    deleted → modified, alphabetical), "entities_total"}.
    """
    import time as _time

    import rdflib
    from rdflib.compare import graph_diff, to_isomorphic

    a_name = pathlib.Path(p.get("a") or p["graph"]).name
    b_name = pathlib.Path(p.get("b") or (p["graph"] + ".bak")).name
    if not re.fullmatch(r"[\w.-]+", a_name) or not re.fullmatch(r"[\w.-]+", b_name):
        raise ValueError("bad file name")

    def load(name):
        f = _resolve_onto_file(name)
        g = rdflib.Graph()
        g.parse(str(f), format=FOREIGN_EXTS.get(f.suffix.lower(), "xml"))
        return g, f

    fa, fb = _resolve_onto_file(a_name), _resolve_onto_file(b_name)
    key = (a_name, b_name, fa.stat().st_mtime, fb.stat().st_mtime)
    if _DIFF_CACHE.get("key") != key:  # compute once; paging / searching reuse the cache
        ga, _ = load(a_name)
        gb, _ = load(b_name)
        _, in_a, in_b = graph_diff(to_isomorphic(ga), to_isomorphic(gb))
        nm = ga.namespace_manager
        RDFNS, RDFSNS, OWLNS = rdflib.RDF, rdflib.RDFS, rdflib.OWL
        # every rdfs:label of the two ontologies: entities are displayed by label, like Protégé
        labels = {}
        for g in (gb, ga):  # A wins on conflicts
            for s_, o_ in g.subject_objects(RDFSNS.label):
                labels[s_] = str(o_)
        for g in (in_b, in_a):  # labels of unmatched blank nodes only exist in the diff graphs
            for s_, o_ in g.subject_objects(RDFSNS.label):
                labels.setdefault(s_, str(o_))
        KIND_DECL = {
            OWLNS.Class: "Class",
            RDFSNS.Datatype: "Datatype",
            OWLNS.ObjectProperty: "ObjectProperty",
            OWLNS.DatatypeProperty: "DataProperty",
            OWLNS.AnnotationProperty: "AnnotationProperty",
            OWLNS.NamedIndividual: "Individual",
            OWLNS.Ontology: "Ontology",
        }
        PRED_WORD = {
            RDFSNS.subClassOf: "SubClassOf",
            OWLNS.equivalentClass: "EquivalentTo",
            OWLNS.disjointWith: "DisjointWith",
            RDFSNS.subPropertyOf: "SubPropertyOf",
            OWLNS.equivalentProperty: "EquivalentTo",
            OWLNS.inverseOf: "InverseOf",
            RDFSNS.domain: "Domain",
            RDFSNS.range: "Range",
            RDFNS.type: "Type",
            RDFSNS.label: "Label",
            RDFSNS.comment: "Comment",
        }

        def disp(x):
            """Protégé-like display of one named term: label, else local name; literals capped."""
            if isinstance(x, rdflib.URIRef):
                return labels.get(x) or short(str(x))
            lit = x.n3(nm)
            return lit if len(lit) <= 160 else lit[:157] + "…"

        from collections import defaultdict

        def fold_side(diff_g, full_g):
            """One side of the diff with the anonymous structures FOLDED back into the class /
            range expressions they encode (owl2-mapping-to-rdf): unionOf → "(A or B)",
            restrictions → "(p some C)", facet lists → "decimal[>= 0, <= 100]", rdf:Lists
            collected — instead of one pseudo-entity per blank node / list cell.
            Returns (by_named: URIRef → [axiom text…], orphans: [folded text…])."""
            by_s = defaultdict(list)
            for s_, p_, o_ in diff_g:
                by_s[s_].append((p_, o_))
            consumed = set()

            def value(n, pr):
                for p_, o_ in by_s.get(n, []):
                    if p_ == pr:
                        return o_
                return full_g.value(n, pr)  # partially matched structure: complete it from the full graph

            def rdf_list(n, depth):
                out = []
                while n is not None and n != RDFNS.nil:
                    if isinstance(n, rdflib.BNode):
                        consumed.add(n)
                    out.append(expr(value(n, RDFNS.first), depth))
                    n = value(n, RDFNS.rest)
                return [x for x in out if x is not None]

            def expr(n, depth=0):
                if n is None:
                    return None
                if not isinstance(n, rdflib.BNode):
                    return disp(n)
                consumed.add(n)
                if depth > 8:
                    return "…"
                v = lambda pr: value(n, pr)
                if v(OWLNS.unionOf) is not None:
                    return "(" + " or ".join(rdf_list(v(OWLNS.unionOf), depth + 1)) + ")"
                if v(OWLNS.intersectionOf) is not None:
                    return "(" + " and ".join(rdf_list(v(OWLNS.intersectionOf), depth + 1)) + ")"
                if v(OWLNS.complementOf) is not None:
                    return f"(not {expr(v(OWLNS.complementOf), depth + 1)})"
                if v(OWLNS.oneOf) is not None:
                    return "{" + ", ".join(rdf_list(v(OWLNS.oneOf), depth + 1)) + "}"
                if v(OWLNS.inverseOf) is not None:
                    return f"inverse({expr(v(OWLNS.inverseOf), depth + 1)})"
                if v(OWLNS.onProperty) is not None:  # owl:Restriction
                    pr = expr(v(OWLNS.onProperty), depth + 1)
                    for key, word in (
                        (OWLNS.someValuesFrom, "some"),
                        (OWLNS.allValuesFrom, "only"),
                        (OWLNS.hasValue, "value"),
                    ):
                        if v(key) is not None:
                            return f"({pr} {word} {expr(v(key), depth + 1)})"
                    for key, word in (
                        (OWLNS.qualifiedCardinality, "exactly"),
                        (OWLNS.minQualifiedCardinality, "min"),
                        (OWLNS.maxQualifiedCardinality, "max"),
                        (OWLNS.cardinality, "exactly"),
                        (OWLNS.minCardinality, "min"),
                        (OWLNS.maxCardinality, "max"),
                    ):
                        if v(key) is not None:
                            q = v(OWLNS.onClass) or v(OWLNS.onDataRange)
                            return f"({pr} {word} {v(key)}" + (f" {expr(q, depth + 1)})" if q is not None else ")")
                    if v(OWLNS.hasSelf) is not None:
                        return f"({pr} Self)"
                    return f"({pr} restriction)"
                if v(OWLNS.onDatatype) is not None:  # datatype restriction with facets
                    facets = []
                    for cell_txt, cell in _facet_cells(v(OWLNS.withRestrictions)):
                        facets.append(cell_txt)
                    return f"{expr(v(OWLNS.onDatatype), depth + 1)}[{', '.join(facets)}]"
                if v(RDFNS.first) is not None:  # a bare list reached as a root
                    return "(" + ", ".join(rdf_list(n, depth + 1)) + ")"
                pairs = by_s.get(n, [])
                if pairs:  # unknown shape: inline its outgoing arcs
                    return "[" + "; ".join(f"{disp(p_)} {expr(o_, depth + 1)}" for p_, o_ in pairs[:6]) + "]"
                return "(anonymous)"

            def _facet_cells(n):
                while n is not None and n != RDFNS.nil:
                    if isinstance(n, rdflib.BNode):
                        consumed.add(n)
                    cell = value(n, RDFNS.first)
                    if isinstance(cell, rdflib.BNode):
                        consumed.add(cell)
                        for p_, o_ in by_s.get(cell, []) or [(pp, oo) for pp, oo in full_g.predicate_objects(cell)]:
                            yield f"{short(str(p_))} {disp(o_)}", cell
                    n = value(n, RDFNS.rest)

            SKIP_STRUCT = {
                OWLNS.unionOf, OWLNS.intersectionOf, OWLNS.complementOf, OWLNS.oneOf, OWLNS.inverseOf,
                OWLNS.onProperty, OWLNS.someValuesFrom, OWLNS.allValuesFrom, OWLNS.hasValue, OWLNS.onClass,
                OWLNS.onDataRange, OWLNS.onDatatype, OWLNS.withRestrictions, RDFNS.first, RDFNS.rest,
                OWLNS.qualifiedCardinality, OWLNS.minQualifiedCardinality, OWLNS.maxQualifiedCardinality,
                OWLNS.cardinality, OWLNS.minCardinality, OWLNS.maxCardinality, OWLNS.hasSelf,
            }
            by_named = defaultdict(list)
            # 1) axioms of the NAMED subjects, blank-node objects folded to expressions
            for s_, prs in by_s.items():
                if isinstance(s_, rdflib.BNode):
                    continue
                for p_, o_ in prs:
                    if p_ == RDFNS.type and o_ in KIND_DECL:
                        by_named[s_].append(f"{KIND_DECL[o_]}: {disp(s_)}")
                    else:
                        by_named[s_].append(f"{disp(s_)} {PRED_WORD.get(p_) or disp(p_)} {expr(o_, 1)}")
            # 2) anonymous structures whose ROOT is not referenced by any named diff axiom: walk
            # every blank subject up its incoming blank arcs to the root of its structure; roots
            # already folded inline (object of a named triple) are excluded, the rest is shown
            # once, folded (owl2-mapping-to-rdf shapes: unions, restrictions, lists, facets…)
            named_objs = set()
            parent = {}
            for s_, prs in by_s.items():
                for _, o_ in prs:
                    if isinstance(o_, rdflib.BNode):
                        parent.setdefault(o_, s_)
                        if not isinstance(s_, rdflib.BNode):
                            named_objs.add(o_)

            def root_of(n):
                seen = set()
                while n in parent and isinstance(parent[n], rdflib.BNode) and n not in seen:
                    seen.add(n)
                    n = parent[n]
                return n

            roots = set()
            for s_ in by_s:
                if isinstance(s_, rdflib.BNode):
                    r = root_of(s_)
                    if r not in named_objs:
                        roots.add(r)
            orphans = []
            for r in roots:
                txt = expr(r, 0)
                if txt and txt != "(anonymous)":
                    orphans.append(txt)
            return by_named, orphans

        named_a, orph_a = fold_side(in_a, ga)
        named_b, orph_b = fold_side(in_b, gb)
        entities, counts = [], {"created": 0, "deleted": 0, "modified": 0}
        for s in set(named_a) | set(named_b):
            status = (
                "modified"
                if (s, None, None) in ga and (s, None, None) in gb
                else ("created" if (s, None, None) in ga else "deleted")
            )
            counts[status] += 1
            entities.append(
                {
                    "name": str(s),
                    "label": labels.get(s),
                    "iri": str(s),
                    "anon": False,
                    "status": status,
                    "new": sorted(named_a.get(s, [])),
                    "baseline": sorted(named_b.get(s, [])),
                    "new_total": len(named_a.get(s, [])),
                    "baseline_total": len(named_b.get(s, [])),
                }
            )
        # folded anonymous expressions whose root is not referenced by any named axiom of the diff
        for txts, status in ((orph_a, "created"), (orph_b, "deleted")):
            for txt in sorted(set(txts)):
                counts[status] += 1
                entities.append(
                    {
                        "name": txt if len(txt) <= 140 else txt[:137] + "…",
                        "label": None,
                        "iri": None,
                        "anon": True,
                        "status": status,
                        "new": [txt] if status == "created" else [],
                        "baseline": [txt] if status == "deleted" else [],
                        "new_total": 1 if status == "created" else 0,
                        "baseline_total": 1 if status == "deleted" else 0,
                    }
                )
        order = {"created": 0, "deleted": 1, "modified": 2}
        entities.sort(key=lambda e: (order[e["status"]], e["anon"], e["name"]))
        _DIFF_CACHE.update(
            {"key": key, "entities": entities, "counts": counts, "added": len(in_a), "removed": len(in_b)}
        )
    ents, counts = _DIFF_CACHE["entities"], _DIFF_CACHE["counts"]
    q = (p.get("q") or "").strip().lower()
    if q:  # search over the display name, the IRI and the axiom texts
        ents = [
            e
            for e in ents
            if q in e["name"].lower()
            or q in (e["label"] or "").lower()
            or q in (e["iri"] or "").lower()
            or any(q in ax.lower() for ax in e["new"])
            or any(q in ax.lower() for ax in e["baseline"])
        ]
    per = 100
    pages = max(1, -(-len(ents) // per))
    page = min(max(int(p.get("page") or 0), 0), pages - 1)
    sl = [{**e, "new": e["new"][:80], "baseline": e["baseline"][:80]} for e in ents[page * per : (page + 1) * per]]
    return {
        "a": a_name,
        "b": b_name,
        "b_time": _time.strftime("%Y-%m-%d %H:%M:%S", _time.localtime(fb.stat().st_mtime)),
        "counts": counts,
        "added_total": _DIFF_CACHE["added"],
        "removed_total": _DIFF_CACHE["removed"],
        "entities": sl,
        "filtered_total": len(ents),
        "page": page,
        "pages": pages,
    }


def api_merge(c, p):
    """Merge workspace modules into a new module file (Protégé: Refactor → Merge ontologies).

    Payload: "files": [module file name…] (at least two), "name" (target file, .owl appended
    when missing), optional "iri" (ontology IRI of the merged module).  ``c`` is None.
    The union of the sources is computed with rdflib; their ``owl:Ontology`` headers (imports
    and header annotations included) are dropped and replaced by one new header, so the merged
    module is self-contained.  The sources are not touched.  Raises ValueError for a bad
    target name, an existing target or fewer than two sources.
    Side effects: the merged .owl is written to the workspace, workspace.json updated (the
    index reports stale until the next rebuild).  Returns {"file", "iri", "triples"}.
    """
    import rdflib
    from rdflib import RDF, URIRef
    from rdflib.namespace import OWL

    files = p.get("files") or []
    if len(files) < 2:
        raise ValueError("select at least two modules to merge")
    name = (p.get("name") or "").strip()
    if not name.endswith(".owl"):
        name += ".owl"
    if not re.fullmatch(r"[\w.-]+\.owl", name):
        raise ValueError("file name must contain only letters, digits, _ . - and end in .owl")
    ws = workspace.load()
    wdir = pathlib.Path(ws["dir"])
    out = wdir / name
    if out.exists():
        raise ValueError(f"{name} already exists in the workspace")
    g = rdflib.Graph()
    for f in files:
        src = _resolve_onto_file(pathlib.Path(f).name)
        g.parse(str(src), format=FOREIGN_EXTS.get(src.suffix.lower(), "xml"))
    for s in list(g.subjects(RDF.type, OWL.Ontology)):
        g.remove((s, None, None))
    iri = (p.get("iri") or "").strip() or f"http://www.semanticweb.org/ontologies/{name[:-4]}"
    g.add((URIRef(iri), RDF.type, OWL.Ontology))
    g.serialize(destination=str(out), format="xml")
    ws["files"].append(name)
    workspace.save(ws)
    return {"file": name, "iri": iri, "triples": len(g)}


def api_server_log(q):
    """Tail of the server log (viewer/data/viewer.log, written by start_viewer.sh).

    No query parameters.  Returns {"file", "exists", "log": last 400 lines ("" when the server
    was started without the launcher script)}.
    """
    f = config.DATA_DIR / "viewer.log"
    if not f.is_file():
        return {"file": str(f), "exists": False, "log": ""}
    return {"file": str(f), "exists": True, "log": "\n".join(f.read_text(errors="replace").splitlines()[-400:])}


_DIFF_CACHE = {}  # last computed diff (key, entities, counts, added, removed): paging and search reuse it


# external ontologies added to the Comparison / Merge views (URL fetch / upload)
COMPARE_DIR = config.DATA_DIR / "compare"
COMPARE_EXTS = (".owl", ".rdf", ".xml", ".ttl", ".n3", ".nt", ".jsonld")


def _resolve_onto_file(name):
    """A file usable by the Comparison / Merge views: looked up in the workspace directory
    (modules and their .bak backups) first, then in data/compare/ (external ontologies).
    Raises FileNotFoundError with a hint when missing.
    """
    wdir = pathlib.Path(workspace.load()["dir"])
    for base in (wdir, COMPARE_DIR):
        f = base / name
        if f.is_file():
            return f
    hint = " (the .bak appears after the first Save of the module)" if name.endswith(".bak") else ""
    raise FileNotFoundError(f"{name} not found in the workspace or among the added ontologies{hint}")


def diff_files(q):
    """Files available to the Comparison view: only what actually exists.

    No query parameters.  Returns {"files": [{"name", "kind": module | backup | external}…]} =
    the workspace modules, their existing ``.bak`` backups, and the external ontologies stored
    in data/compare/ (added with /api/diff/fetch or /api/diff/upload).
    """
    ws = workspace.load()
    wdir = pathlib.Path(ws["dir"])
    out = []
    for m in ws["files"]:
        out.append({"name": m, "kind": "module"})
        if (wdir / (m + ".bak")).is_file():
            out.append({"name": m + ".bak", "kind": "backup"})
    if COMPARE_DIR.is_dir():
        for f in sorted(COMPARE_DIR.iterdir()):
            if f.is_file() and f.suffix.lower() in COMPARE_EXTS:
                out.append({"name": f.name, "kind": "external"})
    return {"files": out}


def _fetch_ontology(url, dest_dir, name=None):
    """Download an ontology (50 MB cap) into ``dest_dir``; the target name defaults to the
    basename of the URL path.  Returns the pathlib.Path of the saved file.
    """
    import urllib.parse
    import urllib.request

    url = (url or "").strip()
    if not url.startswith(("http://", "https://")):
        raise ValueError("an http(s) URL is required")
    name = (name or "").strip() or pathlib.Path(urllib.parse.urlparse(url).path).name or "remote.owl"
    if not re.fullmatch(r"[\w.-]+", name):
        raise ValueError("bad target file name")
    if not name.lower().endswith(COMPARE_EXTS):
        name += ".owl"
    req = urllib.request.Request(
        url, headers={"Accept": "application/rdf+xml, text/turtle;q=0.9, */*;q=0.8", "User-Agent": "ontology-viewer"}
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read(50 * 1024 * 1024)
    dest_dir.mkdir(exist_ok=True)
    f = dest_dir / name
    f.write_bytes(data)
    return f


def diff_fetch(c, p):
    """Download an ontology from a URL into data/compare/ for the Comparison / Merge views.

    Payload: "url" (http/https), optional "name" (target file name; default: the basename of
    the URL path).  ``c`` is None.  The file is stored as-is; its format is recognised by
    extension when compared.  Returns {"file": name}.
    """
    return {"file": _fetch_ontology(p.get("url"), COMPARE_DIR, p.get("name")).name}


def handle_diff_upload(handler):
    """Upload an ontology file (multipart field "file") into data/compare/ for the Comparison
    view; read directly by ``ontoviewer.http`` like handle_upload.  Returns {"file": name}.
    """
    env = {"REQUEST_METHOD": "POST", "CONTENT_TYPE": handler.headers.get("Content-Type", "")}
    form = cgi.FieldStorage(fp=handler.rfile, headers=handler.headers, environ=env)
    if "file" not in form or not getattr(form["file"], "filename", None):
        raise ValueError("no file")
    name = pathlib.Path(form["file"].filename).name
    if not re.fullmatch(r"[\w.-]+", name) or not name.lower().endswith(COMPARE_EXTS):
        raise ValueError(f"the file must be one of {', '.join(COMPARE_EXTS)}")
    COMPARE_DIR.mkdir(exist_ok=True)
    (COMPARE_DIR / name).write_bytes(form["file"].file.read())
    return {"file": name}


def api_check_empty(q):
    """Entities declared but never used (Protégé/Ontop: Check empty entities).

    No query parameters.  An entity is empty when its only outgoing statements are the
    declaration (rdf:type) and rdfs:label / rdfs:comment / skos annotations, and nothing
    references it as object or predicate.  Returns {"entities": [{"iri", "kind", "label"}…]
    (first 500, alphabetically), "truncated"}.
    """
    meta = (
        "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
        "http://www.w3.org/2000/01/rdf-schema#label",
        "http://www.w3.org/2000/01/rdf-schema#comment",
        "http://www.w3.org/2004/02/skos/core#altLabel",
        "http://www.w3.org/2004/02/skos/core#notation",
    )
    rows = db().execute(
        f"""SELECT n.iri, n.kind, n.label FROM nodes n
            WHERE n.kind IN ('class','objprop','dataprop','annprop','individual','datatype')
              AND NOT EXISTS (SELECT 1 FROM stmt s JOIN nodes p ON p.id=s.p
                              WHERE s.s=n.id AND p.iri NOT IN ({','.join('?' * len(meta))}))
              AND NOT EXISTS (SELECT 1 FROM stmt s WHERE s.o_id=n.id)
              AND NOT EXISTS (SELECT 1 FROM stmt s WHERE s.p=n.id)
            ORDER BY n.iri LIMIT 501""",
        meta,
    ).fetchall()
    return {
        "entities": [{"iri": r["iri"], "kind": r["kind"], "label": r["label"]} for r in rows[:500]],
        "truncated": len(rows) > 500,
    }


def api_indexes(q):
    """The SQLite indexes on disk (data/index_*.db), one per workspace ever opened.

    No query parameters.  Each entry is labelled through the current + recent workspaces when
    the hash matches (older ones show as unknown).  Returns {"indexes": [{"file", "size",
    "mtime", "current", "dir", "files"}…]} sorted by size (largest first).
    """
    import time as _time

    cur = workspace.load()
    known = {}
    for w in [cur] + workspace.load_recent():
        known.setdefault(f"index_{workspace.key(w)}.db", w)
    cur_name = f"index_{workspace.key(cur)}.db"
    out = []
    for f in config.DATA_DIR.glob("index_*.db"):
        w = known.get(f.name)
        st = f.stat()
        out.append(
            {
                "file": f.name,
                "size": st.st_size,
                "mtime": _time.strftime("%Y-%m-%d %H:%M", _time.localtime(st.st_mtime)),
                "current": f.name == cur_name,
                "dir": w["dir"] if w else None,
                "files": w["files"] if w else None,
            }
        )
    out.sort(key=lambda e: -e["size"])
    return {"indexes": out}


def index_remove(c, p):
    """Delete one index file (never the one of the current workspace; the .owl files are not
    touched — reopening that workspace just rebuilds it).

    Payload: "file" (index_<hash>.db).  ``c`` is None.  Returns {"removed", "bytes"}.
    """
    name = pathlib.Path(p["file"]).name
    if not re.fullmatch(r"index_[0-9a-f]{10}\.db", name):
        raise ValueError("bad index file name")
    if name == f"index_{workspace.key()}.db":
        raise ValueError("cannot delete the index of the current workspace (open another one first)")
    f = config.DATA_DIR / name
    if not f.is_file():
        raise FileNotFoundError(f"{name} not found")
    size = f.stat().st_size
    f.unlink()
    for suf in ("-wal", "-shm"):
        (config.DATA_DIR / (name + suf)).unlink(missing_ok=True)
    return {"removed": name, "bytes": size}


def api_sources(q):
    """File → Loaded ontology sources…: every module of the workspace with its file facts,
    plus the catalog-v001.xml mappings of the workspace directory (Protégé's ontology
    libraries / catalog).

    No query parameters.  Returns {"dir", "sources": [{"file", "path", "exists", "size",
    "mtime", "statements" (indexed rows)}…], "catalog": [{"iri", "uri"}…] (empty when the
    directory has no catalog-v001.xml)}.
    """
    import time as _time
    import xml.etree.ElementTree as ET

    ws = workspace.load()
    wdir = pathlib.Path(ws["dir"])
    try:
        per_mod = dict(db().execute("SELECT graph, COUNT(*) FROM stmt GROUP BY graph").fetchall())
    except sqlite3.OperationalError:
        per_mod = {}
    out = []
    for f in ws["files"]:
        p = wdir / f
        ex = p.is_file()
        st = p.stat() if ex else None
        out.append(
            {
                "file": f,
                "path": str(p),
                "exists": ex,
                "size": st.st_size if ex else 0,
                "mtime": _time.strftime("%Y-%m-%d %H:%M", _time.localtime(st.st_mtime)) if ex else None,
                "statements": per_mod.get(f, 0),
            }
        )
    catalog = []
    cat = wdir / "catalog-v001.xml"
    if cat.is_file():
        try:
            for e in ET.parse(cat).getroot():
                if e.tag.endswith("uri"):
                    catalog.append({"iri": e.get("name"), "uri": e.get("uri")})
        except ET.ParseError:
            catalog = [{"iri": "(catalog-v001.xml is not well-formed XML)", "uri": ""}]
    return {"dir": str(wdir), "sources": out, "catalog": catalog}
