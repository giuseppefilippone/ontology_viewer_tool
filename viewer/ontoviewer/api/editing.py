"""POST API: editing operations (triples, entities, expressions, axiom annotations, save).

Every handler receives an editor connection ``c`` (``editor.connect()``): the index is modified
immediately (so the UI reflects the edit) and the change is journaled in the ``changes`` table;
nothing touches the .owl files until ``edit_save`` writes the journal back.  ``ontoviewer.http``
commits the connection after the handler returns.  Payloads name entities by full IRI; "graph"
is a module file name and, when omitted, defaults to the module declaring the subject, else to
the first module of the workspace (``_target_graph``).  Anonymous constructs (expressions,
negative assertions, axiom annotations) are stored as raw RDF/XML blocks that are appended to
the file on save; only their representable triples reach the index.  Anonymous individuals
(``/api/edit/add`` with ``o_anon``) are raw blocks too, but their statements are indexed under
the pseudo-IRI ``_:<nodeID>`` so the entity panels show them at once (``ontoviewer.anon``).

Routes (see ``ontoviewer.api.POST_ROUTES``):
    /api/edit/add               → edit_add
    /api/edit/remove            → edit_remove
    /api/edit/create            → edit_create
    /api/edit/delete            → edit_delete
    /api/edit/rename            → edit_rename
    /api/edit/rename_ns         → edit_rename_ns
    /api/edit/raw               → edit_raw
    /api/edit/axiom_ann_add     → edit_axiom_ann_add
    /api/edit/axiom_ann_remove  → edit_axiom_ann_remove
    /api/save                   → edit_save
    /api/edit/expr              → edit_expr
    /api/edit/anon_remove       → edit_anon_remove
    /api/edit/anon_annotate     → edit_anon_annotate
    /api/edit/negative          → edit_negative
"""

import re

from ontoviewer import editor, indexer, manchester
from ontoviewer.store import short
from ontoviewer.api import ontology


def _target_graph(c, payload):
    """Module receiving a new triple: explicit choice, else where the subject is declared.

    Reads payload["graph"] (optional) and payload["s"] (subject IRI); falls back to the first
    workspace module for subjects declared nowhere (imported or brand-new IRIs).
    """
    return payload.get("graph") or editor.declaring_graph(c, payload["s"]) or indexer.FILES[0]


def edit_add(c, p):
    """Add one triple (entity or literal object) to the index and the journal.

    Payload: "s", "p" (IRIs) and either "o" (object IRI, or the ``_:<id>`` pseudo-IRI of an
    existing anonymous individual), "lit" (+ optional "dt" datatype IRI, "lang") or "o_anon" — the
    description of a NEW anonymous individual used as the object: {"annotations": [[p, value, dt,
    lang]…], "types": [class IRI | {"expr": Manchester text}…], "obj": [[p, o]…], "data": [[p, lit,
    dt, lang]…], "neg_obj": [[p, o]…], "neg_data": [[p, lit, dt, lang]…]} where an annotation
    ``value`` / an ``o`` is a literal string, {"iri": IRI} or a nested {"anon": {…}} description
    (see ``editor.add_anon_individual``); optional "graph" (see ``_target_graph``).  "s" may itself
    be an anonymous individual.  A rdf:type of an OWL kind or a rdfs:label also updates the node's
    kind/label.  Returns {"added": bool (False when the triple already exists in that module),
    "graph": file} plus "anon": the pseudo-IRI of the new anonymous individual when one was created.
    """
    graph = _target_graph(c, p)
    if p.get("o_anon") is not None:
        iri = editor.add_anon_individual(c, graph, p["s"], p["p"], p["o_anon"])
        return {"added": True, "graph": graph, "anon": iri}
    ok = editor.add_triple(c, graph, p["s"], p["p"], p.get("o"), p.get("lit"), p.get("dt"), p.get("lang"))
    return {"added": ok, "graph": graph}


def edit_remove(c, p):
    """Remove a triple from every module, or from one when "graph" is given.

    Payload: "s", "p" and "o" (object IRI) or "lit"; optional "graph".  Unknown subject or
    predicate removes nothing.  Returns {"removed": number of statements deleted}.
    """
    n = editor.remove_triple(c, p["s"], p["p"], p.get("o"), p.get("lit"), p.get("graph"))
    return {"removed": n}


