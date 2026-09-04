"""GET API: entity lists, search, entity details, hierarchies, usage, fuzzy entities.

All handlers read the SQLite index through ``ontoviewer.store`` (tables ``nodes``, ``stmt``,
``axiom_ann``, ``bnode_refs``, ``datatype_bounds``) and never write.  Unless stated otherwise the
optional ``graph`` query parameter restricts a result to the entities *declared* (rdf:type of an
OWL kind) in one module file; '' means the whole import closure.  Entities are returned as
``store.node_json`` dicts: {"id", "iri", "label", "kind", "name", "fuzzy", "builtin"}.

Routes (see ``ontoviewer.api.GET_ROUTES``):
    /api/list          → api_list
    /api/search        → api_search
    /api/entity        → api_entity
    /api/instances     → api_instances
    /api/tree          → api_tree
    /api/usage         → api_usage
    /api/entity_axioms → api_entity_axioms
    /api/fuzzy         → api_fuzzy
"""

import re
import sqlite3

from rdflib.namespace import RDFS, OWL

from ontoviewer import axioms, config, inference, workspace
from ontoviewer.store import db, declared_in, fuzzy_ids, get_id, node_json, short


def api_list(q):
    """One page of the entities of a kind, optionally filtered by a substring.

    Query parameters:
        kind   class|objprop|dataprop|annprop|datatype|individual|ontology (default individual)
        page   0-based page number (default 0), ``config.PAGE_SIZE`` entries per page
        q      substring matched against the IRI or the label (default '')
        graph  module file: only entities declared there (default '' = closure)

    Returns {"total": int, "page": int, "items": [node_json…]} ordered by IRI.  For
    kind=datatype without a graph filter the OWL 2 built-in datatypes absent from the index are
    appended as synthetic items (id None, builtin True), like the OWL 2 built-in datatype list.
    """
    kind = q.get("kind", ["individual"])[0]
    page = int(q.get("page", ["0"])[0])
    search = q.get("q", [""])[0]
    gsql, gpar = declared_in(q.get("graph", [""])[0])
    limit, off = config.PAGE_SIZE, page * config.PAGE_SIZE
    if search:
        like = f"%{search}%"
        where = "kind=? AND (iri LIKE ? OR label LIKE ?)" + gsql
        par = (kind, like, like) + gpar
    else:
        where = "kind=?" + gsql
        par = (kind,) + gpar
    rows = (
        db()
        .execute(f"SELECT * FROM nodes WHERE {where} ORDER BY lname, iri LIMIT ? OFFSET ?", par + (limit, off))
        .fetchall()
    )
    total = db().execute(f"SELECT COUNT(*) FROM nodes WHERE {where}", par).fetchone()[0]
    items = [node_json(r) for r in rows]
    builtins = {"datatype": config.BUILTIN_DATATYPES, "annprop": config.BUILTIN_ANNPROPS}.get(kind)
    if builtins and not q.get("graph", [""])[0] and page == 0:  # OWL 2 / RDFS built-ins on page 0
        have = {n["iri"] for n in items}
        extra = [
            b for b in builtins if b not in have and (not search or search.lower() in config.builtin_name(b).lower())
        ]
        items += [
            {
                "id": None,
                "iri": b,
                "label": None,
                "kind": kind,
                "name": config.builtin_name(b),
                "fuzzy": False,
                "builtin": True,
            }
            for b in extra
        ]
        items.sort(key=lambda n: n["name"].lower())
        total += len(extra)  # synthetic rows exist once, on the first page
    return {"total": total, "page": page, "items": items}


def api_search(q):
    """Quick-search box: up to 50 entities of any kind whose IRI or label contains the text.

    Query parameters:
        q      search text; fewer than 2 characters yields no items (default '')
        graph  module file: only entities declared there (default '' = closure)

    Returns {"items": [node_json…]} ordered by IRI length (shortest = most likely match first);
    anonymous individuals (kind 'anon') are never listed — they are only shown inline.
    """
    text = q.get("q", [""])[0]
    if len(text) < 2:
        return {"items": []}
    like = f"%{text}%"
    gsql, gpar = declared_in(q.get("graph", [""])[0])
    rows = (
        db()
        .execute(
            f"""SELECT * FROM nodes WHERE (iri LIKE ? OR label LIKE ?) AND kind IS NOT 'anon'{gsql}
           ORDER BY LENGTH(iri) LIMIT 50""",
            (like, like) + gpar,
        )
        .fetchall()
    )
    return {"items": [node_json(r) for r in rows]}


