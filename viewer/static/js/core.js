// core.js — Shared helpers (DOM, API calls, escaping, colours), header/index bar, sidebar (entity lists and trees), global search, main tabs, tab reordering, workspace switching.
/*
 * Overview
 * --------
 * First script loaded by index.html (classic script: every top-level const/let/function is a
 * global shared with entities.js, axioms.js, graphs.js, query.js, reasoner.js and main.js).
 *
 * Defines: the per-kind colour/label tables (KC, KCF, KL), the DOM/API helpers ($, esc, api,
 * fmtBytes, dot, entLink), the sidebar state (tab, page, filter, selIri, scope, treeExpandAll),
 * the index-status poller (ixRefresh / ixWasRunning), list/tree loading (loadList, loadTree),
 * the main-tab switcher, drag-to-reorder tabs (makeSortable / applyTabOrder), the sidebar
 * resizer, countAnn / setCountAnn, fitSidebar and the "open another ontology" dialog.
 *
 * Uses globals defined in later files: post, modules, show, openForm, refreshChanges
 * (entities.js); ontoData, activeOnt, drawOntology, renderOntology, renderAxioms, renderFdl,
 * renderFuzzyTab (axioms.js); renderByClass, renderKg, renderGraph (graphs.js); renderDlQuery,
 * renderSparql, renderRules, renderHelp (query.js); renderReasoner (reasoner.js).
 *
 * DOM ids owned: #stats, #ixchip, #ixbtn, #ixbar, #ixmsg, #ixlog (header / index bar);
 * #tabs, #ls, #list, #pager, #pinfo, #prev, #next, #scopesel (sidebar); #gs, #searchresults
 * (global search); #maintabs and the visibility of every #tab-* panel; #sbresize, #sidebar
 * (resizing); #modalbox [name=path] and #ferr (only from the workspace dialog).
 */

/** CSS colour (as a CSS variable reference) of each entity kind, used for the kind dots and badges. */
const KC = {
	class: 'var(--class)',
	objprop: 'var(--objprop)',
	dataprop: 'var(--dataprop)',
	annprop: 'var(--annprop)',
	datatype: 'var(--datatype)',
	individual: 'var(--individual)',
	anon: 'var(--individual)',
	ontology: 'var(--ontology)'
};
/** Human-readable label of each entity kind (also the values of the "Type" select in the entity forms). */
const KL = {
	class: 'Class',
	objprop: 'Object property',
	dataprop: 'Data property',
	annprop: 'Annotation property',
	datatype: 'Datatype',
	individual: 'Individual',
	anon: 'Anonymous individual',
	ontology: 'Ontology'
};
// Sidebar state: tab = active sub-tab id (data-tab of #tabs: tree|individual|objprop|dataprop|annprop|datatype),
// page = 0-based page of the list (200 items per page), filter = text of #ls, selIri = IRI of the entity shown in #detail.
let tab = 'tree',
	page = 0,
	filter = '',
	selIri = null;
/**
 * Shorthand for document.querySelector.
 * @param {string} q CSS selector.
 * @returns {Element|null}
 */
const $ = (q) => document.querySelector(q);
/**
 * Escape a value for safe insertion in HTML text or double-quoted attributes.
 * @param {*} s Any value (converted with String()).
 * @returns {string} Text with &, <, > and " replaced by entities.
 */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
/**
 * GET a JSON API endpoint.
 * @param {string} p URL path (e.g. '/api/list').
 * @param {Object} q Query-string parameters (serialised with URLSearchParams).
 * @returns {Promise<Object>} Parsed JSON body.
 */
const api = (p, q) => fetch(p + '?' + new URLSearchParams({ ...q, active: activeFile() })).then((r) => r.json());
// ---------- active-ontology state (KIT: every view and api() depend on it) ----------
// ontoData = cached GET /api/ontology response ({ontologies:[{iri,file,imports,annotations}], metrics:
// {file:{name:value}}, per_module, prefixes:{file:[[prefix,ns]]}}); activeOnt = IRI of the active ontology
let ontoData = null,
	activeOnt = null;
/**
 * Runs `cb` once the ontology data (`ontoData`) is available, fetching it on first use.
 * @param {Function} cb  callback invoked (synchronously if already loaded) after `ontoData` is set.
 * @returns {*} the callback's return value when `ontoData` was already loaded, otherwise undefined.
 * Side effects: GET /api/ontology; sets the globals `ontoData` and (if unset) `activeOnt`, which
 * defaults to the module with the most imports, i.e. the root of the closure (same rule as renderOntology).
 */
function ensureOnto(cb) {
	if (ontoData) return cb();
	api('/api/ontology', {}).then((d) => {
		ontoData = d;
		activeOnt = activeOnt || [...d.ontologies].sort((a, b) => b.imports.length - a.imports.length)[0]?.iri;
		refreshNames(); // display names depend on the active ontology
		cb();
	});
}
/**
 * File name (module) of the active ontology.
 * @returns {string|null} the .owl file of `activeOnt`, or null when unknown / not indexed.
 */
function fdlFile() {
	const o = (ontoData?.ontologies || []).find((x) => x.iri === activeOnt);
	return o && o.file ? o.file : null;
}

/** Module file of the active ontology ('' before the ontology data is loaded): entities declared elsewhere are shown with a prefix. */
const activeFile = () => {
	try {
		return ontoData ? ontoData.ontologies.find((x) => x.iri === activeOnt)?.file || '' : '';
	} catch (e) {
		return ''; // `let ontoData` (axioms.js) not initialised yet
	}
};
/**
 * Human-readable byte size (binary units): 1536 → "1.5 KiB".
 * @param {number} b Number of bytes (falsy → 0).
 * @returns {string}
 */
const fmtBytes = (b) => {
	const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
	let i = 0;
	b = b || 0;
	while (b >= 1024 && i < u.length - 1) {
		b /= 1024;
		i++;
	}
	return (i ? b.toFixed(1) : b) + ' ' + u[i];
};
// fuzzy entities (fuzzy annotation or equivalence with one) get their own colour per kind, so they stand out from crisp ones
const KCF = {
	class: '#f28c28',
	datatype: '#e6a700',
	individual: '#f28c28',
	objprop: '#f28c28',
	dataprop: '#f28c28',
	annprop: '#f28c28'
};
/**
 * Coloured "kind dot" shown before entity names (lists, trees, search results, links).
 * @param {string} k Entity kind (key of KC / KCF).
 * @param {boolean} [f] Fuzzy entity: use the KCF colour plus a halo ring.
 * @param {boolean} [def] Defined class (has an equivalentClass axiom): the dot shows "≡".
 * @returns {string} HTML of a <span class="kind"> element.
 */