def edit_create(c, p):
    """Declare a new entity (rdf:type of its OWL kind, optional English rdfs:label).

    Payload: "graph" (required), "iri", "kind" (class|objprop|dataprop|annprop|datatype|
    individual|ontology), optional "label".  Raises ValueError (→ HTTP 400) when the IRI already
    has statements.  Returns {"created": iri, "graph": file}.
    """
    editor.create_entity(c, p["graph"], p["iri"], p["kind"], p.get("label"))
    return {"created": p["iri"], "graph": p["graph"]}


def edit_delete(c, p):
    """Delete an entity: every statement having it as subject or object, in every module.

    Payload: "iri".  The node row stays (kind and label cleared) so that ids remain stable.
    Returns {"removed": number of statements deleted}.
    """
    return {"removed": editor.delete_entity(c, p["iri"])}


def edit_rename(c, p):
    """Rename an entity IRI; statements follow the node, files are rewritten on save.

    Payload: "iri", "new_iri".  Raises ValueError when the source is unknown or the target
    exists.  Returns {"graphs": [file…]} = the modules mentioning the entity (to be rewritten).
    """
    return {"graphs": editor.rename_entity(c, p["iri"], p["new_iri"])}


def edit_rename_ns(c, p):
    """Mass rename of a namespace prefix over all entities (all modules).

    Payload: "old_ns", "new_ns" (IRI prefixes).  Raises ValueError for an empty/identical
    prefix or when no entity matches.  Returns {"entities": n renamed, "graphs": [file…]}.
    """
    return editor.rename_namespace(c, p["old_ns"], p["new_ns"])


def edit_raw(c, p):
    """Append a raw RDF/XML block to a module on save, indexing only its representable triples.

    Payload: "graph", "xml" (block text, top-level elements), optional "triples":
    [{"s", "p", "o"|"lit", "dt", "lang"}…] stored in the index right away, optional "subject"
    (IRI the block is about; defaults to the subject of the first triple).
    Returns {"ok": True}.
    """
    editor.add_raw_block(c, p["graph"], p["xml"], p.get("triples") or [], p.get("subject"))
    return {"ok": True}


def edit_axiom_ann_add(c, p):
    """Annotate an existing assertion (owl:Axiom reification), e.g. with a fuzzy degree.

    Payload: the assertion "s", "p", "o"|"lit" (+ "dt", "lang"), "value" (annotation text, e.g.
    the fuzzyLabel XML), optional "prop" (annotation property IRI, default sdf:fuzzyLabel) and
    "graph".  A previous annotation with the same property on that assertion is replaced (in the
    ``axiom_ann`` table now, in the file on save).  Returns {"ok": True, "graph": file}.
    """
    graph = _target_graph(c, p)
    editor.add_axiom_annotation(
        c,
        graph,
        p["s"],
        p["p"],
        p.get("o"),
        p.get("lit"),
        p.get("dt"),
        p.get("lang"),
        p.get("prop") or editor.FUZZY_LABEL,
        p["value"],
    )
    return {"ok": True, "graph": graph}


def edit_axiom_ann_remove(c, p):
    """Remove the annotations of one axiom; with `prop` only that annotation property is removed
    (the owl:Axiom block is rewritten with the remaining ones).

    Payload: "graph", the assertion "s", "p", "o"|"lit" (+ "dt", "lang"), optional "prop"
    (annotation property IRI).  Returns {"removed": number of annotations actually dropped}.
    """
    si, pi = editor.node_id(c, p["s"]), editor.node_id(c, p["p"])
    oi = editor.node_id(c, p["o"]) if p.get("o") else None
    # the file writer drops the whole owl:Axiom block of (s, p, o): annotations of OTHER
    # properties on the same axiom are collected first and re-added below
    keep = []
    if p.get("prop"):
        pid = editor.node_id(c, p["prop"])
        keep = [
            (r["prop"], r["value"])
            for r in c.execute(
                "SELECT prop, value FROM axiom_ann WHERE s=? AND p=? AND o_id IS ? AND o_lit IS ? AND prop<>?",
                (si, pi, oi, p.get("lit"), pid),
            ).fetchall()
        ]
    n = editor.remove_axiom_annotation(
        c, p["graph"], p["s"], p["p"], p.get("o"), p.get("lit"), p.get("dt"), p.get("lang")
    )
    for prop_id, value in keep:
        prop_iri = c.execute("SELECT iri FROM nodes WHERE id=?", (prop_id,)).fetchone()["iri"]
        editor.add_axiom_annotation(
            c, p["graph"], p["s"], p["p"], p.get("o"), p.get("lit"), p.get("dt"), p.get("lang"), prop_iri, value
        )
    return {"removed": n - len(keep)}


