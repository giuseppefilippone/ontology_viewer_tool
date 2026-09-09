"""Per-package smoke tests: ``python3 -m ontoviewer.plugintests [package…]``.

Each view package (``plugins/builtin/<id>/``, ``plugins/custom/<name>/``) may carry a
``tests.json``: a list of shots run in-process against the index of the current workspace
(read-only — no running server needed, nothing is written):

    [{"name": "fuzzy overview", "get": "/api/fuzzy", "expect": ["groups", "total"]},
     {"get": "/api/axioms", "params": {"graph": "$module"}, "expect": ["tbox"]},
     {"post": "/api/sparql", "payload": {"query": "SELECT …"}, "expect": ["rows"]},
     {"get": "p:stats", "params": {"kind": "class"}}]

Shot fields:
    name     label printed on failure (default: the route)
    get      an ``/api/…`` GET route, or ``p:<route>`` = the package's own Python backend
    post     an ``/api/…`` POST route — only routes of ``api.NO_CONNECTION`` (read-only)
    params   GET query parameters (plain values); ``"$module"`` = first workspace file
    payload  POST JSON payload
    expect   keys that must be present in the answer; an ``error`` key always fails a shot

Without arguments every package carrying a ``tests.json`` runs; exit code 0 = all passed.
"""

import json
import sys

from ontoviewer import api, workspace
from ontoviewer.api import plugins


def _resolve(v):
    """``$module`` placeholder → the first file of the current workspace."""
    return workspace.load()["files"][0] if v == "$module" else v


def run_package(d):
    """Run the shots of one package directory; returns (total, [failure line…])."""
    shots = json.loads((d / "tests.json").read_text())
    fails = []
    for i, s in enumerate(shots):
        label = s.get("name") or s.get("get") or s.get("post") or f"shot {i}"
        try:
            if "get" in s:
                q = {k: [str(_resolve(v))] for k, v in (s.get("params") or {}).items()}
                route = s["get"]
                if route.startswith("p:"):
                    res = plugins.backend_call("GET", d.name, route[2:], q)
                else:
                    res = api.GET_ROUTES[route](q)
            else:
                route = s["post"]
                if route.startswith("p:"):
                    res = plugins.backend_call("POST", d.name, route[2:], s.get("payload") or {})
                elif route in api.NO_CONNECTION:
                    res = api.POST_ROUTES[route](None, s.get("payload") or {})
                else:
                    raise AssertionError(f"{route} writes to the index: only NO_CONNECTION POST routes are testable")
            if isinstance(res, dict) and res.get("error"):
                raise AssertionError(f"error: {res['error']}")
            for k in s.get("expect") or []:
                if k not in res:
                    raise AssertionError(f"missing key {k!r} in the answer")
        except AssertionError as e:
            fails.append(f"  FAIL {label}: {e}")
        except Exception as e:
            fails.append(f"  FAIL {label}: {type(e).__name__}: {e}")
    return len(shots), fails


def main(names):
    """Run the tests of the named packages (default: every package with a tests.json)."""
    plugins.load_backends()
    packs = []
    for base in (plugins.BUILTIN_DIR, plugins.PLUGINS_DIR):
        if base.is_dir():
            packs += [d for d in sorted(base.iterdir()) if (d / "tests.json").is_file()]
    if names:
        missing = set(names) - {d.name for d in packs}
        if missing:
            print("no tests.json:", ", ".join(sorted(missing)))
        packs = [d for d in packs if d.name in names]
    if not packs:
        print("no package with a tests.json found")
        return 1
    ok = True
    for d in packs:
        n, fails = run_package(d)
        print(f"{d.name}: {n - len(fails)}/{n} passed")
        for f in fails:
            print(f)
        ok = ok and not fails
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
