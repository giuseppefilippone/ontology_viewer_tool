"""DL Query (ontology-editor-like): a Manchester class expression → super/sub/equivalent classes and
instances.

* classes: HermiT (owlready2) on the schema modules with a temporary class __Q ≡ expression;
  falls back to the asserted subClassOf closure of the index when the expression is a named class
  and the reasoner is not requested.
* instances: evaluated on the index (asserted types + subclass closure, property values); the
  reasoner does not see the 400k-individual ABox.
"""

import json
import sqlite3
import sys
import time

from rdflib.namespace import RDF, RDFS, OWL

from ontoviewer import manchester
from ontoviewer import reasoner
from ontoviewer import workspace

RDF_TYPE = str(RDF.type)
SUBCLASS = str(RDFS.subClassOf)
OWL_THING = str(OWL.Thing)
XSD = "http://www.w3.org/2001/XMLSchema#"

QUERY_RUNNER = r"""
import json, sys, traceback
owl, qiri = sys.argv[1], sys.argv[2]
out = {}
try:
    from owlready2 import get_ontology, sync_reasoner_hermit, Thing, Nothing, IRIS
    import owlready2
    onto = get_ontology("file://" + owl).load()
    with onto:
        sync_reasoner_hermit(debug=0)
    Q = IRIS[qiri]
    def named(cs):
        return sorted({str(c.iri) for c in cs if hasattr(c, "iri") and str(c.iri) != qiri})
    equiv = named(Q.equivalent_to) + ([str(Thing.iri)] if Thing in Q.equivalent_to else [])
    direct_sup = named(Q.is_a)
    sup = named(Q.ancestors(include_self=False))
    direct_sub = named(Q.subclasses())
    sub = named(Q.descendants(include_self=False))
    unsat = Nothing in Q.equivalent_to or any(str(getattr(c, "iri", "")) == str(Nothing.iri) for c in Q.equivalent_to)
    out = {"equivalent": equiv, "direct_superclasses": direct_sup, "superclasses": sup,
           "direct_subclasses": direct_sub, "subclasses": sub, "unsatisfiable": bool(unsat)}
except Exception as e:
    out = {"error": str(e), "traceback": traceback.format_exc()[-2500:]}
print("@@JSON@@" + json.dumps(out))
"""


def _conn():
    c = sqlite3.connect(workspace.db_path())
    c.row_factory = sqlite3.Row
    return c


def _nid(c, iri):
    r = c.execute("SELECT id FROM nodes WHERE iri=?", (iri,)).fetchone()
    return r[0] if r else None


def _subclass_closure(c, cid, down=True):
    """ids of all (transitive) sub- (down) or super-classes (up) of cid, named only."""
    sub = _nid(c, SUBCLASS)
    out, frontier = set(), [cid]
    while frontier:
        i = frontier.pop()
        rows = (
            c.execute("SELECT s FROM stmt WHERE p=? AND o_id=?", (sub, i)).fetchall()
            if down
            else c.execute("SELECT o_id FROM stmt WHERE p=? AND s=? AND o_id IS NOT NULL", (sub, i)).fetchall()
        )
        for (j,) in rows:
            if j not in out:
                out.add(j)
                frontier.append(j)
    return out


# ------------------------------------------------------------ instances on the index


def _instances_of_class(c, cid):
    ti = _nid(c, RDF_TYPE)
    ids = {cid} | _subclass_closure(c, cid, down=True)
    out = set()
    for k in ids:
        out.update(r[0] for r in c.execute("SELECT s FROM stmt WHERE p=? AND o_id=?", (ti, k)).fetchall())
    return out


def _all_individuals(c):
    return {r[0] for r in c.execute("SELECT id FROM nodes WHERE kind='individual'").fetchall()}


def _lit_ok(val, dt, ast):
    """literal satisfies a data range AST?"""
    k = ast[0]
    if k == "datatype":
        base, facets = ast[1], ast[2]
        try:
            x = float(val)
        except ValueError:
            return not facets and (base.endswith("string") or base.endswith("Literal"))
        for f, v in facets:
            v = float(v)
            if (
                (f == "minInclusive" and x < v)
                or (f == "maxInclusive" and x > v)
                or (f == "minExclusive" and x <= v)
                or (f == "maxExclusive" and x >= v)
            ):
                return False
        return True
    if k == "dataOneOf":
        return val in ast[1]
    return False


