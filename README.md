# SDF Ontology Viewer

Local web app of the SDF (Sustainability Decision Framework) project to browse, edit, and
reason over OWL 2 ontologies, with native support for the Fuzzy OWL 2 constructs: fuzzy
datatypes with live membership plots, modifiers, weighted/OWA concepts, graded assertions,
classical reasoning (HermiT / Pellet), fuzzy reasoning (`fuzzy-dl-owl2`), DL queries, SPARQL,
SWRL rules, graphs, and a full `fuzzyDL` export.

## Requirements

- **Python ≥ 3.11** with:

  ```sh
  pip install rdflib fuzzy-dl-owl2 owlready2 pandas ijson requests
  ```

  (`rdflib` is enough to browse; `fuzzy-dl-owl2` adds fuzzy reasoning and the FDL export,
  `owlready2` the classical reasoners.)
- Optional, for fuzzy reasoning: a MILP solver supported by `fuzzy-dl-owl2` — Gurobi is the
  tested one (set `milpProvider` in the library's `CONFIG.ini`).
- Optional, for the Pellet reasoner: Java ≥ 25 (`brew install openjdk`).
- Optional, to rebuild the minified JS bundle after editing `viewer/static/js/*.js`:
  Node.js, then `cd viewer && npm install`. Without Node the app still runs
  (append `?dev=1` to the URL to load the readable sources).

## Installation

```sh
git clone <this repository> sdf-viewer
cd sdf-viewer
pip install rdflib fuzzy-dl-owl2 owlready2
```

Place the ontology modules (`SDF_ext.owl`, `SDF_individuals.owl`, …) in the **parent
directory** of the repository — that is the default workspace — or open any other
folder/ontology from the app afterwards (folder button in the header, top left).

## Starting and stopping the viewer

```sh
./start_viewer.sh [port]      # default 8765; opens http://localhost:<port> in the browser
./stop_viewer.sh  [port]      # clean shutdown (or use the power button in the app header)
```

- The server binds to `127.0.0.1` only.
- On the **first launch** the SQLite index of the ontology is built in the background
  (progress bar at the top of the app); large ontologies take a few minutes, and the index is
  reused afterwards.
- Logs: `viewer/data/viewer.log` — PID file: `viewer/data/viewer.pid`.
- Manual run (foreground): `cd viewer && python3 server.py [port]`, Ctrl+C to quit.

Everything the app writes (indexes, workspaces, uploads, exports, reasoner scratch files) lives
under `viewer/data/` and is **git-ignored**: each clone builds its own.

## Repository layout

| path | content |
| ------ | ------ |
| `viewer/server.py` | entry point of the Ontology Viewer |
| `viewer/ontoviewer/` | Python package: indexer, store, editor, reasoners, API |
| `viewer/static/` | front-end (HTML/CSS/JS; `app.min.js` is the committed bundle) |
| `viewer/data/` | **generated** — per-user indexes, workspaces, logs (git-ignored) |
| `start_viewer.sh`, `stop_viewer.sh` | start/stop the viewer in the background |