def api_entity(q):
    """Everything the entity panel shows about one IRI (asserted data only, no reasoning).

    Query parameters:
        iri  IRI of the entity (default '')

    Returns {"node": node_json, "out": [group…], "incoming": [group…], "incoming_total": int,
    "modules": [file…], "bounds": {"kmin", "kmax"} | None} where
        out       statements with the entity as subject, one group per predicate:
                  {"pred": short name, "piri": IRI, "pkind": kind of the predicate (annprop,
                  objprop, dataprop or None), "values": [value…], "more": n}; a value is
                  {"lit", "dt", "dt_iri", "lang", "graph"} for literals or {"iri", "label", "name",
                  "kind", "graph"} for entities (kind 'anon' = an anonymous individual, rendered as an
                  inline card by the front-end), optionally with "axiom_ann": [{"prop", "value",
                  "graph"}…] = owl:Axiom annotations of that assertion (fuzzy degrees).  At most
                  100 values per predicate (``more`` counts the rest) out of 3000 rows scanned.
        incoming  statements with the entity as object (first 200), same grouping without ``more``
        modules   files holding at least one statement about the entity
        bounds    numeric range of a fuzzy datatype (table datatype_bounds), if any
    A built-in datatype absent from the index yields a synthetic node with empty lists; an unknown
    IRI yields {"error": "not found"}.  ``iri`` may be the pseudo-IRI ``_:<id>`` of an anonymous
    individual (same payload, node kind 'anon').
    """
    iri = q.get("iri", [""])[0]
    i = get_id(iri)
    if i is None:
        if iri in config.BUILTIN_KIND:  # not used anywhere yet: synthetic node
            return {
                "node": {
                    "id": None,
                    "iri": iri,
                    "label": None,
                    "kind": config.BUILTIN_KIND[iri],
                    "name": config.builtin_name(iri),
                    "fuzzy": False,
                    "builtin": True,
                },
                "out": [],
                "incoming": [],
                "incoming_total": 0,
                "modules": [],
                "bounds": None,
            }
        return {"error": "not found"}
    node = node_json(db().execute("SELECT * FROM nodes WHERE id=?", (i,)).fetchone())
    out = {}
    # outgoing statements: predicate IRI + either a literal (o_lit, dt, lang) or the object entity
    # (LEFT JOIN: o_id is NULL for literals); grouped per predicate below
    rows = (
        db()
        .execute(
            """SELECT p.iri AS piri, p.kind AS pkind, n.iri AS oiri, n.label AS olabel, n.kind AS okind,
                  s.o_lit, s.dt, s.lang, s.graph
           FROM stmt s JOIN nodes p ON p.id=s.p LEFT JOIN nodes n ON n.id=s.o_id
           WHERE s.s=? LIMIT 3000""",
            (i,),
        )
        .fetchall()
    )
    for r in rows:
        e = out.setdefault(r["piri"], {"pred": short(r["piri"]), "pkind": r["pkind"], "values": [], "more": 0})
        if len(e["values"]) >= 100:  # the UI shows 100 values per predicate and a "+n more" counter
            e["more"] += 1
            continue
        if r["o_lit"] is not None:
            e["values"].append(
                {
                    "lit": r["o_lit"],
                    "dt": short(r["dt"]) if r["dt"] else None,
                    "dt_iri": r["dt"],
                    "lang": r["lang"],
                    "graph": r["graph"],
                }
            )
        else:
            e["values"].append(
                {
                    "iri": r["oiri"],
                    "label": r["olabel"],
                    "name": short(r["oiri"]),
                    "kind": r["okind"],
                    "graph": r["graph"],
                }
            )
        e["piri"] = r["piri"]
    # annotations on axioms whose subject is this entity (e.g. fuzzy degrees)
    try:
        for r in (
            db()
            .execute(
                """SELECT p.iri AS piri, n.iri AS oiri, a.o_lit, ap.iri AS aprop, a.value, a.graph
                   FROM axiom_ann a JOIN nodes p ON p.id=a.p LEFT JOIN nodes n ON n.id=a.o_id
                   JOIN nodes ap ON ap.id=a.prop WHERE a.s=?""",
                (i,),
            )
            .fetchall()
        ):
            e = out.get(r["piri"])
            if not e:
                continue
            for v in e["values"]:
                if (r["o_lit"] is not None and v.get("lit") == r["o_lit"]) or (
                    r["oiri"] is not None and v.get("iri") == r["oiri"]
                ):
                    v.setdefault("axiom_ann", []).append(
                        {"prop": short(r["aprop"]), "value": r["value"], "graph": r["graph"]}
                    )
    except sqlite3.OperationalError:
        pass  # index built before axiom_ann existed
    # numeric bounds [kmin, kmax] of a fuzzy datatype, extracted from its fuzzyLabel at index time
    # (table absent in older indexes)
    bounds = None
    try:
        b = db().execute("SELECT kmin, kmax FROM datatype_bounds WHERE id=?", (i,)).fetchone()
        if b:
            bounds = {"kmin": b["kmin"], "kmax": b["kmax"]}
    except sqlite3.OperationalError:
        pass
    # incoming statements (entity as object): exact count, but only the first 200 rows are listed
    # (the Usage tab paginates the rest)
    n_in = db().execute("SELECT COUNT(*) FROM stmt WHERE o_id=?", (i,)).fetchone()[0]
    inc = {}
    rows = (
        db()
        .execute(
            """SELECT p.iri AS piri, n.iri AS siri, n.label AS slabel, n.kind AS skind, s.graph
           FROM stmt s JOIN nodes p ON p.id=s.p JOIN nodes n ON n.id=s.s
           WHERE s.o_id=? LIMIT 200""",
            (i,),
        )
        .fetchall()
    )
    for r in rows:
        e = inc.setdefault(r["piri"], {"pred": short(r["piri"]), "piri": r["piri"], "values": []})
        e["values"].append(
            {"iri": r["siri"], "label": r["slabel"], "name": short(r["siri"]), "kind": r["skind"], "graph": r["graph"]}
        )
    # modules with statements about the entity: declaration and assertions may live in different files
    mods = [g for (g,) in db().execute("SELECT DISTINCT graph FROM stmt WHERE s=?", (i,)).fetchall()]
    return {
        "node": node,
        "out": list(out.values()),
        "incoming": list(inc.values()),
        "incoming_total": n_in,
        "modules": mods,
        "bounds": bounds,
    }