def eval_instances(c, ast, universe=None):
    k = ast[0]
    if k == "class":
        if ast[1] == OWL_THING:
            return universe if universe is not None else _all_individuals(c)
        cid = _nid(c, ast[1])
        return _instances_of_class(c, cid) if cid is not None else set()
    if k == "and":
        sets = [eval_instances(c, x, universe) for x in ast[1]]
        return set.intersection(*sets) if sets else set()
    if k == "or":
        return set().union(*[eval_instances(c, x, universe) for x in ast[1]])
    if k == "not":
        u = universe if universe is not None else _all_individuals(c)
        return u - eval_instances(c, ast[1], u)
    if k == "oneOf":
        return {i for i in (_nid(c, x) for x in ast[1]) if i is not None}
    if k in ("some", "only", "value", "card", "self"):
        if str(ast[1]).startswith(manchester.INVERSE):
            raise manchester.ExprError("inverse properties cannot be evaluated on the index (use the reasoner)")
        pid = _nid(c, ast[1] if k != "card" else ast[2])
        if pid is None:
            return set()
        if k == "value":
            v = ast[2]
            if v[0] == "ind":
                oid = _nid(c, v[1])
                return (
                    {r[0] for r in c.execute("SELECT s FROM stmt WHERE p=? AND o_id=?", (pid, oid)).fetchall()}
                    if oid is not None
                    else set()
                )
            return {r[0] for r in c.execute("SELECT s FROM stmt WHERE p=? AND o_lit=?", (pid, v[1])).fetchall()}
        if k == "self":
            return {r[0] for r in c.execute("SELECT s FROM stmt WHERE p=? AND o_id=s", (pid,)).fetchall()}
        filler = ast[2] if k != "card" else ast[4]
        pkind = ast[3] if k != "card" else ast[5]
        data = pkind == "dataprop"
        # subjects with their values for this property
        vals = {}
        for r in c.execute("SELECT s, o_id, o_lit, dt FROM stmt WHERE p=?", (pid,)).fetchall():
            vals.setdefault(r["s"], []).append((r["o_id"], r["o_lit"], r["dt"]))
        if filler is None:

            def ok(v):
                return True

        elif data:

            def ok(v):
                return v[1] is not None and _lit_ok(v[1], v[2], filler)

        else:
            fill = eval_instances(c, filler, universe)

            def ok(v):
                return v[0] in fill

        if k == "some":
            return {s for s, vs in vals.items() if any(ok(v) for v in vs)}
        if k == "only":  # individuals whose every value satisfies the filler (those without values included, as in OWL)
            u = universe if universe is not None else _all_individuals(c)
            return {s for s in u if all(ok(v) for v in vals.get(s, []))}
        n = int(ast[3])
        cnt = {s: sum(1 for v in vs if ok(v)) for s, vs in vals.items()}
        if ast[1] == "min":
            return (
                {s for s, m in cnt.items() if m >= n}
                if n > 0
                else (universe if universe is not None else _all_individuals(c))
            )
        u = universe if universe is not None else _all_individuals(c)
        if ast[1] == "max":
            return {s for s in u if cnt.get(s, 0) <= n}
        return {s for s in u if cnt.get(s, 0) == n}
    return set()


# ------------------------------------------------------------ classes via HermiT


def classes_by_reasoner(expr_ast, timeout=600):
    """HermiT on the schema modules plus a temporary class ``__Query ≡ expression``: the runner's
    {"equivalent", "direct_superclasses", "superclasses", "direct_subclasses", "subclasses",
    "unsatisfiable"} (IRIs) or {"error", …} (``reasoner.run_script``)."""
    work = reasoner.new_workdir("dlq_")
    owl = work / "kb.owl"
    reasoner.build_temp_ontology([], owl)
    qiri = "http://www.semanticweb.org/ontologies/fuzzydl_ontology/class#__Query"
    block = manchester.axiom_block(qiri, "class", "owl:equivalentClass", expr_ast)
    txt = owl.read_text(encoding="utf-8")
    txt = txt.replace("</rdf:RDF>", block + "</rdf:RDF>")
    owl.write_text(txt, encoding="utf-8")
    return reasoner.run_script(work, QUERY_RUNNER, [owl, qiri], timeout, log_chars=1500)