const dot = (k, f, def) =>
	`<span class="kind${def ? ' def' : ''}" style="background:${f ? KCF[k] || '#f28c28' : KC[k] || '#999'}${f ? ';box-shadow:0 0 0 2px #fff,0 0 0 3px ' + (KCF[k] || '#f28c28') : ''}" title="${def ? 'defined class (equivalentClass axiom)' : ''}${f ? (def ? ', ' : '') + 'fuzzy entity' : ''}">${def ? '≡' : ''}</span>`;


/**
 * Transient notification in the bottom-right corner (auto-hides after 8 s), with an optional
 * action button. Used e.g. when the ontology files change on disk outside the app.
 * @param {string} msg  text of the toast.
 * @param {string} [actionLabel]  label of the action button.
 * @param {Function} [action]  click handler of the action button.
 * @returns {void}
 */
function toast(msg, actionLabel, action) {
	let box = $('#toasts');
	if (!box) {
		box = document.createElement('div');
		box.id = 'toasts';
		document.body.appendChild(box);
	}
	const el = document.createElement('div');
	el.className = 'toast';
	el.innerHTML = `<span>${esc(msg)}</span>`;
	if (actionLabel) {
		const b = document.createElement('button');
		b.className = 'ibtn';
		b.style.margin = '0';
		b.textContent = actionLabel;
		b.onclick = () => {
			el.remove();
			action && action();
		};
		el.appendChild(b);
	}
	box.appendChild(el);
	setTimeout(() => el.remove(), 8000);
}

/** Material icon paths (24px viewBox) used by ic(); one source for every button/link icon of the app. */
const ICONS = {
	play: 'M8 5v14l11-7z',
	download: 'M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z',
	upload: 'M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z',
	folder: 'M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z',
	save: 'M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z',
	edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.9959.9959 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
	delete: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
	close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
	refresh:
		'M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
	fit: 'M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm-7 7H3v4c0 1.1.9 2 2 2h4v-2H5v-4zM5 5h4V3H5c-1.1 0-2 .9-2 2v4h2V5zm14-2h-4v2h4v4h2V5c0-1.1-.9-2-2-2zm0 16h-4v2h4c1.1 0 2-.9 2-2v-4h-2v4z',
	prev: 'M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z',
	next: 'M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z',
	first: 'M18.41 16.59 13.82 12l4.59-4.59L17 6l-6 6 6 6zM6 6h2v12H6z',
	last: 'M5.59 7.41 10.18 12l-4.59 4.59L7 18l6-6-6-6zM16 6h2v12h-2z',
	add: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
	swap: 'M6.99 11 3 15l3.99 4v-3H14v-2H6.99v-3zM21 9l-3.99-4v3H10v2h7.01v3L21 9z',
	check: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
	diamond: 'M12 2 22 12 12 22 2 12z',
	dark: 'M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.389 5.389 0 0 1-4.4 2.26 5.403 5.403 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1z',
	light:
		'M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1zM5.99 4.58a.996.996 0 0 0-1.41 0 .996.996 0 0 0 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.03 0-1.41L5.99 4.58zm12.37 12.37a.996.996 0 0 0-1.41 0 .996.996 0 0 0 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0a.996.996 0 0 0 0-1.41l-1.06-1.06zm1.06-10.96a.996.996 0 0 0 0-1.41.996.996 0 0 0-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06zM7.05 18.36a.996.996 0 0 0 0-1.41.996.996 0 0 0-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06z'
};
/**
 * Inline SVG icon (class "ic", 16px, currentColor) for buttons and links.
 * @param {string} name Key of ICONS.
 * @returns {string} HTML of the <svg>.
 */
const ic = (name) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;

/**
 * Help tooltips (title attributes) of the buttons built by the shared builders, one group per builder:
 *   plus   — the "+" of the entity sections (plusBtn), keyed by the addAssertion key, or "<kind>:<key>" when the
 *            meaning depends on the kind of the subject; "{name}" is replaced by the entity name;
 *   act    — the row action icons (rowActs, anonRow, the assert icon of inferred rows); "{n}" = annotation count;
 *   pager  — pagerHtml;  form — the footer of the modal dialogs (openForm, explanation dialogs);
 *   etab / xtab / anntab / btab / otab — the tab bars built by tabBtn (entity view, expression dialog, annotation
 *            dialog, ontology imports / prefixes / GCAs, ontology overview / metrics / export).
 * Static buttons (index.html) and one-off template strings carry their title attribute directly.
 */