def api_instances(q):
    """One page of the individuals asserted to be instances of a class (rdf:type, no reasoning).

    Query parameters:
        iri    class IRI (default '')
        page   0-based page of 200 individuals (default 0)
        graph  module file: only type assertions stored in that file (default '' = all)

    Returns {"total": int, "page": int, "items": [node_json…]} ordered by IRI, or
    {"error": "not found"} when the class is not in the index.
    """
    iri = q.get("iri", [""])[0]
    page = int(q.get("page", ["0"])[0])
    ci, ti = get_id(iri), get_id(config.RDF_TYPE)
    if ci is None:
        return {"error": "not found"}
    graph = q.get("graph", [""])[0]
    # unlike the other lists, `graph` filters the module of the rdf:type ASSERTION, not the one
    # declaring the individual (individuals are typically declared and typed in the same ABox file)
    gsql, gpar = (" AND s.graph=?", (graph,)) if graph else ("", ())
    total = db().execute(f"SELECT COUNT(*) FROM stmt s WHERE s.p=? AND s.o_id=?{gsql}", (ti, ci) + gpar).fetchone()[0]
    rows = (
        db()
        .execute(
            f"""SELECT n.* FROM stmt s JOIN nodes n ON n.id=s.s
           WHERE s.p=? AND s.o_id=?{gsql} ORDER BY n.lname, n.iri LIMIT 200 OFFSET ?""",
            (ti, ci) + gpar + (page * 200,),
        )
        .fetchall()
    )
    return {"total": total, "page": page, "items": [node_json(r) for r in rows]}


def _inferred_hierarchy(kind, by_iri):
    """Inferred edges of the saved TBox diff (``inference.load_tbox``) for one tree kind, as index ids:
    ({(child, parent)}, [(a, b) equivalences], {unsatisfiable ids}); empty when there is no result."""
    data = inference.load_tbox()
    edges, eqs, unsat = set(), [], set()
    for iri, e in data.get("classes" if kind == "class" else "properties", {}).items():
        i = by_iri.get(iri)
        if i is None:
            continue
        if e.get("unsatisfiable"):
            unsat.add(i)
        edges.update((i, by_iri[p]) for p in e.get("parents", []) if p in by_iri)
        eqs += [(i, by_iri[p]) for p in e.get("equivalent", []) if p in by_iri]
    return edges, eqs, unsat


