"""Editing layer for the ontology viewer.

Model: the SQLite index (``workspace.db_path()``) is the working copy. Every edit
mutates the db immediately (so the UI reflects it) and is journaled in the
`changes` table. `save()` writes the journal into the .owl files — each triple only
into the module where it lives / where the entity is declared; renames into every
module where the IRI appears. `discard()` reverts the db from the journal.

Main entry points (all take an open connection from `connect()`):
- edit ops: `add_triple`, `remove_triple`, `create_entity`, `delete_entity`,
  `rename_entity`, `rename_namespace`, `add_raw_block`, `remove_anon`, `drop_block`,
  `add_axiom_annotation`, `remove_axiom_annotation`
- journal: `list_changes`, `discard`, `save`

Journal (`changes` table): one row per operation, ``op`` in
    add / remove        a triple (s, p, o) — ``o`` is an IRI (is_lit=0) or a literal (is_lit=1, dt, lang)
    rename              s = old IRI, o = new IRI, one row per module where the IRI appears
    rename_ns           s = old namespace prefix, o = new one (mass rename)
    raw                 a raw RDF/XML block to append on save (extra.xml); its representable
                        triples are journaled as `add` rows tagged with the same extra.group
    raw_remove          drop the owl:Axiom reification(s) of (s, p, o) (extra.axiom = true)
    anon_remove         drop (s, p, <blank node>) where the blank node renders as extra.dl
    block_drop          delete the whole top-level XML block whose rdf:about is s
``extra`` is a JSON object (or NULL) carrying the op-specific payload described above.

Data flow: reads/writes the index db (tables nodes, stmt, changes, axiom_ann); `save()`
rewrites the .owl files of the workspace directory (backups in <dir>/backup/, temporary
<file>.owl.tmp), patches catalog-v001.xml after renames and touches the db mtime.

File writers (see `save()`):
- files < BIG_FILE_MB: streaming line rewrite first (keeps the original formatting), then
  a full reparse check (`_verify`); on any failure the file is restored and rewritten with
  rdflib (`_write_small`: load → apply → serialize, full rewrite, isomorphism
  check against the in-memory graph)
- big generated files: streaming line rewrite only (`_write_big`) — renames as attribute
  substitution, removals by re-serializing only the affected top-level blocks,
  additions appended before </rdf:RDF>. Nothing else is touched.

Anonymous individuals (blank nodes used as annotation values / assertion targets, indexed
as ``_:<id>`` by ``ontoviewer.anon``): a new one is written as a raw block nested in its
subject's description (`add_anon_individual`); statements added to / removed from an
existing one are journaled with ``extra.ref`` = the named entity whose block holds it, and
the writers re-serialize that block (and any top-level ``rdf:nodeID`` block of the node),
locating the blank node by its nodeID or by recomputing its stable id (`_bmap`).

Caveats: anonymous class expressions are not indexed, so they are only handled at save
time (by their DL rendering); the streaming writer relies on the usual RDF/XML layout (one
top-level block per entity, 4- or 2-space indent, end tag on its own line).
"""

import json
import os
import re
import shutil
import sqlite3
import time
from xml.sax.saxutils import escape

import rdflib
from rdflib.namespace import OWL, RDF, RDFS

from ontoviewer import anon, config, indexer, manchester, workspace
from ontoviewer.store import CANON

HERE = config.VIEWER_DIR
BIG_FILE_MB = 50  # files at/above this size are only ever written by the streaming writer
RDF_TYPE = str(RDF.type)
RDFS_LABEL = str(RDFS.label)
KIND_TYPES = indexer.KIND_TYPES  # declaration type IRI -> nodes.kind ('class', 'objprop', …)


FUZZY_LABEL = "http://www.semanticweb.org/ontologies/fuzzydl_ontology#fuzzyLabel"


# Opening line of a top-level block: 2 (rdflib) or 4 (OWL API) spaces of indent, the tag name,
# rdf:about="…" (named subject) or rdf:nodeID="…" (anonymous individual), optionally self-closing.
# Groups: (1) indent, (2) tag, (3) "about" | "nodeID", (4) IRI / nodeID, (5) "/" or "".
BLOCK_OPEN = re.compile(r'^( {2}| {4})<([\w:.-]+) rdf:(about|nodeID)="([^"]+)"\s*(/?)>')
_esc = manchester._esc  # XML attribute / text escaping shared with the expression writer
# Any IRI-valued attribute (rdf:about / rdf:resource): groups (1) attribute name, (2) IRI.
ATTR_IRI = re.compile(r'(rdf:about|rdf:resource)="([^"]+)"')
# The <rdf:RDF …> root open tag with all its xmlns declarations (may span several lines).
ROOT_TAG = re.compile(r"<rdf:RDF[^>]*>")


def _db():
    """Path of the SQLite index of the current workspace."""
    return workspace.db_path()


def _ont_dir():
    """Directory holding the .owl files of the current workspace."""
    return workspace.ont_dir()


# ---------------------------------------------------------------- db helpers


def connect():
    """Open the index db (rows as sqlite3.Row) and create the editing tables if missing.

    `changes` is the edit journal; `axiom_ann` (owl:Axiom annotations of assertions) is
    normally created by the indexer but older indexes may lack it.
    """
    c = sqlite3.connect(_db())
    c.row_factory = sqlite3.Row
    c.execute(
        """CREATE TABLE IF NOT EXISTS changes(
        id INTEGER PRIMARY KEY, ts REAL, op TEXT, graph TEXT, s TEXT, p TEXT,
        o TEXT, is_lit INT, dt TEXT, lang TEXT, extra TEXT)"""
    )
    # covering index for the scope filters (declared_in): older indexes may lack it
    c.execute("CREATE INDEX IF NOT EXISTS i_pog ON stmt(p, o_id, graph, s)")
    c.execute(
        """CREATE TABLE IF NOT EXISTS axiom_ann(
        s INT, p INT, o_id INT, o_lit TEXT, prop INT, value TEXT, graph TEXT)"""
    )
    return c


def node_id(c, iri, create=False):
    """Return the `nodes.id` of an IRI; None if unknown, unless `create` inserts it (kind/label NULL —
    the ``_:<id>`` pseudo-IRI of an anonymous individual gets kind 'anon')."""
    r = c.execute("SELECT id FROM nodes WHERE iri=?", (iri,)).fetchone()
    if r:
        return r["id"]
    if not create:
        return None
    c.execute("INSERT INTO nodes(iri, kind) VALUES(?,?)", (iri, "anon" if anon.is_anon(iri) else None))
    return c.execute("SELECT id FROM nodes WHERE iri=?", (iri,)).fetchone()["id"]


def declaring_graph(c, iri):
    """Module where the entity is declared (rdf:type owl:Class/…); None if imported/unknown.

    Falls back to the module of any statement having the entity as subject.
    """
    i = node_id(c, iri)
    if i is None:
        return None
    ti = node_id(c, RDF_TYPE)
    # all (module, type IRI) pairs of the entity's rdf:type statements
    for g, o in c.execute(
        """SELECT s.graph, n.iri FROM stmt s JOIN nodes n ON n.id=s.o_id
               WHERE s.s=? AND s.p=?""",
        (i, ti),
    ).fetchall():
        if o in KIND_TYPES:
            return g
    r = c.execute("SELECT graph FROM stmt WHERE s=? LIMIT 1", (i,)).fetchone()
    return r["graph"] if r else None


def _journal(c, op, graph, s, p=None, o=None, is_lit=0, dt=None, lang=None, extra=None):
    """Append one row to the `changes` journal (see the module docstring for the ops); `extra` is JSON-encoded.
    A new edit outside undo/redo invalidates the redo stack (``REDO``)."""
    if not _UNDO_REDO["on"]:
        REDO.clear()
    c.execute(
        "INSERT INTO changes(ts,op,graph,s,p,o,is_lit,dt,lang,extra) VALUES(?,?,?,?,?,?,?,?,?,?)",
        (time.time(), op, graph, s, p, o, is_lit, dt, lang, json.dumps(extra) if extra else None),
    )


