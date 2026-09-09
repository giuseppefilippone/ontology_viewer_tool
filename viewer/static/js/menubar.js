// menubar.js — Protégé-like menu bar in the header: File / View / Reasoner / Window / Help.
//
// The single home of the global actions (no duplicated header buttons): each label opens a dropdown panel
// (#mbpanel, styled by .dmenu). The panels are rebuilt on every open, so entry states (disabled Save, hidden
// tabs, inferred view available) are always current. The Reasoner panel reuses rmenuBody() from inference.js;
// the other menus map Protégé's onto existing viewer actions:
//   File   → Open… / Save / Discard / Remove from index / Stop server   (Protégé: File)
//   Edit   → new entity of each kind, through the Entities sidebar      (Protégé: Edit / entity toolbar)
//   View   → theme, asserted vs inferred hierarchy, reload              (Protégé: View, Window→Views…(inferred))
//   Tools  → rebuild the search index, clear the reasoner memory        (Protégé: Tools)
//   Window → show / hide the main tabs, hidden set saved in ui_config   (Protégé: Window→Tabs)
//   Help   → Help tab, GitHub page                                     (Protégé: Help)
// Globals used: $, ic, post, CHN, newEntity (entities.js), infActive, infViewOn, viewChanged, ixRefresh
// (core.js / inference.js), clearReasonerWork (reasoner.js).

/** Close the menu-bar panel and release the highlighted label. @returns {void} */
function menusClose() {
	MBSUB = null;
	const p = $('#mbpanel');
	if (p) p.hidden = true;
	const p2 = $('#mbpanel2');
	if (p2) p2.hidden = true;
	document.querySelectorAll('#menubar .mb.on').forEach((b) => b.classList.remove('on'));
}

/**
 * One panel entry: {l:label, i:icon, js:onclick, off:disabled, chk:checked, stay:keep the panel open,
 * h:section header} or null = separator.
 * @returns {string}
 */
const mbItem = (e) =>
	e === null
		? '<div class="rms"></div>'
		: e.h
			? `<div class="rmh">${e.l}</div>`
			: `<div class="rmi ${e.off ? 'off' : ''}" onclick="${e.off ? '' : e.stay ? e.js : `menusClose();${e.js}`}">${e.i ? ic(e.i) : ''}${e.chk ? '<b>✓</b> ' : ''}${e.l}${e.arrow ? '<span style="margin-left:auto;opacity:.6">▸</span>' : ''}</div>`;

