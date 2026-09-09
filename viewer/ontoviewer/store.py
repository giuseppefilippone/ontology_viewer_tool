"""Read access to the SQLite index of the current workspace (thread-local connections, node helpers).

The index is built by ``ontoviewer.indexer`` (tables ``nodes``, ``stmt``, ``metrics``,
``axiom_ann``, ``datatype_bounds``, ``bnode_refs``); this module is the thin layer every
API handler goes through to query it:

    db()               thread-local ``sqlite3`` connection to the index of the current workspace
    get_id(iri)        node id of an IRI
    node_json(row)     JSON view of a ``nodes`` row (the entity object sent to the browser)
    fuzzy_ids()        cached set of fuzzy entity ids (fuzzy annotation + equivalence closure)
    declared_in(graph) SQL fragment restricting a query to entities declared in one module
    DB                 proxy Path of the current index file (follows workspace switches)

Writes to the index go through ``ontoviewer.editor`` instead, which opens its own connections.
"""

import re
import sqlite3
import threading

from ontoviewer import anon, config, indexer, workspace

LOCAL = threading.local()  # one SQLite connection per server thread
FUZZY_CACHE = {}  # fuzzy entity ids and their equivalence sources (per index build + label)
REQUEST = threading.local()  # per-request context: .active = file of the active ontology (display names)
DECL_CACHE = {}  # node id -> module file declaring it (per index build)
PREFIX_CACHE = {}  # namespace -> prefix, from the module headers (per workspace)


def db():
    """Return the thread-local connection to the index of the current workspace.

    The connection is (re)opened when the thread has none yet or when the workspace
    changed since it was opened (compared by index path).  Rows are ``sqlite3.Row``
    (column access by name).  On open, the ``i_nkind`` index is created if missing:
    a one-off write on indexes built before it was added to the indexer.
    """
    path = str(workspace.db_path())
    if getattr(LOCAL, "path", None) != path:
        LOCAL.db = sqlite3.connect(path)
        LOCAL.db.row_factory = sqlite3.Row
        LOCAL.path = path
        try:  # older indexes: add what newer builds create (no-op afterwards)
            LOCAL.db.execute("CREATE INDEX IF NOT EXISTS i_nkind ON nodes(kind, iri)")
            _ensure_sort_column(LOCAL.db)
            LOCAL.db.commit()
        except sqlite3.Error:
            pass
    return LOCAL.db


def _ensure_sort_column(conn):
    """Add ``nodes.lname`` (lower-case local name, the alphabetical sort key of lists and trees) to an
    index built before the column existed: computed in Python for every row (~2 s for 400k nodes)."""
    if any(r[1] == "lname" for r in conn.execute("PRAGMA table_info(nodes)").fetchall()):
        return
    conn.execute("ALTER TABLE nodes ADD COLUMN lname TEXT")
    rows = conn.execute("SELECT id, iri FROM nodes").fetchall()
    conn.executemany("UPDATE nodes SET lname=? WHERE id=?", [(short(r[1]).lower(), r[0]) for r in rows])
    conn.execute("CREATE INDEX IF NOT EXISTS i_nlname ON nodes(kind, lname)")


def declaring_files():
    """{node id: module file} for every declared entity (rdf:type of an OWL kind), cached per index build."""
    key = (str(workspace.db_path()), DB.stat().st_mtime if DB.exists() else 0)
    if DECL_CACHE.get("key") != key:
        ti = get_id(config.RDF_TYPE)
        kinds = [get_id(k) for k in indexer.KIND_TYPES if get_id(k) is not None]
        decl = {}
        if ti is not None and kinds:
            marks = ",".join("?" * len(kinds))
            for s, g in (
                db().execute(f"SELECT s, graph FROM stmt WHERE p=? AND o_id IN ({marks})", (ti, *kinds)).fetchall()
            ):
                decl.setdefault(s, g)
        DECL_CACHE.update({"key": key, "decl": decl})
    return DECL_CACHE["decl"]


CANON = {config.OWL_NS: "owl", config.RDFS_NS: "rdfs", config.RDF_NS: "rdf", config.XSD_NS: "xsd"}


