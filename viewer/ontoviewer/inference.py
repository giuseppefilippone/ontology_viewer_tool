"""Inferred view: what a classical reasoner (HermiT / Pellet through owlready2) adds to the asserted
ontology, shown next to the asserted axioms like the "inferred" mode of an ontology editor.

Two services, both on temporary KBs written by ``reasoner.build_temp_ontology`` under
config.WORK_DIR and classified by ``INFER_RUNNER`` in a subprocess with a timeout
(``reasoner.run_script``):

* TBox/RBox closure — ``start(engine)`` classifies the schema of every module (the modules holding
  individuals contribute their named class/property axioms from the index, no individual) in a
  background thread; ``status()`` reports progress.  The result — inferred direct superclasses,
  equivalent classes, unsatisfiable classes, sub/equivalent properties, minus what is already
  asserted — is saved as data/inferred_<workspace key>.json and served by ``load_tbox()``, which
  re-filters it against the current index (asserting an inferred axiom removes it from the diff
  at once) and resolves the entities mentioned.  ``stop()`` deletes the file.
* one individual — ``infer_individual(iri, engine)``: schema + the individual + its 1-hop
  neighbourhood (individuals it links to and, up to ``NEIGHBOURS``, those linking to it) →
  inferred direct types and property values of that individual, cached in memory per
  (iri, engine, index mtime).

The runner compares owlready2's view before and after ``sync_reasoner_*`` (the reasoner rewrites
``is_a`` / ``equivalent_to`` in place with the most specific named parents, and adds the inferred
property values as triples), so only new direct axioms are reported.
"""

import json
import sqlite3
import threading
import time

from rdflib.namespace import OWL, RDFS

from ontoviewer import config, reasoner, store, workspace

ENGINES = ("hermit", "pellet")
NEIGHBOURS = 100  # max individuals referring to the focus individual copied into its temp KB
TIMEOUT = 600  # seconds, both services
STATE = {"thread": None, "engine": None, "started": 0.0, "seconds": None, "error": None}  # background run
IND_CACHE = {}  # (iri, engine, index mtime) -> infer_individual result
LOCK = threading.Lock()
SUBCLASS, SUBPROP = str(RDFS.subClassOf), str(RDFS.subPropertyOf)
EQ_CLASS, EQ_PROP = str(OWL.equivalentClass), str(OWL.equivalentProperty)
NOTHING = str(OWL.Nothing)
# result section -> (hierarchy predicate, equivalence predicate) used to filter out asserted axioms
PREDS = {"classes": (SUBCLASS, EQ_CLASS), "properties": (SUBPROP, EQ_PROP)}

