"""GET API: TBox graph (classes, properties, UML extras) and knowledge graph of individuals.

Both handlers read the index only; node ids in the results are the ``nodes.id`` of the index and
edges reference them.  Names are the local parts of the IRIs (``store.short``).

Routes (see ``ontoviewer.api.GET_ROUTES``):
    /api/graph → api_graph
    /api/kg    → api_kg
"""

from rdflib.namespace import RDFS, OWL

from ontoviewer import axioms, config, workspace
from ontoviewer.store import db, declared_in, fuzzy_ids, get_id, short


def api_graph(q):
    """TBox graph of one module ('' = closure): nodes = named classes (+ datatypes reached by data
    properties), edges = subClassOf / equivalentClass / disjointWith between named classes, object
    properties as domain→range edges, data properties as domain→datatype edges.

    Query parameters:
        graph  module file: classes/properties declared there and axioms stored there
               (default '' = closure)

    Returns {"graph": file or "closure", "nodes": [node…], "edges": [edge…]} where
        node  {"id", "iri", "name", "kind": class|datatype, "fuzzy", "module"?} plus the UML
              extras "attrs"?: [{"name", "range", "func"}…] (data properties by domain),
              "equiv"?: [name…] (asserted named equivalents), "restr"?: [DL line…] (up to 6
              anonymous super/equivalent class expressions)
        edge  {"s": id, "o": id, "type": subClassOf|equivalentClass|disjointWith|objprop|dataprop,
              "label"?, "iri"?} (label/iri = the property, for property edges only)
    """
    graph = q.get("graph", [""])[0]
    gsql, gpar = declared_in(graph)  # entities declared in the module
    gw, gp = (" AND graph=?", (graph,)) if graph else ("", ())  # statements stored in the module
    c = db()
    P = {k: get_id(str(RDFS[k])) for k in ("subClassOf", "domain", "range")}
    P.update({k: get_id(str(OWL[k])) for k in ("equivalentClass", "disjointWith")})
    ti, cls_t = get_id(config.RDF_TYPE), get_id(str(OWL.Class))
    fz = fuzzy_ids()
    nodes = {
        r["id"]: {"iri": r["iri"], "name": short(r["iri"]), "kind": "class", "fuzzy": r["id"] in fz}
        for r in c.execute(f"SELECT * FROM nodes WHERE kind='class'{gsql}", gpar).fetchall()
    }
    # declaring module of each class (file of its rdf:type owl:Class), used to colour nodes per file
    for r in c.execute("SELECT s, graph FROM stmt WHERE p=? AND o_id=?", (ti, cls_t)).fetchall():
        if r["s"] in nodes:
            nodes[r["s"]].setdefault("module", r["graph"])
    # class-to-class axioms; an edge is kept only when both ends are named classes of the graph
    # (anonymous expressions are blank nodes, hence not in `nodes`)
    edges = []
    for kind, pid in (
        ("subClassOf", P["subClassOf"]),
        ("equivalentClass", P["equivalentClass"]),
        ("disjointWith", P["disjointWith"]),
    ):
        if pid is None:
            continue
        for r in c.execute(f"SELECT s, o_id FROM stmt WHERE p=? AND o_id IS NOT NULL{gw}", (pid,) + gp).fetchall():
            if r["s"] in nodes and r["o_id"] in nodes:
                edges.append({"s": r["s"], "o": r["o_id"], "type": kind})
    props = {
        r["id"]: (r["iri"], r["kind"])
        for r in c.execute(f"SELECT * FROM nodes WHERE kind IN ('objprop','dataprop'){gsql}", gpar).fetchall()
    }
    # named domains/ranges per property (a property may have several of each: one edge per pair)
    dom, rng = {}, {}
    for r in c.execute(
        f"SELECT s, p, o_id FROM stmt WHERE p IN (?,?) AND o_id IS NOT NULL{gw}", (P["domain"], P["range"]) + gp
    ).fetchall():
        if r["s"] in props:
            (dom if r["p"] == P["domain"] else rng).setdefault(r["s"], []).append(r["o_id"])
    for pid, (piri, pk) in props.items():
        for d in dom.get(pid, []):
            if d not in nodes:
                continue
            for o in rng.get(pid, []):
                if pk == "objprop":
                    if o in nodes:
                        edges.append({"s": d, "o": o, "type": "objprop", "label": short(piri), "iri": piri})
                else:
                    # datatypes are not graph nodes by default: added on demand when a data
                    # property's range points to one (built-in or user-defined)
                    if o not in nodes:
                        r = c.execute("SELECT iri FROM nodes WHERE id=?", (o,)).fetchone()
                        if not r:
                            continue
                        nodes[o] = {"iri": r["iri"], "name": short(r["iri"]), "kind": "datatype", "fuzzy": o in fz}
                    edges.append({"s": d, "o": o, "type": "dataprop", "label": short(piri), "iri": piri})
    # UML extras per class: attributes (data properties by domain, with range and
    # {func}), named equivalents (asserted side), anonymous restrictions as text lines
    func = get_id(str(OWL.FunctionalProperty))
    functional = (
        {r[0] for r in c.execute("SELECT s FROM stmt WHERE p=? AND o_id=?", (ti, func)).fetchall()} if func else set()
    )
    rng_names = {}
    for pid, (piri, pk) in props.items():
        if pk == "dataprop":
            names = []
            for o in rng.get(pid, []):
                r = c.execute("SELECT iri FROM nodes WHERE id=?", (o,)).fetchone()
                if r:
                    names.append(short(r["iri"]))
            rng_names[pid] = names
            for d in dom.get(pid, []):
                if d in nodes:
                    nodes[d].setdefault("attrs", []).append(
                        {"name": short(piri), "range": ",".join(names) or "?", "func": pid in functional}
                    )
    eqp = get_id(str(OWL.equivalentClass))
    if eqp is not None:
        for r in c.execute(f"SELECT s, o_id FROM stmt WHERE p=? AND o_id IS NOT NULL{gw}", (eqp,) + gp).fetchall():
            if r["s"] in nodes and r["o_id"] in nodes:
                nodes[r["s"]].setdefault("equiv", []).append(nodes[r["o_id"]]["name"])
    # `restr`: anonymous superclass / equivalent-class expressions are not indexed (blank nodes):
    # take their DL text from the module files' cached TBox, at most 6 lines per class
    by_iri = {n["iri"]: i for i, n in nodes.items()}
    files = [graph] if graph else workspace.load()["files"]
    for f in files:
        try:
            for a in axioms.tbox(f):
                i = by_iri.get(a.get("siri"))
                if (
                    i is not None
                    and a.get("anon")
                    and a["kind"] in ("SubClassOf", "EquivalentClasses")
                    and a.get("odl")
                ):
                    lines = nodes[i].setdefault("restr", [])
                    if len(lines) < 6:
                        lines.append(("≡ " if a["kind"] == "EquivalentClasses" else "⊑ ") + a["odl"])
        except Exception:
            pass
    return {"graph": graph or "closure", "nodes": [dict(id=i, **n) for i, n in nodes.items()], "edges": edges}


