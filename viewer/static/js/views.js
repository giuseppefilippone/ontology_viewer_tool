// views.js — the Rendering / Comparison / Merge / Plugins dialogs, opened from the menu bar
// (File → Serialize ontology…, Tools → Compare ontologies… / Plugins…, Refactor → Merge ontologies…).
//
// They are modal dialogs like the Import-ontology one (#modal / #modalbox, closed by closeForm);
// the Protégé counterparts are the Turtle / RDF-XML rendering views, the Ontology comparison
// Difference list, Refactor → Merge ontologies and the Plugins table of the Preferences.
// Plugin views for the main tab bar are still available through registerView() (see PLUGINS.md).

// The built-in views are NOT registered here any more: each lives in its own package
// viewer/plugins/builtin/<id>/ (plugin.json + view.js with the registerView call), bundled
// after this file in canonical order — see bundle.BUILTIN_VIEWS and PLUGINS.md.

/**
 * Fill the modal with one dialog. `wide` widens the box (Comparison needs the most room).
 * @param {string} html Dialog content (title + body + its own Close button).
 * @param {boolean} [wide]
 * @returns {void}
 */
function openDialog(html, wide) {
	const b = $('#modalbox');
	b.classList.toggle('wide', !!wide);
	b.style.width = wide ? 'min(1200px, 94vw)' : '';
	b.innerHTML = html;
	$('#modal').style.display = 'flex';
}

/** Footer with the Close button, shared by the four dialogs. */
const DLG_CLOSE = `<div style="text-align:right;margin-top:12px"><button class="ibtn" onclick="closeForm()">Close</button></div>`;

// ---------- shared: files usable by Comparison / Merge and the "Add ontology" controls ----------
/** Suffix shown next to a file of /api/diff/files. @returns {string} */
const dfTag = (f) => (f.kind === 'backup' ? ' (last save)' : f.kind === 'external' ? ' (external)' : '');
/**
 * "Add ontology" row: fetch from a URL or upload a file into data/compare/, then `cb(newName)`.
 * `pfx` keeps the ids unique per dialog. @returns {string} HTML.
 */
const addOntoHtml = (pfx, cb) => `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px">
  <span class="dt">Add ontology</span>
  <input id="${pfx}url" placeholder="https://… (.owl, .ttl, .rdf, …)" style="min-width:280px">
  <button class="ibtn" style="margin:0" onclick="addOntoFetch('${pfx}', ${cb})" title="Download the ontology at this URL into viewer/data/compare/ and add it to the lists">${ic('download')} Fetch URL</button>
  <label class="ibtn" style="margin:0;cursor:pointer;display:inline-flex;align-items:center;gap:6px" title="Upload an ontology file into viewer/data/compare/ and add it to the lists">${ic('upload')} Upload file…
    <input type="file" accept=".owl,.rdf,.xml,.ttl,.n3,.nt,.jsonld" style="display:none" onchange="addOntoUpload(this, ${cb})"></label>
  <span id="${pfx}addst" class="dt"></span></div>`;
/** "Fetch URL" button of an Add-ontology row: POST /api/diff/fetch. @returns {void} */
function addOntoFetch(pfx, cb) {
	const url = $(`#${pfx}url`).value.trim();
	if (!url) return;
	$(`#${pfx}addst`).textContent = 'downloading…';
	post('/api/diff/fetch', { url }).then((r) => {
		$(`#${pfx}addst`).textContent = r.error ? '' : `added ${r.file}`;
		if (r.error) alert(r.error);
		else cb(r.file);
	});
}
/** "Upload file…" control of an Add-ontology row: multipart POST /api/diff/upload. @returns {void} */
function addOntoUpload(inp, cb) {
	const f = inp.files[0];
	if (!f) return;
	const fd = new FormData();
	fd.append('file', f);
	fetch('/api/diff/upload', { method: 'POST', body: fd })
		.then((r) => r.json())
		.then((r) => {
			if (r.error) alert(r.error);
			else cb(r.file);
		});
}

// ---------- Rendering (File → Serialize ontology…) ----------
/** Name of the staged export file of the last serialization (download button). */
let RD_NAME = '';

