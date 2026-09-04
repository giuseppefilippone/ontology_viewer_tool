"""Reasoning services for the viewer.

fuzzy   : fuzzy_dl_owl2 — OWL 2 (with fuzzyLabel annotations) → FuzzyDL (.fdl) → queries
classic : owlready2 (HermiT / Pellet, Java) — consistency + inferred hierarchy / types

Both run in a subprocess with a timeout, on a temporary merged ontology built from
the workspace: the "schema" modules (no individuals) plus, optionally, a selection
of individuals extracted from the index (the full 400k-individual ABox is out of
reach for any of these reasoners).

Entry points: `run_fuzzy(individuals, queries, …)`, `run_classic(individuals, engine, …)`;
`build_temp_ontology` and `fdl_safe` are also used by fdl_export; `new_workdir` + `run_script`
(scratch dir, runner execution and result parsing) and `JAVA_SETUP` (JDK selection for Pellet)
are shared with dlquery, the rules runner and the inferred view (``ontoviewer.inference``).

Data flow: reads workspace.json, the .owl modules of the workspace and the index db
(nodes, stmt, axiom_ann); writes a scratch dir per run under config.WORK_DIR
(kb.owl, run.py, CONFIG.ini, the converter's results/kb.fdl, kb_query.fdl) — the dir is
kept for inspection ("workdir" in the fuzzy result). The runner scripts (FUZZY_RUNNER,
CLASSIC_RUNNER) are Python sources executed with the same interpreter; they report their
result as one JSON line prefixed by "@@JSON@@" on stdout, everything else is log.

Caveats: FuzzyDL identifiers are restricted, so local names are sanitised with
`fdl_safe` and mapped back in the results; Pellet needs Java >= 25 (see CLASSIC_RUNNER).
"""

import json
import pathlib
import sqlite3
import subprocess
import sys
import tempfile
import time

import rdflib
from rdflib.namespace import OWL, RDF, RDFS, XSD

from ontoviewer import config
from ontoviewer import workspace


import re as _re2

WORK = config.WORK_DIR
# named schema axioms copied from the index for the modules that are not parsed in full (tbox_all)
SCHEMA_PREDS = {
    str(p)
    for p in (
        RDF.type,
        RDFS.subClassOf,
        RDFS.subPropertyOf,
        RDFS.domain,
        RDFS.range,
        OWL.equivalentClass,
        OWL.equivalentProperty,
        OWL.inverseOf,
        OWL.disjointWith,
        OWL.propertyDisjointWith,
    )
}
SCHEMA_KINDS = ("class", "objprop", "dataprop", "annprop", "datatype")  # nodes.kind of the schema entities
FDL_QUERIES = {  # query type -> (fdl template, arg names)
    "sat": ("(sat?)", []),
    "max-instance": ("(max-instance? {a} {C})", ["a", "C"]),
    "min-instance": ("(min-instance? {a} {C})", ["a", "C"]),
    "all-instances": ("(all-instances? {C})", ["C"]),
    "max-subs": ("(max-subs? {C} {D})", ["C", "D"]),
    "min-subs": ("(min-subs? {C} {D})", ["C", "D"]),
    "max-sat": ("(max-sat? {C})", ["C"]),
    "min-sat": ("(min-sat? {C})", ["C"]),
    "max-related": ("(max-related? {a} {b} {R})", ["a", "b", "R"]),
    "min-related": ("(min-related? {a} {b} {R})", ["a", "b", "R"]),
    "defuzzify-lom": ("(defuzzify-lom? {C} {a} {f})", ["C", "a", "f"]),
    "defuzzify-mom": ("(defuzzify-mom? {C} {a} {f})", ["C", "a", "f"]),
    "defuzzify-som": ("(defuzzify-som? {C} {a} {f})", ["C", "a", "f"]),
}


# ------------------------------------------------------------ fuzzy (fuzzy_dl_owl2)