def _prune_redundant(children, rep_of):
    """Drop the edges of a parent → children map made redundant by a longer path (A ⊑ C asserted, A ⊑ B
    inferred with B ⊑ C: A stays under B only, as in the inferred hierarchy of an ontology editor).
    ``children`` maps representative ids to lists of representative ids; modified in place."""
    anc = {}

    def ancestors(i):
        """Transitive parents of i (memoised)."""
        if i not in anc:
            anc[i] = set()
            for p, cs in children.items():
                if i in cs:
                    anc[i].add(p)
                    anc[i] |= ancestors(p)
        return anc[i]

    parents_of = {}
    for p, cs in children.items():
        for c in cs:
            parents_of.setdefault(c, []).append(p)
    for c, ps in parents_of.items():
        for p in ps:
            if any(o != p and p in ancestors(o) for o in ps):
                children[p].remove(c)


def api_tree(q=None):
    """Hierarchy of classes (rdfs:subClassOf / owl:equivalentClass) or of object, data and
    annotation properties (rdfs:subPropertyOf / owl:equivalentProperty), asserted only unless
    the inferred view is requested.

    Query parameters (``q`` may be None when called internally):
        kind      class|objprop|dataprop|annprop (default class)
        graph     module file: only entities declared there; for classes the instance counts are
                  also restricted to the rdf:type assertions of that file (default '' = closure)
        inferred  '1': add the inferred direct parents / equivalences of the saved reasoner result
                  (``ontoviewer.inference``): asserted ∪ inferred edges minus the redundant ones,
                  unsatisfiable classes grouped under a synthetic owl:Nothing root (first root)

    Returns {"roots": [tree node…]}; a tree node is node_json plus
        instances   number of asserted instances (0 for properties)
        equivalent  [{"name", "iri"}…] the other members of its equivalence group
        defined     True when the class has an owl:equivalentClass axiom (named or anonymous)
        children    sub-nodes, sorted by name
        inferred    (inferred view) True when the edge to its parent is inferred
        unsat       (inferred view) True for the owl:Nothing root and the unsatisfiable classes
    Roots are the group representatives without any parent, sorted by name.  A class occurs
    once in the tree per parent (multiple inheritance duplicates the sub-tree, as in the OWL API).
    """
    kind = (q or {}).get("kind", ["class"])[0]
    is_class = kind == "class"
    sub = get_id(str(RDFS.subClassOf if is_class else RDFS.subPropertyOf))
    graph = (q or {}).get("graph", [""])[0]
    inferred = bool((q or {}).get("inferred", [""])[0])
    gsql, gpar = declared_in(graph)
    # all entities of the kind (optionally declared in `graph`), keyed by index id
    classes = {
        r["id"]: node_json(r)
        for r in db().execute(f"SELECT * FROM nodes WHERE kind=?{gsql}", (kind,) + gpar).fetchall()
    }
    by_iri = {n["iri"]: i for i, n in classes.items()}
    inf_edges, inf_eqs, unsat = _inferred_hierarchy(kind, by_iri) if inferred else (set(), [], set())
    ti = get_id(config.RDF_TYPE)
    # asserted instance counts per class (objects of rdf:type); properties have none
    counts = (
        dict(
            db()
            .execute(
                "SELECT o_id, COUNT(*) FROM stmt WHERE p=?" + (" AND graph=?" if graph else "") + " GROUP BY o_id",
                (ti,) + gpar,
            )
            .fetchall()
        )
        if is_class
        else {}
    )
    # hierarchy edges from EVERY module (not only `graph`): an imported class may be specialised
    # in another file; edges touching entities outside `classes` are ignored when building
    edges = db().execute("SELECT s, o_id FROM stmt WHERE p=? AND o_id IS NOT NULL", (sub,)).fetchall() if sub else []
    edges = [tuple(e) for e in edges] + sorted(inf_edges)  # inferred edges (if any) after the asserted ones
    # equivalence groups (asserted owl:equivalentClass/Property between named entities) collapse into
    # ONE node "A = B = C": representative = the asserted subject (alphabetically first if several);
    # children and instances of every member are merged under it
    eqp = get_id(str(OWL.equivalentClass if is_class else OWL.equivalentProperty))
    parent = {i: i for i in classes}  # union-find forest over the entity ids

    def find(i):
        """Root of i in the union-find forest (with path compression)."""
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    # union the two sides of every asserted (and, in the inferred view, inferred) equivalence
    # between named entities of the tree; the asserted subjects are remembered as preferred
    # representatives
    subjects = set()
    eq_pairs = (
        [tuple(r) for r in db().execute("SELECT s, o_id FROM stmt WHERE p=? AND o_id IS NOT NULL", (eqp,)).fetchall()]
        if eqp is not None
        else []
    )
    for s, o in eq_pairs + inf_eqs:
        if s in classes and o in classes and s not in unsat and o not in unsat:
            subjects.add(s)
            parent[find(s)] = find(o)
    groups = {}  # root id -> members (singletons included)
    for i in classes:
        groups.setdefault(find(i), []).append(i)
    rep_of = {}  # member id -> representative id of its group
    for g in groups.values():
        subs = [i for i in g if i in subjects] or g
        rep = min(subs, key=lambda i: classes[i]["name"].lower())
        for i in g:
            rep_of[i] = rep
    # "defined" mark: any equivalentClass axiom, named or anonymous (the latter from the module files)
    defined = {i for g in groups.values() if len(g) > 1 for i in g}
    # anonymous equivalences (C ≡ ∃r.D …) are not in the index: read them from the cached TBox of
    # each module; a module that fails to parse simply contributes no marks
    for f in workspace.load()["files"] if is_class else []:
        try:
            for a in axioms.tbox(f):
                if a["kind"] == "EquivalentClasses" and a.get("siri") in by_iri:
                    defined.add(by_iri[a["siri"]])
        except Exception:
            pass
    # parent → children between representatives only: an edge inside a group is a no-op, and a
    # child is listed once per parent; unsatisfiable classes leave the hierarchy (owl:Nothing root)
    children, has_parent, inf_rep = {}, set(), set()
    for s, o in edges:
        if s in classes and o in classes and s not in unsat:
            rs, ro = rep_of[s], rep_of[o]
            if rs != ro and rs not in children.setdefault(ro, []):
                children[ro].append(rs)
                has_parent.add(rs)
            if (s, o) in inf_edges:
                inf_rep.add((rs, ro))
    if inferred:
        _prune_redundant(children, rep_of)

    def build(i, above=None):
        """Tree node of representative i under parent `above` (recursive): instances, equivalents, defined
        flag, inferred / unsatisfiable marks (inferred view), children."""
        g = groups[find(i)]
        n = dict(classes[i])
        if inferred:
            n["inferred"] = (i, above) in inf_rep
            n["unsat"] = i in unsat
        if not is_class:
            n["instances"] = 0
        elif len(g) == 1:
            n["instances"] = counts.get(i, 0)
        else:  # equivalent classes share their individuals: count them once
            marks = ",".join("?" * len(g))
            n["instances"] = (
                db()
                .execute(
                    f"SELECT COUNT(DISTINCT s) FROM stmt WHERE p=? AND o_id IN ({marks})"
                    + (" AND graph=?" if graph else ""),
                    (ti, *g) + gpar,
                )
                .fetchone()[0]
            )
        n["fuzzy"] = any(classes[j]["fuzzy"] for j in g)
        n["equivalent"] = sorted(
            ({"name": classes[j]["name"], "iri": classes[j]["iri"]} for j in g if j != i),
            key=lambda x: x["name"].lower(),
        )
        n["defined"] = i in defined
        n["children"] = sorted((build(c, i) for c in children.get(i, [])), key=lambda x: x["name"].lower())
        return n

    roots = [build(i) for i in classes if rep_of[i] == i and i not in has_parent and i not in unsat]
    nothing = []
    if unsat:  # inferred view: the unsatisfiable classes, flat, under a synthetic owl:Nothing root
        nothing = [
            {
                **node_json({"id": None, "iri": str(OWL.Nothing), "label": None, "kind": "class"}),
                "instances": 0,
                "equivalent": [],
                "defined": False,
                "inferred": True,
                "unsat": True,
                "children": sorted((build(i) for i in unsat), key=lambda x: x["name"].lower()),
            }
        ]
    if kind == "annprop":  # built-in annotation properties (never declared): synthetic roots
        have = {n["iri"] for n in classes.values()}
        roots += [
            {
                "id": None,
                "iri": b,
                "label": None,
                "kind": "annprop",
                "name": config.builtin_name(b),
                "fuzzy": False,
                "builtin": True,
                "instances": 0,
                "equivalent": [],
                "defined": False,
                "children": [],
            }
            for b in config.BUILTIN_ANNPROPS
            if b not in have
        ]
    roots.sort(key=lambda x: x["name"].lower())
    return {"roots": nothing + roots}


