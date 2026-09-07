"""One-time indexer: parses the ontology modules of the workspace and builds their SQLite index.

The viewer reads only the database, so startup is instant and RAM stays low.
Re-run (``python3 indexer.py [--force]`` from ``code/viewer``, or let ``server.py`` /
``POST /api/reindex`` run it in the background) after regenerating the .owl files.

Index layout (one file per workspace, ``data/index_<hash>.db``, see ``workspace.db_path``):
    nodes(id, iri, label, kind, lname)              every IRI seen (subject, predicate or object) and
                                                    the anonymous individuals (iri ``_:<id>``, kind
                                                    'anon'); lname = lower-case local name (sort key)
    stmt(s, p, o_id, o_lit, dt, lang, graph)        triples with named / anonymous-individual subject
                                                    and object (``o_id`` xor ``o_lit``); ``graph`` = file
    metrics(graph, name, value)                     OWL API axiom counts per module
    axiom_ann(s, p, o_id, o_lit, prop, value, graph) annotations of reified axioms (owl:Axiom)
    datatype_bounds(id, kmin, kmax)                 numeric range of user datatypes (fuzzy domains)
    bnode_refs(s, ref, via, graph)                  named entities used inside anonymous
                                                    definitions of a named subject

Blank-node structures (restrictions, unions…) are NOT stored as statements; the viewer
re-reads the RDF/XML files when it needs them (``ontoviewer.axioms``).  Blank nodes used as
individuals (annotation values, assertion targets) ARE indexed, under the pseudo-IRI
``_:<id>`` assigned by ``ontoviewer.anon`` (the file's ``rdf:nodeID`` or a stable hash).

Module globals ``ONT_DIR``, ``FILES`` and ``DB`` are snapshots of the workspace taken at
import time; call ``refresh()`` after a workspace switch.  The build is protected by a
file lock (``config.LOCK_FILE``) so the server and a manual run cannot build concurrently.
"""

import sqlite3
import sys
import time

import rdflib
from rdflib.namespace import OWL, RDF, RDFS

from ontoviewer import anon, config, workspace

# current workspace (dir + files) — see workspace.py; re-read at build time
ONT_DIR = workspace.ont_dir()
FILES = workspace.load()["files"]
DB = workspace.db_path()

# rdf:type object → ``nodes.kind`` value; also the set of entity declaration types used
# by ``store.declared_in``
KIND_TYPES = {
    str(OWL.Class): "class",
    str(OWL.ObjectProperty): "objprop",
    str(OWL.DatatypeProperty): "dataprop",
    str(OWL.AnnotationProperty): "annprop",
    str(RDFS.Datatype): "datatype",
    str(OWL.NamedIndividual): "individual",
    str(OWL.Ontology): "ontology",
}


# property characteristics (rdf:type objects) → OWL API axiom type name used in the metrics;
# the object-property names are replaced by FunctionalDataProperty for data properties
CHARACT = {
    OWL.FunctionalProperty: "FunctionalObjectProperty",
    OWL.InverseFunctionalProperty: "InverseFunctionalObjectProperty",
    OWL.TransitiveProperty: "TransitiveObjectProperty",
    OWL.SymmetricProperty: "SymmetricObjectProperty",
    OWL.AsymmetricProperty: "AsymmetricObjectProperty",
    OWL.ReflexiveProperty: "ReflexiveObjectProperty",
    OWL.IrreflexiveProperty: "IrreflexiveObjectProperty",
}
# rdf:type objects that are entity declarations (counted separately, not as class assertions)
DECL_TYPES = {
    OWL.Class,
    OWL.ObjectProperty,
    OWL.DatatypeProperty,
    OWL.AnnotationProperty,
    OWL.NamedIndividual,
    RDFS.Datatype,
    OWL.Ontology,
}
# built-in annotation properties: never declared in the files but still AnnotationAssertions
BUILTIN_ANN = {
    RDFS.label,
    RDFS.comment,
    RDFS.seeAlso,
    RDFS.isDefinedBy,
    OWL.versionInfo,
    OWL.priorVersion,
    OWL.backwardCompatibleWith,
    OWL.incompatibleWith,
    OWL.deprecated,
}