# Subprocess script (cwd = scratch dir): argv = merged .owl, JSON list of FuzzyDL query
# lines, base IRI, MILP provider. Output: "@@JSON@@" + {"steps", "fdl", "results"} or {"error", "traceback"}.
FUZZY_RUNNER = r"""
import json, sys, time, traceback, os, warnings
warnings.filterwarnings("ignore")
owl, queries, base_iri, provider = sys.argv[1], json.loads(sys.argv[2]), sys.argv[3], sys.argv[4]
# fuzzy_dl_owl2 reads its settings from CONFIG.ini in the cwd (solver, epsilon, annotation label)
open("CONFIG.ini", "w").write(
    ("[DEFAULT]\nmilpProvider = %s\ndebugPrint = False\nepsilon = 0.001\n"
     "maxIndividuals = -1\nowlAnnotationLabel = fuzzyLabel\n") % provider)
out = {"steps": []}
try:
    # step 1: OWL 2 -> FuzzyDL; the converter writes results/kb.fdl relative to the cwd
    t0 = time.time()
    from fuzzy_dl_owl2.fuzzyowl2.fuzzyowl2_to_fuzzydl import FuzzyOwl2ToFuzzyDL
    conv = FuzzyOwl2ToFuzzyDL(owl, "kb.fdl", base_iri=base_iri)
    conv.translate_owl2ontology()
    fdl_path = os.path.join("results", "kb.fdl")
    fdl = open(fdl_path).read()
    out["steps"].append({"step": "owl2fdl", "seconds": round(time.time() - t0, 2), "lines": fdl.count("\n")})
    # step 2: append the query lines to the KB (kept in the result for display) and solve it
    fdl_q = fdl.rstrip("\n") + "\n" + "\n".join(queries) + "\n"
    open("kb_query.fdl", "w").write(fdl_q)
    out["fdl"] = fdl_q
    t0 = time.time()
    from fuzzy_dl_owl2.fuzzydl.parser import DLParserFast as DLParser
    kb, qs = DLParser.get_kb("kb_query.fdl")
    kb.solve_kb()
    out["steps"].append({"step": "parse+solve_kb", "seconds": round(time.time() - t0, 2)})
    # step 3: one MILP per query; a failing query does not abort the others
    results = []
    for q in qs:
        t0 = time.time()
        try:
            sol = q.solve(kb)
            results.append({"query": str(q), "result": str(sol),
                            "value": sol.get_solution() if sol.is_consistent_kb() else None,
                            "consistent": sol.is_consistent_kb(),
                            "seconds": round(time.time() - t0, 2)})
        except Exception as e:
            results.append({"query": str(q), "error": str(e)})
    out["results"] = results
except Exception as e:
    out["error"] = str(e)
    out["traceback"] = traceback.format_exc()[-3000:]
print("@@JSON@@" + json.dumps(out))
"""


# ------------------------------------------------------------ classic (owlready2)

# Fragment shared by the owlready2 runners (spliced inside their `try:` block, 4-space indent; expects
# `engine`, `owlready2` and `subprocess` in scope). Pellet's bundled Jena jars need Java >= 25: pick
# the newest JDK available (macOS java_home) or fail with an explicit message.
JAVA_SETUP = r"""
    if engine == "pellet":
        import re, glob
        def major(java):
            # major version of a java executable from `java -version` (0 if it cannot be run)
            try:
                v = subprocess.run([java, "-version"], capture_output=True, text=True).stderr
                m = re.search(r'version "(\d+)', v); return int(m.group(1)) if m else 0
            except Exception:
                return 0
        # candidates: owlready2's configured java, java_home's JDK 25+, Homebrew and system JDKs
        candidates = [owlready2.JAVA_EXE or "java"]
        jh = subprocess.run(["/usr/libexec/java_home", "-v", "25+"], capture_output=True, text=True)
        if jh.stdout.strip(): candidates.append(jh.stdout.strip() + "/bin/java")
        candidates += (glob.glob("/opt/homebrew/opt/openjdk*/bin/java")
                       + glob.glob("/Library/Java/JavaVirtualMachines/*/Contents/Home/bin/java"))
        ok = [j for j in candidates if major(j) >= 25]
        if not ok:
            found = sorted({major(j) for j in candidates if major(j)})
            raise RuntimeError(f"Pellet (owlready2) requires Java >= 25: its bundled Jena jars are compiled "
                               f"for class version 69. JDKs found on this Mac: {found}. Install a JDK 25 "
                               f"(e.g. an up-to-date `brew install openjdk`, or Temurin 25 from adoptium.net) "
                               f"or use HermiT, which works with Java 23.")
        owlready2.JAVA_EXE = ok[0]
"""