def api_usage(q):
    """ontology-editor-like 'Usage' of an entity: as predicate, as literal datatype, inside
    anonymous definitions (restrictions…) of named entities. Paginated (200).

    Query parameters:
        iri   IRI of the entity (default '')
        page  0-based page of the 'as predicate' list, 200 rows per page (default 0)

    Returns {"as_predicate": {"total", "page", "items": [{"s": node, "o": value, "graph"}…]},
    "as_datatype": {"total", "items": [{"s", "pred", "lit"}…]} (first 50 literals typed with the IRI),
    "in_definitions": [{"s": node, "via": predicate name, "graph"}…] (up to 500 named entities whose
    anonymous expression references the IRI, ``via`` = the predicate leading to the expression),
    "as_object_total": int} — or {"error": "not found"}.  ``as_datatype`` / ``in_definitions`` are
    empty on indexes lacking the ``dt`` column / the ``bnode_refs`` table.
    """
    iri = q.get("iri", [""])[0]
    page = int(q.get("page", ["0"])[0])
    i = get_id(iri)
    if i is None:
        return {"error": "not found"}
    out = {}
    # 1) as predicate: statements using the entity as property (annotation/object/data property)
    n_pred = db().execute("SELECT COUNT(*) FROM stmt WHERE p=?", (i,)).fetchone()[0]
    rows = (
        db()
        .execute(
            """SELECT ns.iri AS siri, ns.label AS slabel, ns.kind AS skind, no.iri AS oiri, no.label AS olabel,
                  no.kind AS okind, s.o_lit, s.dt, s.lang, s.graph
           FROM stmt s JOIN nodes ns ON ns.id=s.s LEFT JOIN nodes no ON no.id=s.o_id
           WHERE s.p=? ORDER BY ns.lname, ns.iri LIMIT 200 OFFSET ?""",
            (i, page * 200),
        )
        .fetchall()
    )
    out["as_predicate"] = {
        "total": n_pred,
        "page": page,
        "items": [
            {
                "s": {
                    "iri": r["siri"],
                    "label": r["slabel"],
                    "kind": r["skind"],
                    "name": short(r["siri"]),
                    "fuzzy": get_id(r["siri"]) in fuzzy_ids(),
                },
                "o": (
                    {"lit": r["o_lit"], "dt": short(r["dt"]) if r["dt"] else None, "lang": r["lang"]}
                    if r["o_lit"] is not None
                    else {"iri": r["oiri"], "label": r["olabel"], "kind": r["okind"], "name": short(r["oiri"])}
                ),
                "graph": r["graph"],
            }
            for r in rows
        ],
    }
    # 2) as datatype: literals typed with this IRI (`dt` stores the datatype IRI as text, so the
    # lookup is by IRI, not by node id)
    try:
        n_dt = db().execute("SELECT COUNT(*) FROM stmt WHERE dt=?", (iri,)).fetchone()[0]
        drows = (
            db()
            .execute(
                """SELECT ns.iri AS siri, ns.kind AS skind, np.iri AS piri, s.o_lit FROM stmt s
               JOIN nodes ns ON ns.id=s.s JOIN nodes np ON np.id=s.p WHERE s.dt=? LIMIT 50""",
                (iri,),
            )
            .fetchall()
        )
        out["as_datatype"] = {
            "total": n_dt,
            "items": [
                {
                    "s": {"iri": r["siri"], "name": short(r["siri"]), "kind": r["skind"]},
                    "pred": short(r["piri"]),
                    "lit": r["o_lit"],
                }
                for r in drows
            ],
        }
    except sqlite3.OperationalError:
        out["as_datatype"] = {"total": 0, "items": []}
    # 3) inside anonymous definitions: bnode_refs (filled at index time) records, for every blank-node
    # expression hanging off a named subject, the entities it references and the predicate (`via`)
    try:
        brows = (
            db()
            .execute(
                """SELECT ns.iri AS siri, ns.label AS slabel, ns.kind AS skind, nv.iri AS via, b.graph
               FROM bnode_refs b JOIN nodes ns ON ns.id=b.s JOIN nodes nv ON nv.id=b.via
               WHERE b.ref=? ORDER BY ns.lname, ns.iri LIMIT 500""",
                (i,),
            )
            .fetchall()
        )
        out["in_definitions"] = [
            {
                "s": {
                    "iri": r["siri"],
                    "label": r["slabel"],
                    "kind": r["skind"],
                    "name": short(r["siri"]),
                    "fuzzy": get_id(r["siri"]) in fuzzy_ids(),
                },
                "via": short(r["via"]),
                "graph": r["graph"],
            }
            for r in brows
        ]
    except sqlite3.OperationalError:
        out["in_definitions"] = []
    # 4) as object of statements: only the count (api_entity lists them under "incoming")
    n_in = db().execute("SELECT COUNT(*) FROM stmt WHERE o_id=?", (i,)).fetchone()[0]
    out["as_object_total"] = n_in
    return out