const TIPS = {
	plus: {
		ann: 'Add an annotation to {name}: label, comment, fuzzy degree… with a literal, an entity or a new anonymous individual as value',
		type: 'Assert a class of {name} (rdf:type): a named class or a class expression (Manchester syntax)',
		rel: 'Add an object property assertion: {name} → property → individual (or a new anonymous individual)',
		data: 'Add a data property assertion of {name}: property and literal value (datatype or language tag)',
		negobj: 'Add a negative object property assertion: {name} is NOT related to an individual by a property',
		negdata: 'Add a negative data property assertion: {name} does NOT have a value for a data property',
		equiv: 'Add a class equivalent to {name}: a named class or a class expression (Manchester syntax, restrictions)',
		sub: 'Add a superclass of {name}: a named class or a class expression (Manchester syntax, restrictions)',
		gca: 'Add a general class axiom: subclass axiom whose subject is a class expression (Manchester syntax)',
		disj: 'Add a class disjoint with {name} (no individual can belong to both)',
		disjunion: 'Declare {name} as the disjoint union of a set of classes (owl:disjointUnionOf)',
		haskey: 'Add a key of {name}: the properties whose values identify its instances (owl:hasKey)',
		equivprop: 'Add a property equivalent to {name} (or a property expression)',
		subprop: 'Add a super-property of {name}: every assertion of {name} implies one of the super-property',
		inverse: 'Add the inverse property of {name} (owl:inverseOf)',
		domain: 'Add a domain of {name}: the class of its subjects (several domains are intersected)',
		'objprop:range': 'Add a range of {name}: the class of its values (several ranges are intersected)',
		'dataprop:range': 'Add a range of {name}: a datatype or a data range, e.g. xsd:decimal[>= 0, <= 100]',
		range: 'Add a range of {name}',
		disjprop: 'Add a property disjoint with {name}: no pair of individuals is related by both',
		chain: 'Add a property chain implying {name}: p o q SubPropertyOf {name}',
		dtdef: 'Define {name} as a data range (datatype definition), e.g. xsd:decimal[>= 0, <= 1]',
		adomain: 'Add a domain of the annotation property {name} (rdfs:domain, informative only)',
		arange: 'Add a range of the annotation property {name} (rdfs:range, informative only)',
		asuper: 'Add a super-property of the annotation property {name} (rdfs:subPropertyOf)',
		sameas: 'Declare individuals equal to {name} (owl:sameAs): pick existing ones or create new ones',
		different: 'Declare individuals different from {name} (owl:differentFrom): pick existing ones or create new ones',
		type_inst: 'Add instances of {name}: pick existing individuals or create new ones (one rdf:type each)'
	},
	act: {
		explain:
			'Explain: the asserted axiom, its module, its annotations and (fuzzy degrees) the values the reasoner used',
		ann: 'Annotate this axiom (e.g. fuzzy degree, comment)',
		annHas: '{n} annotation(s) on this axiom — view / edit / remove',
		edit: 'Edit this axiom: the dialog is prefilled, on OK the old triple is replaced',
		editAnon: 'Edit the expression: the dialog is prefilled with the Manchester text, on OK the old axiom is replaced',
		del: 'Remove this axiom from its module (pending until Save)',
		assert: 'Assert this inferred axiom: add it to a module as an asserted axiom (a popover asks which module)'
	},
	pager: {
		first: 'First page',
		prev: 'Previous page',
		next: 'Next page',
		last: 'Last page',
		page: 'Type a page number and press Enter'
	},
	form: {
		cancel: 'Close the dialog without adding anything',
		ok: 'Apply: the change joins the pending changes (written to the files on Save)',
		close: 'Close this dialog'
	},
	etab: {
		desc: 'Logical axioms of the entity: hierarchy, equivalences, disjointness, domains / ranges, property assertions',
		ann: 'Annotations of the entity (labels, comments, fuzzy markers) with the "+" to add one',
		usage: 'Where the entity is used: as object of triples, as property, as datatype, in definitions',
		inst: 'Asserted direct instances of the class (paginated) with the "+" to add some',
		fuzzy:
			'Fuzzy definition of the entity: membership function, modifier or fuzzy concept, with its plot and the edit button'
	},
	xtab: {
		hier: 'Pick a named class in the hierarchy (filter box above the tree)',
		obj: 'Build an object property restriction: property, some / only / value / cardinality, filler class',
		data: 'Build a data property restriction: property, some / only / value / cardinality, datatype',
		expr: 'Type the expression in Manchester syntax with autocompletion (and, or, not, some, only…)',
		prop: 'Pick a named property in the hierarchy',
		dtl: 'Pick a datatype: OWL 2 built-ins and the datatypes declared in the workspace',
		dva: 'Property tree on the left, then the literal value with its datatype or language tag',
		iri: 'Type any IRI by hand (for targets outside the workspace)',
		inds: 'Pick existing individuals (multi-selection, searched in the whole workspace) or create new ones',
		two: 'Type the property and the target names (autocompleted)'
	},
	anntab: {
		literal: 'The value is a literal: text with an optional language tag or datatype',
		entity: 'The value is an entity of the workspace, picked by name',
		iri: 'The value is any IRI typed by hand',
		anon: 'The value is a new anonymous individual described by its own annotations, types and property values'
	},
	btab: {
		imports: 'Direct and indirect imports of the active ontology, with the "+" to add an import',
		prefixes: 'Namespace prefixes declared in the module file (✎ renames a namespace in every module)',
		gca: 'General class axioms of the module (subclass axioms whose subject is a class expression)'
	},
	otab: {
		overview: 'Ontology header (IRI, version, annotations), imports and prefixes',
		metrics: 'Ontology metrics (OWL API style) of the closure and of the module, with the breakdown by module',
		export: 'Export the selected metrics as CSV, LaTeX or PDF'
	}
};
/**
 * Escaped tooltip text from TIPS.
 * @param {string} group Key of TIPS.
 * @param {string|string[]} keys One key, or several tried in order (the first one present wins).
 * @param {Object<string,string>} [vars] Placeholders replaced in the text: {name: 'City'} replaces "{name}".
 * @param {string} [fallback] Text used when no key is present.
 * @returns {string} Attribute-safe text ('' when nothing is found).
 */
function tip(group, keys, vars, fallback) {
	const g = TIPS[group] || {};
	let t = (
		[]
			.concat(keys)
			.map((k) => g[k])
			.find(Boolean) ||
		fallback ||
		''
	).toString();
	Object.entries(vars || {}).forEach(([k, v]) => (t = t.split('{' + k + '}').join(v)));
	return esc(t);
}
/**
 * Button of a tab bar (entity view, dialogs, ontology panel): data attribute, "on" class, tooltip from TIPS and
 * an inline onclick.
 * @param {string} attr Dataset attribute holding the tab id (e.g. 'et' → data-et).
 * @param {string} key Tab id (also the key of the tooltip in TIPS[group]).
 * @param {string} label Button label (already HTML-safe).
 * @param {boolean} on Active tab.
 * @param {string} js Inline onclick code (must not contain double quotes).
 * @param {string} group Key of TIPS holding the tooltips of the bar.
 * @returns {string} HTML.
 */
const tabBtn = (attr, key, label, on, js, group) =>
	`<button type="button" data-${attr}="${esc(key)}" class="${on ? 'on' : ''}" title="${tip(group, key)}" onclick="${js}">${label}</button>`;

/**
 * Pager used by every paginated list: first / previous / page number box / next / last.
 * @param {number} cur   Current page (0-based).
 * @param {number} pages Number of pages (≥ 1).
 * @param {string} go    JS snippet run to move; "{p}" is replaced by the 0-based target page
 *                       (a number, or the variable `p` for the page box), e.g. 'page={p};loadList()'.
 * @param {string} [info] Text shown after "/ pages" (e.g. "1,234 total").
 * @returns {string} HTML of a <span class="pager2">; empty when there is a single page and no info.
 */
function pagerHtml(cur, pages, go, info) {
	pages = Math.max(1, pages);
	if (pages === 1 && !info) return '';
	const g = (p) => esc(go.replace('{p}', p));
	// name = icon and TIPS.pager key; the tooltip doubles as the accessible label of the icon-only button
	const btn = (name, p, dis) =>
		`<button type="button" class="ibtn pg" ${dis ? 'disabled' : ''} title="${tip('pager', name)}" aria-label="${tip('pager', name)}" onclick="${g(p)}">${ic(name)}</button>`;
	return (
		`<span class="pager2">` +
		btn('first', 0, cur <= 0) +
		btn('prev', Math.max(0, cur - 1), cur <= 0) +
		`<input type="number" class="pgn" min="1" max="${pages}" value="${cur + 1}" aria-label="page" title="${tip('pager', 'page')}" onkeydown="if(event.key==='Enter')this.blur()" onchange="const p=Math.min(${pages},Math.max(1,parseInt(this.value)||1))-1;${g('p')}">` +
		`<span class="dt">/ ${pages.toLocaleString('en')}${info ? ' — ' + esc(info) : ''}</span>` +
		btn('next', Math.min(pages - 1, cur + 1), cur >= pages - 1) +
		btn('last', pages - 1, cur >= pages - 1) +
		`</span>`
	);
}

/**
 * Load the workspace summary and fill the header statistics.
 * Calls GET /api/overview; sets the global `modules` (list of module file names), refreshes the
 * scope selector (fillScope) and writes the counts into #stats ("index not built yet" if empty).
 * @returns {void}
 */