# Subprocess script (cwd = scratch dir): argv = merged .owl, engine ("hermit" | "pellet").
# Output: "@@JSON@@" + {"engine", "seconds", "classes", "individuals", "inferred_subclass",
# "inferred_types", "unsatisfiable"} or {"error", "traceback"}.
CLASSIC_RUNNER = (
    r"""
import json, sys, time, traceback
owl, engine = sys.argv[1], sys.argv[2]
out = {}
try:
    from owlready2 import get_ontology, sync_reasoner_hermit, sync_reasoner_pellet, Thing, Nothing
    import owlready2, subprocess, shutil
"""
    + JAVA_SETUP
    + r"""
    t0 = time.time()
    onto = get_ontology("file://" + owl).load()
    # asserted (class, superclass) and (individual, type) pairs before reasoning; only named
    # parents (with an .iri) are compared, anonymous restrictions are ignored
    before = {(str(c.iri), str(p.iri)) for c in onto.classes() for p in c.is_a if hasattr(p, "iri")}
    types_before = {(str(i.iri), str(t.iri)) for i in onto.individuals() for t in i.is_a if hasattr(t, "iri")}
    with onto:
        if engine == "pellet":
            sync_reasoner_pellet(infer_property_values=True, debug=0)
        else:
            sync_reasoner_hermit(infer_property_values=True, debug=0)
    # the reasoner adds inferred parents/types in place: the difference is what was inferred
    after = {(str(c.iri), str(p.iri)) for c in onto.classes() for p in c.is_a if hasattr(p, "iri")}
    types_after = {(str(i.iri), str(t.iri)) for i in onto.individuals() for t in i.is_a if hasattr(t, "iri")}
    # unsatisfiable classes: equivalent to owl:Nothing, plus owlready2's own list when available
    unsat = [str(c.iri) for c in onto.classes() if Nothing in c.equivalent_to]
    try:
        incons = [str(c.iri) for c in list(owlready2.default_world.inconsistent_classes())]
    except Exception:
        incons = []
    out = {"engine": engine, "seconds": round(time.time() - t0, 1),
           "classes": len(list(onto.classes())), "individuals": len(list(onto.individuals())),
           "inferred_subclass": sorted(after - before),
           "inferred_types": sorted(types_after - types_before),
           "unsatisfiable": sorted(set(unsat) | set(incons))}
except Exception as e:
    out = {"error": str(e), "traceback": traceback.format_exc()[-3000:]}
print("@@JSON@@" + json.dumps(out))
"""
)


def short(iri):
    """Local name of an IRI (the part after the last '#' or, failing that, the last '/')."""
    return iri.rsplit("#", 1)[-1].rsplit("/", 1)[-1]


# ------------------------------------------------------------ temp ontology


def _module_role(c, graph):
    """'schema' (declares classes/properties/datatypes, no individuals),
    'abox' (declares individuals) or 'annotations' (no declarations at all)."""
    # distinct rdf:type objects used in the module
    kinds = {
        k
        for (k,) in c.execute(
            """SELECT DISTINCT n.iri FROM stmt s JOIN nodes n ON n.id=s.o_id JOIN nodes p ON p.id=s.p
           WHERE s.graph=? AND p.iri=?""",
            (graph, str(RDF.type)),
        ).fetchall()
    }
    if str(OWL.NamedIndividual) in kinds:
        return "abox"
    if kinds & {str(OWL.Class), str(OWL.ObjectProperty), str(OWL.DatatypeProperty), str(RDFS.Datatype)}:
        return "schema"
    return "annotations"


def _index_schema_triples(c, g, skip_files):
    """Copy into ``g`` the named schema axioms that the modules NOT parsed in full (``skip_files``
    excluded) assert about classes, properties and datatypes: declarations, hierarchy, equivalence,
    domain/range, inverse and disjointness (``SCHEMA_PREDS``) with an IRI object, read from the
    index — an ABox module of hundreds of MB cannot be parsed, but the few properties it declares
    must reach the reasoner.  Anonymous expressions of such modules are not indexed and are lost.
    Returns the number of triples added."""
    marks = ",".join("?" * len(SCHEMA_KINDS))
    n = 0
    # driven by the (few hundred) schema nodes: stmt is indexed by subject, not by module
    for r in c.execute(
        f"""SELECT st.graph AS g, ns.iri AS s, np.iri AS p, no.iri AS o FROM nodes ns
            JOIN stmt st ON st.s=ns.id JOIN nodes np ON np.id=st.p JOIN nodes no ON no.id=st.o_id
            WHERE ns.kind IN ({marks})""",
        SCHEMA_KINDS,
    ).fetchall():
        if r["g"] not in skip_files and r["p"] in SCHEMA_PREDS:
            g.add((rdflib.URIRef(r["s"]), rdflib.URIRef(r["p"]), rdflib.URIRef(r["o"])))
            n += 1
    return n


