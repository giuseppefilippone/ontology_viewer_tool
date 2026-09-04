"""POST API: fuzzy/classic reasoning, DL queries, SPARQL, SWRL rules, reasoner work-dir cleanup.

The reasoners never see the workspace files: each run merges the schema modules and the chosen
individuals into a temporary KB under data/reasoner_work/ (``reasoner.build_temp_ontology``) and
executes a runner script in a subprocess with a timeout; the runner prints its JSON result after
a ``@@JSON@@`` marker so that it can be told apart from solver chatter.  SPARQL runs in a
subprocess too.  Rules are the only thing written back (journaled raw blocks, saved by
``/api/save``).

Routes (see ``ontoviewer.api``):
    POST /api/reason/fuzzy    → reason_fuzzy
    POST /api/reason/classic  → reason_classic
    GET  /api/rules           → api_rules
    POST /api/rules/add       → rules_add
    POST /api/rules/run       → rules_run
    POST /api/rules/remove    → rules_remove
    POST /api/dlquery         → api_dlquery
    POST /api/sparql          → api_sparql
    GET  /api/reasoner/work   → reasoner_work_info
    POST /api/reasoner/clear  → reasoner_clear
"""

import json
import shutil
import subprocess
import sys
import time

from rdflib.namespace import RDFS

from ontoviewer import config, dlquery, editor, indexer, reasoner, rules


def reason_fuzzy(c, p):
    """Run fuzzy_dl_owl2 on a temporary KB and answer FuzzyDL queries.

    Payload: "individuals": [iri…] added to the ABox (individuals named in the queries are added
    automatically), "queries": [{"type": sat|max-instance|min-instance|all-instances|max-subs|
    min-subs|max-sat|min-sat|max-related|min-related|defuzzify-lom|defuzzify-mom|defuzzify-som,
    "args": {"a", "b", "C", "D", "R", "f"} as needed}…] (default: a single (sat?)), "provider":
    MILP solver name (default gurobi), "base_iri" (default: the shortest ontology IRI + '#'),
    "timeout" seconds (default 600).  ``c`` is not used.  Side effect: a fuzzy_* directory under
    data/reasoner_work/ holding kb.owl, the converted kb.fdl and run.py.

    Returns {"stats": {"schema_files", "individuals", "triples", "renamed"}, "queries": [fdl
    line…], "seconds", "workdir", "log", "steps": [{"step", "seconds"…}…], "fdl": str,
    "results": [{"query", "result", "value", "consistent", "seconds"} | {"query", "error"}…]},
    or the same with "error" (timeout, converter failure, no output).
    """
    return reasoner.run_fuzzy(
        p.get("individuals") or [],
        p.get("queries") or [],
        p.get("provider") or "gurobi",
        p.get("base_iri"),
        int(p.get("timeout") or 600),
    )


def reason_classic(c, p):
    """Run HermiT or Pellet (via owlready2) on a temporary KB: inferred subclasses/types,
    unsatisfiable classes.

    Payload: "individuals": [iri…], "engine": hermit|pellet (default hermit; Pellet needs a
    Java ≥ 25), "timeout" seconds (default 600).  ``c`` is not used.  Side effect: a classic_*
    directory under data/reasoner_work/.

    Returns {"stats", "seconds", "log", "engine", "classes", "individuals",
    "inferred_subclass": [[class, superclass]…], "inferred_types": [[individual, class]…],
    "unsatisfiable": [iri…]} or {"error", "stats", …}.
    """
    return reasoner.run_classic(p.get("individuals") or [], p.get("engine") or "hermit", int(p.get("timeout") or 600))


def api_rules(q):
    """SWRL rules (swrl:Imp) found in the workspace modules.

    No query parameters.  Returns {"rules": [{"iri", "bnode", "label", "comment", "text",
    "degree", "module"}…]} (``text`` in the 'body -> head' syntax accepted by rules_add); a
    parse failure of a module yields {"rules": [], "error": …} with HTTP 200.
    """
    try:
        return {"rules": rules.list_rules()}
    except Exception as e:
        return {"rules": [], "error": str(e)}