LOCK = config.LOCK_FILE


def local_name(iri):
    """Local name of an IRI: the part after the last '#' or '/'."""
    return iri.rsplit("#", 1)[-1].rsplit("/", 1)[-1]


def refresh():
    """Re-read the workspace (after the user opened another ontology).

    Updates the module globals ``ONT_DIR``, ``FILES`` and ``DB`` from ``workspace.json``.
    """
    global ONT_DIR, FILES, DB
    ONT_DIR = workspace.ont_dir()
    FILES = workspace.load()["files"]
    DB = workspace.db_path()


def compute_metrics(g, ctx):
    """OWL API axiom metrics for one module (single pass over the graph).

    ctx accumulates entity declarations across modules (FILES must list imported
    modules first) so that e.g. an object property declared in SDF_ext is still
    recognised when asserted in SDF_individuals — as the OWL API does over the closure.

    Returns ``{metric name: int}`` with one entry per OWL API axiom type found (SubClassOf,
    ClassAssertion, ObjectPropertyAssertion…), the entity counts of this module only
    (``Class count``…), ``Declaration axioms count``, ``Logical axiom count`` and the total
    ``Axiom``.  Names follow the OWL API axiom types.  ``ctx`` is mutated
    (its ``classes``/``objp``/``datap``/``annp``/``inds``/``dts`` sets grow).
    """
    from collections import Counter

    B = rdflib.BNode

    def typ(t):
        """Set of subjects of ``rdf:type t`` in the module graph."""
        return set(g.subjects(RDF.type, t))

    # entities declared in THIS module (for the per-module counts)…
    own = {
        "classes": typ(OWL.Class),
        "objp": typ(OWL.ObjectProperty),
        "datap": typ(OWL.DatatypeProperty),
        "annp": typ(OWL.AnnotationProperty),
        "inds": typ(OWL.NamedIndividual),
        "dts": typ(RDFS.Datatype),
    }
    # …merged into the cumulative sets used to classify the axioms of this module
    for k, v in own.items():
        ctx.setdefault(k, set()).update(v)
    classes, objp, datap = ctx["classes"], ctx["objp"], ctx["datap"]
    annp, inds, dts = ctx["annp"], ctx["inds"], ctx["dts"]
    annpreds = annp | BUILTIN_ANN
    ontologies = typ(OWL.Ontology)  # header annotations are not AnnotationAssertion axioms
    c = Counter()
    # one triple ≈ one axiom, classified by predicate (and by the declared kind of the subject)
    for s, p, o in g:
        if s in ontologies:
            continue
        if p == RDF.type:
            if o in DECL_TYPES:
                continue
            if o in CHARACT:
                # only Functional exists for data properties; every other characteristic (and an
                # undeclared property, as the OWL API assumes) counts as the object-property axiom
                data_functional = s in datap and s not in objp and o == OWL.FunctionalProperty
                c["FunctionalDataProperty" if data_functional else CHARACT[o]] += 1
            elif o == OWL.AllDisjointClasses:
                c["DisjointClasses"] += 1
            elif o == OWL.AllDifferent:
                c["DifferentIndividuals"] += 1
            elif o == OWL.AllDisjointProperties:
                c["DisjointObjectProperties"] += 1
            elif o == OWL.NegativePropertyAssertion:
                prop = g.value(s, OWL.assertionProperty)
                c["NegativeObjectPropertyAssertion" if prop in objp else "NegativeDataPropertyAssertion"] += 1
            elif o == OWL.Restriction or o == OWL.Axiom:
                continue  # structural bnode typing, not an axiom
            elif s in inds or o in classes or isinstance(o, B):
                c["ClassAssertion"] += 1  # named or anonymous class
        elif p == RDFS.subClassOf:
            c["GCI count" if isinstance(s, B) else "SubClassOf"] += 1  # anonymous subclass = GCI
        elif p == OWL.equivalentClass:
            c["DatatypeDefinition" if s in dts else "EquivalentClasses"] += 1
        elif p == OWL.disjointWith:
            c["DisjointClasses"] += 1
        elif p == RDFS.subPropertyOf:
            c[
                "SubObjectPropertyOf" if s in objp else "SubDataPropertyOf" if s in datap else "SubAnnotationPropertyOf"
            ] += 1
        elif p == OWL.equivalentProperty:
            c["EquivalentObjectProperties" if s in objp else "EquivalentDataProperties"] += 1
        elif p == OWL.propertyDisjointWith:
            c["DisjointObjectProperties" if s in objp else "DisjointDataProperties"] += 1
        elif p == OWL.inverseOf:
            c["InverseObjectProperties"] += 1
        elif p == RDFS.domain:
            c[
                (
                    "ObjectPropertyDomain"
                    if s in objp
                    else "DataPropertyDomain" if s in datap else "AnnotationPropertyDomain"
                )
            ] += 1
        elif p == RDFS.range:
            c[
                (
                    "ObjectPropertyRange"
                    if s in objp
                    else "DataPropertyRange" if s in datap else "AnnotationPropertyRangeOf"
                )
            ] += 1
        elif p == OWL.propertyChainAxiom:
            c["SubPropertyChainOf"] += 1
        elif p == OWL.sameAs:
            c["SameIndividual"] += 1
        elif p == OWL.differentFrom:
            c["DifferentIndividuals"] += 1
        elif p in objp:
            c["ObjectPropertyAssertion"] += 1
        elif p in datap:
            c["DataPropertyAssertion"] += 1
        elif p in annpreds:
            c["AnnotationAssertion"] += 1
        elif p == OWL.imports:
            c["Imports"] += 1
    # OWL API "hidden GCI": named class with an anonymous equivalent AND a SubClassOf
    eq_anon = {s for s, o in g.subject_objects(OWL.equivalentClass) if isinstance(o, B) and s in classes}
    c["Hidden GCI Count"] = sum(1 for s in eq_anon if (s, RDFS.subClassOf, None) in g)

    def named(S):
        """Number of named (non-blank) nodes in ``S``."""
        return sum(1 for x in S if not isinstance(x, B))

    decl = {
        "Class count": named(own["classes"]),
        "Object property count": len(own["objp"]),
        "Data property count": len(own["datap"]),
        "Annotation property count": len(own["annp"]),
        "Individual count": len(own["inds"]),
        "Datatype count": named(own["dts"]),
    }
    m = dict(c)
    m.update(decl)
    m["Declaration axioms count"] = sum(decl.values())
    # logical = everything except annotation axioms (assertions, annotation property domain/range),
    # imports and the derived hidden-GCI figure — as OWL API count them
    non_logical = (
        "AnnotationAssertion",
        "AnnotationPropertyDomain",
        "AnnotationPropertyRangeOf",
        "Imports",
        "Hidden GCI Count",
    )
    m["Logical axiom count"] = sum(v for k, v in c.items() if k not in non_logical)
    m["Axiom"] = m["Logical axiom count"] + m["Declaration axioms count"] + c["AnnotationAssertion"]
    return m