/** Open the serialization dialog; the text itself is loaded by renderingLoad. @returns {void} */
function openRendering() {
	openDialog(
		`<h3 style="margin-top:0">Serialize ontology</h3>
  <div class="dt" style="margin:4px 0 8px">Serialization of the active ontology module (parsed and re-serialized with rdflib).</div>
  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
    <select id="rdfmt" aria-label="Serialization format"><option value="turtle">Turtle</option><option value="xml">RDF/XML</option><option value="nt">N-Triples</option><option value="n3">N3</option><option value="json-ld">JSON-LD</option></select>
    <button class="ibtn primary" style="margin:0" onclick="renderingLoad()">${ic('play')} Render</button>
    <button class="ibtn" style="margin:0" onclick="if(RD_NAME)location.href='/api/export_file?name='+encodeURIComponent(RD_NAME)"
            title="Download the full serialization (renders first if needed)">${ic('download')} Download</button>
    <span id="rdstatus" class="dt"></span></div>
  <pre id="rdout" style="max-height:55vh;overflow:auto;background:var(--bg);padding:10px;border-radius:6px;font-size:11.5px;margin-top:10px"></pre>` +
			DLG_CLOSE,
		true
	);
}

/** "Render" button: POST /api/serialize on the active ontology and show the text. @returns {void} */
function renderingLoad() {
	$('#rdstatus').textContent = 'serializing…';
	post('/api/serialize', { graph: activeFile(), fmt: $('#rdfmt').value }).then((d) => {
		if (d.error) {
			$('#rdstatus').textContent = '';
			$('#rdout').textContent = d.error;
			return;
		}
		RD_NAME = d.name;
		$('#rdstatus').textContent =
			`${activeFile()} · ${d.triples} triples${d.truncated ? ' · preview truncated, use Download for the full file' : ''}`;
		$('#rdout').textContent = d.text;
	});
}

// ---------- Comparison (Tools → Compare ontologies…) ----------
/** Open the comparison dialog (the file lists load asynchronously). @returns {void} */
function openCompare() {
	openDialog(
		`<h3 style="margin-top:0">Compare ontologies</h3>
  <div class="dt" style="margin:4px 0 8px">Difference list between two ontologies: workspace modules, their existing <code>.bak</code> backups (written by Save), or external ontologies added below from a URL / file. BNode-safe (rdflib isomorphic comparison), grouped by entity like Protégé's Ontology Differences.</div>
  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
    <span class="dt">A</span><select id="cmpa"></select>
    <span class="dt">B</span><select id="cmpb"></select>
    <button class="ibtn primary" style="margin:0" onclick="compareLoad(0)">${ic('play')} Compare</button>
    <input id="cmpq" placeholder="filter entities / axioms…" style="min-width:220px"
           oninput="clearTimeout(window._cmpT);window._cmpT=setTimeout(()=>compareLoad(0),300)">
    <span id="cmpstatus" class="dt"></span></div>
  ${addOntoHtml('cmp', 'cmpAdded')}
  <div id="cmpout" style="margin-top:10px;max-height:52vh;overflow:auto"></div>` + DLG_CLOSE,
		true
	);
	cmpFillSelects();
}
/** Fill the two selects with the files that actually exist (GET /api/diff/files). @returns {void} */
function cmpFillSelects(selA, selB) {
	api('/api/diff/files', {}).then((d) => {
		const opts = (d.files || [])
			.map((f) => `<option value="${esc(f.name)}">${esc(f.name)}${dfTag(f)}</option>`)
			.join('');
		$('#cmpa').innerHTML = opts;
		$('#cmpb').innerHTML = opts;
		$('#cmpa').value = selA || activeFile();
		const bak = (selA || activeFile()) + '.bak';
		$('#cmpb').value =
			selB ||
			((d.files || []).some((f) => f.name === bak)
				? bak
				: (d.files.find((f) => f.name !== $('#cmpa').value) || d.files[0] || {}).name || '');
	});
}
/** An ontology was just added: refresh the selects and preselect it as B. @returns {void} */
function cmpAdded(name) {
	cmpFillSelects($('#cmpa').value, name);
}