def edit_save(c, p):
    """Write the journal to the .owl files (``editor.save``) and re-index them.

    Payload: unused.  Refused with ValueError (→ HTTP 400) while an index build is running (the
    build would overwrite the index the edits live in).  Side effects: modified modules rewritten
    (backups under <dir>/backup/), catalog-v001.xml updated on renames, journal emptied,
    ``ONTOLOGY_CACHE`` cleared and a background reindex started.

    Returns the ``editor.save`` dict {"saved": [per-file result…]} (+ "message" when there was
    nothing to save) with "reindex": the ``api_reindex`` result.
    """
    if indexer.build_running():
        raise ValueError("the index is being rebuilt: wait for it to finish, then save again")
    res = editor.save(c)
    if res.get("saved"):
        ontology.ONTOLOGY_CACHE.clear()
        res["reindex"] = ontology.api_reindex()  # re-read the written files: metrics + consistency check
    return res


# property axioms whose object may be a property expression (`inverse P`): predicate → RDF/XML tag
PROP_TAGS = {
    "equivalentProperty": "owl:equivalentProperty",
    "subPropertyOf": "rdfs:subPropertyOf",
    "propertyDisjointWith": "owl:propertyDisjointWith",
    "inverseOf": "owl:inverseOf",
}
# class collection axioms: predicate → RDF/XML tag (members in an rdf:parseType="Collection" list)
COLLECTION_TAGS = {
    "disjointUnionOf": "owl:disjointUnionOf",
    "hasKey": "owl:hasKey",
    "propertyChainAxiom": "owl:propertyChainAxiom",
}


def edit_expr(c, p):
    """Add an axiom whose object (and optionally subject) is a Manchester-syntax expression.

    Payload: "p" predicate IRI (rdfs:subClassOf, owl:equivalentClass, owl:disjointWith,
    rdfs:domain or rdfs:range — anything else is a KeyError → HTTP 400), "expr" Manchester text
    of the object, optional "s" subject IRI, "kind" of the subject (class|datatype|objprop|
    dataprop|annprop; 'datatype', or 'dataprop' with range, parses "expr" as a data range),
    "sub" Manchester text of an anonymous subject (general class axiom, when "s" is empty),
    "graph".  Raises ValueError when both "s" and "sub" are missing.

    Property predicates (``PROP_TAGS``: owl:equivalentProperty, rdfs:subPropertyOf,
    owl:propertyDisjointWith, owl:inverseOf) take a *property expression* instead: a property
    name / IRI or ``inverse P`` (object properties only) — see ``_edit_prop_expr``.

    Side effects: the RDF/XML block is journaled for the save; when the object is a named class
    or a plain datatype the (s, p, o) triple is also indexed.  Returns {"ok": True, "graph":
    file, "dl": Manchester rendering of the axiom, "xml": the block}.
    """
    pred = p["p"]  # e.g. rdfs:subClassOf, owl:equivalentClass, rdfs:domain
    if short(pred) in PROP_TAGS:
        return _edit_prop_expr(c, p, PROP_TAGS[short(pred)])
    tag = {
        "subClassOf": "rdfs:subClassOf",
        "equivalentClass": "owl:equivalentClass",
        "disjointWith": "owl:disjointWith",
        "domain": "rdfs:domain",
        "range": "rdfs:range",
        "type": "rdf:type",  # class assertion of an individual with an anonymous class
    }[short(pred)]
    kind = p.get("kind") or ""
    data_range = kind == "datatype" or (kind == "dataprop" and short(pred) == "range")
    ast = manchester.parse(p["expr"], data_range=data_range)
    sub_ast = manchester.parse(p["sub"]) if p.get("sub") else None
    s = p.get("s") or ""
    if not s and sub_ast is None:
        raise ValueError("a general class axiom needs both expressions")
    graph = p.get("graph") or (editor.declaring_graph(c, s) if s else None) or indexer.FILES[0]
    xml = manchester.axiom_block(s or None, kind, tag, ast, sub_ast)
    triples = []
    if s and ast[0] in ("class", "datatype") and (ast[0] == "class" or not ast[2]):  # named object: index it too
        triples = [{"s": s, "p": pred, "o": ast[1]}]
    # the journal entry is attached to the named subject; for a GCI, to a named class of the
    # axiom when there is one (parsed as: (s or sub-class or object-class) if object is a class else s)
    editor.add_raw_block(
        c,
        graph,
        xml,
        triples,
        # anchor of the raw block: the subject, else a named class of the GCI (either side), else
        # the first entity referenced by the XML (both sides anonymous)
        subject=s
        or (sub_ast[1] if sub_ast and sub_ast[0] == "class" else None)
        or (ast[1] if ast[0] == "class" else None)
        or (re.search(r'rdf:(?:resource|about)="([^"]+)"', xml) or [None, None])[1],
    )
    kw = {"subClassOf": "SubClassOf", "equivalentClass": "EquivalentTo", "disjointWith": "DisjointWith"}.get(
        short(pred)
    )
    return {
        "ok": True,
        "graph": graph,
        "dl": (manchester.to_manchester(sub_ast) + f" {kw} " if sub_ast else "") + manchester.to_manchester(ast),
        "xml": xml,
    }