function loadOverview() {
	api('/api/overview', {}).then((d) => {
		if (d.empty) {
			$('#stats').textContent = 'index not built yet';
			return;
		}
		modules = d.modules || [];
		fillScope();
		$('#stats').textContent =
			`${(d.kinds.individual || 0).toLocaleString('en')} individuals · ` +
			`${d.kinds.class || 0} classes · ${d.statements.toLocaleString('en')} axioms · ${d.modules.length} modules`;
	});
}

// ---------- index menu ----------
let ixWasRunning = false; // true while a (re)build has been observed running: when it stops the page reloads
/**
 * Poll the index status and update the header chip / button / progress bar.
 * Calls GET /api/index_status ({exists, stale, running, failed, files:[{name,newer}], log}).
 * State machine on the chip (#ixchip) and button (#ixbtn):
 *   running          → "indexing…", bar #ixbar visible with #ixmsg + tail of the log in #ixlog, re-polls every 2 s;
 *   just finished    → location.reload() (ixWasRunning was set by a previous poll);
 *   failed           → "indexing failed" + Retry button;
 *   no index         → "no index" + Build index button;
 *   stale            → "ontologies changed" (title lists the newer files) + Update index button;
 *   otherwise        → "index up to date", button hidden.
 * Side effects: mutates ixWasRunning; modifies #ixchip, #ixbtn, #ixbar, #ixmsg, #ixlog.
 * @returns {void}
 */
function ixRefresh() {
	api('/api/index_status', {}).then((d) => {
		const chip = $('#ixchip'),
			btn = $('#ixbtn'),
			bar = $('#ixbar');
		if (d.running) {
			chip.textContent = 'indexing…';
			chip.className = 'chip run';
			btn.style.display = 'none';
			bar.style.display = 'block';
			$('#ixmsg').textContent = d.exists
				? 'Updating the index (the viewer keeps working on the current index)…'
				: 'Building the index, this takes a few minutes…';
			const lg = $('#ixlog');
			lg.textContent = d.log;
			lg.scrollTop = lg.scrollHeight;
			ixWasRunning = true;
			setTimeout(ixRefresh, 2000);
			return;
		}
		bar.style.display = 'none';
		if (ixWasRunning) {
			location.reload();
			return;
		} // rebuild just finished -> reload data
		// the button's tooltip explains what the (re)build does in each state
		if (d.failed) {
			chip.textContent = 'indexing failed';
			chip.title = 'The last index build failed: see the log in the bar after Retry';
			chip.className = 'chip warn';
			btn.textContent = 'Retry';
			btn.title = 'Run the indexer again after the failed build (the log is shown in the bar at the top)';
			btn.style.display = '';
		} else if (!d.exists) {
			chip.textContent = 'no index';
			chip.title = 'The search index of this workspace has not been built yet';
			chip.className = 'chip warn';
			btn.textContent = 'Build index';
			btn.title = 'Build the SQLite index of the workspace ontologies (a few minutes; the page reloads when done)';
			btn.style.display = '';
		} else if (d.stale) {
			const n = d.files
				.filter((f) => f.newer)
				.map((f) => f.name)
				.join(', ');
			if (!window._wasStale) {
				window._wasStale = true; // one toast per transition: files edited outside the app
				toast(`Ontology files changed on disk: ${n}. Update the index to see the changes.`, 'Update index', () => $('#ixbtn')?.click());
			}
			chip.textContent = 'ontologies changed';
			chip.title = 'Files newer than the index: ' + n;
			chip.className = 'chip warn';
			btn.textContent = 'Update index';
			btn.title = 'Rebuild the index from the changed files (the viewer keeps working on the current index meanwhile)';
			btn.style.display = '';
		} else {
			window._wasStale = false;
			chip.textContent = 'index up to date';
			chip.title = 'The search index matches the ontology files';
			chip.className = 'chip ok';
			btn.style.display = 'none';
		}
	});
}
/** Build/Update/Retry button: POST /api/reindex starts the indexer, then the poller picks up the "running" state. */
$('#ixbtn').onclick = () =>
	fetch('/api/reindex', { method: 'POST' }).then(() => {
		ixWasRunning = false;
		ixRefresh();
	});

/**
 * Inline clickable link to an entity: kind dot + name (+ label in parentheses if different).
 * @param {{iri:string, name:string, kind:string, fuzzy?:boolean, label?:string}} v Entity node as returned by the API.
 * @returns {string} HTML; the <a> calls show(encodedIri) on click.
 */
function entLink(v) {
	const other = RENDER_MODE === 'label' ? v.name : v.label;
	const lbl = other && other !== dname(v) ? ` <span class="dt">(${esc(other)})</span>` : '';
	return `${dot(v.kind, v.fuzzy)}<a class="ent" onclick="show('${encodeURIComponent(v.iri)}')">${esc(dname(v))}</a>${lbl}`;
}
/** View-menu rendering mode (ui_config.render_mode): 'name' (local name), 'prefix', 'label'. */
let RENDER_MODE = 'name';
/** Back-compatibility alias kept for older ui_config files (render_labels: true). */
let RENDER_LABELS = false;
/** Prefixed form of an IRI (SPARQL_PFX namespaces, query.js), else the local name. */
const pfxName = (iri, name) => {
	for (const [ns, p] of Object.entries(SPARQL_PFX)) if (iri && iri.startsWith(ns)) return p + iri.slice(ns.length);
	return name;
};
/** Display name of an entity node according to the View-menu rendering mode. */
const dname = (v) =>
	RENDER_MODE === 'label' && v.label ? v.label : RENDER_MODE === 'prefix' ? pfxName(v.iri, v.name) : v.name;

// ---------- sidebar ----------
/** Sub-tab click (#tabs): select the kind, reset page and filter (#ls), reload the list. Mutates tab, page, filter. */
document.querySelectorAll('#tabs button').forEach(
	(b) =>
		(b.onclick = () => {
			document.querySelectorAll('#tabs button').forEach((x) => x.classList.remove('on'));
			b.classList.add('on');
			tab = b.dataset.tab;
			page = 0;
			$('#ls').value = filter = '';
			loadList();
		})
);
/** Filter box (#ls): debounced (250 ms, timer in window._t) reload of the list with the typed text. Mutates filter, page. */
$('#ls').oninput = (e) => {
	filter = e.target.value;
	page = 0;
	clearTimeout(window._t);
	window._t = setTimeout(loadList, 250);
};

// entity scope: '' = closure, 'active' = module of the active ontology, else a module file
let scope = '';
/**
 * Resolve the current scope to the `graph` parameter expected by the API.
 * @returns {string} '' (whole closure) or a module file name; 'active' is mapped to the file of activeOnt (axioms.js).
 */