/** Menu definitions: functions so every open reflects the current state. */
const MB = {
	file: () => [
		{ l: 'Open ontology…', i: 'folder', js: 'openWorkspace()' },
		{ l: 'Open from URL…', i: 'download', js: 'mbOpenUrl()' },
		{ l: 'Open recent', js: 'mbRecent(this)', stay: true, arrow: true },
		{ l: 'New ontology module…', i: 'add', js: 'mbNewModule()' },
		null,
		{ l: 'Save changes', i: 'save', js: 'saveChanges()', off: !CHN },
		{ l: 'Discard changes', i: 'delete', js: 'discardChanges()', off: !CHN },
		{ l: 'Loaded ontology sources…', js: 'mbSources()' },
		null,
		{ l: 'Serialize ontology (Turtle, RDF/XML, …)…', i: 'download', js: 'openRendering()' },
		{ l: 'Export inferred axioms as ontology', i: 'download', js: 'mbExportInferred()', off: !infActive() },
		null,
		{ l: 'Remove active ontology from index', i: 'close', js: 'removeFromIndex()' },
		null,
		{ l: 'Stop the viewer server', js: 'stopServer()' },
	],
	edit: () => [
		{ l: 'Undo last change', i: 'prev', js: 'mbUndo()', off: !CHN },
		{ l: 'Redo', i: 'next', js: 'mbRedo()' },
		null,
		{ l: 'Find… (⌘K)', js: "$('#gs').focus()" },
		null,
		{ l: 'New class…', i: 'add', js: "mbNew('tree')" },
		{ l: 'New individual…', i: 'add', js: "mbNew('individual')" },
		{ l: 'New object property…', i: 'add', js: "mbNew('objprop')" },
		{ l: 'New data property…', i: 'add', js: "mbNew('dataprop')" },
		{ l: 'New annotation property…', i: 'add', js: "mbNew('annprop')" },
		{ l: 'New datatype…', i: 'add', js: "mbNew('datatype')" },
		null,
		{ l: 'Create child of selected class/property…', i: 'add', js: 'mbNewChild()', off: !selIri },
		{ l: 'Create sibling of selected class/property…', i: 'add', js: 'mbNewSibling()', off: !selIri },
		null,
		{ l: 'Duplicate selected entity…', i: 'add', js: 'mbDuplicate()', off: !selIri },
		{ l: 'Deprecate selected entity', js: 'mbDeprecate()', off: !selIri },
		{ l: 'Delete selected entity', i: 'delete', js: 'deleteEntity(selIri)', off: !selIri },
	],
	refactor: () => [
		{ l: 'Convert selected class to defined (⊑ → ≡)', js: "mbConvertClass('defined')", off: !selIri },
		{ l: 'Convert selected class to primitive (≡ → ⊑)', js: "mbConvertClass('primitive')", off: !selIri },
		null,
		{ l: 'Rename entity IRI… (selected entity)', i: 'edit', js: 'mbRename()', off: !selIri },
		{ l: 'Rename namespace… (all entities)', i: 'edit', js: 'mbRenameNs()' },
		{ l: 'Change ontology IRI… (active ontology)', i: 'edit', js: 'mbChangeOntoIri()' },
		null,
		{ l: 'Merge ontologies…', js: 'openMerge()' },
	],
	tools: () => [
		{ l: 'Rebuild the search index', i: 'refresh', js: 'mbReindex()' },
		{ l: 'Indexes on disk…', js: 'mbIndexes()' },
		{ l: 'Clear reasoner memory', i: 'delete', js: 'clearReasonerWork()' },
		null,
		{ l: 'Compare ontologies…', js: 'openCompare()' },
		{ l: 'Check for inconsistencies (HermiT)', js: 'mbCheckInconsistent()' },
		{ l: 'Check for empty entities…', js: 'mbCheckEmpty()' },
		null,
		{ l: 'Show server log', js: 'mbServerLog()' },
		null,
		{ l: 'Plugins…', i: 'add', js: 'openPlugins()' },
	],
	view: () => [
		{ l: 'Back (previous entity)', i: 'prev', js: 'histGo(-1)', off: !HIST.back.length },
		{ l: 'Forward', i: 'next', js: 'histGo(1)', off: !HIST.fwd.length },
		null,
		{ l: 'Switch light / dark theme', i: 'dark', js: 'toggleTheme()' },
		null,
		{ l: 'Render by entity local name', js: "mbRender('name')", chk: RENDER_MODE === 'name' },
		{ l: 'Render by prefixed name', js: "mbRender('prefix')", chk: RENDER_MODE === 'prefix' },
		{ l: 'Render by label (rdfs:label)', js: "mbRender('label')", chk: RENDER_MODE === 'label' },
		null,
		{ l: 'Asserted class hierarchy', js: "mbHier('asserted')", chk: !infViewOn() },
		{ l: 'Inferred class hierarchy', js: "mbHier('inferred')", off: !infActive(), chk: infViewOn() },
		null,
		{ l: 'Refresh user interface', i: 'refresh', js: 'location.reload()' },
	],
	window: () => [
		{ l: 'Tabs', js: "mbWinSub('tabs', this)", stay: true, arrow: true },
		{ l: 'Entities sidebar views', js: "mbWinSub('views', this)", stay: true, arrow: true },
		null,
		{ l: 'Reset layout to default', i: 'refresh', js: 'mbResetLayout()' },
	],
	help: () => [
		{ l: 'Help tab: notations and keywords', js: "document.querySelector('#maintabs [data-mt=help]')?.click()" },
		{ l: 'Project page on GitHub', js: "window.open('https://github.com/giuseppefilippone/ontology_viewer_tool')" },
		null,
		{ l: 'About Ontology Viewer', js: 'mbAbout()' },
	],
};

