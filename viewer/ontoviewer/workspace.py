"""Workspace = the set of ontology files currently open (dir + file names).

Each workspace has its own SQLite index (index_<hash>.db) so switching back to a
previously opened ontology is instant. The workspace is persisted in
workspace.json; imports are resolved through catalog-v001.xml (OASIS XML catalog)
and owl:imports declarations found in the file headers.

A workspace is a plain dict ``{"dir": <absolute directory>, "files": [<file names>]}``;
``files`` are relative to ``dir`` and ordered so that imported modules come first (the
indexer's metrics rely on that order).

Main entry points:
    load() / save(ws)      read / write ``workspace.json`` (``save`` also updates ``recent.json``)
    db_path(ws)            path of the SQLite index of a workspace
    ont_dir(ws)            directory of the ontology files
    resolve(paths)         build a workspace from entry files by following their import closure

``indexer``, ``store`` and ``api.ontology`` are the main consumers; ``indexer.refresh()`` must
be called after ``save`` so that its module-level globals follow the new workspace.
"""

import hashlib
import json
import pathlib
import re

from ontoviewer import config

WS_FILE = config.WS_FILE
RECENT_FILE = config.RECENT_FILE
DATA_DIR = config.DATA_DIR
# Workspace used when workspace.json is missing or unreadable: the SDF ontology modules
# of this project.  Also the only workspace entitled to inherit the legacy ``ontology.db``
# index (see ``db_path``).
DEFAULT = {
    # parent directory of the repository: put the ontology modules there (or open
    # any other folder from the app with the workspace button in the header)
    "dir": str(pathlib.Path(__file__).resolve().parents[3]),
    "files": ["SDF_ext.owl", "SDF_individuals.owl", "SDF_individuals_annotations.owl", "SDF_fuzzy_annotated.owl"],
}


def load():
    """Return the current workspace dict from ``workspace.json``.

    Falls back to a copy of ``DEFAULT`` when the file is missing or not valid JSON
    (never raises).
    """
    if WS_FILE.exists():
        try:
            return json.load(open(WS_FILE))
        except Exception:
            pass
    return dict(DEFAULT)


def save(ws):
    """Persist ``ws`` as the current workspace and push it on top of the recent list.

    Writes ``workspace.json`` and ``recent.json`` (the latter is de-duplicated on
    ``(dir, files)`` and capped to the 10 most recent entries).  ``data/`` must exist.
    """
    json.dump(ws, open(WS_FILE, "w"), indent=1)
    # move-to-front: drop any previous entry equal to ws, then insert it first
    recent = [r for r in load_recent() if r["dir"] != ws["dir"] or r["files"] != ws["files"]]
    recent.insert(0, {"dir": ws["dir"], "files": ws["files"]})
    json.dump(recent[:10], open(RECENT_FILE, "w"), indent=1)


def load_recent():
    """Return the list of recently opened workspaces (most recent first), ``[]`` if unavailable."""
    if RECENT_FILE.exists():
        try:
            return json.load(open(RECENT_FILE))
        except Exception:
            pass
    return []


def key(ws=None):
    """Short (10 hex chars) SHA-1 of ``dir`` and the ordered file list; identifies the index file.

    Defaults to the current workspace.  The order of ``files`` matters: the same files in a
    different order give a different key (and therefore a different index).
    """
    ws = ws or load()
    # sorted: the same file SET shares one index whatever the order it was opened in
    h = hashlib.sha1((ws["dir"] + "|" + "|".join(sorted(ws["files"]))).encode()).hexdigest()[:10]
    return h


def _legacy_key(ws):
    """Pre-2026-09 key: order-sensitive (the same set in a different order duplicated the index)."""
    return hashlib.sha1((ws["dir"] + "|" + "|".join(ws["files"])).encode()).hexdigest()[:10]


def migrate_index_names():
    """One-off after the order-insensitive key: rename the indexes of the current and recent
    workspaces from their legacy (order-sensitive) name to the sorted-key name."""
    for ws in [load()] + load_recent():
        old = DATA_DIR / f"index_{_legacy_key(ws)}.db"
        new = DATA_DIR / f"index_{key(ws)}.db"
        if old != new and old.exists() and not new.exists():
            old.rename(new)
            for suf in ("-wal", "-shm"):
                s = DATA_DIR / (old.name + suf)
                if s.exists():
                    s.rename(DATA_DIR / (new.name + suf))


def db_path(ws=None):
    """Path of the SQLite index of ``ws`` (default: the current workspace): ``data/index_<key>.db``.

    Side effect: on the first run after the workspace refactor, the pre-existing single index
    ``data/ontology.db`` is renamed to the new name — only for ``DEFAULT`` (the ontology it was
    built from) and only if the new file does not exist yet.  The path returned may not exist.
    """
    ws = ws or load()
    p = config.DATA_DIR / f"index_{key(ws)}.db"
    legacy = config.DATA_DIR / "ontology.db"
    if not p.exists() and legacy.exists() and ws == DEFAULT:
        legacy.rename(p)  # first run after the workspace refactor: reuse the existing index
    return p