/**
 * "Compare" button / filter / pager: POST /api/diff (server-side cache, search and pages of
 * 100) and render it Protégé-style — one row per entity (Created / Deleted / Modified),
 * expandable to the baseline (B) and new (A) axioms; anonymous nodes labelled by their type
 * with stable _:bN tokens.
 * @param {number} [page] 0-based page of the filtered list.
 * @returns {void}
 */
function compareLoad(page = 0) {
	$('#cmpstatus').textContent = 'comparing…';
	post('/api/diff', { a: $('#cmpa').value, b: $('#cmpb').value, q: $('#cmpq').value.trim(), page }).then((d) => {
		if (d.error) {
			$('#cmpstatus').textContent = '';
			$('#cmpout').innerHTML = `<span class="dt">${esc(d.error)}</span>`;
			return;
		}
		$('#cmpstatus').textContent =
			`${esc(d.a)} (new) vs ${esc(d.b)} (baseline, ${esc(d.b_time)}) — ` +
			`${d.counts.created} entities created, ${d.counts.deleted} deleted, ${d.counts.modified} modified · ` +
			`${d.added_total} axioms only in A, ${d.removed_total} only in B` +
			($('#cmpq').value.trim() ? ` · filter: ${d.filtered_total} entities` : '');
		const st = {
			created: ['Created', 'color:var(--ok-fg)', ''],
			deleted: ['Deleted', 'color:var(--danger)', 'text-decoration:line-through'],
			modified: ['Modified', 'color:var(--acc)', '']
		};
		// axiom rows show entities by local name, like everywhere else in the app (full IRI too long)
		const shortAx = (t) => t.replace(/<https?:\/\/[^>\s]+[#\/]([A-Za-z0-9_.~-]+)>/g, '$1');
		// axiom rows are plain text: the status word and the struck-through entity name already say "deleted"
		const axr = (t) =>
			`<div style="padding:1px 0;font-size:11.5px;font-family:var(--mono);word-break:break-word" title="${esc(t)}">${esc(shortAx(t))}</div>`;
		const col = (title, rows, total) =>
			`<div style="flex:1;min-width:min(420px,100%)"><div class="dt" style="margin-bottom:2px">${title} (${total})</div>${
				rows.map(axr).join('') || '<div class="dt">none</div>'
			}${total > rows.length ? `<div class="dt">… first ${rows.length} shown</div>` : ''}</div>`;
		// the standard pager of the app (first / prev / page input / next / last + total)
		const pager = `<div style="display:flex;margin:8px 0">${pagerHtml(d.page, d.pages, 'compareLoad({p})', `${d.filtered_total.toLocaleString('en')} entities`)}</div>`;
		$('#cmpout').innerHTML =
			pager +
			((d.entities || [])
				.map((e) => {
					const [lbl, color, deco] = st[e.status];
					const who = e.anon
						? `<span style="font-style:italic;${deco}">${esc(e.name)}</span>`
						: `<span style="${deco}">${entLink({ iri: e.iri, name: short(e.iri), label: e.label, kind: 'class' })}</span>`;
					return `<details style="padding:2px 0"><summary style="cursor:pointer" title="${esc(e.iri || e.name)}"><span style="${color}">${lbl}:</span>
${who}
<span class="dt">(${e.new_total} new / ${e.baseline_total} baseline axioms)</span></summary>
<div style="display:flex;gap:18px;flex-wrap:wrap;margin:4px 0 6px 16px">${col('New axioms (A)', e.new, e.new_total)}${col('Baseline axioms (B)', e.baseline, e.baseline_total)}</div></details>`;
				})
				.join('') || '<div class="dt">no differences (with this filter): the two ontologies match</div>') +
			pager;
	});
}

// ---------- Merge (Refactor → Merge ontologies…) ----------
/** Open the merge dialog (the source list loads asynchronously). @returns {void} */
function openMerge() {
	openDialog(
		`<h3 style="margin-top:0">Merge ontologies</h3>
  <div class="dt" style="margin:4px 0 8px">Union of the selected ontologies (workspace modules and external ontologies added below from a URL / file) into a new self-contained module of the workspace: the sources are untouched, their <code>owl:Ontology</code> headers (imports included) are replaced by one new header. Update the index afterwards to browse the merged module.</div>
  <div style="display:flex;gap:24px;flex-wrap:wrap">
    <div><div class="ptitle" style="margin-top:0">Ontologies to merge (at least two)</div>
      <div id="mrglist" style="max-height:40vh;overflow:auto"><span class="dt">loading…</span></div></div>
    <div style="min-width:320px">
      <div class="ptitle" style="margin-top:0">Target module</div>
      <input id="mrgname" placeholder="merged.owl" style="width:100%">
      <div class="ptitle">Ontology IRI (optional)</div>
      <input id="mrgiri" placeholder="http://www.semanticweb.org/ontologies/merged" style="width:100%">
      <div style="margin-top:10px"><button class="ibtn primary" style="margin:0" onclick="mergeRun()">${ic('play')} Merge</button> <span id="mrgstatus" class="dt"></span></div>
    </div></div>
  ${addOntoHtml('mrg', 'mrgAdded')}` + DLG_CLOSE
	);
	mrgFillList();
}
/** Fill the source checkboxes: workspace modules + external ontologies (backups excluded). @returns {void} */
function mrgFillList(checked = []) {
	api('/api/diff/files', {}).then((d) => {
		$('#mrglist').innerHTML =
			(d.files || [])
				.filter((f) => f.kind !== 'backup')
				.map(
					(f) =>
						`<label style="display:block;font-size:13px;margin:3px 0"><input type="checkbox" class="mrgf" value="${esc(f.name)}" ${checked.includes(f.name) ? 'checked' : ''}> ${esc(f.name)}${dfTag(f)}</label>`
				)
				.join('') || '<span class="dt">nothing to merge</span>';
	});
}
/** An ontology was just added: refresh the list keeping the ticks, with the new one ticked. @returns {void} */
function mrgAdded(name) {
	mrgFillList([...document.querySelectorAll('.mrgf:checked')].map((x) => x.value).concat(name));
}

/** "Merge" button: POST /api/merge on the checked ontologies. @returns {void} */
function mergeRun() {
	const files = [...document.querySelectorAll('.mrgf:checked')].map((x) => x.value);
	if (files.length < 2) {
		alert('Select at least two ontologies to merge.');
		return;
	}
	$('#mrgstatus').textContent = 'merging…';
	post('/api/merge', { files, name: $('#mrgname').value || 'merged', iri: $('#mrgiri').value }).then((d) => {
		if (d.error) {
			$('#mrgstatus').textContent = '';
			alert(d.error);
			return;
		}
		$('#mrgstatus').textContent = `created ${d.file} (${d.triples} triples)`;
		alert(
			`Created ${d.file} (${d.iri}, ${d.triples} triples).\nUpdate the index to browse it (bar at the top or Tools menu).`
		);
		ixRefresh();
	});
}

// ---------- Plugins (Tools → Plugins…) ----------
/**
 * Open the plugin manager dialog: the installed zip plugins (uninstallable), the built-in view
 * plugins = every main tab except Help (enable / disable, persisted like the Window menu),
 * install from zip and the in-app how-to.
 * @returns {void}
 */
function openPlugins() {
	api('/api/plugins', {}).then((d) => openPluginsDraw(d));
}
/** Draw the plugin dialog from the /api/plugins payload (builtin + custom packages). @returns {void} */
function openPluginsDraw(d) {
	// "help" link = the package ships a help page (plugin.json "help")
	const hl = (p) => (p.help ? ` <span class="expand" onclick="viewHelp('${esc(p.name)}')">help</span>` : '');
	// green badge = the package ships a Python backend (/api/p/<name>/…); red = its import failed
	const bk = (p) => (p.backend ? (p.backend_error ? ` <span class="badge" style="background:#b3261e" title="${esc(p.backend_error)}">backend error</span>` : ' <span class="badge" style="background:#2e7d32" title="Python backend: /api/p/' + esc(p.name) + '/">backend</span>') : '');
	const builtins = (d.builtin || [])
		.slice()
		.sort((a, b) => (a.title || a.name).localeCompare(b.title || b.name))
		.map((p) => {
			const tab = document.querySelector(`#maintabs [data-mt="${p.name}"]`);
			const on = tab && tab.style.display !== 'none';
			return `<div class="prow"><div class="val"><b>${esc(p.title || p.name)}</b> <span class="badge" style="background:#6c757d">built-in</span>${bk(p)}${on ? '' : ' <span class="badge" style="background:#9a6b12">disabled</span>'}
<div class="dt">${esc(p.description || '')}</div>
<div class="dt">plugins/builtin/${esc(p.name)}/ · ${esc((p.js_min || p.js).join(', '))}${hl(p)}</div></div>
<span class="acts" style="opacity:1">${
				tab
					? `<button class="ibtn" style="margin:0" onclick="mbTabToggle('${esc(p.name)}');openPlugins()"
	title="${on ? 'Hide this view (its tab disappears; re-enable it here or from the Window menu)' : 'Show this view again in the tab bar'}">${on ? 'Disable' : 'Enable'}</button> `
					: ''
			}<button class="ibtn danger" style="margin:0" onclick="pluginRemove('${esc(p.name)}', true)"
	title="Delete plugins/builtin/${esc(p.name)}/ entirely: the view disappears at the next reload. Restore it by downloading the folder again from the GitHub repository">${ic('delete')} Uninstall</button></span></div>`;
		})
		.join('');
	openDialog(
		`<h3 style="margin-top:0">Plugins</h3>
  <div class="dt" style="margin:4px 0 10px">Front-end plugins installed under <code>viewer/data/plugins/</code>: their JS / CSS load after the core
at every start and can add views with <code>registerView()</code>. Package format: a zip with <code>plugin.json</code> (name, version, description, js, css, optional <code>backend</code> = a Python module serving <code>/api/p/&lt;name&gt;/…</code>) — see PLUGINS.md in the repository.</div>
  <div class="ptitle" style="margin-top:0">Installed plugins</div>
  <div id="pluglist" style="max-height:30vh;overflow:auto"><span class="dt">loading…</span></div>
  <div style="margin-top:10px"><label class="ibtn" style="margin:0;cursor:pointer;display:inline-flex;align-items:center;gap:6px"
       title="Upload a plugin package: a zip carrying plugin.json and the files it lists">${ic('upload')} Install plugin (.zip)…
    <input type="file" accept=".zip" style="display:none" onchange="pluginInstall(this)"></label></div>
  <div class="ptitle">Built-in view plugins (the main tabs)</div>
  <div class="dt" style="margin-bottom:4px">Self-contained packages in <code>viewer/plugins/builtin/</code>: Disable hides the tab (persisted, same state as the Window menu);
Uninstall deletes the package folder — restore it by downloading it again from the repository.</div>
  <div style="max-height:30vh;overflow:auto">${builtins}</div>
  <details style="margin-top:16px"><summary class="dt" style="cursor:pointer" title="The package format and the minimal working example">How to build a plugin (package structure and minimal example)</summary>
    <div style="display:flex;gap:24px;flex-wrap:wrap;margin-top:8px">
      <div><div class="ptitle" style="margin-top:0">Zip structure</div>
<pre style="background:var(--bg);padding:10px;border-radius:6px;font-size:11.5px">my-plugin.zip
├── plugin.json     required manifest
├── my_views.js     the scripts listed in "js"
├── my.css          optional stylesheets ("css")
├── backend.py      optional Python backend ("backend")
├── help.html       optional help page ("help")
├── tests.json      optional smoke tests
└── logo.png        other assets, served at
                    /plugins/&lt;name&gt;/logo.png</pre>
        <div class="ptitle">plugin.json</div>
<pre style="background:var(--bg);padding:10px;border-radius:6px;font-size:11.5px">{
  "name": "my-plugin",
  "version": "1.0",
  "description": "One line for this list",
  "js": ["my_views.js"],
  "css": [],
  "backend": "backend.py",
  "help": "help.html"
}</pre></div>
      <div style="max-width:520px"><div class="ptitle" style="margin-top:0">Minimal my_views.js: one new view</div>
<pre style="background:var(--bg);padding:10px;border-radius:6px;font-size:11.5px">registerView({
  id: 'stats',                  // tab #tab-stats
  title: 'Statistics',          // tab label
  tooltip: 'What the tab shows',
  render: () => {               // called on every click
    const el = $('#tab-stats');
    if (el.dataset.ready) return;   // build once
    el.dataset.ready = '1';
    el.innerHTML = '&lt;div class="card"&gt;…&lt;/div&gt;';
  },
});</pre>
        <div class="dt" style="margin-top:6px">The scripts load after the core at every start, so every global helper is available
(<code>$</code>, <code>api</code>/<code>post</code>, <code>esc</code>, <code>ic</code>, <code>entLink</code>, <code>openForm</code>, <code>downloadText</code>, …).
A view registered this way becomes a main tab and joins the Window menu, the drag-to-reorder and the <code>#tab=</code> deep links.
Reinstalling the same name replaces the plugin (upgrade).
<b>backend.py</b> (optional) defines <code>GET_ROUTES</code> / <code>POST_ROUTES</code> dicts served at <code>/api/p/&lt;name&gt;/&lt;route&gt;</code> — call them with <code>papi()</code> / <code>ppost()</code>; an import error shows here as a red badge.
<b>help.html</b> (optional) becomes the view's help page: the round <b>?</b> of the tab bar, Help menu and the "help" link of this list.
<b>tests.json</b> (optional) holds read-only smoke shots run by <code>python3 -m ontoviewer.plugintests</code>.
Full guide: <a class="ent" onclick="window.open('https://github.com/giuseppefilippone/ontology_viewer_tool/blob/main/PLUGINS.md')">PLUGINS.md</a>.</div></div>
    </div></details>` + DLG_CLOSE,
		true
	);
	api('/api/plugins', {}).then((d) => {
		$('#pluglist').innerHTML =
			(d.plugins || [])
				.map(
					(
						p
					) => `<div class="prow"><div class="val"><b>${esc(p.name)}</b>${p.version ? ` <span class="badge" style="background:#3457b0">v${esc(p.version)}</span>` : ''}${bk(p)}
<div class="dt">${esc(p.description || 'no description')}</div>
<div class="dt">files: ${[...p.js, ...(p.css || [])].map(esc).join(', ') || 'none'} · served at <code>/plugins/${esc(p.name)}/</code>${hl(p)}</div></div>
<span class="acts" style="opacity:1"><button class="ibtn danger" style="margin:0" onclick="pluginRemove('${esc(p.name)}')"
	title="Delete this plugin's directory under viewer/data/plugins/ and reload the page">${ic('delete')} Uninstall</button></span></div>`
				)
				.join('') ||
			'<div class="dt">no plugins installed — install one below, or write your own (see the how-to underneath)</div>';
	});
}
/** "Install plugin (.zip)" control: multipart POST /api/plugins/install, then reload to activate. @returns {void} */
function pluginInstall(inp) {
	const f = inp.files[0];
	if (!f) return;
	const fd = new FormData();
	fd.append('file', f);
	fetch('/api/plugins/install', { method: 'POST', body: fd })
		.then((r) => r.json())
		.then((r) => {
			if (r.error) {
				alert('Install: ' + r.error);
				return;
			}
			alert(`Installed ${r.installed}${r.version ? ' v' + r.version : ''}. The page reloads to activate it.`);
			location.reload();
		});
}
/** "Uninstall" button: after confirmation delete the plugin and refresh the dialog (it stays
 * open, so more plugins can be removed; the already-loaded view disappears at the next reload). */
function pluginRemove(name) {
	if (
		!confirm(
			`Uninstall the plugin "${name}"? Its files under viewer/data/plugins/ are deleted (its view disappears at the next page reload).`
		)
	)
		return;
	post('/api/plugins/remove', { name }).then((r) => {
		if (r.error) alert(r.error);
		openPlugins();
	});
}