# Subprocess script (cwd = scratch dir): argv = merged .owl, engine ("hermit" | "pellet"), JSON list of
# the focus individuals' IRIs (empty for a TBox-only run).  Output: "@@JSON@@" + {"engine", "seconds",
# "classes": {iri: {"parents", "equivalent", "unsatisfiable"}}, "properties": {iri: {"parents",
# "equivalent"}}, "individuals": {iri: {"types", "obj": [[p, o]], "data": [[p, lexical, dt]]}},
# "n_classes", "n_properties"} — only the entries with something inferred — or {"error", …}.
INFER_RUNNER = (
    r"""
import json, sys, time, traceback
owl, engine, focus = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
out = {}
try:
    from owlready2 import get_ontology, sync_reasoner_hermit, sync_reasoner_pellet, Thing, Nothing, IRIS
    from owlready2 import OwlReadyInconsistentOntologyError
    import owlready2, subprocess, shutil
"""
    + reasoner.JAVA_SETUP
    + r"""
    t0 = time.time()
    onto = get_ontology("file://" + owl).load()
    THING, NOTHING, OWL_NS = str(Thing.iri), str(Nothing.iri), "http://www.w3.org/2002/07/owl#"
    XSD = "http://www.w3.org/2001/XMLSchema#"
    def named(xs):
        # IRIs of the named entities of a list: restrictions, owl:Thing and the owl:*Property
        # meta-classes are dropped, owl:Nothing is kept (it flags unsatisfiable classes)
        return {str(x.iri) for x in xs if hasattr(x, "iri")
                and str(x.iri) != THING and (str(x.iri) == NOTHING or not str(x.iri).startswith(OWL_NS))}
    def equivalents(e):
        # equivalence closure (symmetric, transitive) when owlready2 offers it, else the direct list
        eq = e.equivalent_to
        return named(eq.indirect() if hasattr(eq, "indirect") else eq) - {str(e.iri)}
    def hier(ents):
        # {iri: (direct named parents, equivalents)}
        return {str(e.iri): (named(e.is_a), equivalents(e)) for e in ents}
    def lit(v):
        # (lexical form, datatype IRI) of a data value as owlready2 loaded it
        if isinstance(v, bool): return (str(v).lower(), XSD + "boolean")
        if isinstance(v, int): return (str(v), XSD + "integer")
        if isinstance(v, float): return (repr(v), XSD + "decimal")
        return (str(v), None)
    def values(ind):
        # property values of an individual (asserted + inferred so far): {(p, o)}, {(p, lexical, dt)}
        obj, data = set(), set()
        for p in ind.get_properties():
            vs = getattr(ind, p.python_name)
            for v in (vs if isinstance(vs, list) else [vs]):
                if v is None: continue
                if hasattr(v, "iri"): obj.add((str(p.iri), str(v.iri)))
                else: data.add((str(p.iri),) + lit(v))
        return obj, data
    props = lambda: list(onto.object_properties()) + list(onto.data_properties())
    c_before, p_before = hier(onto.classes()), hier(props())
    inds = [(i, IRIS[i]) for i in focus]
    inds = [(i, e) for i, e in inds if e is not None]
    i_before = {i: (named(e.is_a), values(e)) for i, e in inds}
    with onto:
        if engine == "pellet":
            sync_reasoner_pellet(infer_property_values=bool(inds), infer_data_property_values=bool(inds), debug=0)
        else:
            sync_reasoner_hermit(infer_property_values=bool(inds), debug=0)
    c_after, p_after = hier(onto.classes()), hier(props())
    try:
        incons = {str(c.iri) for c in owlready2.default_world.inconsistent_classes()}
    except Exception:
        incons = set()
    def diff(before, after):
        # per entity: new direct parents / new equivalents; an unsatisfiable class (≡ owl:Nothing)
        # gets the flag only — every other unsatisfiable class is equivalent to it, nothing to list
        res = {}
        for iri, (par, eq) in after.items():
            par0, eq0 = before.get(iri, (set(), set()))
            bad = iri in incons or NOTHING in eq
            entry = {}
            if bad:
                entry["unsatisfiable"] = True
            else:
                if par - par0 - {NOTHING}: entry["parents"] = sorted(par - par0 - {NOTHING})
                if eq - eq0 - {NOTHING}: entry["equivalent"] = sorted(eq - eq0 - {NOTHING})
            if entry: res[iri] = entry
        return res
    individuals = {}
    for i, e in inds:
        t0s, (o0, d0) = i_before[i]
        o1, d1 = values(e)
        individuals[i] = {"types": sorted(named(e.is_a) - t0s - {NOTHING}),
                          "obj": sorted(o1 - o0), "data": sorted(d1 - d0, key=str)}
    out = {"engine": engine, "seconds": round(time.time() - t0, 1),
           "classes": diff(c_before, c_after), "properties": diff(p_before, p_after),
           "individuals": individuals, "n_classes": len(c_after), "n_properties": len(p_after)}
except OwlReadyInconsistentOntologyError as e:
    out = {"error": "the ontology is inconsistent: " + str(e)[:800], "inconsistent": True}
except Exception as e:
    out = {"error": str(e), "traceback": traceback.format_exc()[-3000:]}
print("@@JSON@@" + json.dumps(out))
"""
)


# ------------------------------------------------------------ helpers


def result_path():
    """The saved TBox diff of the current workspace: data/inferred_<workspace key>.json."""
    return config.DATA_DIR / f"inferred_{workspace.key()}.json"


def index_mtime():
    """Modification time of the current index (0 when missing): the cache / staleness key."""
    return store.DB.stat().st_mtime if store.DB.exists() else 0


def _conn():
    """A private read connection to the index (the background thread cannot share ``store.db()``)."""
    c = sqlite3.connect(workspace.db_path())
    c.row_factory = sqlite3.Row
    return c


def asserted_pairs(c=None):
    """{predicate IRI: {(subject IRI, object IRI)}} of the named hierarchy / equivalence axioms of the
    index (both directions for the symmetric equivalences): what the inferred diff must not repeat."""
    c = c or _conn()
    out = {}
    for p in (SUBCLASS, EQ_CLASS, SUBPROP, EQ_PROP):
        pairs = set()
        for r in c.execute(
            """SELECT ns.iri AS s, no.iri AS o FROM stmt st JOIN nodes ns ON ns.id=st.s JOIN nodes no ON no.id=st.o_id
               WHERE st.p=(SELECT id FROM nodes WHERE iri=?)""",
            (p,),
        ).fetchall():
            pairs.add((r["s"], r["o"]))
            if p in (EQ_CLASS, EQ_PROP):
                pairs.add((r["o"], r["s"]))
        out[p] = pairs
    return out