/** Drawer of the open second-level panel (Window submenus): mbRefresh redraws it instead of the menu. */
let MBSUB = null;

/** Build the panel of one menu-bar label and place it under the label. @returns {void} */
function mbDraw(btn) {
	MBSUB = null;
	$('#mbpanel2').hidden = true;
	const p = $('#mbpanel');
	p.innerHTML = btn.dataset.menu === 'reasoner' ? rmenuBody() : MB[btn.dataset.menu]().map(mbItem).join('');
	p.style.left = btn.offsetLeft + 'px';
}

/** Click on a menu-bar label: draw its panel and toggle it. @returns {void} */
function mbToggle(btn) {
	const p = $('#mbpanel');
	const was = !p.hidden && btn.classList.contains('on');
	menusClose();
	if (was) return;
	mbDraw(btn);
	p.hidden = false;
	btn.classList.add('on');
}

/** Redraw the open panel in place (after a stay-open entry changed some state). @returns {void} */
function mbRefresh() {
	if (MBSUB) {
		MBSUB();
		return;
	}
	const b = document.querySelector('#menubar .mb.on');
	if (b) mbDraw(b);
}

/** Open the second-level panel BESIDE the menu (Protégé-style flyout), aligned to its entry. @returns {void} */
function mbFlyout(html, anchor) {
	const p = $('#mbpanel'),
		p2 = $('#mbpanel2');
	p2.innerHTML = html;
	p2.style.left = p.offsetLeft + p.offsetWidth + 2 + 'px';
	p2.style.top = p.offsetTop + (anchor ? anchor.offsetTop : 0) + 'px';
	p2.hidden = false;
}

/** Window submenu 'tabs' | 'views': the show / hide list in a flyout beside the menu. @returns {void} */
function mbWinSub(kind, anchor) {
	MBSUB = () => {
		const tabs = kind === 'tabs';
		const items = [...document.querySelectorAll(tabs ? '#maintabs [data-mt]' : '#tabs [data-tab]')].map((b) => ({
			l: b.textContent,
			js: tabs ? `mbTabToggle('${b.dataset.mt}')` : `mbEntityTabToggle('${b.dataset.tab}')`,
			chk: b.style.display !== 'none',
			stay: true,
		}));
		mbFlyout(
			mbItem({ l: (tabs ? 'Tabs' : 'Entities sidebar views') + ': click to show / hide', h: true }) +
				items.map(mbItem).join(''),
			anchor
		);
	};
	MBSUB();
}

/**
 * Window menu: show / hide one main tab. The last visible tab cannot be hidden; hiding the active one
 * switches to the first visible. The hidden set is persisted in ui_config.json (key hidden_tabs).
 * @param {string} mt data-mt value of the tab.
 * @returns {void}
 */
function mbTabToggle(mt) {
	const all = [...document.querySelectorAll('#maintabs [data-mt]')];
	const b = all.find((x) => x.dataset.mt === mt);
	const visible = all.filter((x) => x.style.display !== 'none');
	if (b.style.display !== 'none' && visible.length === 1) return;
	b.style.display = b.style.display === 'none' ? '' : 'none';
	if (b.style.display === 'none' && b.classList.contains('on')) visible.find((x) => x !== b).click();
	post('/api/ui_config', { hidden_tabs: all.filter((x) => x.style.display === 'none').map((x) => x.dataset.mt) });
	mbRefresh();
}

/** Edit menu: open the Entities tab on the right sidebar kind and start the new-entity form. */
function mbNew(t) {
	document.querySelector('#maintabs [data-mt=entities]')?.click();
	document.querySelector(`#tabs [data-tab=${t}]`).click();
	newEntity();
}