def _drop_individuals(c, g):
    """Remove from ``g`` every statement about an individual (subject typed owl:NamedIndividual in
    the graph, or of kind 'individual' in the index) — used when a module that is not an ABox
    module still annotates individuals; the reasoner must see the schema only."""
    inds = set()
    for s in set(g.subjects()):
        if not isinstance(s, rdflib.URIRef):
            continue
        if (s, RDF.type, OWL.NamedIndividual) in g:
            inds.add(s)
        else:
            r = c.execute("SELECT kind FROM nodes WHERE iri=?", (str(s),)).fetchone()
            if r and r["kind"] == "individual":
                inds.add(s)
    for s in inds:
        g.remove((s, None, None))
        g.remove((None, None, s))
    return len(inds)


def build_temp_ontology(
    individuals, out_path, include_annotations=False, files=None, tbox_all=False, incoming=0, rename=True
):
    """Merge schema modules (+ selected individuals from the index) into one OWL file.
    files: explicit module list to merge (default: the workspace's schema modules).
    Returns stats.

    `individuals` is a list of IRIs; their statements (and, one hop away, the individuals
    they refer to, with their own statements) are copied from the index together with the
    owl:Axiom degree annotations; with `incoming` > 0 also up to that many individuals
    referring to each selected one (their statements too) join the neighbourhood.
    rdfs:comment is skipped unless `include_annotations`.
    `tbox_all`: the TBox/RBox of the whole workspace — the modules without individuals are
    parsed in full, the named schema axioms of the ABox modules come from the index
    (``_index_schema_triples``) and no individual is kept (``_drop_individuals``).
    Sanitisation applied to the merged graph only (the workspace files are never touched):
    owl:imports removed, rdf:PlainLiteral ranges → xsd:string, "Class(IRI)" inside
    fuzzyLabel values → local names, unsafe local names renamed with `fdl_safe` (skipped
    with `rename=False`: only FuzzyDL needs it, owlready2 works on the original IRIs).
    Writes `out_path` (pretty-xml) and returns {"schema_files", "individuals" (nodes
    copied, neighbours included), "triples", "renamed": {safe name: original name}}.
    """
    c = sqlite3.connect(workspace.db_path())
    c.row_factory = sqlite3.Row
    ws = workspace.load()
    g = rdflib.Graph()
    schema_files = []
    for f in files if files is not None else ws["files"]:
        # tbox_all: everything but the ABox modules is parsed (annotation-only modules included)
        if files is None and _module_role(c, f) != "schema" and not (tbox_all and _module_role(c, f) != "abox"):
            continue
        p = pathlib.Path(ws["dir"]) / f
        if p.exists():
            g.parse(p, format="xml")
            schema_files.append(f)
    if tbox_all:
        _index_schema_triples(c, g, set(schema_files))
        _drop_individuals(c, g)
    # a single ontology header for the merged file
    for o in list(g.subjects(RDF.type, OWL.Ontology)):
        g.remove((o, OWL.imports, None))
    # reasoner-only sanitisation (the workspace files are never touched):
    # pyowl2 (used by fuzzy_dl_owl2) cannot map rdf:PlainLiteral ranges → xsd:string
    for s, p, o in list(g.triples((None, RDFS.range, RDF.PlainLiteral))):
        g.remove((s, p, o))
        g.add((s, p, XSD.string))
    # OWA/choquet <Name> elements must hold local names, not "Class(IRI)" functional syntax
    import re as _re

    FL = rdflib.URIRef("http://www.semanticweb.org/ontologies/fuzzydl_ontology#fuzzyLabel")
    for s, p, o in list(g.triples((None, FL, None))):
        if "Class(" in str(o):
            # "Class(<IRI>)" -> local name of the IRI, anywhere in the label
            fixed = _re.sub(r"Class\(([^)]*)\)", lambda m: short(m.group(1)), str(o))
            g.remove((s, p, o))
            g.add((s, p, rdflib.Literal(fixed)))
    n_ind = 0
    if individuals:
        ids = {}  # node id -> IRI of the selected individuals found in the index
        for iri in individuals:
            r = c.execute("SELECT id FROM nodes WHERE iri=?", (iri,)).fetchone()
            if r:
                ids[r["id"]] = iri
        # closure over referenced individuals (1 hop: the objects of the selected ones)
        queue, seen = list(ids.items()), set()
        # ... and, on request, the individuals referring to the selected ones (1 hop backwards,
        # capped: a country is the object of thousands of yearly snapshots)
        for i in list(ids):
            for row in c.execute(
                "SELECT n.id, n.iri FROM stmt s JOIN nodes n ON n.id=s.s WHERE s.o_id=? AND n.kind='individual' LIMIT ?",
                (i, int(incoming)),
            ).fetchall():
                if row["id"] not in ids:
                    queue.append((row["id"], row["iri"]))
        while queue:
            i, iri = queue.pop()
            if i in seen:
                continue
            seen.add(i)
            # every statement of the individual, with predicate/object IRIs, object kind and literal details
            for row in c.execute(
                """SELECT p.iri AS p, s.p AS pid, n.iri AS o, n.id AS oid, n.kind AS okind,
                              s.o_lit, s.dt, s.lang FROM stmt s
                       JOIN nodes p ON p.id=s.p LEFT JOIN nodes n ON n.id=s.o_id
                       WHERE s.s=?""",
                (i,),
            ).fetchall():
                if row["p"] == str(RDFS.comment) and not include_annotations:
                    continue
                s_ = rdflib.URIRef(iri)
                if row["o_lit"] is not None:
                    g.add(
                        (
                            s_,
                            rdflib.URIRef(row["p"]),
                            rdflib.Literal(
                                row["o_lit"],
                                datatype=rdflib.URIRef(row["dt"]) if row["dt"] else None,
                                lang=row["lang"] or None,
                            ),
                        )
                    )
                else:
                    g.add((s_, rdflib.URIRef(row["p"]), rdflib.URIRef(row["o"])))
                    # only the selected individuals (i in ids) pull in their neighbours: 1 hop
                    if row["okind"] == "individual" and row["oid"] not in seen and i in ids:
                        queue.append((row["oid"], row["o"]))
                    # materialized degrees live on the reified axiom (owl:Axiom + fuzzyLabel Degree):
                    # without them the converter would assert the type with degree 1.0
                    try:
                        anns = c.execute(
                            """SELECT ap.iri AS prop, a.value FROM axiom_ann a JOIN nodes ap ON ap.id=a.prop
                                            WHERE a.s=? AND a.p=? AND a.o_id=?""",
                            (i, row["pid"], row["oid"]),
                        ).fetchall()
                    except sqlite3.OperationalError:
                        anns = []  # old index without the axiom_ann table
                    if anns:
                        bn = rdflib.BNode()
                        g.add((bn, RDF.type, OWL.Axiom))
                        g.add((bn, OWL.annotatedSource, s_))
                        g.add((bn, OWL.annotatedProperty, rdflib.URIRef(row["p"])))
                        g.add((bn, OWL.annotatedTarget, rdflib.URIRef(row["o"])))
                        for a in anns:
                            g.add((bn, rdflib.URIRef(a["prop"]), rdflib.Literal(a["value"])))
            n_ind += 1
    # FDL identifiers: letters/digits/_/- only, not starting with a digit → rename in the
    # temp graph (reversible map, results are mapped back to the original names)
    name_map = {}
    for term in (set(g.subjects()) | set(g.objects())) if rename else ():
        if isinstance(term, rdflib.URIRef) and "#" in str(term):
            ns, frag = str(term).rsplit("#", 1)
            safe = fdl_safe(frag)
            if safe != frag:
                name_map[safe] = frag
                new = rdflib.URIRef(ns + "#" + safe)
                for t in list(g.triples((term, None, None))):
                    g.remove(t)
                    g.add((new, t[1], t[2]))
                for t in list(g.triples((None, None, term))):
                    g.remove(t)
                    g.add((t[0], t[1], new))
    g.serialize(destination=str(out_path), format="pretty-xml")
    return {"schema_files": schema_files, "individuals": n_ind, "triples": len(g), "renamed": name_map}