def api_kg(q):
    """Knowledge graph of individuals: BFS over object-property assertions (both directions)
    from a start individual (iri=) or from a sample of the instances of a class (cls=).

    Query parameters (``whole`` wins over ``iri``, which wins over ``cls``):
        iri    start individual IRI (default '')
        cls    class IRI: its first min(limit, 40) asserted instances are the seeds (default '')
        depth  number of BFS hops from the seeds (default 1; forced to 0 in ``whole`` mode)
        limit  maximum number of nodes (default 150); reaching it sets "truncated"
        whole  'closure' or a module file: no BFS, take the first object-property assertions
               of that scope (file order) so that about `limit` individuals plus the edges among
               them form a connected sample (default '')

    Returns {"nodes": [{"id", "iri", "name", "kind", "fuzzy", "types": [class name…] (≤ 6),
    "depth", "seed"}…], "edges": [{"s", "o", "label", "iri"}…], "truncated": bool,
    "total_individuals": n in ``whole`` mode, else None}; {"nodes": [], "edges": [], "error": …}
    when no seed is found.
    """
    start, cls = q.get("iri", [""])[0], q.get("cls", [""])[0]
    depth, limit = int(q.get("depth", ["1"])[0]), int(q.get("limit", ["150"])[0])
    whole = q.get("whole", [""])[0]  # 'closure' or a module file: the first `limit` individuals + edges among them
    c = db()
    ti = get_id(config.RDF_TYPE)
    seeds = []
    whole_edges = []
    if whole:  # the first object-property assertions of the scope (file order) → a connected sample, not isolated nodes
        gw, gp = (" AND st.graph=?", (whole,)) if whole != "closure" else ("", ())
        sel = set()
        # 3×limit assertions are scanned: once `limit` individuals are selected only edges between
        # already-selected ones are kept, which densifies the sample without growing it
        for r in c.execute(
            f"""SELECT st.s, st.o_id, np.iri AS piri FROM stmt st
                               JOIN nodes np ON np.id=st.p JOIN nodes ns ON ns.id=st.s
                               WHERE np.kind='objprop' AND st.o_id IS NOT NULL AND ns.kind='individual'{gw} LIMIT ?""",
            gp + (limit * 3,),
        ).fetchall():
            if len(sel) >= limit and (r["s"] not in sel or r["o_id"] not in sel):
                continue
            sel.add(r["s"])
            sel.add(r["o_id"])
            whole_edges.append({"s": r["s"], "o": r["o_id"], "label": short(r["piri"]), "iri": r["piri"]})
        seeds = sorted(sel)
        depth = 0
    elif start and get_id(start) is not None:
        seeds = [get_id(start)]
    elif cls and get_id(cls) is not None:
        seeds = [
            r[0]
            for r in c.execute(
                "SELECT s FROM stmt WHERE p=? AND o_id=? LIMIT ?", (ti, get_id(cls), min(limit, 40))
            ).fetchall()
        ]
    if not seeds:
        return {"nodes": [], "edges": [], "error": "start individual or class not found"}
    # BFS over object-property assertions in both directions: every edge touching the frontier is
    # collected once (seen_e); endpoints not seen before join the next frontier with depth d+1
    # until `limit` nodes exist (further endpoints are skipped, their edges pruned below)
    nodes, edges, seen_e = {}, [], set()
    frontier = list(seeds)
    for i in seeds:
        nodes[i] = {"depth": 0}
    edges += whole_edges
    for d in range(depth):
        nxt = []
        for i in frontier:
            rows = c.execute(
                """SELECT st.s, st.p, st.o_id, np.iri AS piri FROM stmt st JOIN nodes np ON np.id=st.p
                                WHERE (st.s=? OR st.o_id=?) AND np.kind='objprop' AND st.o_id IS NOT NULL""",
                (i, i),
            ).fetchall()
            for r in rows:
                key = (r["s"], r["p"], r["o_id"])
                if key in seen_e:
                    continue
                seen_e.add(key)
                edges.append({"s": r["s"], "o": r["o_id"], "label": short(r["piri"]), "iri": r["piri"]})
                for j in (r["s"], r["o_id"]):
                    if j not in nodes:
                        if len(nodes) >= limit:
                            continue
                        nodes[j] = {"depth": d + 1}
                        nxt.append(j)
        frontier = nxt
    # drop edges whose endpoint was refused by the node limit
    edges = [e for e in edges if e["s"] in nodes and e["o"] in nodes]
    fz = fuzzy_ids()
    out = []
    for i, meta in nodes.items():
        r = c.execute("SELECT iri, kind, label FROM nodes WHERE id=?", (i,)).fetchone()
        # asserted classes of the node (rdf:type objects) minus the owl:NamedIndividual declaration
        types = [
            short(t[0])
            for t in c.execute(
                """SELECT n.iri FROM stmt s JOIN nodes n ON n.id=s.o_id WHERE s.s=? AND s.p=? AND n.iri<>?""",
                (i, ti, str(OWL.NamedIndividual)),
            ).fetchall()
        ]
        out.append(
            {
                "id": i,
                "iri": r["iri"],
                "name": short(r["iri"]),
                "kind": r["kind"] or "individual",
                "fuzzy": i in fz,
                "types": types[:6],
                "depth": meta["depth"],
                "seed": i in seeds and not whole,
            }
        )
    total = None
    if whole:  # how many individuals the sample was drawn from (declared in the scope)
        gsql, gpar = declared_in("" if whole == "closure" else whole)
        total = c.execute(f"SELECT COUNT(*) FROM nodes WHERE kind='individual'{gsql}", gpar).fetchone()[0]
    return {"nodes": out, "edges": edges, "truncated": len(nodes) >= limit, "total_individuals": total}