/** Tools menu: rebuild the SQLite index on demand (the header button appears only when it is stale). */
function mbReindex() {
	if (!confirm('Rebuild the search index of the workspace? This takes a few minutes; the page reloads when done.')) return;
	fetch('/api/reindex', { method: 'POST' }).then(ixRefresh);
}

/**
 * Window menu: show / hide one Entities sidebar view (kind tab). The last visible one cannot be
 * hidden; hiding the active one switches to the first visible. Persisted in ui_config
 * (key hidden_entity_tabs) like the main tabs.
 * @param {string} t data-tab value ('tree', 'individual', …).
 * @returns {void}
 */
function mbEntityTabToggle(t) {
	const all = [...document.querySelectorAll('#tabs [data-tab]')];
	const b = all.find((x) => x.dataset.tab === t);
	const visible = all.filter((x) => x.style.display !== 'none');
	if (b.style.display !== 'none' && visible.length === 1) return;
	b.style.display = b.style.display === 'none' ? '' : 'none';
	if (b.style.display === 'none' && b.classList.contains('on')) visible.find((x) => x !== b).click();
	post('/api/ui_config', { hidden_entity_tabs: all.filter((x) => x.style.display === 'none').map((x) => x.dataset.tab) });
	mbRefresh();
}

/** View menu: show the Entities class tree in asserted or inferred mode (Protégé's Class hierarchy (inferred)). */
function mbHier(v) {
	document.querySelector('#maintabs [data-mt=entities]')?.click();
	document.querySelector('#tabs [data-tab=tree]')?.click();
	const s = $('#viewsel');
	if (s && s.value !== v) {
		s.value = v;
		viewChanged();
	}
}

// ---------- File helpers ----------
/** File → Open recent: replace the panel with the recent workspaces (GET /api/workspace). */
function mbRecent(anchor) {
	api('/api/workspace', {}).then((w) => {
		const rows = (w.recent || []).map((r) => {
			const names = r.files.map((f) => f.replace(/\.owl$/, '')).join(', ');
			return `<div class="rmi" onclick="menusClose();mbOpenRecent('${esc(r.dir)}/${esc(r.files[r.files.length - 1])}')"
	title="${esc(r.dir)}: ${esc(r.files.join(', '))}"><span style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(
		r.dir.split('/').pop()
	)}: ${esc(names)}</span> <span class="dt">(${r.files.length})</span></div>`;
		});
		mbFlyout('<div class="rmh">Open recent</div>' + (rows.join('') || '<div class="rmh">none</div>'), anchor);
	});
}
/** Open one recent workspace by its entry file path and reload. */
function mbOpenRecent(path) {
	post('/api/workspace/open', { path }).then((r) => {
		if (r.error) alert(r.error);
		else setTimeout(() => location.reload(), 300);
	});
}
/** File → New ontology module: name (+ optional IRI) form, then POST /api/module/new. */
function mbNewModule() {
	openForm(
		'New ontology module',
		[
			{ name: 'name', label: 'File name (.owl)' },
			{ name: 'iri', label: 'Ontology IRI (optional)' },
		],
		(v) =>
			post('/api/module/new', v).then((r) => {
				if (r.error) return r;
				alert(`Created ${r.file} (${r.iri}).\nUpdate the index to browse it (bar at the top or Tools menu).`);
				ixRefresh();
				return r;
			}),
		'The module is created empty in the workspace directory and indexed at the next index update.'
	);
}
/** File → Export inferred axioms: stage the .owl on the server, then download it. */
function mbExportInferred() {
	post('/api/inference/export', {}).then((r) => {
		if (r.error) alert(r.error);
		else location.href = '/api/export_file?name=' + encodeURIComponent(r.name);
	});
}

// ---------- Edit helpers ----------