function scopeGraph() {
	if (scope === 'active') {
		// Protégé semantics: the ACTIVE ONTOLOGY is the module plus its whole import closure
		if (!ontoData) return '';
		const byIri = {};
		ontoData.ontologies.forEach((o) => (byIri[o.iri] = o));
		const files = [];
		const walk = (iri) => {
			const o = byIri[iri];
			if (!o || !o.file || files.includes(o.file)) return;
			files.push(o.file);
			(o.imports || []).forEach(walk);
		};
		walk(activeOnt);
		// the active closure spans every module of the workspace → the unfiltered fast path
		if (typeof modules !== 'undefined' && modules.length && files.length >= modules.length) return '';
		return files.join(',');
	}
	return scope;
}
/**
 * (Re)build the options of the scope selector #scopesel: closure, active ontology (if known), one entry per module.
 * Keeps the previously selected value when still present. Mutates `scope`.
 * @returns {void}
 */
let scopeTouched = false; // the user picked a scope: fillScope must not override it with the default
function fillScope() {
	const sel = $('#scopesel');
	const cur = sel.value;
	const act = ontoData?.ontologies.find((x) => x.iri === activeOnt);
	sel.innerHTML =
		(act ? `<option value="active">Active ontology (${esc(act.file)})</option>` : '') +
		`<option value="">Closure (all modules)</option>`;
	// default scope = the ACTIVE ontology (not the closure) until the user chooses explicitly
	sel.value = cur === 'active' && act ? 'active' : !scopeTouched && act ? 'active' : '';
	if (sel.value !== scope) {
		scope = sel.value;
		loadList(); // the first list may have loaded with the closure before the default applied
	}
}
/** onchange handler of #scopesel (wired in index.html): store the new scope and reload the list from page 0. */
function scopeChanged() {
	scopeTouched = true;
	scope = $('#scopesel').value;
	page = 0;
	loadList();
}
/** onchange handler of #viewsel (Asserted | Inferred hierarchy, wired in index.html): reload the tree. */
function viewChanged() {
	loadList();
}
// sub-tabs shown as a hierarchy (no filter text): tab id → entity kind
const TREE_KINDS = { tree: 'class', objprop: 'objprop', dataprop: 'dataprop', annprop: 'annprop' };
// synthetic top node shown above the roots of each hierarchy (annotation properties have none)
const TREE_ROOT = { class: 'owl:Thing', objprop: 'owl:topObjectProperty', dataprop: 'owl:topDataProperty' };
/**
 * Entity kind of the current sub-tab ('tree' → 'class', the other tab ids coincide with the kind).
 * @returns {string}
 */
const listKind = () => TREE_KINDS[tab] || tab;
/**
 * Fill the sidebar list (#list) for the current sub-tab, filter, page and scope.
 * Hierarchical kinds without filter text are delegated to loadTree(); otherwise calls
 * GET /api/list ({items:[node…], total}) and renders one .item per entity (the selected one gets .sel).
 * Also updates the pager (#pager, #pinfo, #prev, #next); if `page` is past the end it is clamped and the list reloaded.
 * @returns {void}
 */
function loadList() {
	if (TREE_KINDS[tab] && !filter) return loadTree(TREE_KINDS[tab]);
	api('/api/list', { kind: listKind(), page, q: filter, graph: scopeGraph() }).then((d) => {
		$('#list').innerHTML =
			d.items
				.map(
					(n) =>
						`<div class="item${n.iri === selIri ? ' sel' : ''}" onclick="show('${encodeURIComponent(n.iri)}')" title="${esc(n.iri)}">` +
						`${dot(n.kind, n.fuzzy)}${esc(dname(n))}</div>`
				)
				.join('') || '<div class="empty">empty</div>';
		const pages = Math.max(1, Math.ceil(d.total / 200));
		if (page >= pages) {
			page = pages - 1;
			return loadList();
		}
		$('#pager').style.display = pages > 1 ? 'flex' : 'none';
		$('#pager').innerHTML = pagerHtml(page, pages, 'page={p};loadList()', `${d.total.toLocaleString('en')} total`);
	});
}
const treeExpandAll = {}; // per kind: expand all / collapse all (collapsed = default view)
/**
 * Expand or collapse every sub-list of the tree currently shown in #list.
 * @param {boolean} on true = expand all, false = collapse all.
 * @returns {void} Side effects: toggles `hidden` on ul.sub and the ▸/▾ glyph of the non-root toggles.
 */
function treeSetAll(on, root = '#list') {
	document.querySelectorAll(`${root} .tree ul.sub`).forEach((u) => {
		u.hidden = !on;
	});
	document.querySelectorAll(`${root} .tree li li .tg`).forEach((t) => {
		if (t.textContent) t.textContent = on ? '▾' : '▸';
	});
}
/**
 * Render the hierarchy of a kind (classes or properties) in the sidebar list #list.
 * Calls GET /api/tree ({roots:[{iri,name,fuzzy,defined,equivalent:[{iri,name}],instances,children:[…]}]}).
 * Builds nested <ul>/<li> rows: a ▸/▾ toggle for nodes with children, kind dot, name (bold when it has
 * equivalents, which are listed after "="), instance count, all under the synthetic TREE_ROOT node.
 * An "Expand all" checkbox (#treeexp) drives treeExpandAll[kind] / treeSetAll. Hides #pager.
 * @param {string} kind 'class' | 'objprop' | 'dataprop' | 'annprop'.
 * @returns {void}
 */
/**
 * HTML of a hierarchy in the sidebar style (the same markup for the Entities sidebar and the
 * Individuals-by-class tree): an "Expand all" checkbox row, then nested <ul>/<li> rows with a ▸/▾ toggle
 * for nodes with children, the kind dot, the name (bold when it has equivalents, listed after "="),
 * the instance count and, when TREE_ROOT[kind] exists, a synthetic always-expanded top node.
 * @param {Object[]} roots  Nodes {iri,name,fuzzy,defined,equivalent:[{iri,name}],instances,children:[…]} — in the
 *                          inferred view also inferred (edge to the parent inferred) and unsat (owl:Nothing root and
 *                          the unsatisfiable classes under it: rendered in the error colour, the root not clickable).
 * @param {string} kind     'class' | 'objprop' | 'dataprop' | 'annprop' (dot colour, top node).
 * @param {Object} o        Options: click(iri) → JS snippet run when a name is clicked;
 *                          expanded (bool, initial state of the sub-trees); expandJs (onchange JS of the
 *                          checkbox); selected (IRI of the highlighted row, optional).
 * @returns {string} HTML (a <div class="tree">).
 */