def anon_referrer(c, iri):
    """Named entity whose description holds the anonymous individual ``iri`` (nested anonymous
    individuals are followed upwards); None when nothing references it.

    Recorded in the journal (``extra.ref``) of every statement about an anonymous individual so
    that the file writers know which top-level block to rewrite (``_group_ops``).
    """
    seen = set()
    while anon.is_anon(iri) and iri not in seen:
        seen.add(iri)
        r = c.execute(
            """SELECT n.iri FROM stmt st JOIN nodes n ON n.id=st.s
               WHERE st.o_id=(SELECT id FROM nodes WHERE iri=?) ORDER BY n.iri LIKE '_:%' LIMIT 1""",
            (iri,),
        ).fetchone()  # a named referrer first (LIKE = 0 sorts before 1)
        if not r:
            return None
        iri = r["iri"]
    return None if anon.is_anon(iri) else iri


def _with_ref(c, s, extra=None):
    """Journal ``extra`` of an operation on subject ``s``: unchanged for a named subject; for an
    anonymous individual the referring named entity is added as ``ref`` (see ``anon_referrer``)."""
    if not anon.is_anon(s):
        return extra
    return dict(extra or {}, ref=anon_referrer(c, s))


def _refresh_kind_label(c, si, p, o_id, o_lit):
    """Keep the denormalised `nodes.kind` / `nodes.label` columns in sync after adding (si, p, o).

    A declaration triple (rdf:type owl:Class/…) sets the kind; an rdfs:label literal sets the label.
    """
    if p == RDF_TYPE and o_id is not None:
        oiri = c.execute("SELECT iri FROM nodes WHERE id=?", (o_id,)).fetchone()["iri"]
        if oiri in KIND_TYPES:
            c.execute("UPDATE nodes SET kind=? WHERE id=?", (KIND_TYPES[oiri], si))
    if p == RDFS_LABEL and o_lit is not None:
        c.execute("UPDATE nodes SET label=? WHERE id=?", (o_lit, si))


# ---------------------------------------------------------------- edit ops


def add_triple(c, graph, s, p, o=None, lit=None, dt=None, lang=None, journal=True, extra=None):
    """Insert the triple (s, p, o | lit) into module `graph` and journal it as an `add`.

    Exactly one of `o` (object IRI) and `lit` (literal value, with optional `dt` / `lang`)
    is given. Missing nodes are created. Returns False when the identical statement is
    already in the module (nothing is inserted or journaled). `journal=False` is used by
    `discard()` to undo a removal without producing a new journal row; `extra` is stored in
    the journal row (e.g. the group id of a raw block; for an anonymous subject its referrer).
    """
    si, pi = node_id(c, s, True), node_id(c, p, True)
    oi = node_id(c, o, True) if o is not None else None
    # `IS` (not `=`) so that NULL object columns compare equal
    exists = c.execute(
        "SELECT 1 FROM stmt WHERE s=? AND p=? AND o_id IS ? AND o_lit IS ? AND graph=?", (si, pi, oi, lit, graph)
    ).fetchone()
    if exists:
        return False
    c.execute("INSERT INTO stmt VALUES(?,?,?,?,?,?,?)", (si, pi, oi, lit, dt, lang, graph))
    _refresh_kind_label(c, si, p, oi, lit)
    if journal:
        _journal(
            c,
            "add",
            graph,
            s,
            p,
            o if o is not None else lit,
            0 if o is not None else 1,
            dt,
            lang,
            _with_ref(c, s, extra),
        )
    return True


def remove_triple(c, s, p, o=None, lit=None, graph=None, journal=True):
    """Delete the triple (s, p, o | lit) from one module (`graph`) or from every module.

    Each deleted statement is journaled as a `remove` in its own module (with its stored
    datatype/language). Removing an rdfs:label re-derives `nodes.label` from any label left.
    Returns the number of statements deleted (0 if s or p is unknown).
    """
    si, pi = node_id(c, s), node_id(c, p)
    oi = node_id(c, o) if o is not None else None
    if si is None or pi is None:
        return 0
    rows = c.execute(
        "SELECT rowid, graph, dt, lang FROM stmt WHERE s=? AND p=? AND o_id IS ? AND o_lit IS ?"
        + (" AND graph=?" if graph else ""),
        (si, pi, oi, lit) + ((graph,) if graph else ()),
    ).fetchall()
    ref = _with_ref(c, s)  # referrer of an anonymous subject, looked up before its statements go
    for r in rows:
        c.execute("DELETE FROM stmt WHERE rowid=?", (r["rowid"],))
        if journal:
            _journal(
                c,
                "remove",
                r["graph"],
                s,
                p,
                o if o is not None else lit,
                0 if o is not None else 1,
                r["dt"],
                r["lang"],
                ref,
            )
    if p == RDFS_LABEL:
        # label column := first remaining rdfs:label of the subject (NULL if none)
        c.execute(
            """UPDATE nodes SET label=(SELECT o_lit FROM stmt WHERE s=? AND p=? LIMIT 1)
                     WHERE id=?""",
            (si, pi, si),
        )
    return len(rows)


def create_entity(c, graph, iri, kind, label=None):
    """Declare a new entity of `kind` ('class', 'objprop', …, see KIND_TYPES) in module `graph`.

    Adds the rdf:type declaration and, if given, an English rdfs:label; sets `nodes.kind`.
    Raises ValueError when the IRI already has statements (a node without statements —
    e.g. left over by `delete_entity` — may be reused).
    """
    type_iri = {v: k for k, v in KIND_TYPES.items()}[kind]
    if (
        node_id(c, iri) is not None
        and c.execute("SELECT 1 FROM stmt WHERE s=(SELECT id FROM nodes WHERE iri=?)", (iri,)).fetchone()
    ):
        raise ValueError("IRI already exists")
    add_triple(c, graph, iri, RDF_TYPE, type_iri)
    if kind == "individual":
        pass
    if label:
        add_triple(c, graph, iri, RDFS_LABEL, lit=label, dt=None, lang="en")
    c.execute("UPDATE nodes SET kind=? WHERE iri=?", (kind, iri))


def delete_entity(c, iri):
    """Remove every statement having `iri` as subject or object (all modules), journaling each.

    The node row is kept (statements of other journal rows may refer to it) but its kind and
    label are cleared. Returns the number of statements removed.
    """
    i = node_id(c, iri)
    if i is None:
        return 0
    n = 0
    ref = _with_ref(c, iri)  # anonymous individual: its referrer, before the statements go
    # every statement mentioning the entity, resolved to IRIs so it can be journaled
    for r in c.execute(
        """SELECT s.rowid, s.graph, ns.iri AS s_iri, np.iri AS p_iri, no.iri AS o_iri,
                      s.o_lit, s.dt, s.lang FROM stmt s
               JOIN nodes ns ON ns.id=s.s JOIN nodes np ON np.id=s.p
               LEFT JOIN nodes no ON no.id=s.o_id WHERE s.s=? OR s.o_id=?""",
        (i, i),
    ).fetchall():
        c.execute("DELETE FROM stmt WHERE rowid=?", (r["rowid"],))
        _journal(
            c,
            "remove",
            r["graph"],
            r["s_iri"],
            r["p_iri"],
            r["o_iri"] if r["o_iri"] is not None else r["o_lit"],
            0 if r["o_iri"] is not None else 1,
            r["dt"],
            r["lang"],
            ref if r["s_iri"] == iri else _with_ref(c, r["s_iri"]),
        )
        n += 1
    c.execute("UPDATE nodes SET kind=NULL, label=NULL WHERE id=?", (i,))
    return n