/** File → Loaded ontology sources…: the module files of the workspace + the catalog mappings. */
function mbSources() {
	api('/api/sources', {}).then((d) => {
		const rows = (d.sources || [])
			.map(
				(s) => `<div class="prow"><div class="val"><b>${esc(s.file)}</b>${s.exists ? '' : ' <span class="badge" style="background:#b3261e">missing</span>'}
<div class="dt">${esc(s.path)}</div>
<div class="dt">${s.exists ? `${fmtBytes(s.size)} · ${esc(s.mtime)} · ` : ''}${s.statements.toLocaleString('en')} indexed statements</div></div></div>`
			)
			.join('');
		const cat = (d.catalog || [])
			.map((c) => `<div style="padding:1px 0;font-size:11.5px;font-family:var(--mono);word-break:break-all">${esc(c.iri)} → ${esc(c.uri)}</div>`)
			.join('');
		openDialog(
			`<h3 style="margin-top:0">Loaded ontology sources</h3>
<div class="dt" style="margin-bottom:6px">Workspace directory: <code>${esc(d.dir)}</code>. A module newer than the index shows the
"ontologies changed" chip in the header: update the index from there or from the Tools menu.</div>
<div style="max-height:40vh;overflow:auto">${rows || '<span class="dt">no modules</span>'}</div>
<div class="ptitle">catalog-v001.xml mappings</div>
<div style="max-height:20vh;overflow:auto">${cat || '<span class="dt">no catalog file in the workspace directory</span>'}</div>` + DLG_CLOSE,
			true
		);
	});
}

/** File → Open from URL…: the server downloads the ontology into uploads/ and opens it. */
function mbOpenUrl() {
	const url = prompt('URL of the ontology to open (http/https; imports are resolved among the downloaded file only)');
	if (!url) return;
	post('/api/workspace/open', { url }).then((r) => {
		if (r.error) {
			alert(r.error);
			return;
		}
		alert(
			'Workspace: ' +
				r.workspace.dir +
				'\nFiles: ' +
				r.workspace.files.join(', ') +
				(r.reindex_started ? '\n\nIndex being built: watch the bar at the top.' : '')
		);
		setTimeout(() => location.reload(), 300);
	});
}
/** Edit → Redo: re-apply the change most recently undone (adds / removes only). */
function mbRedo() {
	post('/api/edit/redo', {}).then((r) => {
		if (r.error) {
			alert(r.error);
			return;
		}
		if (!r.redone) {
			alert('Nothing to redo (the redo stack empties when a new edit is made).');
			return;
		}
		refreshChanges();
		if (selIri) show(encodeURIComponent(selIri));
		loadList();
	});
}
/** Edit → Undo last change: revert the newest journal entry (grouped edits as a whole). */
function mbUndo() {
	post('/api/edit/undo', {}).then((r) => {
		if (r.error) {
			alert(r.error);
			return;
		}
		refreshChanges();
		if (selIri) show(encodeURIComponent(selIri));
		loadList();
	});
}
/** Edit → Rename entity IRI: prompt on the selected entity, then /api/edit/rename. */
function mbRename() {
	if (!selIri) return;
	const v = prompt('New IRI for the selected entity', selIri);
	if (!v || v === selIri) return;
	post('/api/edit/rename', { iri: selIri, new_iri: v }).then((r) => {
		if (r.error) {
			alert(r.error);
			return;
		}
		selIri = v;
		refreshChanges();
		show(encodeURIComponent(v));
		loadList();
	});
}

// ---------- View / Tools / Window / Help helpers ----------
/** View → rendering mode (local name / prefixed name / label): persist and repaint. */
function mbRender(mode) {
	RENDER_MODE = mode;
	post('/api/ui_config', { render_mode: mode });
	loadList();
	if (selIri) show(encodeURIComponent(selIri));
}
/** Tools → Show server log: tail of viewer.log in the modal. */
function mbServerLog() {
	api('/api/server_log', {}).then((d) => {
		$('#modalbox').innerHTML = `<h3 style="margin-top:0">Server log</h3>
<div class="dt">${esc(d.file)}${d.exists ? '' : ' — not found (server started without start_viewer.sh)'}</div>
<pre style="max-height:60vh;overflow:auto;background:var(--bg);padding:10px;border-radius:6px;font-size:11px">${esc(d.log || 'empty')}</pre>
<div style="text-align:right"><button class="ibtn" onclick="closeForm()">Close</button></div>`;
		$('#modal').style.display = 'flex';
	});
}

