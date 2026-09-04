"""GET/POST API: axiom listing (DL / FuzzyDL) and the generated FuzzyDL of a module closure.

TBox/RBox axioms come from the module files (``ontoviewer.axioms.tbox``, cached per file mtime
in memory and in a .axioms.json sidecar of the index), ABox assertions from the index; the
FuzzyDL export lives in data/exports/<module stem>.fdl with a .meta.json sidecar of page offsets.

Routes (see ``ontoviewer.api``):
    GET  /api/axioms        → api_axioms
    GET  /api/fdl           → api_fdl
    POST /api/export_fdl    → fdl_generate
    POST /api/fdl/generate  → fdl_generate (same handler, older path kept for the front-end)
"""

import pathlib
from collections import Counter

from ontoviewer import axioms, config, fdl_export, indexer
from ontoviewer.store import fuzzy_ids


def api_axioms(q):
    """TBox/RBox (from the module file) + paginated ABox (from the index), each axiom
    rendered in DL and FuzzyDL with a fuzzy flag.

    Query parameters:
        graph  module file name, '' = closure (every workspace module) (default '')
        page   0-based ABox page of ``config.AXIOM_PAGE`` assertions (default 0)
        q      substring filter: TBox axioms whose DL or FuzzyDL text contains it, ABox
               assertions whose subject IRI contains it (default '')

    Returns {"graph": file or "closure", "tbox": [axiom…] (whole list, not paginated),
    "tbox_kinds": {kind: n}, "tbox_fuzzy": n, "tbox_by_module": {file: n},
    "abox": {"total", "page", "items": [axiom…]}, "abox_stats": {"ClassAssertion",
    "ObjectPropertyAssertion", "DataPropertyAssertion", "individuals", "axiom", "logical",
    "declaration", "annotation", "with_degree"}, "limit": AXIOM_PAGE}.  An axiom has at least
    {kind, fuzzy, dl, fdl, s}; TBox items also carry "module" and the other ``axioms.tbox``
    fields (fm, man, siri, oiri, odl, anon, refs, ann…).  A module that fails to parse
    contributes one item of kind "error" instead of failing the request.
    """
    graph = q.get("graph", [""])[0]  # '' = closure (all modules)
    page = int(q.get("page", ["0"])[0])
    text = q.get("q", [""])[0]
    limit = config.AXIOM_PAGE
    tb = []
    for f in [graph] if graph else indexer.FILES:  # closure = the workspace modules in import order
        try:
            tb += [dict(a, module=f) for a in axioms.tbox(f)]
        except Exception as e:
            tb.append({"kind": "error", "fuzzy": False, "dl": f"{f}: {e}", "fdl": "", "s": "", "module": f})
    # the TBox filter is textual on the in-memory list; the ABox filter is pushed into the SQL
    if text:
        t = text.lower()
        tb = [a for a in tb if t in a["dl"].lower() or t in a["fdl"].lower()]
    ab = axioms.abox(graph, page, limit, fuzzy_ids(), text)
    return {
        "graph": graph or "closure",
        "tbox": tb,
        "tbox_kinds": dict(Counter(a["kind"] for a in tb)),
        "tbox_fuzzy": sum(a["fuzzy"] for a in tb),
        "tbox_by_module": dict(Counter(a.get("module", graph) for a in tb)),
        "abox": ab,
        "abox_stats": axioms.abox_stats(graph),
        "limit": limit,
    }


def api_fdl(q):
    """One page (or filtered lines) of the generated FuzzyDL of a module's closure + statistics.

    Query parameters:
        file  module file name; the export read is data/exports/<stem>.fdl (default '')
        page  0-based page of ``config.FDL_PAGE`` lines (default 0)
        q     substring: the first FDL_PAGE matching lines are returned instead of a page (default '')

    Returns {"missing": True} when nothing has been generated yet, otherwise the
    ``fdl_export.read_page`` dict {"file", "stats", "limit", "lines", "page", "pages"[, "filtered"]}.
    """
    file = q.get("file", [""])[0]
    path = fdl_export.EXPORTS / (pathlib.Path(file).stem + ".fdl")
    if not file or not path.is_file():
        return {"missing": True}
    return fdl_export.read_page(path, int(q.get("page", ["0"])[0]), q.get("q", [""])[0])


def fdl_generate(c, p):
    """Generate (or regenerate) the FuzzyDL export of a module's import closure.

    Payload: "file": module file name.  ``c`` is None (``NO_CONNECTION``).  Side effects:
    data/exports/<stem>.fdl is written (TBox translated by fuzzy_dl_owl2 in a subprocess, ABox
    from the index) together with its <stem>.meta.json sidecar (page offsets + statistics).
    Can take minutes on large ABoxes; the request blocks meanwhile.

    Returns the ``fdl_export.export_fdl`` dict {"file", "bytes", "lines", "seconds",
    "converter_files", "abox_files", "renamed"} plus "stats" (from the sidecar), or {"error": …}.
    """
    res = fdl_export.export_fdl(p["file"])
    if "error" not in res:
        res["stats"] = fdl_export.build_meta(fdl_export.EXPORTS / res["file"])["stats"]
    return res