function treeHtml(roots, kind, o) {
	const link = (n, bold) =>
		n.builtin && n.unsat
			? `<a class="ent" style="font-weight:600" title="unsatisfiable classes (equivalent to owl:Nothing)">${esc(n.name)}</a>`
			: `<a class="ent" style="${bold ? 'font-weight:600' : ''}" onclick="${esc(o.click(n.iri))}"${n.inferred ? ` title="inferred by ${esc(infEngineName())}"` : ''}>${esc(dname(n))}</a>`;
	// node label: link to the entity, followed by "= <equivalent>" links (defined classes are bold)
	const label = (n) =>
		link(n, n.equivalent && n.equivalent.length) +
		(n.equivalent || []).map((e) => ` <span class="dt">=</span> ` + link(e, true)).join('');
	// opening tag of the toggle: the inline onclick flips the sibling <ul> and the glyph
	const tg = `<span class="tg" onclick="const u=this.parentNode.parentNode.querySelector('ul');u.hidden^=1;this.textContent=u.hidden?'▸':'▾'">`;
	const glyph = o.expanded ? '▾' : '▸';
	// row classes: selected, inferred placement (pale highlight), unsatisfiable (error colour)
	const rowCls = (n) => `row${o.selected === n.iri ? ' sel' : ''}${n.inferred ? ' inf' : ''}${n.unsat ? ' unsat' : ''}`;
	// recursive <li>: row (toggle, dot, label, instance count) + <ul class="sub"> of the children
	const rec = (n) =>
		`<li><div class="${rowCls(n)}">${n.children.length ? tg + glyph + '</span>' : '<span class="tg"></span>'}` +
		`${dot(kind, n.fuzzy, n.defined)}<span class="lbl">${label(n)}` +
		(n.instances ? ` <span class="cnt">(${n.instances.toLocaleString('en')})</span>` : '') +
		`</span></div>` +
		(n.children.length ? `<ul class="sub"${o.expanded ? '' : ' hidden'}>${n.children.map(rec).join('')}</ul>` : '') +
		`</li>`;
	const rows = roots.map(rec).join('');
	// wrap the roots under owl:Thing / owl:top*Property (always expanded); annotation properties have no top node
	const body = TREE_ROOT[kind]
		? `<li><div class="row">${tg}▾</span>${dot(kind)}<span class="lbl"><a class="ent" style="font-weight:600">${TREE_ROOT[kind]}</a></span></div><ul>${rows}</ul></li>`
		: rows;
	return (
		`<div class="tree"><label class="dt" style="display:inline-flex;align-items:center;gap:6px;margin:4px 0 8px 14px;cursor:pointer;text-transform:none"><input type="checkbox" ${o.expanded ? 'checked' : ''} onchange="${esc(o.expandJs)}"> Expand all</label>` +
		`<ul>${body}</ul></div>`
	);
}
/**
 * Render the hierarchy of a kind (classes or properties) in the sidebar list #list.
 * Calls GET /api/tree ({roots:[…]}; `inferred=1` when the Inferred view is selected in #viewsel, see
 * inference.js) and renders it with treeHtml; the "Expand all" checkbox drives treeExpandAll[kind] / treeSetAll.
 * Hides #pager.
 * @param {string} kind 'class' | 'objprop' | 'dataprop' | 'annprop'.
 * @returns {void}
 */
function loadTree(kind) {
	$('#pager').style.display = 'none';
	api('/api/tree', { kind, graph: scopeGraph(), inferred: infViewOn() ? 1 : '' }).then((d) => {
		if (listKind() !== kind || filter) return; // user moved on while loading
		$('#list').innerHTML = treeHtml(d.roots, kind, {
			click: (iri) => `show('${encodeURIComponent(iri)}')`,
			expanded: !!treeExpandAll[kind],
			expandJs: `treeExpandAll['${kind}']=this.checked;treeSetAll(this.checked)`
		});
	});
}

// ---------- global search ----------
/**
 * Header search box (#gs): from 2 characters, debounced (250 ms, timer in window._g) GET /api/search
 * restricted to the current scope; results go to the #searchresults dropdown (kind dot, name, kind label,
 * "fuzzy" flag, label). Clicking a result opens the entity (show) and hides the dropdown.
 */
$('#gs').oninput = (e) => {
	clearTimeout(window._g);
	const q = e.target.value;
	if (q.length < 2) {
		$('#searchresults').style.display = 'none';
		return;
	}
	window._g = setTimeout(
		() =>
			api('/api/search', { q, graph: scopeGraph() }).then((d) => {
				$('#searchresults').innerHTML =
					d.items
						.map(
							(n) =>
								`<div class="item" title="${esc(n.iri)}" onclick="show('${encodeURIComponent(n.iri)}');this.parentNode.style.display='none'">` +
								`${dot(n.kind, n.fuzzy)}${esc(dname(n))} <span class="dt">${KL[n.kind] || ''}${n.fuzzy ? ' · fuzzy' : ''}${n.label && n.label !== n.name ? ' · ' + esc(RENDER_MODE === 'label' ? n.name : n.label) : ''}</span></div>`
						)
						.join('') || '<div class="item">no results</div>';
				$('#searchresults').style.display = 'block';
			}),
		250
	);
};
/** Any click outside #globalsearch closes the search dropdown. */
document.addEventListener('click', (e) => {
	if (!e.target.closest('#globalsearch')) $('#searchresults').style.display = 'none';
});

// ---------- main tabs ----------
/**
 * Main tab click (#maintabs, data-mt): highlight the button, show only the matching #tab-<id> panel
 * (#tab-entities uses display:flex, the others block) and call the panel's render* function
 * (defined in axioms.js / graphs.js / query.js / reasoner.js, or in the plugin-view registry VIEWS).
 * The Entities panel needs no render call.
 * @param {Element} b The tab button (also used by registerView for buttons created later).
 * @returns {void}
 */
function bindMainTab(b) {
	b.onclick = () => {
		document.querySelectorAll('#maintabs button').forEach((x) => x.classList.remove('on'));
		b.classList.add('on');
		const t = b.dataset.mt;
		// every top-level tab panel is a direct child of <body> with id tab-<id>
		document.querySelectorAll('body > [id^="tab-"]').forEach((p) => {
			p.style.display = p.id === 'tab-' + t ? (t === 'entities' ? 'flex' : 'block') : 'none';
		});
		if (VIEWS[t] && VIEWS[t].render) VIEWS[t].render();
	};
}

// ---------- plugin views ----------
/** Registered views: id → {id, title, tooltip, render}. EVERY main tab goes through this
 * registry — the built-in ones register in views.js, installed plugins at load. See PLUGINS.md. */
const VIEWS = {};
/**
 * Plugin hook: add a main-tab view without touching the core files.
 * Creates the #tab-<id> panel (a direct child of <body>; an existing static panel with that id is
 * reused) and the #maintabs button, and wires the standard tab behaviour: the Window menu
 * (show / hide), drag-to-reorder and the #tab= deep link work on the new view with no further
 * code. `render` is called on every click of the tab: build the panel once behind a data-ready
 * guard and refresh the data on the following calls.
 * @param {{id: string, title: string, tooltip?: string, render?: function(): void}} v
 * @returns {void}
 */