def filter_asserted(data, asserted):
    """Drop from a runner / saved result the parents and equivalents already asserted in the index
    (``asserted_pairs``); entries left empty disappear.  Modifies ``data`` in place and returns it."""
    for section, (sub, eq) in PREDS.items():
        kept = {}
        for iri, e in data.get(section, {}).items():
            entry = {}
            parents = [p for p in e.get("parents", []) if (iri, p) not in asserted[sub]]
            equiv = [q for q in e.get("equivalent", []) if (iri, q) not in asserted[eq]]
            if parents:
                entry["parents"] = parents
            if equiv:
                entry["equivalent"] = equiv
            if e.get("unsatisfiable"):
                entry["unsatisfiable"] = True
            if entry:
                kept[iri] = entry
        data[section] = kept
    return data


def counts(data):
    """Summary numbers of a TBox diff: subclass axioms, equivalences (unordered pairs), unsatisfiable
    classes, property axioms (sub-property + equivalent-property pairs)."""
    cls, props = data.get("classes", {}), data.get("properties", {})
    pairs = lambda sect: {tuple(sorted((a, b))) for a, e in sect.items() for b in e.get("equivalent", [])}
    return {
        "subclass": sum(len(e.get("parents", [])) for e in cls.values()),
        "equivalent": len(pairs(cls)),
        "unsatisfiable": sum(1 for e in cls.values() if e.get("unsatisfiable")),
        "properties": sum(len(e.get("parents", [])) for e in props.values()) + len(pairs(props)),
    }


def axiom_list(data):
    """The inferred TBox diff as a flat list of assertable triples {"s", "p", "o"} (unsatisfiability
    is not an axiom to assert; each equivalence once, on its alphabetically first side)."""
    out = []
    for section, (sub, eq) in PREDS.items():
        seen = set()
        for iri, e in sorted(data.get(section, {}).items()):
            out += [{"s": iri, "p": sub, "o": p} for p in e.get("parents", [])]
            for q in e.get("equivalent", []):
                pair = tuple(sorted((iri, q)))
                if pair not in seen:
                    seen.add(pair)
                    out.append({"s": pair[0], "p": eq, "o": pair[1]})
    return out


def node_of(iri):
    """``store.node_json`` of an IRI, or a synthetic class node for IRIs absent from the index (owl:Nothing)."""
    r = store.db().execute("SELECT * FROM nodes WHERE iri=?", (iri,)).fetchone()
    if r:
        return store.node_json(r)
    name = config.builtin_name(iri) if iri.startswith(config.OWL_NS) else store.short(iri)
    return {"id": None, "iri": iri, "label": None, "kind": "class", "name": name, "fuzzy": False, "builtin": True}


def _run(individuals, engine, timeout=TIMEOUT):
    """Build the temp KB (TBox of the whole workspace, plus the focus individuals with their
    neighbourhood) and run ``INFER_RUNNER``.  Returns the runner's dict plus "stats", "seconds",
    "log" and "workdir" (``reasoner.run_script``)."""
    t0 = time.time()
    work = reasoner.new_workdir("inf_")
    owl = work / "kb.owl"
    stats = reasoner.build_temp_ontology(
        individuals, owl, tbox_all=True, incoming=NEIGHBOURS if individuals else 0, rename=False
    )
    out = {"stats": stats, "workdir": str(work)}
    out.update(reasoner.run_script(work, INFER_RUNNER, [owl, engine, json.dumps(list(individuals))], timeout))
    # "seconds" is the runner's own reasoning time; "wall" includes the KB build and the Java start-up
    out["wall"] = round(time.time() - t0, 1)
    return out


# ------------------------------------------------------------ TBox classification (background)


def running():
    """True while the background classification thread is alive."""
    t = STATE["thread"]
    return t is not None and t.is_alive()


def start(engine="hermit", timeout=TIMEOUT):
    """Start the classification of the TBox/RBox closure with ``engine`` in a background thread.

    Returns {"started": True} or {"started": False, "reason"} (already running / unknown engine).
    """
    if engine not in ENGINES:
        return {"started": False, "reason": f"unknown engine {engine!r} (hermit | pellet)"}
    with LOCK:
        if running():
            return {"started": False, "reason": "already running"}
        STATE.update(engine=engine, started=time.time(), seconds=None, error=None)
        t = threading.Thread(target=_classify, args=(engine, timeout), daemon=True)
        STATE["thread"] = t
        t.start()
    return {"started": True}


