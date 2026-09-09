"""Export the import closure of the active ontology to FuzzyDL syntax.

Hybrid pipeline (the pure converter is O(axioms × |graph|) SPARQL queries in pyowl2 and
takes hours on the ABox modules):
  * schema / annotation modules of the closure → merged, sanitised like the reasoner's
    temp ontology and translated by fuzzy_dl_owl2's FuzzyOwl2ToFuzzyDL (fuzzy datatypes,
    modifiers, weighted concepts, class/property axioms, fuzzy logic);
  * ABox modules → assertions streamed from the index in the converter's own syntax
    ((instance a C d), (related a b R d), (instance a (= f v) 1.0)), degrees taken from
    the owl:Axiom annotations; their few TBox axioms come from axioms.tbox().
Identifiers are renamed with reasoner.fdl_safe exactly as in the converter's input.
The .fdl is written to exports/ (it can be hundreds of MB) and served by /api/export_file.

Entry points: `export_fdl(fname)` (writes exports/<stem>.fdl), `read_page(path, page, q)`
and `get_meta(path)` / `build_meta(path)` (paginated viewing with a <stem>.meta.json sidecar
caching line statistics and page byte offsets).

Data flow: reads workspace.json + the .owl headers (import closure), the index db
(tables stmt, nodes, axiom_ann) and the converter's output; writes a scratch dir under
config.WORK_DIR (deleted afterwards), the .fdl and its .meta.json under config.EXPORTS_DIR.

Caveats: the converter runs in a subprocess (RUNNER) with a timeout; the .fdl is kept
pure ASCII because DLParserFast decodes byte chunks separately.
"""

import json
import pathlib
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time

from rdflib.namespace import RDF, OWL

from ontoviewer import config
from ontoviewer import axioms
from ontoviewer import reasoner
from ontoviewer import workspace

EXPORTS = config.EXPORTS_DIR
RDF_TYPE = str(RDF.type)
NAMED_IND = str(OWL.NamedIndividual)
# Subprocess script (Python source, run with cwd = scratch dir): argv[1] = merged .owl,
# argv[2] = base IRI. Prints "@@OK@@<path of kb.fdl>" or "@@ERR@@<message + traceback>".
RUNNER = r"""
import os, sys, traceback, warnings
warnings.filterwarnings("ignore")
owl, base_iri = sys.argv[1], sys.argv[2]
# fuzzy_dl_owl2 reads its settings from CONFIG.ini in the cwd; the 'mip' provider is only
# needed to import the package (no query is solved here)
open("CONFIG.ini", "w").write(
    "[DEFAULT]\nmilpProvider = mip\ndebugPrint = False\nepsilon = 0.001\n"
    "maxIndividuals = -1\nowlAnnotationLabel = fuzzyLabel\n")
try:
    from fuzzy_dl_owl2.fuzzyowl2.fuzzyowl2_to_fuzzydl import FuzzyOwl2ToFuzzyDL
    # the converter writes its output under ./results/ relative to the cwd
    FuzzyOwl2ToFuzzyDL(owl, "kb.fdl", base_iri=base_iri).translate_owl2ontology()
    print("@@OK@@" + os.path.join(os.getcwd(), "results", "kb.fdl"))
except Exception as e:
    print("@@ERR@@" + str(e) + "\n" + traceback.format_exc()[-2000:])
"""


# numeric literal (optional sign, decimals, exponent): written verbatim, everything else is a string
_NUM = re.compile(r"^-?\d+(\.\d+)?([eE][-+]?\d+)?$")


# DLParserFast reads the file in byte chunks decoded separately: keep the whole .fdl ASCII
def _ascii(s):
    """Replace every non-ASCII character of `s` with '?'."""
    return s.encode("ascii", "replace").decode()


INT_BOUNDS, REAL_BOUNDS = "-100000000 100000000", "-100000000000.0 100000000000.0"  # converter defaults
XSD = "http://www.w3.org/2001/XMLSchema#"
INT_TYPES = {XSD + t for t in ("integer", "int", "long", "short", "byte", "nonNegativeInteger", "positiveInteger")}
REAL_TYPES = {XSD + t for t in ("decimal", "double", "float")}