def rules_add(c, p):
    """Add a SWRL (optionally fuzzy) rule to a module as a journaled raw block.

    Payload: "text" rule in 'body -> head' syntax (atoms C(?x), r(?x, ?y), swrlb:… built-ins,
    sameAs/differentFrom), optional "graph" (default: first module), "iri" (default:
    sdf:Rule_<timestamp>), "label", "comment", "degree" in [0, 1] (fuzzyLabel Degree
    annotation; ValueError → HTTP 400 outside the range).  Side effects: the rule's
    rdf:type swrl:Imp (and rdfs:label) triples are indexed, the swrl:Imp RDF/XML is journaled
    for the save, ``rules._CACHE`` is cleared.

    Returns {"ok": True, "iri", "graph", "xml"}.
    """
    rule = rules.parse_rule(p["text"])
    graph = p.get("graph") or indexer.FILES[0]
    n = int(time.time() * 1000) % 100000000  # short, practically unique suffix for the default IRI
    iri = p.get("iri") or f"http://www.semanticweb.org/ontologies/fuzzydl_ontology#Rule_{n}"
    deg = p.get("degree")
    if deg not in (None, ""):
        deg = float(deg)
        if not 0 <= deg <= 1:
            raise ValueError("degree must be in [0,1]")
    else:
        deg = None
    xml = rules.rule_xml(iri, rule, p.get("label") or None, p.get("comment") or None, deg)
    # only the declaration (and label) are representable in the index: the rule body/head are
    # RDF collections of blank nodes, which live in the raw block alone
    triples = [{"s": iri, "p": config.RDF_TYPE, "o": rules.SWRL + "Imp"}]
    if p.get("label"):
        triples.append({"s": iri, "p": str(RDFS.label), "lit": p["label"], "lang": "en"})
    editor.add_raw_block(c, graph, xml, triples, subject=iri)
    rules._CACHE.clear()
    return {"ok": True, "iri": iri, "graph": graph, "xml": xml}


def rules_run(c, p):
    """Run a rule WITHOUT adding it: on the asserted data of the index (whole ABox, conjunctive
    body, swrlb built-ins) or with Pellet on a temporary KB (schema + chosen individuals).

    Payload: "text" rule, "mode": index (default) | anything else = reasoner, "limit" facts
    returned in index mode (default 500); in reasoner mode also "individuals": [iri…],
    "engine" (default pellet — HermiT ignores SWRL rules), "timeout" seconds (default 600).
    ``c`` is not used.

    Returns in index mode the ``rules.evaluate`` dict {"vars", "bindings", "samples", "facts":
    [{"fact", "asserted", …}…], "new", "truncated", "rule"}; in reasoner mode {"stats",
    "seconds", "rule", "mode": "pellet", "engine", "inferred_subclass", "inferred_types",
    "unsatisfiable", …} or {"error", "stats"[, "log"]}.  Side effect (reasoner mode): a rule_*
    directory under data/reasoner_work/.
    """
    text, mode = p["text"], p.get("mode") or "index"
    if mode == "index":
        return rules.evaluate(text, int(p.get("limit") or 500))
    rule = rules.parse_rule(text)
    inds = p.get("individuals") or []
    work = reasoner.new_workdir("rule_")
    owl = work / "kb.owl"
    stats = reasoner.build_temp_ontology(inds, owl)
    # the ad hoc rule is spliced as RDF/XML into the merged KB before </rdf:RDF>; the swrl prefix
    # must be declared on the root element for the block to parse
    xml = rules.rule_xml("http://www.semanticweb.org/ontologies/fuzzydl_ontology#__Rule", rule, "ad hoc rule")
    txt = owl.read_text(encoding="utf-8")
    if "xmlns:swrl=" not in txt[:4000]:
        txt = txt.replace("<rdf:RDF", '<rdf:RDF xmlns:swrl="http://www.w3.org/2003/11/swrl#"', 1)
    owl.write_text(txt.replace("</rdf:RDF>", xml + "</rdf:RDF>"), encoding="utf-8")
    # same runner as reason_classic; the result parsing is shared too (reasoner.run_script)
    out = {"stats": stats, "rule": text, "mode": "pellet"}
    out.update(
        reasoner.run_script(
            work,
            reasoner.CLASSIC_RUNNER,
            [owl, p.get("engine") or "pellet"],
            int(p.get("timeout") or 600),
            log_chars=2000,
        )
    )
    return out


