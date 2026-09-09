# Extending the Ontology Viewer with plugin views

The viewer has a small plugin surface for adding **views** (main tabs) and **menu entries**
without touching the core files. It is not an optional side door: **every main tab of the
viewer is itself a registered view** — `index.html` carries no tab buttons, the built-ins
register through `registerView()` at the top of `viewer/static/js/views.js` (which also
implements the Serialize / Compare / Merge / Plugins dialogs), and installed plugins register
the same way from their own scripts. The Plugins dialog lists both: installed packages
(uninstallable) and built-in views (disable / enable).

## Adding a view

A view is one main tab: a button in the tab bar plus a panel. Register it with
`registerView()` (defined in `core.js`):

```js
// my_views.js
registerView({
    id: 'stats',                     // #tab-stats panel, data-mt="stats" button
    title: 'Statistics',             // label of the tab button
    tooltip: 'What the tab shows',   // hover text of the button
    render: renderStats,             // called on EVERY click of the tab
});

function renderStats() {
    const el = $('#tab-stats');
    if (el.dataset.ready) return;    // build the panel once…
    el.dataset.ready = '1';
    el.innerHTML = `<div class="card" style="max-width:none"><h2>Statistics</h2>
      <button class="ibtn primary" style="margin:0" onclick="statsLoad()">${ic('play')} Load</button>
      <div id="statsout" style="margin-top:10px"></div></div>`;
}                                    // …and load data on demand (or refresh here on every call)
```

Everything else is automatic: the new tab takes part in **drag-to-reorder**, in the
**Window menu** (show / hide, persisted in `ui_config.json`), and in the `#tab=stats`
deep link — no further wiring.

What a `render` function can rely on (all global, defined in the core files):

| helper | purpose |
| ------ | ------ |
| `$(sel)` | `document.querySelector` |
| `api(path, params)` / `post(path, payload)` | GET / POST of the JSON API, returns a Promise |
| `esc(text)` | HTML escaping |
| `ic(name)` | Material icon SVG (`play`, `download`, `add`, `refresh`, …: see `ICONS` in `core.js`) |
| `dot(kind, fuzzy)` / `entLink(node)` / `openEntity(iri)` | entity dots and clickable entity links |
| `modules`, `ontoData`, `$('#ontsel').value` | module list and active ontology |
| `downloadText(name, text, mime)` / `csvq(s)` | client-side file download, CSV field quoting |
| `openForm(title, fields, onOk, note)` / `closeForm()` | modal forms |
| `registerView(v)` | this hook |

## Packaging a plugin (install without forking)

A plugin can also be **installed from the app** (Tools → Plugins… → Install plugin (.zip)),
with no change to the repository. The zip carries a `plugin.json` manifest at its root (or
inside a single top-level folder) plus the files it lists:

```
my-plugin.zip
├── plugin.json
├── my_views.js
├── my.css          (optional)
└── logo.png        (optional assets)
```

```json
{
    "name": "my-plugin",
    "version": "1.0",
    "description": "One line shown in the Plugins dialog",
    "js": ["my_views.js"],
    "css": ["my.css"],
    "backend": "backend.py"
}
```

- The package is extracted to `viewer/data/plugins/<name>/` (per-user, git-ignored);
  installing the same name again replaces it (upgrade), Uninstall deletes the directory.
- At every start the listed `css` and `js` files are injected **after** the core bundle, so
  the scripts can call `registerView()` and every helper of the table above exactly like a
  fork would. Views registered this way take part in the Window menu and remember their
  hidden state.
- Other files of the package are served under `/plugins/<name>/…` — use that base URL for
  images and data files.
