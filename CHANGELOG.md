# Changelog

## v2.0.0 — 2026-09-09

The Protégé-parity release: every view is a self-contained plugin package, the menu bar
covers the Protégé feature set that applies to this stack, and the fuzzy layer is fully
configurable.

### Architecture
- **Every view is a plugin package** under `viewer/plugins/builtin/<id>/`
  (`plugin.json` + `view.js` + minified build): deleting a folder removes the view,
  built-ins can be uninstalled from the Plugins dialog and restored from the repository.
  Custom plugins install from a zip into `viewer/plugins/custom/` (Tools → Plugins…).
- **Python backends for plugins**: `plugin.json` may declare `"backend": "backend.py"`,
  a module whose `GET_ROUTES` / `POST_ROUTES` are served under `/api/p/<name>/<route>`;
  import errors are isolated and surfaced in the Plugins dialog. Front-end helpers
  `papi()` / `ppost()`.
- **Per-package smoke tests**: `tests.json` shots run in-process by
  `python3 -m ontoviewer.plugintests [package…]`; every built-in package ships a suite.
- Order-insensitive index keys (`index_<hash of dir + sorted files>.db`) with a one-off
  migration of existing indexes at start-up.

### Protégé-style menu bar and editing
- File / Edit / View / Reasoner / Refactor / Tools / Window / Help menus with flyout
  submenus: undo/redo journal, duplicate/deprecate/delete entities, rename IRI and
  namespace, convert defined ↔ primitive class, create child/sibling entities,
  new module, imports and prefixes management, serialization to every standard format,
  ontology comparison and merge (workspace, file or URL sources), consistency and
  empty-entity checks, loaded ontology sources with the `catalog-v001.xml` mappings,
  show/hide of every view, index list with per-index delete.
- Entity **context menu** (right click in every list and hierarchy): open, create
  child/sibling, rename, duplicate, deprecate, delete, copy sub-hierarchy as
  tab-indented text.
- Entity **navigation history** (Back / Forward, Alt+←/→).
- Anonymous expressions grouped and rendered per the OWL 2 mapping-to-RDF vocabulary
  (unions, restrictions, facets) in the comparison and everywhere else.

### Fuzzy layer
- **Configurable fuzzy annotation label** (Ontology Info → Fuzzy annotation, default
  `fuzzyLabel`, empty = classical crisp ontology), forwarded to fuzzy_dl_owl2
  (`owlAnnotationLabel`) and used for SWRL degrees; the `sdf:isFuzzy` flag is gone.
- **Fuzziness through equivalence**: an entity equivalent (owl:equivalentClass /
  owl:equivalentProperty chains) to a fuzzy-annotated one is fuzzy too; the entity page
  and the Fuzzy view show the annotated sources it inherits from.
- **Draggable membership-function editor** on the entity plots (leftshoulder,
  rightshoulder, triangular, trapezoidal, crisp): drag the parameters, save as a
  pending undoable change.
- Saved fuzzy **query sets** per workspace (Reasoner view), auto-restored.
- **Reasoner run history** with side-by-side **diff** of two runs (fuzzy answers or
  classic inferred axioms).

### Performance and robustness
- **Incremental module add**: adding an ontology to the current workspace indexes only
  the new modules and merges them into a copy of the existing index (seconds instead of
  a full rebuild); module removal is incremental too.
- Display-name-ordered entity lists with a memoised order cache, pre-warmed at start-up.
- Stale-files toast with a one-click index update.
- Import/export in every standard RDF format, CSV/LaTeX/PDF exports of axioms, metrics
  and SWRL rules, TikZ/DOT graph exports.

## v1.0.0

Initial public release: entity browsing, fuzzy rendering, FDL export, graphs,
DL/SPARQL queries, SWRL rules, fuzzy and classic reasoning.