def _num(literal, default):
    """Numeric value of a facet literal; ``default`` when it is not a number (e.g. a dateTime bound)."""
    try:
        return float(literal)
    except (TypeError, ValueError):
        return default


def stale():
    """True when the index is missing or older than any existing ontology file of the workspace."""
    if not DB.exists():
        return True
    t = DB.stat().st_mtime
    return any((ONT_DIR / f).exists() and (ONT_DIR / f).stat().st_mtime > t for f in FILES)


def build():
    """Parse every file of ``FILES`` and (re)build the index ``DB`` from scratch.

    The database is written to ``<DB>.tmp`` and atomically renamed over ``DB`` at the end, so
    a running server keeps a consistent (old) index until the build completes.  Missing files
    are skipped with a message.  Progress is printed to stdout (captured in ``build_index.log``
    when run by the server).  Memory: one rdflib graph at a time; node ids, kinds and labels
    are kept in Python dicts for the whole build.  Rebuilding drops the ``changes`` table of
    the editor (pending edits live in the index file).
    """
    tmp = DB.with_suffix(".db.tmp")
    tmp.unlink(missing_ok=True)
    db = sqlite3.connect(tmp)
    # no journal/fsync: the file is throw-away until the final rename; 256 MB page cache
    db.executescript(
        """
        PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-262144;
        CREATE TABLE nodes(id INTEGER PRIMARY KEY, iri TEXT UNIQUE, label TEXT, kind TEXT, lname TEXT);
        CREATE TABLE stmt(s INT, p INT, o_id INT, o_lit TEXT, dt TEXT, lang TEXT, graph TEXT);
        CREATE TABLE metrics(graph TEXT, name TEXT, value INT);
        CREATE TABLE axiom_ann(s INT, p INT, o_id INT, o_lit TEXT, prop INT, value TEXT, graph TEXT);
        CREATE TABLE datatype_bounds(id INT PRIMARY KEY, kmin REAL, kmax REAL);
        CREATE TABLE bnode_refs(s INT, ref INT, via INT, graph TEXT);
    """
    )
    ids = {}  # iri -> node id (ids are assigned sequentially, in order of first appearance)
    kinds = {}  # node id -> kind    (collected in python: no post-hoc SQL analytics)
    labels = {}  # node id -> label
    label_lang = {}  # node id -> language tag of the chosen label
    ctx = {}  # cumulative entity declarations for compute_metrics
    RDF_TYPE, RDFS_LABEL = str(RDF.type), str(RDFS.label)

    def nid(iri):
        """Node id of ``iri``, inserting a new ``nodes`` row on first sight."""
        i = ids.get(iri)
        if i is None:
            i = len(ids) + 1
            ids[iri] = i
            db.execute("INSERT INTO nodes(id, iri) VALUES(?,?)", (i, iri))
        return i

    for fname in FILES:
        path = ONT_DIR / fname
        if not path.exists():
            print("skip (missing):", fname)
            continue
        t0 = time.time()
        g = anon.graph_from_xml(path)  # rdf:nodeID names preserved (ids of the anonymous individuals)
        rows = []
        # adjacency of the anonymous sub-graph (blank-node subjects) and the blank nodes in object position
        adj, bobjs = {}, set()  # bnode -> [(p, o)]; bnodes seen as objects
        for s, p, o in g:
            if isinstance(s, rdflib.BNode):
                adj.setdefault(s, []).append((p, o))
            if isinstance(o, rdflib.BNode):
                bobjs.add(o)
        # anonymous individuals (blank nodes that are not expressions, lists, reifications…) are
        # indexed like entities under a pseudo-IRI "_:<id>" with kind 'anon' — see ontoviewer.anon
        anon_iri = anon.node_ids(g, fname, anon.file_node_ids(path), anon.classify(adj, bobjs))
        for a_iri in anon_iri.values():
            kinds[nid(a_iri)] = "anon"

        def iri_of(t):
            """IRI of a named term or pseudo-IRI of an anonymous individual; None for a structural blank node."""
            return anon_iri.get(t) if isinstance(t, rdflib.BNode) else str(t)

        # annotated axioms (owl:Axiom reification, e.g. fuzzy degrees) are bnodes:
        # collect them so the viewer can show the annotation next to the assertion
        ax = {}  # bnode -> [(predicate IRI, object that is not a structural bnode)]
        for bn, pairs in adj.items():
            props = [(str(p), o) for p, o in pairs if not isinstance(o, rdflib.BNode) or o in anon_iri]
            if props:
                ax[bn] = props
        for bn, props in ax.items():
            d = dict(props)
            if d.get(str(RDF.type)) != OWL.Axiom:
                continue
            src, prp, tgt = (
                d.get(str(OWL.annotatedSource)),
                d.get(str(OWL.annotatedProperty)),
                d.get(str(OWL.annotatedTarget)),
            )
            if src is None or prp is None or tgt is None:
                continue  # annotated axiom with an anonymous expression as source / target (not indexed)
            # every other property of the owl:Axiom node is an annotation of the (src, prp, tgt) axiom
            for pp, v in props:
                if pp in (
                    str(RDF.type),
                    str(OWL.annotatedSource),
                    str(OWL.annotatedProperty),
                    str(OWL.annotatedTarget),
                ):
                    continue
                db.execute(
                    "INSERT INTO axiom_ann VALUES(?,?,?,?,?,?,?)",
                    (
                        nid(iri_of(src)),
                        nid(iri_of(prp)),
                        None if isinstance(tgt, rdflib.Literal) else nid(iri_of(tgt)),
                        str(tgt) if isinstance(tgt, rdflib.Literal) else None,
                        nid(pp),
                        str(v),
                        fname,
                    ),
                )
        del ax
        # named entities referenced inside anonymous definitions (restrictions, unions,
        # datatype facets…) of a named subject: "usage in definitions" for the viewer
        # (anonymous individuals are indexed as statements instead, so they are not walked)
        for s in set(g.subjects()):
            if isinstance(s, rdflib.BNode):
                continue
            # depth-first walk of the structural bnodes hanging off the named subject s
            seen, stack = set(), [
                o for _, o in g.predicate_objects(s) if isinstance(o, rdflib.BNode) and o not in anon_iri
            ]
            refs = set()  # (referenced IRI, predicate IRI leading to it)
            while stack:
                bn = stack.pop()
                if bn in seen:
                    continue
                seen.add(bn)
                for p, o in adj.get(bn, []):
                    if isinstance(o, rdflib.BNode):
                        if o not in anon_iri:
                            stack.append(o)
                    elif isinstance(o, rdflib.URIRef) and not str(o).startswith(
                        "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
                    ):
                        refs.add((str(o), str(p)))  # rdf:* objects (rdf:nil, list typing) are noise
            if refs:
                db.executemany(
                    "INSERT INTO bnode_refs VALUES(?,?,?,?)", [(nid(str(s)), nid(r), nid(p), fname) for r, p in refs]
                )
        del adj
        # domain [k1,k2] of fuzzy datatypes: xsd:minInclusive/maxInclusive facets reachable
        # from the datatype's owl:equivalentClass (anonymous restriction structure)
        XSD = "http://www.w3.org/2001/XMLSchema#"
        for dt in set(g.subjects(RDF.type, RDFS.Datatype)):
            if isinstance(dt, rdflib.BNode):
                continue
            kmin = kmax = None
            stack = [o for o in g.objects(dt, OWL.equivalentClass) if isinstance(o, rdflib.BNode)]
            seen = set()
            while stack:
                bn = stack.pop()
                if bn in seen:
                    continue
                seen.add(bn)
                for _, p, o in g.triples((bn, None, None)):
                    if isinstance(o, rdflib.BNode):
                        stack.append(o)
                    elif str(p) in (XSD + "minInclusive", XSD + "minExclusive"):
                        kmin = _num(o, kmin)  # exclusive bounds are treated as inclusive
                    elif str(p) in (XSD + "maxInclusive", XSD + "maxExclusive"):
                        kmax = _num(o, kmax)
            if kmin is not None or kmax is not None:
                db.execute("INSERT OR REPLACE INTO datatype_bounds VALUES(?,?,?)", (nid(str(dt)), kmin, kmax))
        # the statements proper: subject and object are named entities, anonymous individuals or
        # (object) literals; structural blank nodes are skipped (not needed to browse)
        for s, p, o in g:
            s_iri = iri_of(s)
            o_iri = None if isinstance(o, rdflib.Literal) else iri_of(o)
            if s_iri is None or (o_iri is None and not isinstance(o, rdflib.Literal)):
                continue
            ps = str(p)
            si, pi = nid(s_iri), nid(ps)
            if isinstance(o, rdflib.Literal):
                rows.append((si, pi, None, str(o), str(o.datatype) if o.datatype else None, o.language, fname))
                if ps == RDFS_LABEL and (
                    si not in labels or (o.language in (None, "en") and label_lang.get(si) not in (None, "en"))
                ):
                    # rdflib yields triples in no particular order: prefer a label without language or @en,
                    # otherwise the first one seen (e.g. only an @it label)
                    labels[si], label_lang[si] = str(o), o.language
            else:
                rows.append((si, pi, nid(o_iri), None, None, None, fname))
                if ps == RDF_TYPE and o_iri in KIND_TYPES and si not in kinds:
                    kinds[si] = KIND_TYPES[o_iri]  # first declaration wins (an anonymous individual stays 'anon')
        db.executemany("INSERT INTO stmt VALUES(?,?,?,?,?,?,?)", rows)
        db.executemany("INSERT INTO metrics VALUES(?,?,?)", [(fname, k, v) for k, v in compute_metrics(g, ctx).items()])
        db.commit()
        print(f"{fname}: {len(rows)} statements in {time.time()-t0:.0f}s")
        del g, rows

    print("kinds/labels...")
    db.executemany("UPDATE nodes SET kind=? WHERE id=?", [(k, i) for i, k in kinds.items()])
    db.executemany("UPDATE nodes SET label=? WHERE id=?", [(l, i) for i, l in labels.items()])
    # lname = lower-case local name: alphabetical order of lists and trees, independent of the namespace
    db.executemany("UPDATE nodes SET lname=? WHERE id=?", [(local_name(iri).lower(), i) for iri, i in ids.items()])
    db.commit()
    print("indexing...")
    t0 = time.time()
    # indexes created after the bulk load (much faster than maintaining them during inserts):
    # by subject, by object (usage), by predicate+object (instances of a class, rdf:type lookups),
    # axiom annotations by subject, bnode usage by referenced entity, literals by datatype,
    # entity lists by kind
    db.executescript(
        """
        CREATE INDEX i_s ON stmt(s);
        CREATE INDEX i_oid ON stmt(o_id) WHERE o_id IS NOT NULL;
        CREATE INDEX i_po ON stmt(p, o_id);
        CREATE INDEX i_pog ON stmt(p, o_id, graph, s);
        CREATE INDEX i_ax ON axiom_ann(s);
        CREATE INDEX i_bref ON bnode_refs(ref);
        CREATE INDEX i_dt ON stmt(dt) WHERE dt IS NOT NULL;
        CREATE INDEX i_nkind ON nodes(kind, iri);
        CREATE INDEX i_nlname ON nodes(kind, lname);
        ANALYZE;
    """
    )
    print(f"indexes in {time.time()-t0:.0f}s")
    db.close()
    tmp.replace(DB)  # atomic swap: readers see either the old or the new index
    print("done:", DB, f"{DB.stat().st_size/1e6:.0f} MB")


def try_lock():
    """Exclusive build lock (survives server restarts); returns the fd or None if busy.

    Uses ``flock`` on ``config.LOCK_FILE``: the lock is held as long as the returned file
    object stays open (keep a reference!) and is released automatically when the process
    dies, so a crashed build never leaves a stale lock.  ``data/`` must exist.
    """
    import fcntl

    fd = open(LOCK, "w")
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd
    except OSError:
        fd.close()
        return None


def build_running():
    """True when another process currently holds the build lock (probe: acquire and release)."""
    fd = try_lock()
    if fd is None:
        return True
    fd.close()
    return False


if __name__ == "__main__":
    # command line: build the index of the current workspace if stale (or always with --force)
    refresh()
    lock = try_lock()  # kept open until exit: holds the lock for the whole build
    if lock is None:
        print("another index build is already running — skipped")
        sys.exit(0)
    if stale() or "--force" in sys.argv:
        build()
    else:
        print("index up to date:", DB)