def query(expr, wants, use_reasoner=True, limit=500):
    t0 = time.time()
    ast = manchester.parse(expr)
    c = _conn()
    out = {"expression": manchester.to_manchester(ast), "seconds": 0}
    fz = set()
    try:
        import app  # fuzzy ids for the result rendering

        fz = app.fuzzy_ids()
    except Exception:
        pass

    def node(i):
        r = c.execute("SELECT iri, kind, label FROM nodes WHERE id=?", (i,)).fetchone()
        return {
            "iri": r["iri"],
            "name": r["iri"].rsplit("#", 1)[-1].rsplit("/", 1)[-1],
            "kind": r["kind"] or "class",
            "label": r["label"],
            "fuzzy": i in fz,
        }

    def nodes_by_iri(iris):
        out_ = []
        for iri in iris:
            i = _nid(c, iri)
            out_.append(
                node(i)
                if i is not None
                else {"iri": iri, "name": iri.rsplit("#", 1)[-1], "kind": "class", "fuzzy": False}
            )
        return out_

    cls_wants = [w for w in wants if w != "instances"]
    if cls_wants:
        if use_reasoner:
            res = classes_by_reasoner(ast)
            if "error" in res:
                out["reasoner_error"] = res["error"] + (
                    "\n" + res.get("traceback", res.get("log", "")) if res.get("traceback") or res.get("log") else ""
                )
            else:
                for w in cls_wants:
                    out[w] = nodes_by_iri(
                        res.get(
                            {
                                "direct_superclasses": "direct_superclasses",
                                "superclasses": "superclasses",
                                "equivalent": "equivalent",
                                "direct_subclasses": "direct_subclasses",
                                "subclasses": "subclasses",
                            }[w],
                            [],
                        )
                    )
                out["unsatisfiable"] = res.get("unsatisfiable", False)
        else:  # asserted hierarchy of the index (named class only)
            if ast[0] == "class" and _nid(c, ast[1]) is not None:
                cid = _nid(c, ast[1])
                sub = _nid(c, SUBCLASS)
                d_sup = [
                    r[0]
                    for r in c.execute(
                        "SELECT o_id FROM stmt WHERE p=? AND s=? AND o_id IS NOT NULL", (sub, cid)
                    ).fetchall()
                ]
                d_sub = [r[0] for r in c.execute("SELECT s FROM stmt WHERE p=? AND o_id=?", (sub, cid)).fetchall()]
                m = {
                    "direct_superclasses": d_sup,
                    "superclasses": sorted(_subclass_closure(c, cid, down=False)),
                    "direct_subclasses": d_sub,
                    "subclasses": sorted(_subclass_closure(c, cid, down=True)),
                    "equivalent": [
                        r[0]
                        for r in c.execute(
                            "SELECT o_id FROM stmt WHERE p=(SELECT id FROM nodes WHERE iri='http://www.w3.org/2002/07/owl#equivalentClass') AND s=? AND o_id IS NOT NULL",
                            (cid,),
                        ).fetchall()
                    ],
                }
                for w in cls_wants:
                    out[w] = [node(i) for i in m[w]]
            else:
                out["note"] = (
                    "asserted mode: class hierarchy is available for named classes only (enable the reasoner for expressions)"
                )
    if "instances" in wants:
        ids = eval_instances(c, ast)
        out["instances_total"] = len(ids)
        out["instances"] = [node(i) for i in sorted(ids)[:limit]]
    out["seconds"] = round(time.time() - t0, 1)
    return out


if __name__ == "__main__":
    print(
        json.dumps(
            query(
                sys.argv[1] if len(sys.argv) > 1 else "TerritorialSystem and (povertyRate some LowPoverty)",
                ["direct_superclasses", "subclasses", "instances"],
                use_reasoner="--reasoner" in sys.argv,
            ),
            indent=1,
        )[:3000]
    )