def _edit_prop_expr(c, p, tag):
    """Property axiom (``PROP_TAGS``) whose object is a property expression.

    Payload: "s" subject property IRI, "expr" = a property name / <IRI> or ``inverse P``
    (anonymous inverse, object properties only), "kind" of the subject (objprop | dataprop,
    default objprop), "graph".  A named object is written as an rdf:resource and indexed as
    the (s, p, o) triple; ``inverse P`` becomes a nested owl:ObjectProperty/owl:inverseOf node
    (journaled only).  Returns {"ok": True, "graph": file, "dl": text, "xml": block}.
    """
    kind = p.get("kind") or "objprop"
    toks = manchester.tokenize(p.get("expr") or "")
    inverse = len(toks) == 2 and toks[0][0] == "name" and toks[0][1].lower() == "inverse"
    if not toks or len(toks) > 2 or (len(toks) == 2 and not inverse) or toks[-1][0] not in ("name", "iri"):
        raise ValueError("write a property name, or 'inverse P' for the inverse of an object property")
    if inverse and kind != "objprop":
        raise ValueError("only object properties have an inverse")
    iri = manchester.Resolver().resolve(toks[-1][1], [kind])[0]
    s = p["s"]
    graph = p.get("graph") or editor.declaring_graph(c, s) or indexer.FILES[0]
    el = {"objprop": "owl:ObjectProperty", "dataprop": "owl:DatatypeProperty"}.get(kind, "rdf:Description")
    esc = manchester._esc
    if inverse:
        obj = (
            f"        <{tag}>\n            <owl:ObjectProperty>\n"
            f'                <owl:inverseOf rdf:resource="{esc(iri)}"/>\n'
            f"            </owl:ObjectProperty>\n        </{tag}>"
        )
        triples = []
    else:
        obj = f'        <{tag} rdf:resource="{esc(iri)}"/>'
        triples = [{"s": s, "p": p["p"], "o": iri}]
    xml = f'    <{el} rdf:about="{esc(s)}">\n{obj}\n    </{el}>\n'
    editor.add_raw_block(c, graph, xml, triples, subject=s)
    return {"ok": True, "graph": graph, "dl": ("inverse " if inverse else "") + short(iri), "xml": xml}