def rename_entity(c, old, new):
    """Rename an IRI in the index and journal a `rename` for every module where it appears.

    Statements reference the node id, so only `nodes.iri` changes. Raises ValueError if
    `old` is unknown or `new` already exists. Returns the list of affected modules.
    """
    i = node_id(c, old)
    if i is None:
        raise ValueError("IRI not found")
    if node_id(c, new) is not None:
        raise ValueError("target IRI already exists")
    graphs = [g for (g,) in c.execute("SELECT DISTINCT graph FROM stmt WHERE s=? OR o_id=?", (i, i)).fetchall()]
    c.execute("UPDATE nodes SET iri=? WHERE id=?", (new, i))  # statements follow the node id
    for g in graphs:
        _journal(c, "rename", g, old, None, new)
    return graphs


def rename_namespace(c, old_ns, new_ns):
    """Mass rename: every IRI starting with old_ns gets new_ns (all modules).

    Journals one `rename_ns` per module containing such an IRI (as subject or object).
    Raises ValueError for an empty/unchanged prefix or when no IRI matches.
    Returns {"entities": <renamed IRIs>, "graphs": [modules]}.
    """
    if not old_ns or old_ns == new_ns:
        raise ValueError("invalid namespace")
    n = c.execute("SELECT COUNT(*) FROM nodes WHERE iri LIKE ? || '%'", (old_ns,)).fetchone()[0]
    if n == 0:
        raise ValueError("no entity with this namespace")
    # modules with at least one statement whose subject or object is in the namespace
    graphs = [
        g
        for (g,) in c.execute(
            """SELECT DISTINCT graph FROM stmt WHERE s IN (SELECT id FROM nodes WHERE iri LIKE ?||'%')
           OR o_id IN (SELECT id FROM nodes WHERE iri LIKE ?||'%')""",
            (old_ns, old_ns),
        ).fetchall()
    ]
    # SUBSTR is 1-based: keep the part of the IRI after the old prefix
    c.execute("UPDATE nodes SET iri = ? || SUBSTR(iri, ?) WHERE iri LIKE ? || '%'", (new_ns, len(old_ns) + 1, old_ns))
    for g in graphs:
        _journal(c, "rename_ns", g, old_ns, None, new_ns)
    return {"entities": n, "graphs": graphs}


def add_raw_block(c, graph, xml, triples, subject=None):
    """Complex addition (e.g. fuzzy datatype with anonymous restriction): the db gets
    the representable triples; on save the raw XML block is written instead.

    `triples` is a list of {"s", "p", "o" | "lit", "dt", "lang"} dicts; they are journaled
    as `add` rows sharing a group id with the `raw` row so that the streaming writer skips
    them (the XML carries them) while the rdflib writer applies both (idempotent adds).
    """
    gid = f"raw{int(time.time()*1000)}"
    for t in triples:
        add_triple(c, graph, t["s"], t["p"], t.get("o"), t.get("lit"), t.get("dt"), t.get("lang"), extra={"group": gid})
    _journal(c, "raw", graph, subject or triples[0]["s"], None, None, extra={"group": gid, "xml": xml})


def _axiom_xml(s, p, o=None, lit=None, dt=None, lang=None, prop=FUZZY_LABEL, value=""):
    """RDF/XML of an owl:Axiom reifying (s, p, o | lit) annotated with `prop` = `value`.

    The annotation property is written with a local `ann:` prefix bound to its namespace
    (split at the last '#' or '/'), so the block needs no extra root declarations.
    """
    if lit is not None:
        tgt = (
            f'<owl:annotatedTarget{" xml:lang=%s" % _q(lang) if lang else ""}'
            f'{" rdf:datatype=%s" % _q(dt) if dt else ""}>{escape(lit)}</owl:annotatedTarget>'
        )
    else:
        tgt = f'<owl:annotatedTarget rdf:resource="{o}"/>'
    pfx, local = prop.rsplit("#", 1) if "#" in prop else prop.rsplit("/", 1)
    return (
        "    <owl:Axiom>\n"
        f'        <owl:annotatedSource rdf:resource="{s}"/>\n'
        f'        <owl:annotatedProperty rdf:resource="{p}"/>\n'
        f"        {tgt}\n"
        f'        <ann:{local} xmlns:ann="{pfx}{"#" if "#" in prop else "/"}" >{escape(value)}</ann:{local}>\n'
        "    </owl:Axiom>"
    )


def _q(v):
    """Double-quote a value for use as an XML attribute (escaping embedded quotes)."""
    return '"' + str(v).replace('"', "&quot;") + '"'


def _qname(prop):
    """(qualified element name, xmlns attribute) of a property IRI: the canonical prefix for the rdf /
    rdfs / owl / xsd vocabularies (declared by every module root), otherwise a local ``ns1`` prefix
    bound on the element itself (``xmlns:ns1="…"``) so the block is valid whatever the file declares."""
    cut = max(prop.rfind("#"), prop.rfind("/")) + 1
    ns, local = prop[:cut], prop[cut:]
    if ns in CANON:
        return f"{CANON[ns]}:{local}", ""
    return f"ns1:{local}", f' xmlns:ns1="{_esc(ns)}"'


def _ref_attr(iri, attr="resource"):
    """``rdf:<attr>="…"`` for an IRI, ``rdf:nodeID="…"`` for the pseudo-IRI of an anonymous individual."""
    if anon.is_anon(iri):
        return f'rdf:nodeID="{_esc(iri[len(anon.PREFIX):])}"'
    return f'rdf:{attr}="{_esc(iri)}"'


def _prop_elem(prop, ind, o=None, lit=None, dt=None, lang=None, inner=None):
    """One RDF/XML property element of ``prop`` at indent ``ind``: a reference (``o``: IRI or
    anonymous individual), a literal (``lit`` with ``dt`` or ``lang``) or a nested node element
    (``inner``, already indented one level deeper)."""
    tag, decl = _qname(prop)
    if o is not None:
        return f"{ind}<{tag}{decl} {_ref_attr(o)}/>"
    if inner is not None:
        return f"{ind}<{tag}{decl}>\n{inner}\n{ind}</{tag}>"
    attrs = f' xml:lang="{_esc(lang)}"' if lang else f' rdf:datatype="{_esc(dt)}"' if dt else ""
    return f"{ind}<{tag}{decl}{attrs}>{escape(lit or '')}</{tag}>"


def negative_xml(s, prop, o=None, lit=None, dt=None):
    """RDF/XML owl:NegativePropertyAssertion block: source individual ``s`` (named, or an anonymous
    ``_:<id>`` written as rdf:nodeID), ``prop`` and the target individual ``o`` or literal ``lit``
    (with optional datatype ``dt``)."""
    if o:
        tgt = f"        <owl:targetIndividual {_ref_attr(o)}/>\n"
    else:
        tgt = (
            f'        <owl:targetValue{" rdf:datatype=" + _q(dt) if dt else ""}>{escape(lit or "")}</owl:targetValue>\n'
        )
    return (
        "    <owl:NegativePropertyAssertion>\n"
        f"        <owl:sourceIndividual {_ref_attr(s)}/>\n"
        f'        <owl:assertionProperty rdf:resource="{_esc(prop)}"/>\n'
        + tgt
        + "    </owl:NegativePropertyAssertion>\n"
    )


def _four(entry):
    """A journal / payload entry padded to (p, value, dt, lang) — shorter lists mean no datatype / language."""
    return (list(entry) + [None, None, None])[:4]


