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
	const p = $('#mbpanel');
	if (p) p.hidden = true;
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
			: `<div class="rmi ${e.off ? 'off' : ''}" onclick="${e.off ? '' : e.stay ? e.js : `menusClose();${e.js}`}">${e.i ? ic(e.i) : ''}${e.chk ? '<b>✓</b> ' : ''}${e.l}</div>`;

/** Menu definitions: functions so every open reflects the current state. */
const MB = {
	file: () => [
		{ l: 'Open ontology…', i: 'folder', js: 'openWorkspace()' },
		null,
		{ l: 'Save changes', i: 'save', js: 'saveChanges()', off: !CHN },
		{ l: 'Discard changes', i: 'delete', js: 'discardChanges()', off: !CHN },
		null,
		{ l: 'Remove active ontology from index', i: 'close', js: 'removeFromIndex()' },
		null,
		{ l: 'Stop the viewer server', js: 'stopServer()' },
	],
	edit: () => [
		{ l: 'New class…', i: 'add', js: "mbNew('tree')" },
		{ l: 'New individual…', i: 'add', js: "mbNew('individual')" },
		{ l: 'New object property…', i: 'add', js: "mbNew('objprop')" },
		{ l: 'New data property…', i: 'add', js: "mbNew('dataprop')" },
		{ l: 'New annotation property…', i: 'add', js: "mbNew('annprop')" },
		{ l: 'New datatype…', i: 'add', js: "mbNew('datatype')" },
	],
	tools: () => [
		{ l: 'Rebuild the search index', i: 'refresh', js: 'mbReindex()' },
		{ l: 'Clear reasoner memory', i: 'delete', js: 'clearReasonerWork()' },
	],
	view: () => [
		{ l: 'Switch light / dark theme', i: 'dark', js: 'toggleTheme()' },
		null,
		{ l: 'Asserted class hierarchy', js: "mbHier('asserted')", chk: !infViewOn() },
		{ l: 'Inferred class hierarchy', js: "mbHier('inferred')", off: !infActive(), chk: infViewOn() },
		null,
		{ l: 'Refresh user interface', i: 'refresh', js: 'location.reload()' },
	],
	window: () => [
		{ l: 'Views: click to show / hide', h: true },
		...[...document.querySelectorAll('#maintabs [data-mt]')].map((b) => ({
			l: b.textContent,
			js: `mbTabToggle('${b.dataset.mt}')`,
			chk: b.style.display !== 'none',
			stay: true,
		})),
	],
	help: () => [
		{ l: 'Help tab: notations and keywords', js: "document.querySelector('#maintabs [data-mt=help]').click()" },
		{ l: 'Project page on GitHub', js: "window.open('https://github.com/giuseppefilippone/ontology_viewer_tool')" },
	],
};

/** Build the panel of one menu-bar label and place it under the label. @returns {void} */
function mbDraw(btn) {
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
	const b = document.querySelector('#menubar .mb.on');
	if (b) mbDraw(b);
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
	document.querySelector('#maintabs [data-mt=entities]').click();
	document.querySelector(`#tabs [data-tab=${t}]`).click();
	newEntity();
}

/** Tools menu: rebuild the SQLite index on demand (the header button appears only when it is stale). */
function mbReindex() {
	if (!confirm('Rebuild the search index of the workspace? This takes a few minutes; the page reloads when done.')) return;
	fetch('/api/reindex', { method: 'POST' }).then(ixRefresh);
}

/** View menu: show the Entities class tree in asserted or inferred mode (Protégé's Class hierarchy (inferred)). */
function mbHier(v) {
	document.querySelector('#maintabs [data-mt=entities]').click();
	document.querySelector('#tabs [data-tab=tree]').click();
	const s = $('#viewsel');
	if (s && s.value !== v) {
		s.value = v;
		viewChanged();
	}
}

// click outside the bar closes its panel
document.addEventListener('click', (e) => {
	const p = $('#mbpanel');
	if (p && !p.hidden && !e.target.closest('#menubar')) menusClose();
});