def namespace_prefixes():
    """Two {namespace: prefix} maps from the xmlns declarations of the module headers: the active
    ontology's own ("Ontology prefixes", used first) and the other modules' (fallback); both include
    the canonical owl/rdfs/rdf/xsd prefixes. Cached per (workspace, active file)."""
    active = getattr(REQUEST, "active", None)
    key = (str(workspace.db_path()), active)
    if PREFIX_CACHE.get("key") != key:
        ws = workspace.load()

        def declared(files):
            out = dict(CANON)
            for f in files:
                path = workspace.ont_dir(ws) / f
                if path.exists():
                    head = path.read_text(errors="replace")[:16000].split("<owl:Ontology", 1)[0]
                    for m in re.finditer(r'xmlns:([\w.-]+)="([^"]+)"', head):
                        out.setdefault(m.group(2), m.group(1))
            return out

        own = declared([active] if active in ws["files"] else [])
        others = declared([f for f in ws["files"] if f != active])
        PREFIX_CACHE.update({"key": key, "maps": (own, others)})
    return PREFIX_CACHE["maps"]


def namespace_prefix(ns):
    """Prefix shown for a namespace: the prefix declared in the active ontology's header for that
    namespace or for its closest parent (``…/fuzzydl_ontology/class#`` → ``sdf`` when ``sdf`` is
    bound to ``…/fuzzydl_ontology#``); then the same lookup in the other modules' headers; else
    the last path segment of the namespace."""
    for pfx in namespace_prefixes():
        if ns in pfx:
            return pfx[ns]
        parents = [(p, n) for n, p in pfx.items() if p not in CANON.values() and ns.startswith(n.rstrip("#/") + "/")]
        if parents:
            return max(parents, key=lambda x: len(x[1]))[0]
    return ns.rstrip("#/").rsplit("/", 1)[-1]


def display_name(iri, nid=None):
    """Name shown for an entity: the local name when it is declared in the active ontology (or no
    active ontology is known), ``prefix:local`` otherwise — imported modules use the prefix declared
    in the headers (else the last path segment of the namespace), built-ins their canonical prefix;
    an anonymous individual (``_:<id>``) shows its node id."""
    if iri in config.BUILTIN_KIND:
        return config.builtin_name(iri)
    if anon.is_anon(iri):
        return iri[len(anon.PREFIX) :]
    local = short(iri)
    active = getattr(REQUEST, "active", None)
    if not active:
        return local
    if nid is not None and declaring_files().get(nid) == active:
        return local
    cut = max(iri.rfind("#"), iri.rfind("/"))
    if cut <= 0:
        return local
    ns = iri[: cut + 1]
    return f"{namespace_prefix(ns)}:{local}"


def short(iri):
    """Local name of an IRI: the part after the last ``#``, else after the last ``/``; the node id of the
    ``_:<id>`` pseudo-IRI of an anonymous individual."""
    if anon.is_anon(iri):
        return iri[len(anon.PREFIX) :]
    return iri.rsplit("#", 1)[-1].rsplit("/", 1)[-1]


def fuzzy_ids():
    """ids of the fuzzy entities (cached per index build and per configured label).

    An entity is fuzzy when it carries the fuzzy annotation — any annotation property whose
    local name is ``config.fuzzy_label()``, default ``fuzzyLabel`` — or when it is connected
    to an annotated entity through a chain of owl:equivalentClass / owl:equivalentProperty
    axioms (both directions).  An empty configured label disables fuzziness entirely
    (classical crisp ontology).  ``fuzzy_via()`` maps each equivalence-derived id to the
    annotated ids it inherits from.
    """
    name = config.fuzzy_label()
    key = (str(workspace.db_path()), DB.stat().st_mtime if DB.exists() else 0, name)
    if FUZZY_CACHE.get("key") != key:
        ids, via = set(), {}
        props = (
            [r[0] for r in db().execute("SELECT id FROM nodes WHERE lname=?", (name.lower(),)).fetchall()]
            if name
            else []
        )
        if props:
            qs = ",".join(map(str, props))
            ids = {r[0] for r in db().execute(f"SELECT DISTINCT s FROM stmt WHERE p IN ({qs})").fetchall()}
        if ids:
            eq = [i for i in (get_id(config.OWL_NS + "equivalentClass"), get_id(config.OWL_NS + "equivalentProperty")) if i]
            edges = {}  # undirected adjacency over the named equivalence axioms
            for s, o in (
                db().execute(f"SELECT s, o_id FROM stmt WHERE p IN ({','.join(map(str, eq))}) AND o_id IS NOT NULL").fetchall()
                if eq
                else []
            ):
                edges.setdefault(s, set()).add(o)
                edges.setdefault(o, set()).add(s)
            own, seen = set(ids), set()
            for start in edges:  # every member of a component with an annotated entity is fuzzy
                if start in seen:
                    continue
                comp, todo = [start], [start]
                seen.add(start)
                while todo:
                    for n in edges[todo.pop()]:
                        if n not in seen:
                            seen.add(n)
                            comp.append(n)
                            todo.append(n)
                srcs = own & set(comp)
                if srcs:
                    for n in comp:
                        if n not in own:
                            ids.add(n)
                            via[n] = srcs
        FUZZY_CACHE.update({"key": key, "ids": ids, "via": via})
    return FUZZY_CACHE["ids"]