def api_entity_axioms(q):
    """Schema axioms of one entity across the workspace modules (anonymous expressions rendered
    in DL): own axioms (subject = entity) and general class axioms mentioning it.

    Query parameters:
        iri  IRI of the entity (default '')

    Returns {"own": [axiom…], "gci": [axiom…]}; an axiom is an ``axioms.tbox`` item
    ({kind, fuzzy, dl, fdl, fm, man, s, siri, oiri, odl, sdl, anon, refs, ann, piri, …}) plus
    "module": the file it comes from.  Modules that fail to parse are skipped silently.
    """
    iri = q.get("iri", [""])[0]
    own, gci = [], []
    for f in workspace.load()["files"]:
        try:
            items = axioms.tbox(f)
        except Exception:
            continue
        for a in items:
            if a.get("siri") == iri:
                own.append(dict(a, module=f))
            # axioms with an anonymous subject (GCI, disjointness of expressions) have no `siri`:
            # they are listed when the entity appears anywhere in them (`refs`)
            elif a["kind"] in ("GCI", "DisjointClasses") and iri in a.get("refs", []) and not a.get("siri"):
                gci.append(dict(a, module=f))
    return {"own": own, "gci": gci}


def api_fuzzy(q):
    """All entities marked isFuzzy, grouped by kind, with their fuzzyLabel kind if any.

    No query parameters are used.

    Returns {"groups": {kind: [node…]}, "total": int}; each node is node_json plus
        fuzzyLabel  raw XML text of the Fuzzy OWL 2 annotation (None if absent)
        fuzzyType   the fuzzyType attribute of that XML (datatype, concept, modifier, …);
                    a class without label is reported as "class", other kinds as None
        shape       the membership-function type (leftshoulder, triangular, …), if any
    """
    ids = fuzzy_ids()
    if not ids:
        return {"groups": {}, "total": 0}
    # the fuzzyLabel annotation property: None when the vocabulary is not used in this workspace
    fl = get_id("http://www.semanticweb.org/ontologies/fuzzydl_ontology#fuzzyLabel")
    groups = {}
    for r in (
        db().execute(f"SELECT * FROM nodes WHERE id IN ({','.join(map(str, ids))}) ORDER BY kind, lname").fetchall()
    ):
        n = node_json(r)
        # one label per entity is enough for the summary (LIMIT 1); the fields below are parsed
        # from the Fuzzy OWL 2 XML with regexes, no XML parser needed
        lit = db().execute("SELECT o_lit FROM stmt WHERE s=? AND p=? LIMIT 1", (r["id"], fl)).fetchone() if fl else None
        n["fuzzyLabel"] = lit["o_lit"] if lit else None
        m = re.search(r'fuzzyType="(\w+)"', n["fuzzyLabel"] or "")
        n["fuzzyType"] = m.group(1) if m else ("class" if r["kind"] == "class" else None)
        m2 = re.search(r'<(?:Datatype|Concept|Modifier) type="(\w+)"', n["fuzzyLabel"] or "")
        n["shape"] = m2.group(1) if m2 else None
        groups.setdefault(r["kind"] or "other", []).append(n)
    return {"groups": groups, "total": len(ids)}
