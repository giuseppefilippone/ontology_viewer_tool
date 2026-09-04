// main.js — Start-up: initial data loads, UI configuration, deep links (#tab=, #iri=) and the global error hook. Loaded last.
/*
 * Overview
 * --------
 * Last script loaded by index.html: it only contains top-level start-up statements, no function
 * definitions. Everything it calls lives in the previous files: loadOverview, ixRefresh, listKind,
 * applyTabOrder, makeSortable, fitSidebar, countAnn, $, esc, api (core.js); show, entTabReveal (entities.js);
 * ontoData, drawOntology (axioms.js); attachAutocomplete (query.js); infPoll (inference.js).
 * DOM ids touched: #ls (autocomplete), #sidebar (saved width), #maintabs / #tabs (saved order,
 * drag & drop), #detail (error hook only).
 */

// theme: ?theme=dark|light overrides for one page load (tests), else the stored choice / system preference
{
	const forced = new URLSearchParams(location.search).get('theme');
	let stored = '';
	try {
		stored = localStorage.getItem('theme') || '';
	} catch (e) {
		/* storage disabled */
	}
	if (forced)
		document.documentElement.dataset.theme = forced; // one page load only, not persisted
	else setTheme(stored);
	const b = $('#themebtn');
	if (b) b.innerHTML = ic(currentTheme() === 'dark' ? 'light' : 'dark');
}
loadOverview(); // header statistics + module list (GET /api/overview)
ixRefresh(); // start polling the index status (GET /api/index_status)
infPoll(); // inferred view: header chip, sidebar view select, resume polling a running classification (inference.js)
loadList(); // initial fill of the sidebar (class tree), once every file is loaded (the tree reads the inferred-view state)
// the sidebar filter box autocompletes on the entities of the current sub-tab (whole value = one name)
attachAutocomplete($('#ls'), {
	single: true,
	keywords: false,
	kinds: () => [listKind()],
	onPick: (it) => it.iri && show(encodeURIComponent(it.iri)) // a picked suggestion opens the entity
});
/**
 * Apply the persisted UI configuration (GET /api/ui_config → {count_annotations, sidebar_width, tab_order,
 * entity_tab_order}): metrics flag (countAnn, redraw if the ontology panel is already loaded), sidebar width,
 * order of the main tabs and of the sidebar sub-tabs; then enable drag-to-reorder and fit the sidebar min-width.
 */
api('/api/ui_config', {}).then((cfg) => {
	uiConfig = cfg; // kept for panels rendered later (e.g. the Individuals-by-class column width)
	countAnn = cfg.count_annotations !== false;
	if (ontoData) drawOntology();
	if (cfg.sidebar_width) $('#sidebar').style.width = cfg.sidebar_width + 'px';
	applyTabOrder($('#maintabs'), cfg.tab_order, 'mt');
	applyTabOrder($('#tabs'), cfg.entity_tab_order, 'tab');
	makeSortable($('#maintabs'), 'tab_order');
	makeSortable($('#tabs'), 'entity_tab_order');
	fitSidebar();
});
// deep link: #iri=<encoded IRI> opens the entity directly (also used for headless tests)
// deep link: #tab=<data-mt id> clicks the main tab after a short delay (lets the initial loads settle)
if (location.hash.startsWith('#tab=')) {
	const h = new URLSearchParams(location.hash.slice(1));
	const b = document.querySelector(`#maintabs [data-mt="${h.get('tab')}"]`);
	if (b) setTimeout(() => b.click(), 300);
	if (h.get('click')) setTimeout(() => document.querySelector(h.get('click'))?.click(), 2500); // test hook
}
if (location.hash.startsWith('#iri=')) {
	// the hash is parsed as a query string: iri=<IRI>[&click=<CSS selector>[;<selector>…]][&set=<selector>:<value>[;…]]
	const h = new URLSearchParams(location.hash.slice(1));
	document.querySelector('#maintabs [data-mt=entities]').click();
	show(encodeURIComponent(h.get('iri')));
	// test hook: &set=<selector>:<value> sets the value of those controls (selects) and fires their change event
	// 2 s later (after the start-up loads), e.g. set=#viewsel:inferred for the inferred class tree
	if (h.get('set'))
		setTimeout(
			() =>
				h
					.get('set')
					.split(';')
					.forEach((kv) => {
						const [sel, val] = kv.split(':');
						const el = document.querySelector(sel);
						if (el) {
							el.value = val;
							el.dispatchEvent(new Event('change'));
						}
					}),
			2000
		);
	// test hook: &click=<selectors separated by ";"> clicks those elements in turn (each revealed — its entity tab
	// activated — and scrolled into view), the first 2.5 s later (after the entity view has rendered) and the next
	// ones 900 ms apart (dialogs and trees load meanwhile), logging each
	if (h.get('click'))
		h.get('click')
			.split(';')
			.forEach((sel, i) =>
				setTimeout(
					() => {
						const el = document.querySelector(sel);
						console.log('TESTCLICK', sel, !!el, el && el.getAttribute('onclick'));
						if (el) {
							entTabReveal(el);
							el.scrollIntoView({ block: 'center' });
							el.click();
						}
					},
					2500 + i * 900
				)
			);
}
/**
 * Dev-mode check (?dev=1): every button-like element must carry a help tooltip. After each DOM change (debounced
 * 400 ms; `hidden` toggles count too, since the entity tabs hide their panels) the buttons, .btn / .ibtn, section "+"
 * and row action icons without a non-empty title are listed on the console as "buttons without title: …" (one short
 * selector each: tag#id.classes[onclick…] "text"); elements inside a [hidden] ancestor are skipped. The line
 * "buttons without title: none (N checked)" confirms a clean render.
 */
if (new URLSearchParams(location.search).has('dev')) {
	const describe = (el) => {
		const oc = el.getAttribute('onclick');
		const cls = [...el.classList].map((c) => '.' + c).join('');
		return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls}${oc ? `[onclick="${oc.slice(0, 50)}"]` : ''} "${el.textContent.trim().slice(0, 25)}"`;
	};
	const check = () => {
		const all = [...document.querySelectorAll('button, .btn, .ibtn, .plus, .act')].filter(
			(el) => !el.closest('[hidden]')
		);
		const missing = all.filter((el) => !(el.getAttribute('title') || '').trim()).map(describe);
		if (missing.length) console.warn('buttons without title:', missing.join(' | '));
		else console.log(`buttons without title: none (${all.length} checked)`);
	};
	let timer = null;
	new MutationObserver(() => {
		clearTimeout(timer);
		timer = setTimeout(check, 400);
	}).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] });
	check();
}
/**
 * Global error hook: uncaught JS errors are logged as "JSERR" and, when the detail panel still shows its
 * placeholder (an .empty div), displayed inside #detail so headless tests / users can see them.
 */
window.addEventListener('error', (e) => {
	const d = $('#detail');
	if (d && d.innerHTML.includes('empty')) d.innerHTML = '<div class="err">JS error: ' + esc(e.message) + '</div>';
	console.error('JSERR', e.message, e.lineno);
});