def fuzzy_via():
    """{entity id → set of annotated fuzzy ids it is equivalent to}: only entities whose
    fuzziness is inherited through equivalence appear (with the annotated sources reachable
    from them); entities carrying their own fuzzy annotation are absent."""
    fuzzy_ids()  # ensure the cache is fresh
    return FUZZY_CACHE.get("via", {})


def node_json(row):
    """JSON-serialisable dict for a ``nodes`` row (id, iri, label, kind, name, fuzzy, builtin).

    ``kind`` is taken from the index; OWL built-in datatypes are never declared in the
    files, so they (and the built-in annotation properties) get their kind here and ``builtin=True``.
    """
    kind = row["kind"] or config.BUILTIN_KIND.get(row["iri"])
    return {
        "id": row["id"],
        "iri": row["iri"],
        "label": row["label"],
        "kind": kind,
        "name": display_name(row["iri"], row["id"]),
        "fuzzy": row["id"] in fuzzy_ids(),
        "builtin": row["iri"] in config.BUILTIN_KIND,
    }


def get_id(iri):
    """Node id of ``iri`` in the index, or None if the IRI never occurs."""
    r = db().execute("SELECT id FROM nodes WHERE iri=?", (iri,)).fetchone()
    return r["id"] if r else None


def declared_in(graph):
    """SQL fragment + params restricting nodes to entities DECLARED (rdf:type of an
    OWL entity kind) in the given module; ('', ()) when graph is None (closure).

    The fragment starts with `` AND `` and is meant to be appended to a ``WHERE`` clause on
    the ``nodes`` table (column ``id``); ``graph`` is the module file name as stored in
    ``stmt.graph``.  Returns a (fragment, params) pair.
    """
    if not graph:
        return "", ()
    ti = get_id(config.RDF_TYPE)
    # ids of the declaration classes (owl:Class, owl:ObjectProperty, …) present in the index
    kinds = ",".join(str(get_id(k)) for k in indexer.KIND_TYPES if get_id(k) is not None)
    # nodes with a  <id> rdf:type <kind>  statement asserted in those modules ("," separates
    # several files: the scope "active ontology" sends the module plus its import closure)
    files = [g for g in str(graph).split(",") if g]
    ph = ",".join("?" * len(files))
    return (f" AND id IN (SELECT s FROM stmt WHERE p={ti} AND graph IN ({ph}) AND o_id IN ({kinds}))", tuple(files))


class _DBPath:
    """Current workspace index path (changes when another ontology is opened).

    A lazy proxy for ``workspace.db_path()``: every attribute access (``exists``, ``stat``…)
    and ``os.fspath``/``str`` conversion re-evaluates the path, so module-level ``DB``
    always points to the index of the workspace currently saved on disk.
    """

    def __getattr__(self, name):
        """Delegate any attribute/method (``exists``, ``stat``, ``name``…) to the current Path."""
        return getattr(workspace.db_path(), name)

    def __fspath__(self):
        """Make the proxy usable wherever a path-like object is accepted (``open``, ``sqlite3``)."""
        return str(workspace.db_path())

    def __str__(self):
        """The current index path as a string."""
        return str(workspace.db_path())


# current workspace index path (proxy: follows workspace switches)
DB = _DBPath()