/** Problems met while loading the view packages; shown once by startUp (main.js). */
const PLUGIN_ERRORS = [];
function registerView(v) {
	if (!v || !v.id || !v.title) {
		PLUGIN_ERRORS.push(`registerView: a view needs at least an id and a title (got ${JSON.stringify(v && v.id)})`);
		return;
	}
	if (typeof v.render !== 'function') {
		PLUGIN_ERRORS.push(`view "${v.id}": render is not a function — the view was not registered`);
		return;
	}
	if (VIEWS[v.id]) PLUGIN_ERRORS.push(`view "${v.id}": registered twice (the newer registration replaces the older)`);
	VIEWS[v.id] = v;
	if (!document.getElementById('tab-' + v.id)) {
		const panel = document.createElement('div');
		panel.id = 'tab-' + v.id;
		panel.style.cssText = 'display:none;flex:1;overflow:auto;padding:18px 26px';
		document.body.insertBefore(panel, $('#tab-entities'));
	}
	const b = document.createElement('button');
	b.dataset.mt = v.id;
	b.textContent = v.title;
	if (v.tooltip) b.title = v.tooltip;
	const bar = $('#maintabs');
	bar.insertBefore(b, bar.querySelector('span.dt'));
	if ((uiConfig.hidden_tabs || []).includes(v.id)) b.style.display = 'none'; // views registered after start-up (installed plugins)
	bindMainTab(b);
}
/**
 * Switch to the Entities tab and open an entity (used by links in the other panels).
 * @param {string} iri Raw (not encoded) entity IRI.
 * @returns {void}
 */
function openEntity(iri) {
	document.querySelector('#maintabs [data-mt=entities]')?.click();
	show(encodeURIComponent(iri));
}

// ---------- reorderable tabs (order persisted server-side in ui_config.json) ----------
/**
 * Make the buttons of a tab bar draggable (HTML5 drag & drop) to reorder them.
 * While dragging, the dragged button (kept in container._drag) is moved before/after the hovered
 * button depending on the pointer half; on drop the new order (data-mt or data-tab values) is saved
 * with POST /api/ui_config {[key]: order}.
 * @param {Element} container #maintabs or #tabs.
 * @param {string} key ui_config key: 'tab_order' | 'entity_tab_order'.
 * @returns {void}
 */
function makeSortable(container, key) {
	const btns = () => [...container.querySelectorAll('button')];
	btns().forEach((b) => {
		b.draggable = true;
		b.addEventListener('dragstart', (e) => {
			container._drag = b;
			e.dataTransfer.effectAllowed = 'move';
		});
		b.addEventListener('dragover', (e) => {
			e.preventDefault();
			const d = container._drag;
			if (!d || d === b) return;
			const r = b.getBoundingClientRect();
			container.insertBefore(d, e.clientX < r.left + r.width / 2 ? b : b.nextSibling);
		});
		b.addEventListener('dragend', () => {
			const order = btns().map((x) => x.dataset.mt || x.dataset.tab);
			post('/api/ui_config', { [key]: order });
		});
	});
}
/**
 * Reorder the buttons of a tab bar according to a saved order (from ui_config.json).
 * @param {Element} container #maintabs or #tabs.
 * @param {string[]} order Tab ids in the wanted order (unknown ids are ignored); empty/undefined = no-op.
 * @param {string} attr Dataset attribute holding the id: 'mt' (main tabs) or 'tab' (sidebar tabs).
 * @returns {void}
 */
function applyTabOrder(container, order, attr) {
	if (!order || !order.length) return;
	const map = {};
	container.querySelectorAll('button').forEach((b) => (map[b.dataset[attr]] = b));
	// each listed button is moved just before the first non-tab element (the "drag to reorder" hint span), i.e. appended in order
	order.forEach((k) => {
		if (map[k]) container.insertBefore(map[k], container.querySelector('span,button:not([data-' + attr + '])') || null);
	});
	// buttons not listed keep their position after the ordered ones
	const first = container.querySelector('span.dt');
	if (first) container.appendChild(first); // hint span always last
}
// resizable panels (widths persisted in ui_config.json)
let uiConfig = {}; // the persisted UI configuration, filled by main.js at start-up (GET /api/ui_config)
/**
 * Make a panel horizontally resizable by dragging a handle placed at its right edge.
 * The width is clamped to [minW, 80% of the window]; on mouseup it is saved with
 * POST /api/ui_config {[key]: width}. Text selection is disabled on <body> while dragging.
 * @param {Element|null} handle Drag handle element (e.g. #sbresize); no-op when missing.
 * @param {Element|null} panel  Element whose style.width is changed.
 * @param {string} key          ui_config key persisting the width ('sidebar_width', 'byclass_width').
 * @param {number} [minW=220]   Minimum width in px.
 * @returns {void}
 */
function makeResizable(handle, panel, key, minW = 220) {
	if (!handle || !panel) return;
	let x0 = 0,
		w0 = 0,
		on = false;
	handle.addEventListener('mousedown', (e) => {
		on = true;
		x0 = e.clientX;
		w0 = panel.getBoundingClientRect().width;
		handle.classList.add('on');
		document.body.style.userSelect = 'none';
		e.preventDefault();
	});
	window.addEventListener('mousemove', (e) => {
		if (!on) return;
		panel.style.width = Math.max(minW, Math.min(window.innerWidth * 0.8, w0 + e.clientX - x0)) + 'px';
	});
	window.addEventListener('mouseup', () => {
		if (!on) return;
		on = false;
		handle.classList.remove('on');
		document.body.style.userSelect = '';
		const w = Math.round(panel.getBoundingClientRect().width);
		uiConfig[key] = w;
		post('/api/ui_config', { [key]: w });
	});
}
makeResizable($('#sbresize'), $('#sidebar'), 'sidebar_width', 220);
let countAnn = true; // metrics include annotation axioms (OWL API default); persisted in ui_config
/**
 * Toggle "count annotation axioms in the metrics" (checkbox in the Ontology info panel).
 * @param {boolean} v New value.
 * @returns {void} Side effects: sets countAnn, POST /api/ui_config {count_annotations}, redraws the ontology panel if loaded.
 */
function setCountAnn(v) {
	countAnn = !!v;
	post('/api/ui_config', { count_annotations: countAnn });
	if (ontoData && typeof drawOntology === 'function') drawOntology(); // the ontology package may be uninstalled
}
// the sidebar can never be narrower than its row of sub-tabs (no scrolling, no wrapping)
/** Set the min-width of #sidebar to the natural width of the #tabs row. @returns {void} */
function fitSidebar() {
	$('#sidebar').style.minWidth = $('#tabs').scrollWidth + 2 + 'px';
}

// ---------- workspace: open another ontology ----------
/**
 * "📂 Open" button: modal form to switch the viewer to another main .owl file.
 * Calls GET /api/workspace ({current:{dir,files}, recent:[{dir,files}]}) to prefill the path and list
 * recent workspaces; the form offers a native file picker (pickFile), an upload (uploadFile) or a typed path.
 * On OK: POST /api/workspace/open {path}; shows a summary alert (files, unresolved imports, whether an
 * index build started) and reloads the page.
 * @returns {void}
 */
