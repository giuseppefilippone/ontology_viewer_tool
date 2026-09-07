"""GET/POST API of the inferred view (classical reasoner results next to the asserted axioms).

Thin wrappers around ``ontoviewer.inference``; none of the routes writes to the index (asserting an
inferred axiom goes through ``/api/edit/add``), so the POST routes are in ``NO_CONNECTION``.

Routes (see ``ontoviewer.api``):
    POST /api/inference/run        → inference_run
    GET  /api/inference/status     → inference_status
    GET  /api/inference/tbox       → inference_tbox
    POST /api/inference/stop       → inference_stop
    POST /api/inference/individual → inference_individual
"""

from ontoviewer import inference


def inference_run(c, p):
    """Classify the TBox/RBox closure in the background (no individuals).

    Payload: "engine": hermit (default) | pellet, "timeout" seconds (default 600).  ``c`` is None.
    Returns {"started": True} or {"started": False, "reason"}; poll ``/api/inference/status``.
    """
    return inference.start(p.get("engine") or "hermit", int(p.get("timeout") or inference.TIMEOUT))


def inference_status(q):
    """Progress of the background classification (no query parameters): {"running", "engine",
    "seconds", "error", "active"}."""
    return inference.status()


def inference_tbox(q):
    """The inferred TBox diff of the current workspace (no query parameters): {"active": False} or
    {"active": True, "engine", "when", "seconds", "stale", "counts": {"subclass", "equivalent",
    "unsatisfiable", "properties"}, "classes": {iri: {"parents", "equivalent", "unsatisfiable"}},
    "properties": {iri: {"parents", "equivalent"}}, "axioms": [{"s", "p", "o"}…], "nodes": {iri:
    node_json}, "kb", "n_classes", "n_properties"} — already minus the asserted axioms."""
    return inference.load_tbox()


def inference_stop(c, p):
    """Drop the inferred view (saved diff + individual cache).  Payload unused, ``c`` is None.
    Returns {"stopped": True, "running"}."""
    return inference.stop()


def inference_individual(c, p):
    """Inferred types and property values of one individual on its 1-hop neighbourhood.

    Payload: "iri", "engine": hermit (default) | pellet, "timeout" seconds (default 600).  ``c`` is
    None.  Returns the ``inference.infer_individual`` dict ({"types", "obj", "data", "seconds", …} or
    {"error", …}); the call blocks for the duration of the reasoner run (seconds).
    """
    return inference.infer_individual(p["iri"], p.get("engine") or "hermit", int(p.get("timeout") or inference.TIMEOUT))


def inference_export(c, p):
    """Export the inferred TBox diff as a standalone ontology (Protégé: File → Export inferred
    axioms as ontology).

    Payload: unused.  ``c`` is None.  Raises ValueError when no inferred result exists.
    Side effect: the RDF/XML file is written to the exports dir (fetch it with
    GET /api/export_file?name=<name>).  Returns {"name", "axioms"}.
    """
    d = inference.load_tbox()
    if not d.get("active"):
        raise ValueError("no inferred result: start the reasoner first")
    import rdflib
    from rdflib import OWL, RDF, RDFS, Literal, URIRef

    from ontoviewer import config

    g = rdflib.Graph()
    ont = URIRef("http://www.semanticweb.org/ontologies/inferred")
    g.add((ont, RDF.type, OWL.Ontology))
    g.add((ont, RDFS.comment, Literal(f"Axioms inferred by {d['engine']} on {d['when']} (asserted axioms excluded).")))
    for a in d["axioms"]:
        g.add((URIRef(a["s"]), URIRef(a["p"]), URIRef(a["o"])))
    name = f"inferred_{d['engine']}.owl"
    (config.EXPORTS_DIR / name).write_text(g.serialize(format="xml"), encoding="utf-8")
    return {"name": name, "axioms": len(d["axioms"])}