def edit_collection(c, p):
    """Add a collection axiom whose members are Manchester texts resolved through the index.

    Payload: "s" subject IRI, "p" predicate IRI (``COLLECTION_TAGS``: owl:disjointUnionOf —
    every item is a class expression; owl:hasKey — every item is an object / data property
    name; owl:propertyChainAxiom — every item is an object property name, in chain order),
    "items" list of texts (names, <IRI>s or expressions), "graph".  Raises ValueError when the
    list is empty (a chain needs two members).  The RDF/XML block is journaled for the save
    (members of an rdf:parseType="Collection" list are not indexed).  Returns {"ok": True,
    "graph": file, "dl": Manchester rendering of the members, "xml": the block}.
    """
    items = [t.strip() for t in (p.get("items") or []) if t and t.strip()]
    tag = COLLECTION_TAGS[short(p["p"])]
    if not items or (tag == "owl:propertyChainAxiom" and len(items) < 2):
        raise ValueError(
            "the axiom needs at least " + ("two properties" if tag == "owl:propertyChainAxiom" else "one member")
        )
    s = p["s"]
    graph = p.get("graph") or editor.declaring_graph(c, s) or indexer.FILES[0]
    esc = manchester._esc
    ind = "            "
    if tag == "owl:disjointUnionOf":
        asts = [manchester.parse(t) for t in items]
        members = "\n".join(manchester.node_xml(a, ind) for a in asts)
        dl = ", ".join(manchester.to_manchester(a) for a in asts)
        el = "owl:Class"
    else:
        kinds = ["objprop"] if tag == "owl:propertyChainAxiom" else ["objprop", "dataprop"]
        r = manchester.Resolver()
        iris = [r.resolve(t.strip("'<>"), kinds)[0] for t in items]
        members = "\n".join(f'{ind}<rdf:Description rdf:about="{esc(i)}"/>' for i in iris)
        dl = (" o " if tag == "owl:propertyChainAxiom" else ", ").join(short(i) for i in iris)
        el = "owl:ObjectProperty" if tag == "owl:propertyChainAxiom" else "owl:Class"
    xml = f'    <{el} rdf:about="{esc(s)}">\n        <{tag} rdf:parseType="Collection">\n{members}\n        </{tag}>\n    </{el}>\n'
    editor.add_raw_block(c, graph, xml, [], subject=s)
    return {"ok": True, "graph": graph, "dl": dl, "xml": xml}


def edit_anon_remove(c, p):
    """Remove an axiom whose object is an anonymous expression, identified by its DL text.

    Payload: "s", "p", "dl" (DL rendering of the expression as listed by ``axioms.tbox``),
    optional "graph".  Nothing changes in the index (blank nodes are not indexed): the removal
    is journaled and performed on save.  Returns {"ok": True, "graph": file}.
    """
    graph = p.get("graph") or editor.declaring_graph(c, p["s"]) or indexer.FILES[0]
    editor.remove_anon(c, graph, p["s"], p["p"], p["dl"])
    return {"ok": True, "graph": graph}


def edit_anon_annotate(c, p):
    """Annotate an axiom whose target is an anonymous expression: owl:Axiom block whose
    annotatedTarget is the expression itself (structural match, as the OWL API does).

    Payload: "s", "p", "man" (Manchester text of the anonymous target), "value" (annotation
    text), optional "prop" (annotation property IRI, default sdf:fuzzyLabel), "kind"
    ('datatype' parses "man" as a data range), "graph".  The block is journaled only (no
    indexed triples).  Returns {"ok": True, "graph": file}.
    """
    ast = manchester.parse(p["man"], data_range=p.get("kind") == "datatype")
    graph = p.get("graph") or editor.declaring_graph(c, p["s"]) or indexer.FILES[0]

    def esc(x):
        """Minimal escaping for XML attribute values and text."""
        return str(x).replace("&", "&amp;").replace("<", "&lt;").replace('"', "&quot;")

    prop = p.get("prop") or editor.FUZZY_LABEL
    # the annotation property is written as <ns_ann:local> with its namespace declared inline,
    # so the block is valid whatever prefixes the target file declares
    pfx, local = prop.rsplit("#", 1) if "#" in prop else prop.rsplit("/", 1)
    xml = (
        "    <owl:Axiom>\n"
        f'        <owl:annotatedSource rdf:resource="{esc(p["s"])}"/>\n'
        f'        <owl:annotatedProperty rdf:resource="{esc(p["p"])}"/>\n'
        + manchester.prop_xml("owl:annotatedTarget", ast, "        ")
        + "\n"
        f'        <ns_ann:{local} xmlns:ns_ann="{esc(pfx + ("#" if "#" in prop else "/"))}">'
        f"{esc(p['value'])}</ns_ann:{local}>\n"
        "    </owl:Axiom>\n"
    )
    editor.add_raw_block(c, graph, xml, [], subject=p["s"])
    return {"ok": True, "graph": graph}


