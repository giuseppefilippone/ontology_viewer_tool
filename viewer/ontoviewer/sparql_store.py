"""rdflib Store over the SQLite index, so SPARQL queries run on the whole import closure
(the 933 MB ABox included) without loading it in memory.

Only named terms and literals are stored in the index: anonymous class expressions and
owl:Axiom reifications are not reachable from SPARQL (axiom annotations are in axiom_ann).
Pattern lookups use the index's own indexes: s → i_s, (p, o) → i_po, o → i_oid.

Usage: python3 sparql_store.py "<query>" [limit]   → JSON on stdout (run in a subprocess
with a timeout by the viewer).
"""

import json
import sqlite3
import sys

import rdflib
from rdflib import Literal, URIRef
from rdflib.store import Store

from ontoviewer import workspace

BASE = "http://www.semanticweb.org/ontologies/fuzzydl_ontology"
PREFIXES = {
    "sdf": BASE + "#",
    "cls": BASE + "/class#",
    "op": BASE + "/object-property#",
    "dp": BASE + "/data-property#",
    "dt": BASE + "/datatype#",
    "ind": BASE + "/individuals#",
    "terr": BASE + "/territories#",
    "owl": "http://www.w3.org/2002/07/owl#",
    "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "rdfs": "http://www.w3.org/2000/01/rdf-schema#",
    "xsd": "http://www.w3.org/2001/XMLSchema#",
}


def run(query, limit=1000):
    g = rdflib.Graph(store=IndexStore())
    for k, v in list(PREFIXES.items()):
        g.bind(k, v)
    head = "".join(
        f"PREFIX {k}: <{v}>\n"
        for k, v in list(PREFIXES.items())
        if f"PREFIX {k}:" not in query and f"prefix {k}:" not in query
    )
    res = g.query(head + query)
    if res.type == "ASK":
        return {"type": "ASK", "result": bool(res.askAnswer)}
    if res.type in ("CONSTRUCT", "DESCRIBE"):
        rows = [[str(t) for t in tr] for _, tr in zip(range(limit), res)]
        return {"type": res.type, "vars": ["s", "p", "o"], "rows": rows, "truncated": len(rows) >= limit}
    vars_ = [str(v) for v in res.vars]
    rows = []
    for row in res:
        rows.append([("" if v is None else str(v)) for v in row])
        if len(rows) >= limit:
            break
    return {"type": "SELECT", "vars": vars_, "rows": rows, "truncated": len(rows) >= limit}


class IndexStore(Store):
    context_aware = False
    formula_aware = False
    transaction_aware = False
    graph_aware = False

    def __init__(self, configuration=None, identifier=None):
        super().__init__(configuration, identifier)
        self.c = sqlite3.connect(workspace.db_path())
        self.c.row_factory = sqlite3.Row
        self._iri = {}  # id -> iri cache
        self._id = {}  # iri -> id cache
        self.ns = dict(PREFIXES)

    # term ↔ id -------------------------------------------------------------
    def _to_id(self, term):
        if term is None or not isinstance(term, URIRef):
            return None
        s = str(term)
        if s not in self._id:
            r = self.c.execute("SELECT id FROM nodes WHERE iri=?", (s,)).fetchone()
            self._id[s] = r[0] if r else -1
        return self._id[s]

    def _term(self, i):
        if i not in self._iri:
            r = self.c.execute("SELECT iri FROM nodes WHERE id=?", (i,)).fetchone()
            self._iri[i] = URIRef(r[0]) if r else None
        return self._iri[i]

    # rdflib Store API ---------------------------------------------------------
    def triples(self, pattern, context=None):
        s, p, o = pattern
        where, par = [], []
        for col, t in (("s", s), ("p", p)):
            if t is not None:
                i = self._to_id(t)
                if i == -1 or i is None:
                    return
                where.append(f"{col}=?")
                par.append(i)
        if o is not None:
            if isinstance(o, Literal):
                where.append("o_lit=?")
                par.append(str(o))
                if o.datatype:
                    where.append("dt=?")
                    par.append(str(o.datatype))
                if o.language:
                    where.append("lang=?")
                    par.append(o.language)
            else:
                i = self._to_id(o)
                if i == -1 or i is None:
                    return
                where.append("o_id=?")
                par.append(i)
        sql = "SELECT s, p, o_id, o_lit, dt, lang FROM stmt" + (" WHERE " + " AND ".join(where) if where else "")
        for r in self.c.execute(sql, par):
            ss, pp = self._term(r["s"]), self._term(r["p"])
            if ss is None or pp is None:
                continue
            if r["o_lit"] is not None:
                oo = Literal(r["o_lit"], datatype=URIRef(r["dt"]) if r["dt"] else None, lang=r["lang"] or None)
            else:
                oo = self._term(r["o_id"])
                if oo is None:
                    continue
            yield (ss, pp, oo), iter(())

    def __len__(self, context=None):
        return self.c.execute("SELECT COUNT(*) FROM stmt").fetchone()[0]

    def namespaces(self):
        for k, v in list(self.ns.items()):
            yield k, URIRef(v)

    def bind(self, prefix, namespace, override=True):
        self.ns[prefix] = str(namespace)

    def prefix(self, namespace):
        for k, v in list(self.ns.items()):
            if v == str(namespace):
                return k

    def namespace(self, prefix):
        return URIRef(self.ns[prefix]) if prefix in self.ns else None


if __name__ == "__main__":
    q = sys.argv[1]
    lim = int(sys.argv[2]) if len(sys.argv) > 2 else 1000
    try:
        print("@@JSON@@" + json.dumps(run(q, lim)))
    except Exception as e:
        print("@@JSON@@" + json.dumps({"error": str(e)}))
