"""History of reasoner runs and diffs between two runs.

Every successful fuzzy or classic reasoner run is snapshotted as one JSON file under
``data/runs_<workspace key>/`` (``save``, called by the API handlers; the history keeps
the most recent ``KEEP`` runs).  ``listing`` returns the history newest-first and
``diff`` compares two runs of the same kind:

    fuzzy   query line → the answers of both runs, side by side, changed values flagged
    classic added / removed inferred subclass links, inferred types and unsatisfiable
            classes between the two runs

Snapshots are per-workspace (like the saved query sets and the inferred view).
"""

import json
import pathlib
import time

from ontoviewer import config, workspace

KEEP = 20  # runs kept per workspace, oldest pruned


def runs_dir():
    """data/runs_<workspace key>/ (created on first use)."""
    d = config.DATA_DIR / f"runs_{workspace.key()}"
    d.mkdir(exist_ok=True)
    return d


def save(kind, payload):
    """Snapshot one successful run ('fuzzy' | 'classic') and prune the history; returns the file name."""
    ts = time.strftime("%Y%m%d-%H%M%S")
    f = runs_dir() / f"{ts}_{kind}.json"
    n = 1
    while f.exists():  # two runs in the same second
        n += 1
        f = runs_dir() / f"{ts}.{n}_{kind}.json"
    f.write_text(json.dumps({"ts": ts, "kind": kind, **payload}, indent=1))
    for old in sorted(runs_dir().glob("*.json"))[:-KEEP]:
        old.unlink()
    return f.name


def load(name):
    """One saved run by file name (reduced to its basename: only files of the runs dir are reachable)."""
    return json.loads((runs_dir() / pathlib.Path(name).name).read_text())


def listing():
    """The saved runs of the current workspace, newest first: file, ts, kind, engine, summary."""
    out = []
    for f in sorted(runs_dir().glob("*.json"), reverse=True):
        try:
            d = json.loads(f.read_text())
        except Exception:
            continue
        out.append(
            {
                "file": f.name,
                "ts": d.get("ts"),
                "kind": d.get("kind"),
                "engine": d.get("engine") or d.get("provider"),
                "summary": d.get("summary"),
            }
        )
    return out


def diff(a, b):
    """Delta between two saved runs (file names): {"kind", …} or {"error"} when incomparable.

    fuzzy   rows: [{"query", "a", "b", "changed"}…] over the union of the query lines
            (the answer is the numeric value when present, else the textual result)
    classic added/removed for inferred_subclass, inferred_types and unsatisfiable
    """
    A, B = load(a), load(b)
    if A.get("kind") != B.get("kind"):
        return {"error": f"cannot compare a {A.get('kind')} run with a {B.get('kind')} run"}
    if A.get("kind") == "fuzzy":

        def answers(d):
            return {
                r.get("query"): (r.get("value") if r.get("value") is not None else r.get("result") or r.get("error"))
                for r in d.get("results") or []
            }

        qa, qb = answers(A), answers(B)
        rows = [
            {"query": q, "a": qa.get(q), "b": qb.get(q), "changed": qa.get(q) != qb.get(q)}
            for q in sorted(set(qa) | set(qb))
        ]
        return {"kind": "fuzzy", "rows": rows, "a": A["ts"], "b": B["ts"]}
    out = {"kind": "classic", "a": A["ts"], "b": B["ts"]}
    for k in ("inferred_subclass", "inferred_types", "unsatisfiable"):
        sa = {tuple(x) if isinstance(x, list) else (x,) for x in A.get(k) or []}
        sb = {tuple(x) if isinstance(x, list) else (x,) for x in B.get(k) or []}
        out[k] = {"added": sorted(sb - sa), "removed": sorted(sa - sb)}
    return out