def rules_remove(c, p):
    """Delete a rule block (swrl:Imp with rdf:about = iri) from a module on save.

    Payload: "graph", "iri" (rules that are blank nodes cannot be removed this way).  Side
    effects: the rule's indexed triples are removed now, the block drop is journaled,
    ``rules._CACHE`` is cleared.  Returns {"ok": True}.
    """
    editor.drop_block(c, p["graph"], p["iri"])
    rules._CACHE.clear()
    return {"ok": True}


def api_dlquery(c, p):
    """ontology-editor-like DL Query: a Manchester class expression → hierarchy and/or instances.

    Payload: "expr" Manchester text, "wants": subset of direct_superclasses|superclasses|
    equivalent|direct_subclasses|subclasses|instances (default ["subclasses"]), "reasoner":
    bool — HermiT on a temporary KB for the class part; otherwise the asserted hierarchy of the
    index, available for named classes only — "limit" instances returned (default 500).
    ``c`` is None (``NO_CONNECTION``).  Instances are always evaluated on the index (asserted
    data, subclass closure).

    Returns {"expression": normalised text, "seconds", <want>: [{"iri", "name", "kind",
    "label", "fuzzy"}…]…, "instances_total"?, "unsatisfiable"?, "reasoner_error"?, "note"?}.
    """
    wants = p.get("wants") or ["subclasses"]
    return dlquery.query(p["expr"], wants, bool(p.get("reasoner")), int(p.get("limit") or 500))


def api_sparql(c, p):
    """SPARQL over the index store, in a subprocess with a timeout.

    Payload: "query" SPARQL text (the usual prefixes are prepended when not declared), "limit"
    rows (default 1000), "timeout" seconds (default 120).  ``c`` is None (``NO_CONNECTION``).
    The query runs in ``python -m ontoviewer.sparql_store`` so that a runaway query cannot
    block the server.

    Returns the runner's JSON — {"type": "SELECT"|"CONSTRUCT"|"DESCRIBE", "vars", "rows",
    "truncated"} or {"type": "ASK", "result"} or {"error"} — plus "seconds"; before running:
    {"error": "empty query"}; on failure {"error": "timeout after Ns"} or {"error": "no result",
    "log"}.
    """
    q, limit, timeout = p.get("query", ""), int(p.get("limit") or 1000), int(p.get("timeout") or 120)
    if not q.strip():
        return {"error": "empty query"}
    t0 = time.time()
    try:
        r = subprocess.run(
            [sys.executable, "-m", "ontoviewer.sparql_store", q, str(limit)],
            cwd=config.VIEWER_DIR,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return {"error": f"timeout after {timeout}s"}
    m = r.stdout.rfind("@@JSON@@")
    if m < 0:
        return {"error": "no result", "log": (r.stdout + r.stderr)[-2000:]}
    out = json.loads(r.stdout[m + 8 :])
    out["seconds"] = round(time.time() - t0, 2)
    return out


def reasoner_work_info(q=None):
    """Size of the reasoner scratch directory (temporary KBs of every reasoner run).

    ``q`` (query string) is ignored; also called internally without it.  Returns
    {"bytes": total size, "files": file count, "runs": number of run directories}, all zero
    when data/reasoner_work/ does not exist.
    """
    files = [p for p in config.WORK_DIR.rglob("*") if p.is_file()] if config.WORK_DIR.exists() else []
    return {
        "bytes": sum(p.stat().st_size for p in files),
        "files": len(files),
        "runs": len([d for d in config.WORK_DIR.iterdir() if d.is_dir()]) if config.WORK_DIR.exists() else 0,
    }


def reasoner_clear(c, p):
    """Delete every temporary KB of past reasoner runs (the directory itself is kept).

    Payload: unused.  ``c`` is None (``NO_CONNECTION``).  Side effect: every entry of
    data/reasoner_work/ is removed (errors ignored).  Returns {"cleared": info before,
    "now": info after} in the ``reasoner_work_info`` format.
    """
    before = reasoner_work_info()
    if config.WORK_DIR.exists():
        for d in config.WORK_DIR.iterdir():
            shutil.rmtree(d, ignore_errors=True) if d.is_dir() else d.unlink(missing_ok=True)
    return {"cleared": before, "now": reasoner_work_info()}
