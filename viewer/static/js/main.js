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
// Every view is a plugin: load the built-in packages (canonical order) and the installed ones —
// minified builds unless ?dev=1 (the readable sources stay on disk for debugging) — THEN start up.
const DEV_MODE = new URLSearchParams(location.search).has('dev');
api('/api/plugins', {}).then((d) => {
	const items = [
		...(d.builtin || []).map((p) => ({ base: `/plugins-builtin/${p.name}/`, p, custom: false })),
		...(d.plugins || []).map((p) => ({ base: `/plugins/${p.name}/`, p, custom: true })),
	];
	let pending = 1; // settles even with zero plugin scripts
	let seen = 0; // views registered so far: a custom script that adds none gets a warning
	const done = () => {
		if (--pending === 0) startUp();
	};
	items.forEach(({ base, p, custom }) => {
		if (p.help) PLUGIN_HELP[p.name] = { url: base + p.help, title: p.title || p.name };
		(p.css || []).forEach((f) => {
			const l = document.createElement('link');
			l.rel = 'stylesheet';
			l.href = base + f;
			document.head.appendChild(l);
		});
		const files = DEV_MODE || !(p.js_min || []).length ? p.js || [] : p.js_min;
		files.forEach((f) => {
			pending++;
			const s = document.createElement('script');
			s.src = base + f;
			s.async = false; // injected scripts keep their insertion order → the `seen` check is per script
			s.onload = () => {
				const now = Object.keys(VIEWS).length;
				if (custom && now === seen)
					PLUGIN_ERRORS.push(`plugin "${p.name}" (${f}): loaded but registered no view — a syntax/runtime error (see the console) or a missing registerView() call`);
				seen = now;
				done();
			};
			s.onerror = () => {
				PLUGIN_ERRORS.push(`plugin "${p.name}": ${f} could not be loaded (network / missing file)`);
				done();
			};
			document.body.appendChild(s);
		});
	});
	done();
});

/** Start-up once every view (built-in and installed) has registered: initial loads, UI config, deep links. */
function startUp() {
	if (PLUGIN_ERRORS.length) alert('Plugin problems:\n\n' + PLUGIN_ERRORS.join('\n'));
	loadOverview(); // header statistics + module list (GET /api/overview)
	// pre-warm the server's display-order cache for the heavy kinds, so the first click on
	// Entities does not pay the one-off sort of 400k individuals (same scope key as the sidebar)
	setTimeout(() => ['individual', 'class'].forEach((k) => api('/api/list', { kind: k, page: 0, graph: scopeGraph() })), 1500);
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
		const rm = cfg.render_mode || (cfg.render_labels === true ? 'label' : 'name');
		if (rm !== 'name') {
			RENDER_MODE = rm; // View menu rendering mode: local name / prefixed name / label
			loadList();
		}
		if (ontoData && typeof drawOntology === 'function') drawOntology();
		if (cfg.sidebar_width) $('#sidebar').style.width = cfg.sidebar_width + 'px';
		applyTabOrder($('#maintabs'), cfg.tab_order, 'mt');
		applyTabOrder($('#tabs'), cfg.entity_tab_order, 'tab');
		// tabs / sidebar views hidden from the Window menu; if the active one is hidden, fall back to the first visible
		(cfg.hidden_tabs || []).forEach((k) => {
			const b = document.querySelector(`#maintabs [data-mt=${k}]`);
			if (b) b.style.display = 'none';
		});
		// start-up tab: Ontology info when visible, else the first visible view
		const first = document.querySelector('#maintabs [data-mt=ontology]');
		(first && first.style.display !== 'none'
			? first
			: [...document.querySelectorAll('#maintabs [data-mt]')].find((b) => b.style.display !== 'none')
		)?.click();
		(cfg.hidden_entity_tabs || []).forEach((k) => {
			const b = document.querySelector(`#tabs [data-tab=${k}]`);
			if (b) b.style.display = 'none';
		});
		const eon = document.querySelector('#tabs button.on');
		if (eon && eon.style.display === 'none') {
			const v = [...document.querySelectorAll('#tabs [data-tab]')].find((b) => b.style.display !== 'none');
			if (v) v.click();
		}
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
		// test hook: like the #iri= branch, ";"-separated selectors are clicked in turn (900 ms apart)
		if (h.get('click'))
			h.get('click')
				.split(';')
				.forEach((sel, i) => setTimeout(() => document.querySelector(sel)?.click(), 2500 + i * 900));
	}
	if (location.hash.startsWith('#iri=')) {
		// the hash is parsed as a query string: iri=<IRI>[&click=<CSS selector>[;<selector>…]][&set=<selector>:<value>[;…]]
		const h = new URLSearchParams(location.hash.slice(1));
		document.querySelector('#maintabs [data-mt=entities]')?.click();
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

