# SDF Ontology Viewer

Local web app of the SDF (Sustainability Decision Framework) project to browse, edit, and
reason over OWL 2 ontologies, with native support for the Fuzzy OWL 2 constructs: fuzzy
datatypes with live membership plots, modifiers, weighted/OWA concepts, graded assertions,
classical reasoning (HermiT / Pellet), fuzzy reasoning (`fuzzy-dl-owl2`), DL queries, SPARQL,
SWRL rules, graphs, and a full `fuzzyDL` export.

## The interface at a glance

A Protégé-like **menu bar** drives the global actions:

- **File** — open an ontology (any standard serialization: RDF/XML, Turtle, N3, N-Triples,
  JSON-LD — foreign formats are converted to RDF/XML on open), open recent workspaces, create
  a new empty module, save / discard the pending changes, export the inferred axioms as an
  ontology, remove the active module from the index, stop the server.
- **Edit** — undo / redo the change journal (grouped edits as a whole), find (⌘K), create
  entities (class, individual, properties, datatype), create a child or sibling of the
  selected entity, duplicate / deprecate / delete the selected entity.
- **View** — light / dark theme; render entities by local name, prefixed name or
  `rdfs:label`; asserted vs inferred class hierarchy; Back / Forward entity history
  (Alt+←/→); reload.
- **Reasoner** — engine (HermiT / Pellet), start / synchronize / stop, configure (default
  engine, timeout), open the inferred view or the inferred class hierarchy, run history
  with a side-by-side diff of two saved runs (fuzzy answers or classic inferred axioms).
- **Refactor** — rename an entity IRI, mass-rename a namespace, change the ontology IRI,
  convert the selected class between defined (≡) and primitive (⊑), merge ontologies.
- **Tools** — rebuild the search index, manage the indexes on disk (one per workspace, with
  per-index delete), clear the reasoner memory, compare ontologies, check for inconsistencies,
  check for empty entities, show the server log, manage plugins.
- **Window** — show / hide every view and every Entities sidebar view (flyout submenus,
  persisted per user), reset the layout.
- **Help** — notation and keyword tables, this repository, About.

**Every main view is a plugin.** The tab bar is not hardcoded: each view — Ontology info,
Entities, Reasoner, Fuzzy, Axioms, FDL, Graph, Individuals by class, Knowledge graph,
DL Query, SPARQL, Rules, Help — is a self-contained package under `viewer/plugins/builtin/<id>/`
(`plugin.json` + `view.js`, minified build alongside), loaded dynamically at start-up together
with the packages installed under `viewer/plugins/custom/`. Deleting a package folder removes
that view entirely (a built-in can be restored by downloading its folder again from this
repository); the Plugins dialog (Tools) lists both groups with install-from-zip, uninstall and
per-view disable. Installed zips are validated (missing or syntactically broken scripts are
rejected) and their scripts minified automatically — the readable sources stay on disk and are
served with `?dev=1`. A package may also ship a **Python backend** (`"backend"` in the
manifest: `GET_ROUTES` / `POST_ROUTES` served under `/api/p/<name>/…`, import errors isolated
and shown in the dialog) and a **`tests.json`** smoke suite run by
`python3 -m ontoviewer.plugintests`. See [PLUGINS.md](PLUGINS.md) for the package format, the
`registerView()` API and the backend/test formats.

Four more tools open as **modal dialogs** from the menus: **Serialize ontology** (File —
Turtle / RDF/XML / N-Triples / N3 / JSON-LD, preview and download), **Compare ontologies**
(Tools — entity-grouped difference list à la Protégé with anonymous OWL expressions folded
back to `(A or B)` / `(p some C)` / facet form, searchable and paginated, between workspace
files, `.bak` backups or external ontologies added from a URL / file), **Merge ontologies**
(Refactor — union into a new self-contained module) and **Indexes on disk** (Tools).

The Entities sidebar defaults to the **Active ontology** scope — the active module plus its
whole import closure, Protégé semantics — with the closure of all modules one click away;
lists are ordered by the displayed name, ontology prefixes of imported entities included, and
the OWL 2 / RDFS / XSD built-in datatypes and annotation properties are always listed. A
right click on any entity opens a **context menu** (open, create child / sibling, rename,
duplicate, deprecate, delete, copy sub-hierarchy as indented text). Adding an ontology to the
current workspace is **incremental**: only the new modules are indexed and merged into a copy
of the existing index.

**Fuzzy layer**: the annotation that marks fuzzy entities is configurable (Ontology info →
Fuzzy annotation; default `fuzzyLabel`, Fuzzy OWL 2 `owlAnnotationLabel`, empty = classical
crisp ontology) and fuzziness propagates through `owl:equivalentClass` /
`owl:equivalentProperty` to the equivalent entities. Membership-function plots on the entity
page are **editable by dragging** the shape parameters; the Reasoner view saves per-workspace
fuzzy **query sets**.

**Exports**: axioms as CSV / LaTeX / PDF, SWRL rules as CSV / LaTeX / PDF, ontology metrics as
CSV / LaTeX / PDF, graphs as SVG / Graphviz DOT / TikZ, the FuzzyDL translation as `.fdl`,
inferred axioms as an ontology, any module in the standard RDF serializations.

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
ontology from the app afterwards (File → Open ontology… / Open from URL…; several paths
separated by `;` open one shared workspace, and the dialog asks whether to start a new
workspace or add to the current one).

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
| `viewer/static/` | front-end KIT (HTML/CSS/shared JS; `app.min.js` is the committed bundle) |
| `viewer/plugins/builtin/<id>/` | one self-contained package per built-in view (`plugin.json` + `view.js`) |
| `viewer/plugins/custom/` | plugins installed from zip (per-user, git-ignored) |
| `viewer/data/` | **generated** — per-user indexes, workspaces, logs (git-ignored) |
| `start_viewer.sh`, `stop_viewer.sh` | start/stop the viewer in the background |
| `PLUGINS.md` | plugin package format, `registerView()` API, menu entries, API routes |