def ont_dir(ws=None):
    """Directory containing the ontology files of ``ws`` (default: current workspace) as a Path."""
    return pathlib.Path((ws or load())["dir"])


# ------------------------------------------------------------ import resolution


def _catalog(dir_):
    """Parse the OWL API's ``catalog-v001.xml`` in ``dir_`` into ``{ontology IRI: relative file path}``.

    Only ``<uri name="…" uri="…"/>`` entries are read (a plain regex, no XML parser);
    returns ``{}`` when there is no catalog.
    """
    cat = dir_ / "catalog-v001.xml"
    if not cat.exists():
        return {}
    txt = cat.read_text(errors="replace")
    # <uri name="<IRI>" uri="<file>"/>  → (IRI, file); attribute order as written by OWL API
    return dict(re.findall(r'<uri\s+name="([^"]+)"\s+uri="([^"]+)"', txt))


def _ontology_block(path):
    """The <owl:Ontology …>…</owl:Ontology> element, wherever it is in the file
    (most writers put it first; rdflib-serialized files may not).

    Returns the raw XML text of the element (``""`` when not found).  Only the first
    64 kB are searched at first; the whole file is scanned only when that fails and the
    file is smaller than 50 MB, so huge ABox modules are never read entirely.
    """
    # either an empty element (<owl:Ontology rdf:about="…"/>) or a full one with imports
    # and header annotations; re.S lets ".*?" span lines
    pat = re.compile(r'<owl:Ontology rdf:about="[^"]*"\s*(?:/>|>.*?</owl:Ontology>)', re.S)
    with open(path, encoding="utf-8", errors="replace") as f:
        head = f.read(64000)
        m = pat.search(head)
        if m:
            return m.group(0)
        # scan the whole file (big files: the header is always at the top, so this
        # only happens for small rdflib-style files)
        if path.stat().st_size < 50e6:
            m = pat.search(head + f.read())
            return m.group(0) if m else ""
    return ""


def _ontology_iri(path):
    """Ontology IRI (``rdf:about`` of the owl:Ontology element) of the file, or None."""
    m = re.search(r'<owl:Ontology rdf:about="([^"]*)"', _ontology_block(path))
    return m.group(1) if m else None


def _imports(path):
    """List of the IRIs declared with ``owl:imports`` in the ontology header of the file."""
    return re.findall(r'<owl:imports rdf:resource="([^"]+)"', _ontology_block(path))


def resolve(paths):
    """Given one or more entry files, return the workspace {dir, files} covering
    their whole import closure (as far as it resolves to local files), plus the
    list of import IRIs that could not be resolved.

    Import IRIs are mapped to files through the catalog of the entry directory first,
    then through the ontology IRIs found in the headers of the ``*.owl`` files of that
    same directory (all files must live in ``paths[0].parent``).  Raises
    ``FileNotFoundError`` when an entry file does not exist.  The returned file list is
    ordered by increasing number of imports so that imported modules precede importers.
    """
    paths = [pathlib.Path(p).expanduser().resolve() for p in paths]
    for p in paths:
        if not p.exists():
            raise FileNotFoundError(str(p))
    dir_ = paths[0].parent
    catalog = _catalog(dir_)
    by_iri = {}  # ontology IRI -> file name, for imports missing from the catalog
    for f in dir_.glob("*.owl"):
        iri = _ontology_iri(f)
        if iri:
            by_iri[iri] = f.name
    # breadth-first walk of the import graph; ``files`` doubles as the visited set
    files, unresolved, queue = [], [], list(paths)
    while queue:
        p = queue.pop(0)
        if p.name in files:
            continue
        files.append(p.name)
        for iri in _imports(p):
            target = catalog.get(iri) or by_iri.get(iri)
            if target and (dir_ / target).exists():
                queue.append(dir_ / target)
            elif iri not in unresolved:
                unresolved.append(iri)
    # imported modules first (metrics need the declarations of imported modules first):
    # depth-first post-order over the import graph = topological order, an importer always
    # follows everything it imports (a plain sort by number of imports is not enough)
    imports_of = {
        f: [t for t in (catalog.get(i) or by_iri.get(i) for i in _imports(dir_ / f)) if t in files] for f in files
    }
    ordered = []

    def visit(f, trail=()):
        if f in ordered or f in trail:  # `trail` guards against import cycles
            return
        for t in imports_of[f]:
            visit(t, trail + (f,))
        ordered.append(f)

    for f in files:
        visit(f)
    return {"dir": str(dir_), "files": ordered}, unresolved