def fdl_safe(frag):
    """Minimal FuzzyDL identifier: the lexer accepts [a-zA-Z0-9_><][a-zA-Z0-9_'/.:><@$!?-]*
    (dots, '@', leading digits are fine); parentheses are dropped like the converter's
    get_short_name does, other illegal characters become '_', all-digit names get '_'."""
    s = _re2.sub(r"[()]", "", frag)  # drop parentheses
    s = _re2.sub(r"[^A-Za-z0-9_'/.:<>@$!?\-]", "_", s)  # anything outside the lexer's set -> '_'
    if not s or s.isdigit():
        s = "_" + s
    return s


def new_workdir(prefix):
    """A fresh scratch directory ``<prefix><random>`` under config.WORK_DIR (created on demand);
    every reasoner run gets one and keeps it for inspection."""
    WORK.mkdir(exist_ok=True)
    return pathlib.Path(tempfile.mkdtemp(prefix=prefix, dir=WORK))


def run_script(work, source, args, timeout, log_chars=3000):
    """Write ``source`` as run.py in ``work``, execute it with this interpreter (cwd = work,
    extra ``args`` after the script path) and parse the runner's result: the JSON that follows
    the last "@@JSON@@" marker on stdout.  Returns that dict plus "seconds" (wall time) and
    "log" (the last ``log_chars`` of stdout before the marker + stderr); on timeout
    {"error": "timeout after Ns"}, without marker {"error": "no result from the reasoner", "log"}.
    """
    runner = work / "run.py"
    runner.write_text(source)
    t0 = time.time()
    try:
        r = subprocess.run(
            [sys.executable, str(runner), *map(str, args)], cwd=work, capture_output=True, text=True, timeout=timeout
        )
    except subprocess.TimeoutExpired:
        return {"error": f"timeout after {timeout}s"}
    out = {"seconds": round(time.time() - t0, 1)}
    marker = r.stdout.rfind("@@JSON@@")
    if marker >= 0:
        out.update(json.loads(r.stdout[marker + 8 :]))
    else:
        out["error"] = "no result from the reasoner"
    out["log"] = (r.stdout[:marker] if marker >= 0 else r.stdout)[-log_chars:] + r.stderr[-log_chars:]
    return out