def _anon_xml(node, spec, ind, triples, blocks):
    """``<rdf:Description rdf:nodeID="node">`` of a new anonymous individual described by ``spec``
    (see ``add_anon_individual``), indented by ``ind``.

    The index triples of its statements are appended to ``triples`` (named / literal objects; a
    class expression type is file-only) and its owl:NegativePropertyAssertion blocks to ``blocks``;
    nested anonymous individuals ({"anon": spec} values) recurse with a fresh nodeID.
    """
    me, n, lines = anon.iri(node), ind + "    ", []

    def ref(prop, v):
        """Element of an object-valued statement: IRI string, {"iri": …} or a nested {"anon": spec}."""
        if isinstance(v, dict) and "anon" in v:
            child = anon.new_id()
            triples.append({"s": me, "p": prop, "o": anon.iri(child)})
            return _prop_elem(prop, n, inner=_anon_xml(child, v["anon"], n + "    ", triples, blocks))
        v = v["iri"] if isinstance(v, dict) else v
        triples.append({"s": me, "p": prop, "o": v})
        return _prop_elem(prop, n, o=v)

    def literal(prop, v, dt, lang):
        """Element of a literal statement."""
        triples.append({"s": me, "p": prop, "lit": v, "dt": dt or None, "lang": lang or None})
        return _prop_elem(prop, n, lit=v, dt=dt, lang=lang)

    for t in spec.get("types") or []:
        if isinstance(t, dict) and "expr" in t:  # anonymous class (Manchester syntax): written, not indexed
            lines.append(manchester.prop_xml("rdf:type", manchester.parse(t["expr"]), n))
        else:
            lines.append(ref(RDF_TYPE, t))
    for prop, o in spec.get("obj") or []:
        lines.append(ref(prop, o))
    for prop, lit, dt, lang in map(_four, spec.get("data") or []):
        lines.append(literal(prop, lit, dt, lang))
    for prop, v, dt, lang in map(_four, spec.get("annotations") or []):
        lines.append(literal(prop, v, dt, lang) if isinstance(v, str) else ref(prop, v))
    for prop, o in spec.get("neg_obj") or []:
        blocks.append(negative_xml(me, prop, o=o))
    for prop, lit, dt, _lang in map(_four, spec.get("neg_data") or []):
        blocks.append(negative_xml(me, prop, lit=lit, dt=dt))
    if not lines:
        return f'{ind}<rdf:Description rdf:nodeID="{node}"/>'
    return f'{ind}<rdf:Description rdf:nodeID="{node}">\n' + "\n".join(lines) + f"\n{ind}</rdf:Description>"


def add_anon_individual(c, graph, s, p, spec):
    """Assert (s, p, <new anonymous individual>) in module `graph`; the new node is described by `spec`:
    {"annotations": [[p, value, dt, lang]…], "types": [class IRI | {"expr": Manchester text}…],
    "obj": [[p, o]…], "data": [[p, lit, dt, lang]…], "neg_obj": [[p, o]…], "neg_data": [[p, lit, dt,
    lang]…]} — an annotation ``value`` / an ``o`` is a literal string, an IRI, {"iri": …} or a
    nested {"anon": spec}.

    The description is written on save as a raw block nested in the subject's element
    (``<rdf:Description rdf:nodeID="genid…">``, negative assertions as separate blocks); its
    statements are indexed at once under the pseudo-IRI ``_:<nodeID>`` (kind 'anon') and
    journaled in the raw block's group.  When ``s`` is itself an anonymous individual the new
    node is a top-level nodeID block and the (s, p, node) link is journaled as a plain add, so the
    block holding ``s`` is rewritten to reference it.  Returns the pseudo-IRI of the new node.
    """
    node = anon.new_id()
    triples, blocks = [], []
    if anon.is_anon(s):
        xml = _anon_xml(node, spec, "    ", triples, blocks) + "\n" + "".join(blocks)
        add_raw_block(c, graph, xml, triples, subject=s)
        add_triple(c, graph, s, p, o=anon.iri(node))
    else:
        triples.append({"s": s, "p": p, "o": anon.iri(node)})
        inner = _anon_xml(node, spec, "            ", triples, blocks)
        xml = (
            f"    <rdf:Description {_ref_attr(s, 'about')}>\n"
            + _prop_elem(p, "        ", inner=inner)
            + "\n    </rdf:Description>\n"
            + "".join(blocks)
        )
        add_raw_block(c, graph, xml, triples, subject=s)
    return anon.iri(node)


def remove_anon(c, graph, s, p, dl):
    """Remove an axiom whose object is an anonymous expression (identified by its DL text)
    on save; nothing to change in the index (blank nodes are not indexed)."""
    _journal(c, "anon_remove", graph, s, p, None, 0, extra={"dl": dl})


def drop_block(c, graph, iri):
    """Delete a whole top-level block (rdf:about = iri) on save — used for SWRL rules; the
    indexed triples of the subject are removed right away."""
    delete_entity(c, iri)
    _journal(c, "block_drop", graph, iri)


def add_axiom_annotation(c, graph, s, p, o=None, lit=None, dt=None, lang=None, prop=FUZZY_LABEL, value=""):
    """Annotate an existing assertion (owl:Axiom reification), e.g. a fuzzy degree.

    The `axiom_ann` row for (s, p, o, prop) is replaced. Two journal rows are written: a
    `raw_remove` that drops any previous owl:Axiom block of the assertion on save, and a
    `raw` block (group "ax<ms>") with the new reification from `_axiom_xml`.
    """
    si, pi, oi = node_id(c, s, True), node_id(c, p, True), node_id(c, o, True) if o else None
    prop_id = node_id(c, prop, True)
    # rows replaced now, saved in the journal so that discard() can put them back
    prev = c.execute(
        "SELECT prop, value FROM axiom_ann WHERE s=? AND p=? AND o_id IS ? AND o_lit IS ? AND prop=?",
        (si, pi, oi, lit, prop_id),
    ).fetchall()
    c.execute(
        "DELETE FROM axiom_ann WHERE s=? AND p=? AND o_id IS ? AND o_lit IS ? AND prop=?",
        (si, pi, oi, lit, prop_id),
    )
    c.execute("INSERT INTO axiom_ann VALUES(?,?,?,?,?,?,?)", (si, pi, oi, lit, prop_id, value, graph))
    _journal(
        c,
        "raw_remove",
        graph,
        s,
        p,
        o if o else lit,
        0 if o else 1,
        dt,
        lang,
        extra={"axiom": True, "prev": [[r["prop"], r["value"]] for r in prev]},
    )  # drop any previous annotation block on this axiom
    _journal(
        c,
        "raw",
        graph,
        s,
        p,
        o if o else lit,
        0 if o else 1,
        dt,
        lang,
        extra={
            "group": f"ax{int(time.time()*1000)}",
            "xml": _axiom_xml(s, p, o, lit, dt, lang, prop, value),
            "axiom": True,
            "prop": prop_id,  # the axiom_ann row inserted above, removed again by discard()
            "value": value,
        },
    )


def remove_axiom_annotation(c, graph, s, p, o=None, lit=None, dt=None, lang=None):
    """Drop every owl:Axiom annotation of the assertion (s, p, o | lit).

    The removed `axiom_ann` rows are stored in the journal (`raw_remove`, extra.prev =
    [[prop id, value], …]) so that `discard()` can restore them. Returns their number.
    """
    si, pi, oi = node_id(c, s), node_id(c, p), node_id(c, o) if o else None
    rows = c.execute(
        "SELECT prop, value FROM axiom_ann WHERE s=? AND p=? AND o_id IS ? AND o_lit IS ?", (si, pi, oi, lit)
    ).fetchall()
    c.execute("DELETE FROM axiom_ann WHERE s=? AND p=? AND o_id IS ? AND o_lit IS ?", (si, pi, oi, lit))
    _journal(
        c,
        "raw_remove",
        graph,
        s,
        p,
        o if o else lit,
        0 if o else 1,
        dt,
        lang,
        extra={"axiom": True, "prev": [[r["prop"], r["value"]] for r in rows]},
    )
    return len(rows)


# ---------------------------------------------------------------- journal


def list_changes(c):
    """All journal rows as dicts, oldest first."""
    return [dict(r) for r in c.execute("SELECT * FROM changes ORDER BY id").fetchall()]