# ------------------------------------------------------------ paginated view + statistics

PAGE = 500  # lines per page of the .fdl viewer


def closure_files(fname):
    """Files of the import closure of one workspace module (the module first).

    Imports are resolved by ontology IRI against the workspace files only (breadth-first,
    no duplicates); missing files are skipped. Empty list if `fname` does not exist.
    """
    ws = workspace.load()
    dir_ = pathlib.Path(ws["dir"])
    by_iri = {}
    for f in ws["files"]:
        iri = workspace._ontology_iri(dir_ / f) if (dir_ / f).exists() else None
        if iri:
            by_iri[iri] = f
    out, queue = [], [fname]
    while queue:
        f = queue.pop(0)
        if f in out or not (dir_ / f).exists():
            continue
        out.append(f)
        for iri in workspace._imports(dir_ / f):
            if iri in by_iri:
                queue.append(by_iri[iri])
    return out


def _convert(files, timeout):
    """fuzzy_dl_owl2 translation of the merged schema modules → (fdl text, renamed map) or raises.

    Builds the merged/sanitised kb.owl with `reasoner.build_temp_ontology` in a fresh
    scratch dir under reasoner.WORK, runs RUNNER there and reads back the produced .fdl.
    `renamed` maps FuzzyDL-safe names to the original local names. Raises RuntimeError on
    timeout or converter failure; the scratch dir is always removed.
    """
    reasoner.WORK.mkdir(exist_ok=True)
    work = pathlib.Path(tempfile.mkdtemp(prefix="fdl_export_", dir=reasoner.WORK))
    try:
        owl = work / "kb.owl"
        stats = reasoner.build_temp_ontology([], owl, files=files)
        (work / "run.py").write_text(  # the converter must read the configured fuzzy label
            RUNNER.replace("owlAnnotationLabel = fuzzyLabel", "owlAnnotationLabel = " + (config.fuzzy_label() or "__none__"))
        )
        try:
            r = subprocess.run(
                [sys.executable, str(work / "run.py"), str(owl), reasoner._guess_base_iri()],
                cwd=work,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            raise RuntimeError(f"converter timeout after {timeout}s")
        ok = r.stdout.rfind("@@OK@@")
        if ok < 0:
            # prefer the runner's own error report; otherwise the tail of both streams
            err = (
                r.stdout[r.stdout.rfind("@@ERR@@") + 7 :]
                if "@@ERR@@" in r.stdout
                else r.stdout[-2000:] + r.stderr[-2000:]
            )
            raise RuntimeError("fuzzy_dl_owl2 conversion failed: " + err.strip()[-1500:])
        return pathlib.Path(r.stdout[ok + 6 :].strip().splitlines()[0]).read_text(), stats["renamed"]
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _tbox_lines(c, graphs):
    """Role axioms of ABox modules in the converter's syntax: concrete features need
    (range f *integer*|*real* min max) / (range f *string*) before any (= f v).

    Reads the property statements (domain, range, inverseOf, subPropertyOf, rdf:type
    characteristics) of the given modules from the index. Data properties without a
    declared range get a default *real* range. Duplicates are removed, order kept.
    """
    marks = ",".join("?" * len(graphs))

    def safe(iri):
        """FuzzyDL-safe local name of an IRI."""
        return reasoner.fdl_safe(axioms.short(iri))

    # every statement with an object/data property as subject and an IRI object, in the ABox modules
    rows = c.execute(
        f"""SELECT ns.iri AS s, ns.kind AS sk, np.iri AS p, no.iri AS o FROM stmt st
                         JOIN nodes ns ON ns.id=st.s JOIN nodes np ON np.id=st.p LEFT JOIN nodes no ON no.id=st.o_id
                         WHERE st.graph IN ({marks}) AND ns.kind IN ('objprop','dataprop') AND st.o_id IS NOT NULL
                         ORDER BY ns.iri""",
        graphs,
    ).fetchall()
    out, seen_range = [], set()
    for r in rows:
        s, p, o, k = safe(r["s"]), axioms.short(r["p"]), r["o"], r["sk"]
        if p == "domain":
            out.append(f"(domain {s} {safe(o)})")
        elif p == "range":
            if k == "objprop":
                out.append(f"(range {s} {safe(o)})")
            else:
                # concrete feature: map the XSD range to a FuzzyDL feature type
                seen_range.add(s)
                out.append(
                    f"(range {s} *integer* {INT_BOUNDS})"
                    if o in INT_TYPES
                    else (
                        f"(range {s} *real* {REAL_BOUNDS})"
                        if o in REAL_TYPES
                        else f"(range {s} *boolean*)" if o == XSD + "boolean" else f"(range {s} *string*)"
                    )
                )
        elif p == "inverseOf":
            out.append(f"(inverse {s} {safe(o)})")
        elif p == "subPropertyOf":
            out.append(f"(implies-role {s} {safe(o)})")
        elif p == "type":
            t = axioms.short(o)
            if t == "FunctionalProperty":
                out.append(f"(functional {s})")
            elif t == "TransitiveProperty":
                out.append(f"(transitive {s})")
            elif t == "SymmetricProperty":
                out.append(f"(symmetric {s})")
    # data properties declared without a range: numeric by default (the converter does the same on first use)
    for r in rows:
        if r["sk"] == "dataprop" and safe(r["s"]) not in seen_range:
            seen_range.add(safe(r["s"]))
            out.append(f"(range {safe(r['s'])} *real* {REAL_BOUNDS})")
    return list(dict.fromkeys(out))


def _abox_lines(c, graphs):
    """FuzzyDL assertions of the given modules, streamed from the index in file order.

    Generator of lines: (instance a C d) for rdf:type (owl:NamedIndividual skipped),
    (instance a (= f v) 1.0) for data values, (related a b R d) for object values.
    Degrees d come from the owl:Axiom annotations in `axiom_ann` (default 1.0).
    Annotation properties and rdfs:* predicates are ignored.
    """
    marks = ",".join("?" * len(graphs))

    def safe(iri):
        """FuzzyDL-safe local name of an IRI."""
        return reasoner.fdl_safe(axioms.short(iri))

    # (s, p, o) -> degree string, from the fuzzyLabel annotations of reified assertions
    deg = {}
    try:
        for r in c.execute(
            f"""SELECT ns.iri AS s, np.iri AS p, no.iri AS o, a.value FROM axiom_ann a
                               JOIN nodes ns ON ns.id=a.s JOIN nodes np ON np.id=a.p LEFT JOIN nodes no ON no.id=a.o_id
                               WHERE a.graph IN ({marks})""",
            graphs,
        ):
            d = axioms.degree_of(r["value"])
            if d:
                deg[(r["s"], r["p"], r["o"])] = d
    except sqlite3.OperationalError:
        pass  # old index without the axiom_ann table: every degree is 1.0
    # all statements of individuals in the ABox modules, grouped by subject in insertion
    # (= file) order; INDEXED BY / CROSS JOIN pin the plan so SQLite streams instead of sorting
    q = f"""SELECT ns.iri AS s, np.iri AS p, no.iri AS o, st.o_lit FROM stmt st INDEXED BY i_s
            CROSS JOIN nodes ns ON ns.id=st.s CROSS JOIN nodes np ON np.id=st.p LEFT JOIN nodes no ON no.id=st.o_id
            WHERE st.graph IN ({marks}) AND ns.kind='individual' AND np.kind IS NOT 'annprop'
              AND np.iri NOT LIKE 'http://www.w3.org/2000/01/rdf-schema#%'
            ORDER BY st.s, st.rowid"""
    for r in c.execute(q, graphs):
        s = safe(r["s"])
        if r["p"] == RDF_TYPE:
            if r["o"] == NAMED_IND:
                continue
            yield f"(instance {s} {safe(r['o'])} {deg.get((r['s'], r['p'], r['o']), '1.0')})"
        elif r["o_lit"] is not None:
            v = r["o_lit"]
            if not _NUM.match(v):  # string literal, sanitised exactly like the converter does
                # whitespace -> '_', parentheses -> '--', double quotes -> single, leading digit escaped
                v = re.sub(r"[)(]", "--", re.sub(r"\s", "_", _ascii(v))).replace('"', "'")
                if v[:1].isdigit():
                    v = "_" + v
            yield f"(instance {s} (= {safe(r['p'])} {v}) 1.0)"
        else:
            yield f"(related {s} {safe(r['o'])} {safe(r['p'])} {deg.get((r['s'], r['p'], r['o']), '1.0')})"


def export_fdl(fname, timeout=3600):
    """Write exports/<fname>.fdl; return {"file", "bytes", "lines", "seconds", "converter_files",
    "abox_files", "renamed"} or {"error"}.

    Modules of the closure are split by `reasoner._module_role`: ABox modules are streamed
    from the index, all the others go through the converter (`_convert`, `timeout` seconds).
    The file starts with '#' comment lines describing its provenance and renamed names.
    """
    files = closure_files(fname)
    if not files:
        return {"error": f"{fname} not found in the workspace directory"}
    c = sqlite3.connect(workspace.db_path())
    c.row_factory = sqlite3.Row
    schema, abox = [], []
    for f in files:
        (abox if reasoner._module_role(c, f) == "abox" else schema).append(f)
    t0 = time.time()
    tbox_fdl, renamed = "", {}
    if schema:
        try:
            tbox_fdl, renamed = _convert(schema, timeout)
        except RuntimeError as e:
            return {"error": str(e)}
    EXPORTS.mkdir(exist_ok=True)
    out = EXPORTS / (pathlib.Path(fname).stem + ".fdl")
    n = 0
    tbox_fdl = _ascii(tbox_fdl)
    with open(out, "w", encoding="ascii") as w:
        w.write(f"#FuzzyDL export of the import closure of {fname} - Ontology Viewer\n")
        w.write(f"#modules: {', '.join(files)}\n")
        if schema:
            w.write(f"#TBox of {', '.join(schema)}: translated by fuzzy_dl_owl2 (FuzzyOwl2ToFuzzyDL)\n")
        if abox:
            w.write(
                f"#ABox of {', '.join(abox)}: assertions from the index in the converter's syntax, "
                "degrees from owl:Axiom annotations\n"
            )
        if renamed:
            w.write(
                "# identifiers renamed for FuzzyDL syntax: "
                + ", ".join(f"{k} = {v}" for k, v in sorted(renamed.items()))
                + "\n"
            )
        w.write("\n" + tbox_fdl.rstrip("\n") + "\n")
        if abox:
            tb = _tbox_lines(c, abox)
            if tb:
                w.write(f"\n# ---- role axioms of {', '.join(abox)} (from the index)\n" + "\n".join(tb) + "\n")
            # this marker line is what build_meta uses to switch from TBox to ABox counting
            w.write(f"\n# ---- ABox of {', '.join(abox)}\n")
            for line in _abox_lines(c, abox):
                w.write(line + "\n")
                n += 1
    return {
        "file": out.name,
        "bytes": out.stat().st_size,
        "lines": n + tbox_fdl.count("\n"),
        "seconds": round(time.time() - t0, 1),
        "converter_files": schema,
        "abox_files": abox,
        "renamed": renamed,
    }


def build_meta(path):
    """One pass over the .fdl: textual statistics + byte offset of every page (sidecar .meta.json).

    Statistics: line/statement/comment/blank counts, TBox vs ABox lines (split at the
    "# ---- ABox" marker), statements per leading keyword, class vs data instance
    assertions, related assertions, assertions with degree ≠ 1.0, distinct individuals and
    asserted concepts. Returns the meta dict {"mtime", "page", "offsets", "stats"} after
    writing it next to the file.
    """
    st = {
        "lines": 0,
        "statements": 0,
        "comments": 0,
        "blank": 0,
        "tbox_lines": 0,
        "abox_lines": 0,
        "by_keyword": {},
        "instance_class": 0,
        "instance_data": 0,
        "related": 0,
        "degree_lt1": 0,
        "individuals": 0,
        "concepts_asserted": 0,
    }
    offsets, inds, concepts, in_abox, pos, n = [0], set(), set(), False, 0, 0
    with open(path, "rb") as f:
        for raw in f:
            if n and n % PAGE == 0:
                offsets.append(pos)  # byte offset of the first line of each page
            pos += len(raw)
            n += 1
            line = raw.decode("ascii", "replace").rstrip("\n")
            if not line:
                st["blank"] += 1
                continue
            if line.startswith("#") or line.startswith("%"):
                st["comments"] += 1
                if line.startswith("# ---- ABox"):
                    in_abox = True
                continue
            st["abox_lines" if in_abox else "tbox_lines"] += 1
            st["statements"] += 1
            head = line[1:].split(" ", 1)[0] if line.startswith("(") else "?"  # keyword after "("
            st["by_keyword"][head] = st["by_keyword"].get(head, 0) + 1
            parts = line.split(" ")
            if head == "instance" and len(parts) > 2:
                inds.add(parts[1])
                if parts[2].startswith("(="):
                    st["instance_data"] += 1
                else:
                    st["instance_class"] += 1
                    concepts.add(parts[2])
                    if not line.endswith(" 1.0)"):
                        st["degree_lt1"] += 1
            elif head == "related" and len(parts) > 2:
                st["related"] += 1
                inds.add(parts[1])
                inds.add(parts[2])
                if not line.endswith(" 1.0)"):
                    st["degree_lt1"] += 1
    st.update({"lines": n, "bytes": pos, "individuals": len(inds), "concepts_asserted": len(concepts)})
    meta = {"mtime": path.stat().st_mtime, "page": PAGE, "offsets": offsets, "stats": st}
    path.with_suffix(".meta.json").write_text(json.dumps(meta))
    return meta


def get_meta(path):
    """Cached meta of a .fdl: reuse the sidecar when its mtime matches the file, else rebuild it."""
    m = path.with_suffix(".meta.json")
    if m.exists():
        try:
            meta = json.loads(m.read_text())
            if meta.get("mtime") == path.stat().st_mtime:
                return meta
        except ValueError:
            pass
    return build_meta(path)


def read_page(path, page=0, q=""):
    """{"lines", "page", "pages", "stats", …}: one page of PAGE lines, or the first PAGE lines
    containing q (whole-file scan) when a filter is given.

    Pages are read by seeking to the byte offsets stored in the meta; `page` is clamped to
    the valid range. Trailing empty lines of the last page are dropped.
    """
    meta = get_meta(path)
    out = {"file": path.name, "stats": meta["stats"], "limit": PAGE}
    if q:
        # substring filter: byte-level scan of the whole file, stop after PAGE hits
        hits, needle = [], q.encode("ascii", "replace")
        with open(path, "rb") as f:
            for raw in f:
                if needle in raw:
                    hits.append(raw.decode("ascii", "replace").rstrip("\n"))
                    if len(hits) >= PAGE:
                        break
        out.update({"lines": hits, "page": 0, "pages": 1, "filtered": True})
        return out
    pages = max(1, len(meta["offsets"]))
    page = min(max(0, page), pages - 1)
    with open(path, "rb") as f:
        f.seek(meta["offsets"][page])
        lines = [f.readline().decode("ascii", "replace").rstrip("\n") for _ in range(PAGE)]
    while lines and lines[-1] == "":
        lines.pop()
    out.update({"lines": lines, "page": page, "pages": pages})
    return out


if __name__ == "__main__":  # self-check: python3 fdl_export.py SDF_ext.owl
    res = export_fdl(sys.argv[1] if len(sys.argv) > 1 else workspace.load()["files"][0])
    if "error" in res:
        print("ERROR:", res["error"])
    else:
        print({k: v for k, v in res.items() if k != "renamed"})
        txt = (EXPORTS / res["file"]).read_text()
        print(txt[:900])
        print("...")
        print(txt[-600:])