/** Entity navigation history (Protégé: Navigation → history). show() records via histVisit. */
const HIST = { back: [], fwd: [], cur: null, nav: false };
/** Record a visited entity (called by show, entities.js); programmatic Back/Forward skips it. */
function histVisit(iri) {
	if (HIST.nav || iri === HIST.cur) return;
	if (HIST.cur) HIST.back.push(HIST.cur);
	HIST.fwd = [];
	HIST.cur = iri;
}
/** View → Back / Forward: move along the visit history (dir −1 = back, +1 = forward). */
function histGo(dir) {
	const from = dir < 0 ? HIST.back : HIST.fwd,
		to = dir < 0 ? HIST.fwd : HIST.back;
	if (!from.length) return;
	if (HIST.cur) to.push(HIST.cur);
	HIST.cur = from.pop();
	HIST.nav = true;
	openEntity(HIST.cur);
	HIST.nav = false;
}
// Alt+←/→ navigate the entity history like a browser
document.addEventListener('keydown', (e) => {
	if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
		e.preventDefault();
		histGo(e.key === 'ArrowLeft' ? -1 : 1);
	}
});

/** Kind-aware sub-axiom predicate of the selected entity (subClassOf / subPropertyOf). */
function _subPredOf(kind) {
	if (kind === 'class') return 'http://www.w3.org/2000/01/rdf-schema#subClassOf';
	if (['objprop', 'dataprop', 'annprop'].includes(kind)) return 'http://www.w3.org/2000/01/rdf-schema#subPropertyOf';
	return null;
}
/** Shared form of Create child / sibling: create the entity, then assert it under `parent`. */
function _newUnder(kind, parent, title) {
	const ns = selIri.slice(0, Math.max(selIri.lastIndexOf('#'), selIri.lastIndexOf('/')) + 1);
	openForm(
		title,
		[
			{ name: 'name', label: 'Local name (or full IRI)', required: true },
			{ name: 'ns', label: 'Namespace (used if the name is not an IRI)', value: ns },
			{ name: 'label', label: 'rdfs:label (optional)' },
			{ name: 'graph', label: 'Target module', type: 'module', value: activeFile() || modules[0] },
		],
		(v) =>
			post('/api/edit/create', { kind, iri: entityIri(v.name, v.ns), label: v.label || null, graph: v.graph }).then((r) => {
				if (r.error) return r;
				return post('/api/edit/add', { s: r.created, p: _subPredOf(kind), o: parent, graph: v.graph }).then((r2) => {
					if (!r2.error) {
						refreshChanges();
						openEntity(r.created);
					}
					return r2;
				});
			}),
		`The new entity is created and asserted under ${short(parent)} as a pending change.`
	);
}
/** Edit → Create child: a new class/property directly under the selected one. */
function mbNewChild() {
	if (!selIri || !curEntity) return;
	const kind = curEntity.d.node.kind;
	if (!_subPredOf(kind)) {
		alert('Select a class or a property first (children only exist in hierarchies).');
		return;
	}
	_newUnder(kind, selIri, `New child of ${short(selIri)}`);
}
/** Edit → Create sibling: a new class/property under the first parent of the selected one. */
function mbNewSibling() {
	if (!selIri || !curEntity) return;
	const kind = curEntity.d.node.kind;
	const pred = _subPredOf(kind);
	if (!pred) {
		alert('Select a class or a property first (siblings only exist in hierarchies).');
		return;
	}
	const grp = (curEntity.d.out || []).find((g) => g.piri === pred);
	const parent = grp && (grp.values.find((x) => x.iri) || {}).iri;
	if (!parent) {
		alert(`${short(selIri)} has no asserted parent: creating a child of owl root instead makes no sense — use New entity.`);
		return;
	}
	_newUnder(kind, parent, `New sibling of ${short(selIri)} (under ${short(parent)})`);
}
/** Refactor → Convert to defined / primitive: swap ⊑ ↔ ≡ on the selected class (indexed fillers). */
function mbConvertClass(to) {
	if (!selIri) return;
	post('/api/edit/convert_class', { iri: selIri, to }).then((r) => {
		if (r.error) {
			alert(r.error);
			return;
		}
		refreshChanges();
		show(encodeURIComponent(selIri));
		let msg = `${r.swapped} axiom(s) converted (pending change).`;
		if (r.skipped) msg += `\n${r.skipped} axiom(s) with an anonymous class expression were left untouched (not indexed): edit them from the entity page.`;
		if (!r.swapped && !r.skipped) msg = 'Nothing to convert.';
		alert(msg);
	});
}