def _revert_change(c, ch):
    """Undo one journal row on the db (no journaling).

    add ↔ remove are inverted; renames are applied backwards on `nodes.iri`; `raw_remove` rows
    restore the `axiom_ann` rows they saved. Ops that only matter at save time (raw without an
    axiom annotation, anon_remove, block_drop) need no undo.
    """
    o_iri = None if ch["is_lit"] else ch["o"]
    lit = ch["o"] if ch["is_lit"] else None
    if ch["op"] == "add":
        remove_triple(c, ch["s"], ch["p"], o_iri, lit, ch["graph"], journal=False)
    elif ch["op"] == "remove":
        add_triple(c, ch["graph"], ch["s"], ch["p"], o_iri, lit, ch["dt"], ch["lang"], journal=False)
    elif ch["op"] == "rename":
        i = node_id(c, ch["o"])
        if i is not None:
            c.execute("UPDATE nodes SET iri=? WHERE id=?", (ch["s"], i))
    elif ch["op"] == "rename_ns":
        # swap the prefixes back: s = old namespace, o = new one
        c.execute(
            "UPDATE nodes SET iri = ? || SUBSTR(iri, ?) WHERE iri LIKE ? || '%'",
            (ch["s"], len(ch["o"]) + 1, ch["o"]),
        )
    elif ch["op"] in ("raw", "raw_remove") and ch["extra"] and json.loads(ch["extra"]).get("axiom"):
        ex = json.loads(ch["extra"])
        si, pi = node_id(c, ch["s"]), node_id(c, ch["p"]) if ch["p"] else None
        oi = None if ch["is_lit"] else node_id(c, ch["o"])
        lit = ch["o"] if ch["is_lit"] else None
        if ch["op"] == "raw_remove":
            for prop, value in ex.get("prev", []):
                c.execute("INSERT INTO axiom_ann VALUES(?,?,?,?,?,?,?)", (si, pi, oi, lit, prop, value, ch["graph"]))
        elif ex.get("prop") is not None:  # raw: drop the annotation row the edit inserted
            c.execute(
                "DELETE FROM axiom_ann WHERE s=? AND p=? AND o_id IS ? AND o_lit IS ? AND prop=? AND value=?",
                (si, pi, oi, lit, ex["prop"], ex["value"]),
            )


def _drop_orphan_anon(c):
    """Drop node rows of anonymous individuals left without any statement (created in the session).

    Correlated EXISTS: index lookups per candidate, no materialisation of the statement table.
    """
    c.execute(
        """DELETE FROM nodes WHERE kind='anon' AND NOT EXISTS (SELECT 1 FROM stmt WHERE s=nodes.id)
           AND NOT EXISTS (SELECT 1 FROM stmt WHERE o_id=nodes.id)"""
    )


def discard(c):
    """Revert the db by undoing the journal in reverse order (see ``_revert_change``).

    Clears the journal and commits.
    """
    for ch in reversed(list_changes(c)):
        _revert_change(c, ch)
    _drop_orphan_anon(c)
    c.execute("DELETE FROM changes")
    c.commit()


def undo_last(c):
    """Undo the newest logical change: the last journal row, or — when it belongs to a grouped
    edit (``extra.group``, e.g. one OWL expression journaled as many triples) — the whole
    trailing group. Reverts the rows, deletes them from the journal and commits.

    Returns the number of journal rows undone (0 when the journal is empty).
    """
    rows = list_changes(c)
    if not rows:
        return 0
    gid = json.loads(rows[-1]["extra"]).get("group") if rows[-1]["extra"] else None
    tail = []
    for ch in reversed(rows):
        g = json.loads(ch["extra"]).get("group") if ch["extra"] else None
        if ch is rows[-1] or (gid is not None and g == gid):
            tail.append(ch)
        else:
            break
    _UNDO_REDO["on"] = True
    try:
        for ch in tail:  # already newest-first
            _revert_change(c, ch)
    finally:
        _UNDO_REDO["on"] = False
    _drop_orphan_anon(c)
    c.execute(f"DELETE FROM changes WHERE id IN ({','.join('?' * len(tail))})", [ch["id"] for ch in tail])
    c.commit()
    if all(ch["op"] in ("add", "remove") for ch in tail):
        REDO.append([dict(ch) for ch in reversed(tail)])  # original order, for redo_last
    else:
        REDO.clear()  # renames / raw ops cannot be re-applied mechanically
    return len(tail)


# ---------------------------------------------------------------- file writers


def _uri(v):
    """rdflib term of a journal IRI: a BNode for the ``_:<id>`` pseudo-IRI of an anonymous individual
    (its nodeID, as the files are parsed with preserved blank-node ids), else a URIRef."""
    return anon.bnode(v) if anon.is_anon(v) else rdflib.URIRef(v)


def _needs_bmap(ops):
    """True when a journal row mentions an anonymous individual (the writer must map its pseudo-IRI)."""
    return any(anon.is_anon(ch["s"]) or (not ch["is_lit"] and anon.is_anon(ch["o"])) for ch in ops)


def _bmap(g, fname, known):
    """{"_:<id>": BNode} of the anonymous individuals of the parsed file / block ``g`` — the inverse of
    ``anon.node_ids`` — so the journal rows find their blank node.

    Blank nodes whose name differs from their id (no rdf:nodeID in the file: the id is the stable
    hash) are relabelled to it, so that the rewritten XML carries ``rdf:nodeID="<id>"`` and the id
    survives the save (``known`` = nodeIDs written in the file / block text).
    """
    out = {}
    for b, iri in anon.node_ids(g, fname, known).items():
        name = iri[len(anon.PREFIX) :]
        if str(b) != name:
            nb = rdflib.BNode(name)
            for t in list(g.triples((b, None, None))):
                g.remove(t)
                g.add((nb, t[1], t[2]))
            for t in list(g.triples((None, None, b))):
                g.remove(t)
                g.add((t[0], t[1], nb))
            b = nb
        out[iri] = b
    return out


def _remove_closure(g, node):
    """Remove every statement of ``node`` and, recursively, of the blank nodes it points to."""
    stack, seen = [node], set()
    while stack:
        n = stack.pop()
        if n in seen:
            continue
        seen.add(n)
        for t in list(g.triples((n, None, None))):
            g.remove(t)
            if isinstance(t[2], rdflib.BNode):
                stack.append(t[2])


def _lit(ch):
    """rdflib.Literal of the object of a literal journal row (datatype / language as stored)."""
    return rdflib.Literal(ch["o"], datatype=_uri(ch["dt"]) if ch["dt"] else None, lang=ch["lang"] or None)


def _apply_to_graph(g, ops, bmap=None):
    """Replay journal rows on an rdflib Graph (a whole file, one block, or an empty fragment).

    Handles every op: add/remove of a triple (an anonymous individual left unreferenced by a
    removal is dropped with its closure), anon_remove / block_drop (removing the blank node
    closure as well), rename / rename_ns (subject and object positions; rename_ns also
    predicates), raw (parse the XML block and merge it) and raw_remove (owl:Axiom
    reifications of the triple).  ``bmap`` (see ``_bmap``) maps the pseudo-IRIs of the
    anonymous individuals of ``g``; one outside it (a node created in this session) becomes
    ``BNode(id)``, which the raw block declaring it (``rdf:nodeID``) merges with.
    """
    bmap = bmap or {}

    def term(v):
        """rdflib term of a journal IRI / pseudo-IRI (None stays None)."""
        return None if v is None else bmap.get(v) or _uri(v)

    for ch in ops:
        s, p = term(ch["s"]), term(ch["p"])
        o = _lit(ch) if ch["is_lit"] else term(ch["o"])
        if ch["op"] == "add":
            g.add((s, p, o))
        elif ch["op"] == "remove":
            g.remove((s, p, o))
            if isinstance(o, rdflib.BNode) and (None, None, o) not in g:
                _remove_closure(g, o)  # anonymous individual no longer referenced: drop its description
        elif ch["op"] == "anon_remove":  # (s, p, <anonymous expression>) identified by its DL text
            from ontoviewer import axioms as _ax

            want = json.loads(ch["extra"])["dl"]
            R = _ax.Renderer(g, set())
            for o in list(g.objects(s, p)):
                if isinstance(o, rdflib.BNode) and R.dl(o) == want:
                    g.remove((s, p, o))
                    _remove_closure(g, o)  # the whole anonymous sub-structure (nested restrictions, lists, …)
        elif ch["op"] == "block_drop":  # subject and everything reachable through blank nodes
            _remove_closure(g, s)
        elif ch["op"] == "rename":
            old, new = s, _uri(ch["o"])
            for t in list(g.triples((old, None, None))):
                g.remove(t)
                g.add((new, t[1], t[2]))
            for t in list(g.triples((None, None, old))):
                g.remove(t)
                g.add((t[0], t[1], new))
        elif ch["op"] == "rename_ns":
            old_ns, new_ns = ch["s"], ch["o"]

            def ren(t):
                """Move a term from the old namespace to the new one (other terms unchanged)."""
                if isinstance(t, rdflib.URIRef) and str(t).startswith(old_ns):
                    return _uri(new_ns + str(t)[len(old_ns) :])
                return t

            for t in list(g):
                nt = tuple(ren(x) for x in t)
                if nt != t:
                    g.remove(t)
                    g.add(nt)
        elif ch["op"] == "raw":
            frag = anon.graph_from_xml(data=_wrap(json.loads(ch["extra"])["xml"]))
            for t in frag:
                g.add(t)
        elif ch["op"] == "raw_remove":  # drop owl:Axiom reifications of (s, p, o)
            for ax in list(g.subjects(OWL.annotatedSource, s)):
                if (ax, OWL.annotatedProperty, p) in g and (ax, OWL.annotatedTarget, o) in g:
                    g.remove((ax, None, None))