def run_fuzzy(individuals, queries, provider="gurobi", base_iri=None, timeout=600):
    """queries: list of {"type": ..., "args": {...}} — names are IRIs or short names.

    Builds the temp KB (individuals named in the query args are added to the selection),
    renders the queries with FDL_QUERIES (sanitised short names; "(sat?)" when none) and
    runs FUZZY_RUNNER with the given MILP `provider`. Returns a dict with "stats",
    "queries", "seconds", "workdir", "log" and the runner's JSON ("results", "fdl",
    "steps" or "error"); on timeout {"error", "stats", "queries"}. Query strings in the
    results are mapped back to the original entity names.
    """
    work = new_workdir("fuzzy_")
    owl = work / "kb.owl"
    # individuals named in the queries are always part of the ABox sent to the reasoner
    individuals = list(
        dict.fromkeys(
            list(individuals)
            + [
                v
                for q in queries
                for k, v in q.get("args", {}).items()
                if k in ("a", "b") and str(v).startswith("http")
            ]
        )
    )
    stats = build_temp_ontology(individuals, owl)
    qlines = []
    for q in queries:
        tpl, names = FDL_QUERIES[q["type"]]
        args = {k: fdl_safe(short(q["args"].get(k, ""))) for k in names}
        qlines.append(tpl.format(**args))
    if not qlines:
        qlines = ["(sat?)"]
    base = base_iri or _guess_base_iri()
    out = {"stats": stats, "queries": qlines, "workdir": str(work)}
    out.update(run_script(work, FUZZY_RUNNER, [owl, json.dumps(qlines), base, provider], timeout, log_chars=4000))
    for res in out.get("results", []):  # show the original entity names
        for safe, orig in stats.get("renamed", {}).items():
            res["query"] = res["query"].replace(safe, orig)
    # everything printed before the marker is log; drop Gurobi's licence/parameter chatter
    out["log"] = "\n".join(
        line
        for line in out.get("log", "").splitlines()
        if "Set parameter" not in line and "Academic license" not in line
    )
    return out


def _guess_base_iri():
    """Base IRI for the converter: the shortest ontology IRI of the index + '#', or a dummy one."""
    c = sqlite3.connect(workspace.db_path())
    r = c.execute("SELECT iri FROM nodes WHERE kind='ontology' ORDER BY LENGTH(iri) LIMIT 1").fetchone()
    return (r[0] + "#") if r else "http://example.org/onto#"


def run_classic(individuals, engine="hermit", timeout=600):
    """Run HermiT or Pellet (`engine`) through owlready2 on the temp KB with the selected individuals.

    Returns {"stats", "seconds", "log"} plus the runner's JSON (inferred subclass/type
    pairs, unsatisfiable classes, counts, or "error"); on timeout {"error", "stats"}.
    """
    work = new_workdir("classic_")
    owl = work / "kb.owl"
    stats = build_temp_ontology(individuals, owl)
    return {"stats": stats, **run_script(work, CLASSIC_RUNNER, [owl, engine], timeout)}