/** Edit → Duplicate selected entity: prompt the new IRI, copy every outgoing statement. */
function mbDuplicate() {
	if (!selIri) return;
	const v = prompt('IRI of the duplicate', selIri + '_copy');
	if (!v || v === selIri) return;
	post('/api/edit/duplicate', { iri: selIri, new_iri: v }).then((r) => {
		if (r.error) {
			alert(r.error);
			return;
		}
		refreshChanges();
		openEntity(v);
	});
}
/** Edit → Deprecate selected entity: add owl:deprecated "true"^^xsd:boolean as a pending change. */
function mbDeprecate() {
	if (!selIri) return;
	post('/api/edit/add', {
		s: selIri,
		p: 'http://www.w3.org/2002/07/owl#deprecated',
		lit: 'true',
		dt: 'http://www.w3.org/2001/XMLSchema#boolean',
	}).then((r) => {
		if (r.error) {
			alert(r.error);
			return;
		}
		refreshChanges();
		show(encodeURIComponent(selIri));
	});
}
/** Refactor → Rename namespace: mass rename of an IRI prefix over all entities. */
function mbRenameNs() {
	const old_ns = prompt('Namespace to rename (IRI prefix)', 'http://www.semanticweb.org/ontologies/');
	if (!old_ns) return;
	const new_ns = prompt('New namespace', old_ns);
	if (!new_ns || new_ns === old_ns) return;
	post('/api/edit/rename_ns', { old_ns, new_ns }).then((r) => {
		if (r.error) {
			alert(r.error);
			return;
		}
		refreshChanges();
		loadList();
		alert('Namespace renamed as a pending change: Save writes it into the files.');
	});
}
/** Refactor → Change ontology IRI: rename the owl:Ontology node of the active ontology. */
function mbChangeOntoIri() {
	const cur = $('#ontsel').value;
	const v = prompt('New IRI for the active ontology', cur);
	if (!v || v === cur) return;
	post('/api/edit/rename', { iri: cur, new_iri: v }).then((r) => {
		if (r.error) {
			alert(r.error);
			return;
		}
		refreshChanges();
		alert('Ontology IRI renamed as a pending change: Save writes it into the files, then reload.');
	});
}
/** Tools → Check for inconsistencies: classify with HermiT and open the Reasoner tab (unsatisfiable classes in the Inferred view). */
function mbCheckInconsistent() {
	infStart('hermit');
	document.querySelector('#maintabs [data-mt=reasoner]')?.click();
}
/** Tools → Check for empty entities: declared but never used anywhere (GET /api/check/empty). */
function mbCheckEmpty() {
	api('/api/check/empty', {}).then((d) => {
		const rows = (d.entities || [])
			.map((e) => `<div style="padding:2px 0">${entLink({ iri: e.iri, name: short(e.iri), label: e.label, kind: e.kind })}</div>`)
			.join('');
		$('#modalbox').innerHTML = `<h3 style="margin-top:0">Empty entities</h3>
<div class="dt" style="margin-bottom:6px;max-width:480px">Entities declared in the workspace but never used: no axiom or assertion beyond the
declaration and their label / comment, not referenced by anything.${d.truncated ? ' First 500 shown.' : ''}</div>
<div style="max-height:55vh;overflow:auto">${rows || '<span class="dt">none — every declared entity is used somewhere</span>'}</div>
<div style="text-align:right;margin-top:8px"><button class="ibtn" onclick="closeForm()">Close</button></div>`;
		$('#modal').style.display = 'flex';
	});
}