def _wrap(xml):
    """Wrap a raw XML block in an <rdf:RDF> root declaring the standard and SDF prefixes, for parsing."""
    return (
        '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" '
        'xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#" '
        'xmlns:owl="http://www.w3.org/2002/07/owl#" '
        'xmlns:xsd="http://www.w3.org/2001/XMLSchema#" '
        'xmlns:sdf-class="http://www.semanticweb.org/ontologies/fuzzydl_ontology/class#" '
        'xmlns:sdf-op="http://www.semanticweb.org/ontologies/fuzzydl_ontology/object-property#" '
        'xmlns:sdf-dp="http://www.semanticweb.org/ontologies/fuzzydl_ontology/data-property#" '
        'xmlns:sdf-datatype="http://www.semanticweb.org/ontologies/fuzzydl_ontology/datatype#" '
        'xmlns:sdf="http://www.semanticweb.org/ontologies/fuzzydl_ontology#">' + xml + "</rdf:RDF>"
    )


def _backup_path(path):
    """backup/<file>.<timestamp>.bak next to the ontology folder (keeps the last 5 per file).

    Creates the backup directory, deletes the oldest backups (all but 4, so that with the
    new one 5 remain) and returns the path to copy to.
    """
    bdir = path.parent / "backup"
    bdir.mkdir(exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    olds = sorted(bdir.glob(path.name + ".*.bak"))
    for o in olds[:-4]:
        o.unlink()
    return bdir / f"{path.name}.{stamp}.bak"


def _header_ns(path):
    """prefix -> uri declared on the file's rdf:RDF root ('' = default namespace).

    Only the first 16 kB are scanned (the root tag is always at the top).
    """
    head = path.read_text(encoding="utf-8", errors="replace")[:16000]
    root = re.search(r"<rdf:RDF[^>]*>", head)
    # xmlns="…" (default, prefix '') and xmlns:prefix="…" declarations of the root tag
    return dict(re.findall(r'xmlns(?::([\w.-]+))?="([^"]+)"', root.group(0))) if root else {}


def _write_small(path, ops):
    """Full rewrite with rdflib: parse the file, apply `ops`, serialize as pretty-xml.

    The file's own prefixes are re-bound so the output keeps them. The result is written
    to <file>.owl.tmp, reparsed and checked to be isomorphic to the in-memory graph
    (RuntimeError otherwise); then the original is backed up and replaced.
    Returns {"file", "triples_before", "triples_after", "mode": "rewrite"}.
    """
    import warnings
    from rdflib.compare import to_isomorphic

    g = anon.graph_from_xml(path)
    for prefix, uri in _header_ns(path).items():
        if prefix:
            g.bind(prefix, uri, override=True)
    n0 = len(g)
    _apply_to_graph(g, ops, _bmap(g, path.name, anon.file_node_ids(path)) if _needs_bmap(ops) else None)
    tmp = path.with_suffix(".owl.tmp")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        g.serialize(destination=str(tmp), format="pretty-xml")
    check = anon.graph_from_xml(tmp)
    if to_isomorphic(check) != to_isomorphic(g):
        tmp.unlink()
        raise RuntimeError(f"verification failed on {path.name}: the rewritten file is not isomorphic")
    shutil.copy2(path, _backup_path(path))
    tmp.replace(path)
    return {"file": path.name, "triples_before": n0, "triples_after": len(g), "mode": "rewrite"}


def _fragment(g, ns_map):
    """Top-level RDF/XML blocks of graph g, 4-space indented, using the file's prefixes.
    Returns (xml, {prefix: uri}) where the dict lists prefixes the fragment relies on."""
    import warnings

    for prefix, uri in ns_map.items():
        if prefix:
            g.bind(prefix, uri, override=True)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        xml = g.serialize(format="pretty-xml")
    root = ROOT_TAG.search(xml)
    # keep only what is between the root open tag and </rdf:RDF>; rdflib indents blocks by 2,
    # OWL API by 4 → add 2 spaces to every non-blank line
    inner = xml[root.end() :].rsplit("</rdf:RDF>", 1)[0].strip("\n")
    inner = "\n".join("  " + line if line.strip() else line for line in inner.splitlines())
    ns = dict(re.findall(r'xmlns:([\w.-]+)="([^"]+)"', root.group(0)))
    return inner, ns


def _group_ops(ops):
    """Split the journal rows of one file into what the streaming writer needs.

    Returns (renames, removes, adds, raws, ax_removes, drops):
    - renames: {old IRI: new IRI}; namespace renames are keyed "\\x00ns:<old prefix>"
    - removes: {subject IRI: [rows to apply on its block]} — blocks to re-serialize: the
      remove / anon_remove rows of a subject, plus every row about an anonymous individual
      keyed both by its pseudo-IRI (a top-level rdf:nodeID block) and by ``extra.ref`` (the
      named entity whose block nests it)
    - adds: add rows to append (those belonging to a raw block's group are skipped,
      their XML is written instead; adds on an anonymous subject go to ``removes``)
    - raws: XML strings of the raw blocks to append
    - ax_removes: raw_remove rows (owl:Axiom blocks to drop)
    - drops: subject IRIs whose whole block is deleted (their removes are discarded)
    """
    renames, removes, adds, raws, ax_removes = {}, {}, [], [], []
    skip_groups = {json.loads(c["extra"])["group"] for c in ops if c["op"] == "raw"}
    drops = {c["s"] for c in ops if c["op"] == "block_drop"}  # whole top-level blocks to delete (e.g. swrl:Imp)
    for ch in ops:
        ex = json.loads(ch["extra"]) if ch["extra"] else {}
        grp = ex.get("group")
        if ch["op"] == "rename":
            renames[ch["s"]] = ch["o"]
        elif ch["op"] == "rename_ns":
            renames["\x00ns:" + ch["s"]] = ch["o"]  # prefix rename, see _sub_iri
        elif ch["op"] in ("remove", "anon_remove"):
            removes.setdefault(ch["s"], []).append(ch)
            if ex.get("ref"):  # statement of an anonymous individual: also rewrite the block holding it
                removes.setdefault(ex["ref"], []).append(ch)
        elif ch["op"] == "add" and grp not in skip_groups:
            if anon.is_anon(ch["s"]):  # existing anonymous individual: rewrite its block(s), never append
                removes.setdefault(ch["s"], []).append(ch)
                if ex.get("ref"):
                    removes.setdefault(ex["ref"], []).append(ch)
            else:
                adds.append(ch)
        elif ch["op"] == "raw":
            raws.append(ex["xml"])
        elif ch["op"] == "raw_remove":
            ax_removes.append(ch)
    for d in drops:  # a dropped block never needs a rewrite
        removes.pop(d, None)
    return renames, removes, adds, raws, ax_removes, drops


def _axiom_matches(block_xml, ns_map, ch):
    """True if the owl:Axiom block reifies the (s, p, o) of the raw_remove row `ch`."""
    frag = anon.graph_from_xml(data=_wrap_ns(block_xml, ns_map))
    s, p = _uri(ch["s"]), _uri(ch["p"])
    o = _lit(ch) if ch["is_lit"] else _uri(ch["o"])
    return any(
        (ax, OWL.annotatedProperty, p) in frag and (ax, OWL.annotatedTarget, o) in frag
        for ax in frag.subjects(OWL.annotatedSource, s)
    )


def _wrap_ns(xml, ns_map):
    """Wrap an XML block in an <rdf:RDF> root declaring exactly the file's prefixes (`ns_map`)."""
    decl = " ".join(f'xmlns:{p}="{u}"' if p else f'xmlns="{u}"' for p, u in ns_map.items())
    return f"<rdf:RDF {decl}>{xml}</rdf:RDF>"


def _sub_iri(renames, iri):
    """Apply the rename map to one IRI: exact renames first, then namespace ("\\x00ns:" keys) prefixes."""
    if iri in renames:
        return renames[iri]
    for k, v in renames.items():
        if k.startswith("\x00ns:") and iri.startswith(k[4:]):
            return v + iri[len(k) - 4 :]  # len(k) - 4 == len(old prefix)
    return iri


def _unrename_ns(ns_renames, iri):
    """Original IRI of an already namespace-renamed one ({old prefix: new prefix}); unchanged if none applies."""
    for old, new in ns_renames.items():
        if iri.startswith(new):
            return old + iri[len(new) :]
    return iri


def _write_big(path, ops):
    """Streaming line-by-line rewrite of an RDF/XML file (formatting of untouched lines kept).

    Pass over the file into <file>.owl.tmp:
    - header (up to the end of the <rdf:RDF …> root tag): namespace renames applied to
      xmlns / xml:base values;
    - every other line: rdf:about / rdf:resource attributes renamed;
    - anonymous <owl:Axiom> blocks: buffered and dropped when they match a raw_remove;
    - top-level blocks (BLOCK_OPEN, rdf:about or rdf:nodeID) of a dropped subject: skipped;
      of a subject with removes: buffered, parsed, edited with `_apply_to_graph` (anonymous
      individuals located through `_bmap`) and re-serialized (or dropped when nothing is left);
    - before </rdf:RDF>: the serialized adds and the raw XML blocks are appended.
    Prefixes used by the new fragments but missing from the root are declared afterwards.
    Finally the original is backed up and replaced. Returns a stats dict (mode "stream").
    """
    renames, removes, adds, raws, ax_removes, drops = _group_ops(ops)
    ns_renames = {k[4:]: v for k, v in renames.items() if k.startswith("\x00ns:")}
    inv_renames = {v: k for k, v in renames.items() if not k.startswith("\x00ns:")}  # new IRI -> old IRI
    ns_map = _header_ns(path)
    tmp = path.with_suffix(".owl.tmp")
    n_blocks_rewritten = n_dropped = 0
    needed_ns = {}
    if adds:
        g = rdflib.Graph()
        _apply_to_graph(g, adds)
        add_xml, ns = _fragment(g, ns_map)
        needed_ns.update(ns)
    else:
        add_xml = ""

    def flush_block(block, block_tag, block_iri, fout):
        """Re-serialize one buffered top-level block after applying its removes (drop it if empty)."""
        nonlocal n_blocks_rewritten, n_dropped
        text = "".join(block)
        frag = anon.graph_from_xml(data=_wrap_ns(text, ns_map))
        ops_ = removes[block_iri]
        _apply_to_graph(frag, ops_, _bmap(frag, path.name, anon.text_node_ids(text)) if _needs_bmap(ops_) else None)
        # the block's attributes were already renamed line-wise, so look up the new subject
        subj = _uri(_sub_iri(renames, block_iri))
        if not list(frag.triples((subj, None, None))):
            n_dropped += 1
            return
        inner, ns = _fragment(frag, ns_map)
        needed_ns.update(ns)
        fout.write(inner + "\n")
        n_blocks_rewritten += 1

    with open(path, encoding="utf-8") as fin, open(tmp, "w", encoding="utf-8") as fout:
        header_done = False
        # block: buffered lines of the block being collected (None = not inside a block);
        # block_iri: its original subject IRI, None for an anonymous owl:Axiom, "\x00drop" for
        # a block being skipped; block_ind: its indent, used to recognise the end tag
        block, block_tag, block_iri, block_ind = None, None, None, "    "
        for line in fin:
            if not header_done:
                for old_ns, new_ns in ns_renames.items():  # xmlns / xml:base follow the namespace
                    line = line.replace(f'="{old_ns}"', f'="{new_ns}"')
                fout.write(line)
                # the root tag ends on the line of "<rdf:RDF" or on one of its "     xml…" continuation lines
                if "<rdf:RDF" in line or line.startswith("     xml"):
                    if line.rstrip().endswith(">") and "<?xml" not in line:
                        header_done = True
                continue
            if renames:
                line = ATTR_IRI.sub(lambda m: f'{m.group(1)}="{_sub_iri(renames, m.group(2))}"', line)
            # top-level (indent ≤ 4) <owl:Axiom> without rdf:about: candidate for a raw_remove
            if block is None and ax_removes and line.lstrip().startswith("<owl:Axiom") and line[:4].strip() == "":
                block, block_tag, block_iri = [line], "owl:Axiom", None  # anonymous axiom block
                block_ind = line[: len(line) - len(line.lstrip())]
                continue
            if block is not None and block_iri is None:
                block.append(line)
                if line.startswith(f"{block_ind}</owl:Axiom>"):
                    xml = "".join(block)
                    if not any(_axiom_matches(xml, ns_map, ch) for ch in ax_removes):
                        fout.write(xml)
                    else:
                        n_dropped += 1
                    block = None
                continue
            if block is None:
                m = BLOCK_OPEN.match(line)
                if m:
                    # the line is already renamed: removes/drops may be journaled under the old
                    # IRI (before a rename) or under the new one (after it) — accept both;
                    # an rdf:nodeID block is keyed by the pseudo-IRI of the anonymous individual
                    new_iri = m.group(4) if m.group(3) == "about" else anon.iri(m.group(4))
                    orig = inv_renames.get(new_iri) or _unrename_ns(ns_renames, new_iri)
                    if orig not in removes and orig not in drops and new_iri in (removes.keys() | drops):
                        orig = new_iri
                    if orig in drops:  # delete the whole block (self-closing or until its end tag)
                        n_dropped += 1
                        if m.group(5) != "/":
                            block, block_tag, block_iri, block_ind = ["drop"], m.group(2), "\x00drop", m.group(1)
                        continue
                    if orig in removes:
                        if m.group(5) == "/":  # self-closing one-line block
                            flush_block([line.replace("/>", "></" + m.group(2) + ">")], m.group(2), orig, fout)
                        else:
                            block, block_tag, block_iri = [line], m.group(2), orig
                            block_ind = m.group(1)
                        continue
                if line.strip() == "</rdf:RDF>":
                    if add_xml:
                        fout.write(add_xml + "\n")
                    for raw in raws:
                        fout.write(raw.rstrip("\n") + "\n")
                fout.write(line)
                continue
            block.append(line)
            if line.startswith(f"{block_ind}</{block_tag}>"):
                if block_iri != "\x00drop":
                    flush_block(block, block_tag, block_iri, fout)
                block = None
    # declare on the root any prefix the new fragments rely on
    missing = {p: u for p, u in needed_ns.items() if p not in ns_map and u not in ns_map.values()}
    if missing:
        head = tmp.read_text(encoding="utf-8", errors="replace")[:20000]
        root = ROOT_TAG.search(head).group(0)
        new_root = root[:-1] + "".join(f'\n     xmlns:{p}="{u}"' for p, u in missing.items()) + ">"
        data = tmp.read_bytes()
        tmp.write_bytes(data.replace(root.encode(), new_root.encode(), 1))
    shutil.copy2(path, _backup_path(path))
    tmp.replace(path)
    return {
        "file": path.name,
        "mode": "stream",
        "blocks_rewritten": n_blocks_rewritten,
        "blocks_dropped": n_dropped,
        "added_ops": len(adds),
        "raw_blocks": len(raws),
        "namespaces_added": list(missing),
    }


def _verify(path, ops):
    """Reparse a (small) file and check every journaled op is reflected.

    rename: the old IRI no longer appears; block_drop: no triple of the subject is left;
    anon_remove: no blank node with that DL text under (s, p); add/remove: the triple is
    present/absent (anonymous individuals resolved through `_bmap`); raw blocks are not
    checked. Returns True when everything matches.
    """
    g = anon.graph_from_xml(path)
    bmap = _bmap(g, path.name, anon.file_node_ids(path)) if _needs_bmap(ops) else {}

    def term(v):
        """rdflib term of a journal IRI / pseudo-IRI."""
        return bmap.get(v) or _uri(v)

    for ch in ops:
        s = term(ch["s"])
        if ch["op"] == "rename":
            if list(g.triples((s, None, None))) or list(g.triples((None, None, s))):
                return False
            continue
        if ch["op"] == "rename_ns":  # s = old prefix: no subject/object may still start with it
            old = ch["s"]
            if any(str(t).startswith(old) for s_, _, o_ in g for t in (s_, o_) if isinstance(t, rdflib.URIRef)):
                return False
            continue
        if ch["op"] == "raw":
            continue
        if ch["op"] == "raw_remove":  # the owl:Axiom reifying (s, p, o) must be gone; the assertion itself stays
            p = _uri(ch["p"])
            o = _lit(ch) if ch["is_lit"] else term(ch["o"])
            if any(
                (ax, OWL.annotatedProperty, p) in g and (ax, OWL.annotatedTarget, o) in g
                for ax in g.subjects(OWL.annotatedSource, s)
            ):
                return False
            continue
        if ch["op"] == "block_drop":
            if list(g.triples((s, None, None))):
                return False
            continue
        if ch["op"] == "anon_remove":
            from ontoviewer import axioms as _ax

            want = json.loads(ch["extra"])["dl"]
            R = _ax.Renderer(g, set())
            if any(isinstance(o, rdflib.BNode) and R.dl(o) == want for o in g.objects(s, _uri(ch["p"]))):
                return False
            continue
        p = _uri(ch["p"])
        o = _lit(ch) if ch["is_lit"] else term(ch["o"])
        present = (s, p, o) in g
        if (ch["op"] == "add") != present:
            return False
    return True


def save(c):
    """Write the journal into the .owl files, then clear it.

    Per module (sorted by name): files below BIG_FILE_MB are streamed (`_write_big`) and
    verified by a full reparse; on any error the file is restored from memory and fully
    rewritten with rdflib (`_write_small`, "fallback_reason" in the result). Bigger files
    are streamed only. Renamed IRIs / namespaces are also patched in catalog-v001.xml.
    The db mtime is bumped so the index is not considered stale. Raises RuntimeError if
    a journaled module file is missing. Returns {"saved": [per-file results]}.
    """
    ops = list_changes(c)
    if not ops:
        return {"saved": [], "message": "no changes"}
    results = []
    for graph in sorted({o["graph"] for o in ops if o["graph"]}):
        path = _ont_dir() / graph
        gops = [o for o in ops if o["graph"] == graph]
        if not path.exists():
            raise RuntimeError(f"missing file: {graph}")
        if path.stat().st_size < BIG_FILE_MB * 1e6:
            # small file: streaming write keeps the original formatting; verified by
            # a full reparse, with the rdflib full rewrite as fallback
            backup = path.read_bytes()
            try:
                res = _write_big(path, gops)
                if not _verify(path, gops):
                    raise RuntimeError("streaming write not verified")
                res["mode"] = "stream+verified"
                results.append(res)
            except Exception as e:
                path.write_bytes(backup)
                res = _write_small(path, gops)
                res["fallback_reason"] = str(e)
                results.append(res)
        else:
            results.append(_write_big(path, gops))
    # renamed ontology IRIs / namespaces must stay resolvable: update catalog-v001.xml
    cat = _ont_dir() / "catalog-v001.xml"
    if cat.exists():
        txt = orig = cat.read_text(encoding="utf-8", errors="replace")
        for ch in ops:
            if ch["op"] == "rename":
                txt = txt.replace(f'name="{ch["s"]}"', f'name="{ch["o"]}"')
            elif ch["op"] == "rename_ns":
                txt = txt.replace(f'name="{ch["s"]}', f'name="{ch["o"]}')  # prefix only: no closing quote
        if txt != orig:
            cat.write_text(txt, encoding="utf-8")
            results.append({"file": cat.name, "mode": "catalog updated"})
    c.execute("DELETE FROM changes")
    c.commit()
    now = time.time()
    os.utime(_db(), (now, now))  # db is in sync with the files just written
    return {"saved": results}


def duplicate_entity(c, iri, new_iri):
    """Duplicate an entity: every statement having it as SUBJECT is copied to ``new_iri`` as a
    journaled add (declaration and rdf:type first, so the new node gets its kind; statements
    where the entity is the object are NOT copied).  The adds share one ``extra.group``, so
    ``undo_last`` reverts the whole duplication at once.  Raises ValueError for an unknown
    source or an existing target.  Returns the number of statements copied.
    """
    si = node_id(c, iri)
    if si is None:
        raise ValueError(f"unknown entity: {iri}")
    if node_id(c, new_iri) is not None:
        raise ValueError(f"{new_iri} already exists")
    rows = c.execute(
        """SELECT p.iri AS p, no.iri AS o, s.o_lit AS lit, s.dt, s.lang, s.graph FROM stmt s
               JOIN nodes p ON p.id=s.p LEFT JOIN nodes no ON no.id=s.o_id
               WHERE s.s=? ORDER BY (p.iri != 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type')""",
        (si,),
    ).fetchall()
    gid = f"dup{int(time.time() * 1000)}"
    for r in rows:
        add_triple(c, r["graph"], new_iri, r["p"], r["o"], r["lit"], r["dt"], r["lang"], extra={"group": gid})
    return len(rows)


# redo stack of undo_last: each entry = the journal rows of one undone change (original order).
# In-memory (per server process); any NEW edit outside undo/redo clears it (see _journal).
REDO = []
_UNDO_REDO = {"on": False}  # guards _journal's redo-stack reset while undo/redo themselves run


def redo_last(c):
    """Re-apply the change most recently reverted by ``undo_last`` (adds / removes only; other
    ops clear the stack when undone).  The re-applied rows are journaled again — with their
    original ``extra.group`` — so a further undo works.  Returns the number of rows re-applied
    (0 when there is nothing to redo).
    """
    if not REDO:
        return 0
    rows = REDO.pop()
    _UNDO_REDO["on"] = True
    try:
        for ch in rows:
            o_iri = None if ch["is_lit"] else ch["o"]
            lit = ch["o"] if ch["is_lit"] else None
            extra = json.loads(ch["extra"]) if ch["extra"] else None
            if ch["op"] == "add":
                add_triple(c, ch["graph"], ch["s"], ch["p"], o_iri, lit, ch["dt"], ch["lang"], extra=extra)
            else:
                remove_triple(c, ch["s"], ch["p"], o_iri, lit, ch["graph"])
    finally:
        _UNDO_REDO["on"] = False
    c.commit()
    return len(rows)