function openWorkspace() {
	api('/api/workspace', {}).then((w) => {
		openForm(
			'Open ontology',
			[
				{
					type: 'html',
					html: `<label>Main .owl file on this computer</label>
<div style="display:flex;gap:8px;margin-top:3px"><button class="ibtn" style="margin:0" onclick="pickFile()" title="Choose the main .owl file with the system file dialog: only its path is filled in below, nothing is uploaded">${ic('folder')} Browse… (system dialog, no upload)</button>
<label class="ibtn" style="margin:0;cursor:pointer" title="Upload a copy of an ontology file into viewer/uploads/ and open it (suitable for small files); Turtle / N3 / N-Triples / JSON-LD files are converted to RDF/XML on open">${ic('upload')} Upload file… <input type="file" accept=".owl,.rdf,.xml,.ttl,.n3,.nt,.jsonld" style="display:none" onchange="uploadFile(this)"></label></div>
<div class="dt" style="margin-top:4px">Imports are resolved via catalog-v001.xml / owl:imports in the same folder. Upload copies the file into viewer/uploads/ (suitable for small files).</div>
<div style="margin-top:10px"><label style="display:block;font-size:13px"><input type="radio" name="wsmode" value="new" checked>
Open as a <b>new workspace</b> (its own index; the current one stays on disk)</label>
<label style="display:block;font-size:13px"><input type="radio" name="wsmode" value="add">
<b>Add to the current workspace</b> (one shared index — a full rebuild is needed before browsing; pending changes of the current index do not carry over: save them first)</label></div>`
				},
				{
					name: 'path',
					label: '…or file path(s) — separate several with ";" to open them in ONE workspace / index',
					required: true,
					placeholder: '/Users/…/ontology.owl; /Users/…/extra_module.owl',
					value: w.current.dir + '/' + (w.current.files[w.current.files.length - 1] || '')
				},
				// recent workspaces: clicking one copies "<dir>/<last file>" into the path field
				{
					type: 'html',
					html:
						`<label>Recent</label>` +
						(w.recent.length
							? w.recent
									.map(
										(r) =>
											`<div class="item" onclick="document.querySelector('#modalbox [name=path]').value='${esc(r.dir)}/${esc(r.files[r.files.length - 1])}'">${esc(r.dir)} — ${r.files.length} file(s)</div>`
									)
									.join('')
							: '<div class="dt">none</div>')
				}
			],
			(v) =>
				// ";"-separated paths open one workspace with all of them (e.g. the SDF entry file + an extra module);
				// wsmode "add" appends them to the CURRENT workspace instead of starting a separate one
				post('/api/workspace/open', {
					paths: v.path.split(';').map((s) => s.trim()).filter(Boolean),
					add: document.querySelector('#modalbox [name=wsmode]:checked')?.value === 'add',
				}).then((r) => {
					if (r.error) return r;
					alert(
						'Workspace: ' +
							r.workspace.dir +
							'\nFiles: ' +
							r.workspace.files.join(', ') +
							(r.unresolved_imports.length ? '\nUnresolved imports: ' + r.unresolved_imports.join(', ') : '') +
							(r.reindex_started ? '\n\nIndex being built: watch the bar at the top.' : '\n\nIndex already present.')
					);
					setTimeout(() => location.reload(), 300);
					return r;
				}),
			'Switching ontology creates (or reuses) a separate index.'
		);
	});
}

/**
 * "Browse…" button of the Open dialog: GET /api/pick_file opens a native file dialog on the server machine
 * and returns {path} (or {error}); the chosen path is written into the form's path field, errors into #ferr.
 * @returns {void}
 */
function pickFile() {
	api('/api/pick_file', {}).then((r) => {
		if (r.path) {
			document.querySelector('#modalbox [name=path]').value = r.path;
		} else if (r.error) $('#ferr').textContent = r.error;
	});
}
/**
 * "Upload file…" input of the Open dialog: multipart POST /api/upload of the selected file; the server stores it
 * under viewer/uploads/ and opens it as the new workspace. Shows progress/errors in #ferr, then an alert and reload.
 * @param {HTMLInputElement} inp The <input type="file"> element.
 * @returns {void}
 */
function uploadFile(inp) {
	if (!inp.files.length) return;
	const fd = new FormData();
	fd.append('file', inp.files[0]);
	$('#ferr').textContent = 'uploading ' + inp.files[0].name + '…';
	fetch('/api/upload', { method: 'POST', body: fd })
		.then((r) => r.json())
		.then((r) => {
			if (r.error) {
				$('#ferr').textContent = r.error;
				return;
			}
			alert(
				'Opened: ' +
					r.workspace.dir +
					'\nFiles: ' +
					r.workspace.files.join(', ') +
					(r.unresolved_imports.length ? '\nUnresolved imports: ' + r.unresolved_imports.join(', ') : '') +
					(r.reindex_started ? '\n\nIndex being built.' : '')
			);
			location.reload();
		});
}

// ---------- theme (light / dark) ----------
/**
 * Apply a colour theme: 'light' | 'dark' | '' (follow the system preference). Stored in
 * localStorage("theme"); the value goes to <html data-theme> which the CSS tokens react to.
 * @param {string} t Theme name.
 */
function setTheme(t) {
	document.documentElement.dataset.theme = t || '';
	try {
		localStorage.setItem('theme', t || '');
	} catch (e) {
		/* storage disabled: the choice lasts for the page only */
	}
	const b = $('#themebtn');
	if (b) b.innerHTML = ic(currentTheme() === 'dark' ? 'light' : 'dark');
}
/** Effective theme: the stored choice, else the system preference. */
function currentTheme() {
	const t = document.documentElement.dataset.theme;
	return t || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}
/** Header button: toggle between light and dark. */
function toggleTheme() {
	setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
}
/** Header button: stop the local server (POST /api/shutdown) and leave a farewell page. */
async function stopServer() {
	if (!confirm('Stop the Ontology Viewer server?')) return;
	try {
		await fetch('/api/shutdown', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
	} catch (e) {
		/* the server may die before the response is fully delivered */
	}
	document.body.innerHTML =
		'<div style="display:flex;height:100vh;align-items:center;justify-content:center;font:16px system-ui">' +
		'Ontology Viewer stopped — you can close this tab. Restart it with <code style="margin:0 .4em">ontology_viewer_tool/start_viewer.sh</code>.</div>';
}
// keyboard: ⌘K / Ctrl+K focuses the global search; Enter / Space activate the icon "buttons" (role=button)
document.addEventListener('keydown', (e) => {
	if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
		e.preventDefault();
		$('#gs').focus();
		$('#gs').select();
	} else if (
		(e.key === 'Enter' || e.key === ' ') &&
		e.target.getAttribute &&
		e.target.getAttribute('role') === 'button'
	) {
		e.preventDefault();
		e.target.click();
	}
});