- A package may also ship a **Python backend**: `"backend": "backend.py"` names a module
  inside the package defining `GET_ROUTES` / `POST_ROUTES` dicts, served under
  `/api/p/<name>/<route>`:

  ```python
  # backend.py — runs inside the viewer server; ontoviewer is importable (read the index
  # through ontoviewer.store, never write to it from a plugin)
  from ontoviewer import store

  def stats(q):  # GET /api/p/my-plugin/stats?kind=class
      kind = q.get("kind", ["class"])[0]
      n = store.db().execute("SELECT COUNT(*) FROM nodes WHERE kind=?", (kind,)).fetchone()[0]
      return {"kind": kind, "count": n}

  GET_ROUTES = {"stats": stats}
  POST_ROUTES = {}  # fn(payload) -> JSON-serialisable dict
  ```

  The front-end reaches it with `papi('my-plugin', 'stats', {kind: 'class'})` /
  `ppost('my-plugin', 'route', {...})`. Handler exceptions become `{"error": …}` (HTTP 400).
  An import error never breaks the server: the Plugins dialog shows a red "backend error"
  badge with the message, and every call answers with it. Built-in packages may declare a
  backend the same way. Anything beyond that (new tables, background jobs) still fits a
  fork better (next sections).

## Where the code goes (forking the repository)

1. Put the view in a new file `viewer/static/js/<name>.js` (or extend `views.js`).
2. Add the file name to `JS_ORDER` in `viewer/ontoviewer/bundle.py` — **after** `core`
   (it defines `registerView`) and **before** `main` (it applies the saved tab order and
   hidden tabs at start-up).
3. Rebuild the bundle: `cd viewer && python3 -m ontoviewer.bundle --force`
   (needs `npm install` once, for terser). During development you can skip the rebuild and
   open the app with `?dev=1`, which loads the readable sources listed in `JS_ORDER`.

## Adding a server endpoint

When the view needs data the JSON API does not expose yet:

1. Write the handler in the fitting module of `viewer/ontoviewer/api/` — GET handlers take
   the parsed query string `q`, POST handlers take `(c, p)` where `c` is the editor SQLite
   connection and `p` the JSON payload.
2. Register the path in `GET_ROUTES` / `POST_ROUTES` in `viewer/ontoviewer/api/__init__.py`.
   Add read-only / file-system POST routes to `NO_CONNECTION` so they do not open (and
   possibly create) an index database.
3. Errors: raise — a POST handler's exception becomes `{"error": …}` with HTTP 400.

## Testing a package

A package may carry a `tests.json`: a list of read-only smoke shots run in-process against
the index of the current workspace — no running server needed:

```json
[
 {"name": "fuzzy overview", "get": "/api/fuzzy", "expect": ["groups", "total"]},
 {"get": "/api/axioms", "params": {"graph": "$module"}, "expect": ["tbox"]},
 {"post": "/api/sparql", "payload": {"query": "SELECT ?s WHERE { ?s ?p ?o } LIMIT 1"}},
 {"get": "p:stats", "params": {"kind": "class"}}
]
```

`get` is an `/api/…` GET route or `p:<route>` (the package's own Python backend); `post`
works for the read-only routes only (`api.NO_CONNECTION`). `params` values may use
`"$module"` (the first workspace file); `expect` lists keys the JSON answer must carry, and
an `error` key always fails the shot. Run with:

```
cd viewer && python3 -m ontoviewer.plugintests            # every package with a tests.json
cd viewer && python3 -m ontoviewer.plugintests fuzzy kg   # selected packages
```

Every built-in package ships such a suite; exit code 0 means all shots passed.

## Adding menu entries

The menu bar (`viewer/static/js/menubar.js`) is data-driven: `MB` maps each menu name to a
function returning its entries, rebuilt on every open, so states are always current:

```js
MB.tools = () => [
    ...MB_TOOLS_ORIGINAL(),                      // keep what is there
    null,                                        // separator
    { l: 'My action', i: 'play', js: 'myAction()', off: !myActionAvailable() },
];
```

Entry fields: `l` label, `i` icon name (optional), `js` inline onclick code, `off` disabled,
`chk` leading check mark, `stay` keep the panel open after the click (call `mbRefresh()` to
redraw it), `h` section header; `null` renders a separator.

## Conventions

- Panels use the shared look: a `.card` wrapper, `.ibtn`/`.ibtn primary` buttons, `.dt` for
  secondary text; theming through the CSS variables of `app.css` (`var(--bg)`, `var(--mono)`, …).
- Long output scrolls inside the panel (`max-height` + `overflow:auto`), never the page sideways.
- The files share one global scope (classic scripts, no modules): prefix your globals to
  avoid collisions, and check `app.css` before inventing class names (`.menu`, `.item`,
  `.res`, … are taken).