def _classify(engine, timeout):
    """Thread body: run the reasoner on the TBox, filter the asserted axioms out, save the JSON file
    (or record the error in ``STATE``)."""
    try:
        res = _run([], engine, timeout)
        if "error" in res:
            STATE["error"] = res["error"] + ("\n" + res["traceback"] if res.get("traceback") else "")
            return
        data = {
            "engine": engine,
            "when": time.strftime("%Y-%m-%d %H:%M:%S"),
            "index_mtime": index_mtime(),
            "seconds": res["wall"],
            "reasoner_seconds": res.get("seconds"),
            "kb": {"schema_files": res["stats"]["schema_files"], "triples": res["stats"]["triples"]},
            "n_classes": res.get("n_classes", 0),
            "n_properties": res.get("n_properties", 0),
            "classes": res.get("classes", {}),
            "properties": res.get("properties", {}),
        }
        filter_asserted(data, asserted_pairs(_conn()))
        data["counts"] = counts(data)
        result_path().write_text(json.dumps(data, indent=1))
    except Exception as e:  # surfaced by /api/inference/status
        STATE["error"] = str(e)
    finally:
        STATE["seconds"] = round(time.time() - STATE["started"], 1)


def status():
    """State of the background classification: {"running", "engine", "seconds" (elapsed while
    running, else the duration of the last run), "error" (last run), "active" (a saved result
    exists)}."""
    run = running()
    return {
        "running": run,
        "engine": STATE["engine"],
        "seconds": round(time.time() - STATE["started"], 1) if run else STATE["seconds"],
        "error": None if run else STATE["error"],
        "active": result_path().exists(),
    }


def load_tbox():
    """The saved TBox diff of the current workspace, re-filtered against the index and completed
    with "nodes" ({iri: node_json} of every entity mentioned), "counts", "axioms" (``axiom_list``)
    and "stale" (the index changed since the run); {"active": False} when there is none."""
    p = result_path()
    if not p.exists():
        return {"active": False}
    data = json.loads(p.read_text())
    filter_asserted(data, asserted_pairs(store.db()))
    data["counts"] = counts(data)
    data["axioms"] = axiom_list(data)
    iris = set()
    for section in PREDS:
        for iri, e in data[section].items():
            iris.add(iri)
            iris.update(e.get("parents", []))
            iris.update(e.get("equivalent", []))
    data["nodes"] = {iri: node_of(iri) for iri in sorted(iris)}
    data["active"] = True
    data["stale"] = data.get("index_mtime") != index_mtime()
    return data


def stop():
    """Discard the inferred view: the saved TBox diff and the per-individual cache.
    Returns {"stopped": True, "running": bool} (a run in progress finishes and saves again)."""
    result_path().unlink(missing_ok=True)
    IND_CACHE.clear()
    STATE["error"] = None
    return {"stopped": True, "running": running()}


# ------------------------------------------------------------ one individual


def infer_individual(iri, engine="hermit", timeout=TIMEOUT):
    """Inferred direct types and property values of one individual (schema + the individual + its
    1-hop neighbourhood), not already asserted.

    Returns {"iri", "engine", "seconds", "kb": {"individuals", "triples"}, "types": [node_json…],
    "obj": [{"p": node_json, "o": node_json}…], "data": [{"p": node_json, "lit", "dt"}…]} — or
    {"error", "traceback"?, "log"?}.  Successful results are cached per (iri, engine, index mtime).
    """
    if engine not in ENGINES:
        return {"error": f"unknown engine {engine!r} (hermit | pellet)"}
    if store.get_id(iri) is None:
        return {"error": "individual not found in the index"}
    key = (iri, engine, index_mtime())
    if key in IND_CACHE:
        return IND_CACHE[key]
    res = _run([iri], engine, timeout)
    if "error" in res:
        return {k: res[k] for k in ("error", "traceback", "log", "inconsistent") if k in res}
    raw = res.get("individuals", {}).get(iri, {"types": [], "obj": [], "data": []})
    out = {
        "iri": iri,
        "engine": engine,
        "seconds": res["wall"],
        "kb": {"individuals": res["stats"]["individuals"], "triples": res["stats"]["triples"]},
        "types": [node_of(t) for t in raw["types"]],
        "obj": [{"p": node_of(p), "o": node_of(o)} for p, o in raw["obj"]],
        "data": [{"p": node_of(p), "lit": v, "dt": dt} for p, v, dt in raw["data"]],
    }
    IND_CACHE[key] = out
    return out