/** Tools → Indexes on disk…: every data/index_*.db with its workspace, size and a Delete button. */
function mbIndexes() {
	api('/api/indexes', {}).then((d) => {
		const rows =
			(d.indexes || [])
				.map(
					(x) => `<div class="prow"><div class="val"><b>${esc(x.file)}</b>${x.current ? ' <span class="badge" style="background:#1a7f42">current</span>' : ''}
<div class="dt">${x.dir ? esc(x.dir.split('/').pop()) + ': ' + esc(x.files.map((f) => f.replace(/\.owl$/, '')).join(', ')) : 'workspace not in the recent list'}</div>
<div class="dt">${fmtBytes(x.size)} · ${esc(x.mtime)}</div></div>
<span class="acts" style="opacity:1"><button class="ibtn danger" style="margin:0" ${x.current ? 'disabled' : ''} onclick="mbIndexRemove('${esc(x.file)}')"
	title="${x.current ? 'The index of the current workspace cannot be deleted (open another one first)' : 'Delete this index file; the .owl files are untouched and reopening that workspace rebuilds it'}">${ic('delete')} Delete</button></span></div>`
				)
				.join('') || '<div class="dt">no indexes on disk</div>';
		openDialog(
			`<h3 style="margin-top:0">Indexes on disk</h3>
<div class="dt" style="margin-bottom:8px">One SQLite index per workspace ever opened (<code>viewer/data/index_&lt;hash&gt;.db</code>).
Deleting one never touches the .owl files: reopening that workspace simply rebuilds it.</div>
<div style="max-height:55vh;overflow:auto">${rows}</div>` + DLG_CLOSE
		);
	});
}
/** Delete one index file after confirmation, then refresh the dialog. @returns {void} */
function mbIndexRemove(file) {
	if (!confirm(`Delete ${file}? The .owl files are untouched; reopening that workspace rebuilds the index.`)) return;
	post('/api/indexes/remove', { file }).then((r) => {
		if (r.error) alert(r.error);
		mbIndexes();
	});
}

/** Window → Reset layout: clear the persisted order / hidden views / widths and reload. */
function mbResetLayout() {
	if (!confirm('Reset the layout (tab order, hidden views, panel widths) to the default?')) return;
	post('/api/ui_config', {
		tab_order: [],
		entity_tab_order: [],
		hidden_tabs: [],
		hidden_entity_tabs: [],
		sidebar_width: 0,
		byclass_width: 0,
	}).then(() => location.reload());
}
/** Help → About: short description, licence and repository link. */
function mbAbout() {
	$('#modalbox').innerHTML = `<h3 style="margin-top:0">Ontology Viewer</h3>
<p style="max-width:480px">Browser-based viewer and editor for OWL 2 / Fuzzy OWL 2 ontologies: SQLite-indexed browsing and search,
editing with a pending-changes journal, fuzzy (FuzzyDL) and classic (HermiT / Pellet) reasoning, DL queries, SPARQL,
graphs, rule evaluation and LaTeX / PDF exports. Extensible with plugin views (see PLUGINS.md).</p>
<p>MIT licence · <a class="ent" onclick="window.open('https://github.com/giuseppefilippone/ontology_viewer_tool')">github.com/giuseppefilippone/ontology_viewer_tool</a></p>
<div style="text-align:right"><button class="ibtn" onclick="closeForm()">Close</button></div>`;
	$('#modal').style.display = 'flex';
}

// click outside the bar closes its panel; a target no longer connected was inside a panel that
// redrew itself during the click (submenus, stay-open toggles), so it never counts as outside
document.addEventListener('click', (e) => {
	const p = $('#mbpanel');
	if (p && !p.hidden && e.target.isConnected && !e.target.closest('#menubar')) menusClose();
});