def edit_negative(c, p):
    """owl:NegativePropertyAssertion (anonymous node) — written to the file, not indexed.

    Payload: "s" source individual (named, or the ``_:<id>`` of an anonymous one), "p" property
    IRI, and "o" (target individual) or "lit" (+ optional "dt") target value; optional "graph".
    Returns {"ok": True, "graph": file}.
    """
    s, prop = p["s"], p["p"]
    graph = p.get("graph") or editor.declaring_graph(c, s) or indexer.FILES[0]
    xml = editor.negative_xml(s, prop, p.get("o"), p.get("lit"), p.get("dt"))
    editor.add_raw_block(c, graph, xml, [], subject=s)
    return {"ok": True, "graph": graph}


def edit_undo(c, p):
    """Undo the newest pending change; a grouped edit (one OWL expression journaled as many
    triples) is undone as a whole.

    Payload: unused.  Returns {"undone": number of journal rows reverted} (0 = journal empty).
    """
    return {"undone": editor.undo_last(c)}


def edit_duplicate(c, p):
    """Duplicate an entity under a new IRI (Protégé: Edit → Duplicate selected entity).

    Payload: "iri", "new_iri".  Every statement with the entity as subject is copied as a
    pending change (types, labels, axioms, assertions; incoming statements are not).
    Returns {"added": number of statements copied}.
    """
    return {"added": editor.duplicate_entity(c, p["iri"], p["new_iri"])}


def edit_redo(c, p):
    """Re-apply the change most recently reverted by /api/edit/undo (adds / removes only; the
    redo stack is cleared by any other new edit).

    Payload: unused.  Returns {"redone": number of journal rows re-applied} (0 = nothing).
    """
    return {"redone": editor.redo_last(c)}


def edit_convert_class(c, p):
    """Convert the selected class between defined and primitive (Protégé: Refactor →
    Convert to defined / primitive class): every owl:equivalentClass axiom of the class
    becomes rdfs:subClassOf, or vice versa.  Only axioms whose filler is in the index (named
    classes, indexed anonymous individuals) can be swapped — anonymous class expressions are
    not indexed and stay untouched (reported in "skipped").

    Payload: "iri", "to": defined | primitive.  Returns {"swapped": n, "skipped": n}.
    """
    import json as _json
    import time as _time

    iri, to = p["iri"], p.get("to")
    if to not in ("defined", "primitive"):
        raise ValueError('"to" must be defined or primitive')
    src = ("http://www.w3.org/2000/01/rdf-schema#subClassOf" if to == "defined"
           else "http://www.w3.org/2002/07/owl#equivalentClass")
    dst = ("http://www.w3.org/2002/07/owl#equivalentClass" if to == "defined"
           else "http://www.w3.org/2000/01/rdf-schema#subClassOf")
    si, pi = editor.node_id(c, iri), editor.node_id(c, src)
    if si is None:
        raise ValueError(f"unknown entity: {iri}")
    if pi is None:
        return {"swapped": 0, "skipped": 0}
    rows = c.execute(
        """SELECT n.iri AS o, s.graph FROM stmt s JOIN nodes n ON n.id=s.o_id
               WHERE s.s=? AND s.p=? AND s.o_id IS NOT NULL""",
        (si, pi),
    ).fetchall()
    gid = {"group": f"cnv{int(_time.time() * 1000)}"}  # one undo step for the whole conversion
    for r in rows:
        editor.remove_triple(c, iri, src, r["o"], None, r["graph"])
        editor.add_triple(c, r["graph"], iri, dst, r["o"], extra=gid)
    skipped = c.execute(
        "SELECT COUNT(*) FROM stmt WHERE s=? AND p=? AND o_id IS NULL", (si, pi)
    ).fetchone()[0]
    return {"swapped": len(rows), "skipped": skipped}
