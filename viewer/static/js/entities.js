// entities.js — Entity view (ontology-editor-like panels), editing forms and actions, pending changes, ontology header editing, fuzzy (Fuzzy OWL 2) constructs and their rendering.
/*
 * Overview
 * --------
 * Second script (after core.js). Sections:
 *   1. fuzzy rendering — parseFuzzy() reads the <fuzzyOwl2> XML stored in sdf:fuzzyLabel annotations
 *      (Fuzzy OWL 2 / fuzzy-dl-owl2 syntax) and the SVG previews of membership functions / modifiers;
 *   2. generic modal form (openForm / closeForm / pickVal / bindPicker / toIri) used by every editing action;
 *   3. editing actions (addAssertion, removeAssertion, renameEntity, deleteEntity, newEntity…);
 *   4. pending changes (refreshChanges / saveChanges / discardChanges);
 *   5. ontology header editing (IRI, annotations, imports, namespace rename);
 *   6. fuzzy entity forms (fuzzy datatype, modifier, fuzzy concept, axiom degree);
 *   7. entity view: show() renders in #detail a sticky header + tab bar (#etabs: Description, Annotations,
 *      Usage, Instances for classes, Fuzzy for fuzzy entities; the active tab is remembered per kind in
 *      uiConfig.ent_tab) and one panel per tab (entityContext → entityPanels), plus per-row actions
 *      (explain / annotate / edit / remove), usage and instances loaders.
 * Every edit goes to POST /api/edit/* and is only queued server-side until POST /api/save.
 *
 * Globals defined here: CLASSNS, NS, RDF, RDFS, OWLNS, XSDNS, XSD_TYPES, SDFNS, SHAPES, ICON, CHARS, ENT_TAB_LABEL,
 * CHAR_LABEL, ANN_PREDS, FIELD_AC, MANCHESTER_HINT, MODAL_STACK, ANON_OPEN, ANON_PANELS, modules, curEntity,
 * post, escXml, short and window._curBounds / window._axAnns / window.fzAddRow (state passed to inline onclick
 * handlers). Anonymous individuals (blank nodes used as annotation values / assertion targets, pseudo-IRI "_:<id>",
 * kind 'anon') are rendered as inline cards (anonCard) and created from the dialogs through a mini description
 * panel (anonPanelHtml) whose "+" buttons open the usual dialogs on top of the current one (modalPush).
 * Uses from core.js: $, esc, api, dot, entLink, KC, KCF, KL, selIri, listKind, loadList, scopeGraph,
 * ixRefresh, ixWasRunning; from axioms.js: ontoData, activeOnt, renderOntology; from query.js: attachAutocomplete.
 *
 * DOM ids owned: #modal, #modalbox, #ferr, #fok (modal form); #chchip, #chlist
 * (pending changes); #detail, #etabs, #instances, #usage (entity view); #fzprev, #fzval, #fmprev, #fmval, #fzrows
 * (fuzzy forms, inside #modalbox).
 */

// ---------- fuzzy rendering ----------
const CLASSNS = 'http://www.semanticweb.org/ontologies/fuzzydl_ontology/class#';
/**
 * Parse the XML of a fuzzyLabel annotation (<fuzzyOwl2 fuzzyType="…">…</fuzzyOwl2>).
 * @param {string} xml Literal value of the sdf:fuzzyLabel annotation.
 * @returns {?Object} One of:
 *   {kind:'datatype', type:'leftshoulder'|'rightshoulder'|'triangular'|'trapezoidal'|'crisp'|'linear'|'modified', p:{a,b,c,d}}
 *   {kind:'weighted', type:'weightedSum'|'weightedSumZero'|'weightedMinimum'|'weightedMaximum', parts:[{w, base}]}
 *   {kind:'weighted', type:'OWA', parts:[{w, iri}]}   (Name elements may contain "Class(<iri>)")
 *   {kind:'modifier', type:'linear'|'triangular', p:{a,b,c}}
 *   {kind:'logic', logic:string}   (ontology-level fuzzy logic)
 *   or null when the XML is not recognised (other concept types, e.g. qowa/choquet, also yield null).
 */
function parseFuzzy(xml) {
	try {
		const doc = new DOMParser().parseFromString(xml, 'text/xml');
		const root = doc.querySelector('fuzzyOwl2');
		if (!root) return null;
		const ft = root.getAttribute('fuzzyType');
		if (ft === 'datatype') {
			const d = root.querySelector('Datatype');
			if (!d) return null;
			const p = {};
			for (const k of ['a', 'b', 'c', 'd']) {
				const v = d.getAttribute(k);
				if (v != null) p[k] = parseFloat(v);
			}
			return { kind: 'datatype', type: d.getAttribute('type'), p };
		}
		if (ft === 'concept') {
			const c = root.querySelector('Concept');
			if (!c) return null;
			const t = c.getAttribute('type');
			if (t.startsWith('weighted')) {
				const parts = [...c.querySelectorAll('Concept[type="weighted"]')].map((w) => ({
					w: parseFloat(w.getAttribute('value')),
					base: w.getAttribute('base')
				}));
				return { kind: 'weighted', type: t, parts };
			}
			if (t === 'owa') {
				const ws = [...c.querySelectorAll('Weight')].map((x) => parseFloat(x.textContent));
				const names = [...c.querySelectorAll('Name')].map((x) => {
					// "Class(<iri>)" wrapper (as written by the FuzzyDL exporter) → keep only the IRI
					const m = x.textContent.match(/Class\(([^)]+)\)/);
					return m ? m[1] : x.textContent;
				});
				return { kind: 'weighted', type: 'OWA', parts: ws.map((w, i) => ({ w, iri: names[i] })) };
			}
		}
		if (ft === 'modifier') {
			const m = root.querySelector('Modifier');
			if (!m) return null;
			const p = {};
			for (const k of ['a', 'b', 'c']) {
				const v = m.getAttribute(k);
				if (v != null) p[k] = parseFloat(v);
			}
			return { kind: 'modifier', type: m.getAttribute('type'), p };
		}
		if (ft === 'ontology') {
			const l = root.querySelector('Fuzzylogic');
			return { kind: 'logic', logic: l ? l.getAttribute('logic') : '?' };
		}
	} catch (e) {}
	return null;
}
// membership μ(x) of a datatype shape over domain [k1,k2]
/**
 * Membership degree μ(x) of a fuzzy datatype (fuzzy-dl-owl2 semantics).
 * @param {string} type Shape: leftshoulder | rightshoulder | triangular | trapezoidal | crisp | linear.
 * @param {{a?:number,b?:number,c?:number,d?:number}} p Shape parameters.
 * @param {number} x Input value.
 * @param {number} k1 Domain minimum (only used by 'linear', whose (a,b) knee is on the normalised domain).
 * @param {number} k2 Domain maximum.
 * @returns {number} Degree in [0,1] (0 for unknown shapes).
 */
function muDatatype(type, p, x, k1, k2) {
	const { a, b, c, d } = p;
	if (type === 'leftshoulder') return x <= a ? 1 : x >= b ? 0 : (b - x) / (b - a);
	if (type === 'rightshoulder') return x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a);
	if (type === 'triangular') return x <= a || x >= c ? 0 : x <= b ? (x - a) / (b - a) : (c - x) / (c - b);
	if (type === 'trapezoidal') return x <= a || x >= d ? 0 : x < b ? (x - a) / (b - a) : x <= c ? 1 : (d - x) / (d - c);
	if (type === 'crisp') return x >= a && x <= b ? 1 : 0;
	// linear: normalise x to t ∈ [0,1], then piecewise ramp (0,0)→(a,b)→(1,1)
	if (type === 'linear') {
		const t = (x - k1) / (k2 - k1 || 1);
		return t <= 0 ? 0 : t >= 1 ? 1 : t <= a ? (b / a) * t : (t * (1 - b) + b - a) / (1 - a);
	}
	return 0;
}
/**
 * Apply a fuzzy modifier to a degree: μ'(y) = modifier(y).
 * @param {string} type 'linear' (parameter c > 0; knee at a=c/(c+1), b=1/(c+1)) or 'triangular' (a,b,c on [0,1]).
 * @param {{a?:number,b?:number,c:number}} p Modifier parameters.
 * @param {number} y Input degree in [0,1].
 * @returns {number} Modified degree.
 */
function muModifier(type, p, y) {
	if (type === 'linear') {
		const c = p.c,
			a = c / (c + 1),
			b = 1 / (c + 1);
		return y <= 0 ? 0 : y >= 1 ? 1 : y <= a ? (b / a) * y : (y * (1 - b) + b - a) / (1 - a);
	}
	const { a, b, c } = p;
	return y <= a || y >= c ? 0 : y <= b ? (y - a) / (b - a) : (c - y) / (c - b);
}
/**
 * Estimated plotting domain when the datatype has no explicit [k1,k2]: the parameter range padded by 30 % each side.
 * @param {Object<string,number>} p Shape parameters.
 * @returns {[number, number]} [x0, x1].
 */
function domainOf(p) {
	const ps = Object.values(p);
	const mn = Math.min(...ps),
		mx = Math.max(...ps),
		span = mx - mn || 10;
	return [mn - span * 0.3, mx + span * 0.3];
}
/**
 * Generic line chart of one or more curves y(x) ∈ [0,1] over [x0,x1] (used for the "modified datatype" preview).
 * @param {{pts:number[][], color:string, dash?:boolean}[]} series Polylines as [[x,y],…]; dashed ones are thinner.
 * @param {number} x0 Left bound of the x axis (labelled "k1=").
 * @param {number} x1 Right bound (labelled "k2=").
 * @param {string} title Text drawn above the chart (escaped).
 * @returns {string} Inline <svg> markup (430×180).
 */
function curvesSVG(series, x0, x1, title) {
	// series: [{pts:[[x,y]...], color, dash}]
	const W = 430,
		H = 168,
		L = 34,
		R = 14,
		T = 14,
		B = 36,
		iw = W - L - R,
		ih = H - T - B;
	const X = (x) => (L + ((x - x0) / (x1 - x0 || 1)) * iw).toFixed(1),
		Y = (y) => (T + (1 - y) * ih).toFixed(1);
	const paths = series
		.map(
			(s) =>
				`<path d="${s.pts.map((q, i) => (i ? 'L' : 'M') + X(q[0]) + ' ' + Y(q[1])).join(' ')}" fill="none" stroke="${s.color}" stroke-width="${s.dash ? 1.5 : 2.2}" ${s.dash ? 'stroke-dasharray="4 3"' : ''}/>`
		)
		.join('');
	const fmt = (v) => (Number.isInteger(v) ? v : v.toFixed(1));
	return `<svg width="${W}" height="${H + 12}" style="background:#fcfdff;border:1px solid var(--line);border-radius:8px"><text x="${W / 2}" y="11" text-anchor="middle" font-size="10" fill="#66727f">${esc(title)}</text><g transform="translate(0,12)"><line x1="${L}" y1="${Y(1)}" x2="${W - R}" y2="${Y(1)}" stroke="#e4e8ee" stroke-dasharray="3 3"/><line x1="${L}" y1="${Y(0)}" x2="${W - R}" y2="${Y(0)}" stroke="#aab2bd"/><line x1="${L}" y1="${Y(0)}" x2="${L}" y2="${T}" stroke="#aab2bd"/><text x="${L - 6}" y="${+Y(1) + 4}" text-anchor="end" font-size="10" fill="#66727f">1</text><text x="${L - 6}" y="${+Y(0) + 4}" text-anchor="end" font-size="10" fill="#66727f">0</text><text x="${L}" y="${+Y(0) + 14}" font-size="10" fill="#66727f">k1=${fmt(x0)}</text><text x="${W - R}" y="${+Y(0) + 14}" text-anchor="end" font-size="10" fill="#66727f">k2=${fmt(x1)}</text>${paths}</g></svg>`;
}
/**
 * Asynchronously render the curve of a "modified" fuzzy datatype: μ'(x) = modifier(μ_base(x)).
 * Fetches both entities with GET /api/entity, reads their fuzzyLabel, samples 161 points over the base
 * domain (bounds of the base datatype, else domainOf) and writes a curvesSVG (dashed base, solid result)
 * or an explanatory message into the target element.
 * @param {string} modIri IRI of the modifier datatype.
 * @param {string} baseIri IRI of the base fuzzy datatype.
 * @param {string} target CSS selector of the container (e.g. '#fzprev' or '#mp…').
 * @returns {void}
 */
function modifiedPreview(modIri, baseIri, target) {
	// μ'(x) = modifier(μ_base(x))
	Promise.all([api('/api/entity', { iri: modIri }), api('/api/entity', { iri: baseIri })]).then(([m, b]) => {
		// parsed fuzzyLabel of an entity payload (null when absent)
		const fl = (d) => {
			const g = (d.out || []).find((x) => x.pred === (fuzzyLbl() || 'fuzzyLabel'));
			return g ? parseFuzzy(g.values[0].lit) : null;
		};
		const fm = fl(m),
			fb = fl(b);
		if (m.error || !fm || fm.kind !== 'modifier') {
			$(target).innerHTML =
				`<span class="dt">${m.error ? 'modifier not found' : 'the chosen modifier has no fuzzyLabel of type modifier'}</span>`;
			return;
		}
		if (b.error || !fb || fb.kind !== 'datatype' || fb.type === 'modified') {
			$(target).innerHTML =
				`<span class="dt">${b.error ? 'base datatype not found' : 'the base datatype must be a fuzzy datatype with an explicit function'}</span>`;
			return;
		}
		const bd = b.bounds && b.bounds.kmin != null && b.bounds.kmax != null;
		const [x0, x1] = bd ? [b.bounds.kmin, b.bounds.kmax] : domainOf(fb.p);
		const N = 160,
			base = [],
			mod = [];
		for (let i = 0; i <= N; i++) {
			const x = x0 + ((x1 - x0) * i) / N;
			const y = muDatatype(fb.type, fb.p, x, x0, x1);
			base.push([x, y]);
			mod.push([x, muModifier(fm.type, fm.p, y)]);
		}
		$(target).innerHTML = curvesSVG(
			[
				{ pts: base, color: '#aab2bd', dash: true },
				{ pts: mod, color: '#7a4bb3' }
			],
			x0,
			x1,
			`${short(modIri)}(${short(baseIri)}) — dashed: ${fb.type}${bd ? '' : ' (estimated domain)'}`
		);
	});
}
/**
 * SVG plot of a membership function when the datatype domain is unknown (x-range estimated from the parameters).
 * @param {string} type leftshoulder | rightshoulder | trapezoidal | triangular (other shapes → null).
 * @param {Object<string,number>} p Shape parameters {a,b,c,d}; each one gets a tick label on the x axis.
 * @returns {?string} Inline <svg> (430×168) or null if the shape cannot be drawn.
 */
function fuzzySVG(type, p) {
	const ps = Object.values(p),
		mn = Math.min(...ps),
		mx = Math.max(...ps);
	const span = mx - mn || 10,
		x0 = mn - span * 0.3,
		x1 = mx + span * 0.3;
	let pts;
	if (type === 'leftshoulder')
		pts = [
			[x0, 1],
			[p.a, 1],
			[p.b, 0],
			[x1, 0]
		];
	else if (type === 'rightshoulder')
		pts = [
			[x0, 0],
			[p.a, 0],
			[p.b, 1],
			[x1, 1]
		];
	else if (type === 'trapezoidal')
		pts = [
			[x0, 0],
			[p.a, 0],
			[p.b, 1],
			[p.c, 1],
			[p.d, 0],
			[x1, 0]
		];
	else if (type === 'triangular')
		pts = [
			[x0, 0],
			[p.a, 0],
			[p.b, 1],
			[p.c, 0],
			[x1, 0]
		];
	else return null;
	const W = 430,
		H = 168,
		L = 34,
		R = 14,
		T = 14,
		B = 36,
		iw = W - L - R,
		ih = H - T - B;
	const X = (x) => (L + ((x - x0) / (x1 - x0)) * iw).toFixed(1),
		Y = (y) => (T + (1 - y) * ih).toFixed(1);
	const path = pts.map((q, i) => (i ? 'L' : 'M') + X(q[0]) + ' ' + Y(q[1])).join(' ');
	const area = path + ` L${X(x1)} ${Y(0)} L${X(x0)} ${Y(0)} Z`;
	const ticks = Object.entries(p)
		.map(
			([k, v]) =>
				`<line x1="${X(v)}" y1="${Y(0)}" x2="${X(v)}" y2="${+Y(0) + 4}" stroke="#66727f"/>` +
				`<text x="${X(v)}" y="${+Y(0) + 16}" text-anchor="middle" font-size="10" fill="#66727f">${k}=${v}</text>`
		)
		.join('');
	return (
		`<svg width="${W}" height="${H}" style="background:#fcfdff;border:1px solid var(--line);border-radius:8px">` +
		`<line x1="${L}" y1="${Y(1)}" x2="${W - R}" y2="${Y(1)}" stroke="#e4e8ee" stroke-dasharray="3 3"/>` +
		`<line x1="${L}" y1="${Y(0)}" x2="${W - R}" y2="${Y(0)}" stroke="#aab2bd"/>` +
		`<line x1="${L}" y1="${Y(0)}" x2="${L}" y2="${T}" stroke="#aab2bd"/>` +
		`<text x="${L - 6}" y="${+Y(1) + 4}" text-anchor="end" font-size="10" fill="#66727f">1</text>` +
		`<text x="${L - 6}" y="${+Y(0) + 4}" text-anchor="end" font-size="10" fill="#66727f">0</text>` +
		`<path d="${area}" fill="rgba(52,87,176,.12)"/>` +
		`<path d="${path}" fill="none" stroke="#3457b0" stroke-width="2.2" stroke-linejoin="round"/>` +
		ticks +
		`<text x="${(L + W - R) / 2}" y="${H - 3}" text-anchor="middle" font-size="10" fill="#66727f">μ(x) — ${type}</text></svg>`
	);
}
/**
 * Render a fuzzyLabel literal in the Annotations panel: a graphical view (membership function, modifier
 * curve, weighted bars, fuzzy logic name) followed by a collapsible <details> with the raw XML.
 * Datatypes use the domain of the current entity (window._curBounds, set by show()) when available.
 * "modified" datatypes get a placeholder <div id="mp…"> filled asynchronously by modifiedPreview().
 * A datatype plot with known domain becomes an editable plot (draggable parameter handles).
 * @param {string} lit The fuzzy annotation XML literal. @param {string} [graph] Module of the annotation.
 * @returns {string} HTML.
 */
function fuzzyRender(lit, graph) {
	const f = parseFuzzy(lit);
	const raw = `<details style="margin-top:4px"><summary class="expand">XML fuzzyOwl2</summary><pre class="lit dt">${esc(lit.trim())}</pre></details>`;
	if (!f) return `<span class="lit">${esc(lit)}</span>`;
	if (f.kind === 'datatype') {
		if (f.type === 'modified') {
			// modifier="…" and base="…" attributes in either order; the names are local names in the datatype namespace
			const m = /modifier="([^"]+)"[^>]*base="([^"]+)"/.exec(lit) || /base="([^"]+)"[^>]*modifier="([^"]+)"/.exec(lit);
			const id = 'mp' + Math.random().toString(36).slice(2);
			if (m) {
				const mod = NS.datatype + m[1],
					base = NS.datatype + m[2];
				setTimeout(() => modifiedPreview(mod, base, '#' + id), 0);
				return (
					`<div>modified: <a class="ent" onclick="show('${encodeURIComponent(mod)}')">${esc(m[1])}</a>(<a class="ent" onclick="show('${encodeURIComponent(base)}')">${esc(m[2])}</a>)</div><div id="${id}"></div>` +
					raw
				);
			}
			return `<span class="lit">${esc(lit)}</span>` + raw;
		}
		const bd = window._curBounds;
		if (graph !== undefined && bd && bd.kmin != null && bd.kmax != null && FZ_MU[f.type])
			return fzEditablePlot(f, bd, lit, graph) + raw;
		const svg =
			bd && bd.kmin != null && bd.kmax != null
				? fuzzySVGdomain(f.type, Object.assign({}, f.p, { k1: bd.kmin, k2: bd.kmax }))
				: fuzzySVG(f.type, f.p);
		return (svg || `<span class="lit">${esc(lit)}</span>`) + raw;
	}
	if (f.kind === 'modifier') {
		const v = { type: f.type, a: f.p.a, b: f.p.b, c: f.p.c };
		return `<div class="dt">fuzzy modifier: <b>${esc(f.type)}</b></div>` + modifierSVG(v) + raw;
	}
	if (f.kind === 'weighted') {
		// one row per component: weight, proportional bar (260px = weight 1), link to the class
		const rows = f.parts
			.map((pt) => {
				const name = pt.base || short(pt.iri || '');
				const iri = pt.iri || CLASSNS + pt.base;
				return (
					`<div style="display:flex;align-items:center;gap:8px;margin:2px 0">` +
					`<span style="width:42px;text-align:right;font-size:12px;color:var(--dim)">${pt.w}</span>` +
					`<div style="height:12px;width:${Math.round(pt.w * 260)}px;background:#3457b0;opacity:.7;border-radius:3px"></div>` +
					`<a class="ent" onclick="show('${encodeURIComponent(iri)}')">${esc(name)}</a></div>`
				);
			})
			.join('');
		return (
			`<div><div class="dt" style="margin-bottom:3px">fuzzy aggregation: <b>${esc(f.type)}</b></div>${rows}</div>` + raw
		);
	}
	if (f.kind === 'logic') return `<span class="lit">Fuzzy logic of the ontology: <b>${esc(f.logic)}</b></span>` + raw;
	return `<span class="lit">${esc(lit)}</span>`;
}
/**
 * Local name of an IRI (text after the last '#' or '/'); the node id of the "_:<id>" pseudo-IRI of an anonymous individual.
 * @param {string} iri
 * @returns {string}
 */
function short(iri) {
	return iri.startsWith('_:') ? iri.slice(2) : iri.split('#').pop().split('/').pop();
}

// ---------- editing: generic modal form ----------
/** Default namespace per entity kind, used to build IRIs from local names typed in the forms (see toIri). */
const NS = {
	class: 'http://www.semanticweb.org/ontologies/fuzzydl_ontology/class#',
	objprop: 'http://www.semanticweb.org/ontologies/fuzzydl_ontology/object-property#',
	dataprop: 'http://www.semanticweb.org/ontologies/fuzzydl_ontology/data-property#',
	annprop: 'http://www.semanticweb.org/ontologies/fuzzydl_ontology#',
	datatype: 'http://www.semanticweb.org/ontologies/fuzzydl_ontology/datatype#',
	individual: 'http://www.semanticweb.org/ontologies/fuzzydl_ontology/individuals#'
};
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
	RDFS = 'http://www.w3.org/2000/01/rdf-schema#',
	OWLNS = 'http://www.w3.org/2002/07/owl#',
	XSDNS = 'http://www.w3.org/2001/XMLSchema#';
// XSD datatypes offered in the "Datatype" selects of the literal forms
const XSD_TYPES = ['string', 'decimal', 'integer', 'float', 'double', 'boolean', 'dateTime', 'date', 'gYear', 'anyURI'];
// lexical forms of the checkable XSD datatypes (literalValid); string-like and declared datatypes always pass
const XSD_LEXICAL = (() => {
	const int = /^[+-]?\d+$/,
		dec = /^[+-]?(\d+\.?\d*|\.\d+)$/,
		flt = /^([+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?|[+-]?INF|NaN)$/,
		nonneg = /^(\+?\d+|-0+)$/,
		tz = '(Z|[+-]\\d\\d:\\d\\d)?$';
	return {
		decimal: dec,
		float: flt,
		double: flt,
		integer: int,
		long: int,
		int: int,
		short: int,
		byte: int,
		nonNegativeInteger: nonneg,
		unsignedLong: nonneg,
		unsignedInt: nonneg,
		unsignedShort: nonneg,
		unsignedByte: nonneg,
		positiveInteger: /^\+?0*[1-9]\d*$/,
		negativeInteger: /^-0*[1-9]\d*$/,
		nonPositiveInteger: /^(-\d+|\+?0+)$/,
		boolean: /^(true|false|0|1)$/,
		dateTime: new RegExp('^-?\\d{4,}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d(\\.\\d+)?' + tz),
		dateTimeStamp: /^-?\d{4,}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/,
		date: new RegExp('^-?\\d{4,}-\\d\\d-\\d\\d' + tz),
		time: new RegExp('^\\d\\d:\\d\\d:\\d\\d(\\.\\d+)?' + tz),
		gYear: new RegExp('^-?\\d{4,}' + tz),
		gYearMonth: new RegExp('^-?\\d{4,}-\\d\\d' + tz),
		anyURI: /^\S+$/
	};
})();
/**
 * Check the lexical form of a literal against an XSD datatype.
 * @param {string} value Literal text.
 * @param {string} dt Datatype IRI ('' / null = untyped).
 * @returns {?string} An error message ("not a valid xsd:decimal") or null when the value is acceptable (unknown and
 *   declared datatypes are not checked).
 */
function literalValid(value, dt) {
	if (!dt || !dt.startsWith(XSDNS)) return null;
	const re = XSD_LEXICAL[short(dt)];
	return re && !re.test(value.trim()) ? `not a valid xsd:${short(dt)}` : null;
}
/**
 * Text of a literal for the previews and the local lists: "value"^^xsd:type, "value"@lang or plain "value".
 * @param {string} lit Literal text. @param {?string} dt Datatype IRI. @param {?string} lang Language tag.
 * @returns {string} Plain text (not escaped).
 */
const litText = (lit, dt, lang) => JSON.stringify(lit) + (dt ? '^^' + xdName(dt) : lang ? '@' + lang : '');
let modules = []; // module file names of the workspace (also refreshed by loadOverview in core.js)
api('/api/overview', {}).then((d) => {
	modules = d.modules || [];
});
/**
 * POST a JSON body to an API endpoint.
 * @param {string} p URL path.
 * @param {Object} body Serialised as JSON.
 * @returns {Promise<Object>} Parsed JSON response (errors come back as {error}).
 */
const post = (p, body) =>
	fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) =>
		r.json()
	);

// fields: [{name,label,type:'text'|'textarea'|'select'|'entity'|'module'|'html', options:[[v,l]], kind, value, required}]
// per-field autocomplete options (null = free text, no suggestions)
// keyed by field name: an attachAutocomplete() options object, or null to disable suggestions on that field
const FIELD_AC = {
	lang: { entities: false, keywords: false, statics: ['en', 'it', 'fr', 'de', 'es', 'pt'] },
	ns: {
		entities: false,
		keywords: false,
		get statics() {
			return Object.values(NS);
		}
	},
	degree: {
		entities: false,
		keywords: false,
		statics: ['0.0', '0.1', '0.2', '0.25', '0.3', '0.4', '0.5', '0.6', '0.7', '0.75', '0.8', '0.9', '1.0']
	},
	name: null,
	label: null,
	comment: null,
	lit: null,
	value: null,
	k1: null,
	k2: null,
	a: null,
	b: null,
	c: null,
	d: null,
	dt: null,
	p: null,
	pc: null,
	o: null,
	modifier: null,
	mbase: null,
	base: null,
	shape: null,
	type: null,
	graph: null,
	kind: null,
	what: null,
	scope: null,
	prop: null,
	iri: null
};
/**
 * Open the generic modal form (#modal / #modalbox) and wire its OK button.
 * @param {string} title Heading (raw HTML).
 * @param {Object[]} fields Field descriptors, see the comment above: {name, label, type, options, kind, value, required, placeholder, html}.
 *   type 'entity' renders a search picker (bindPicker) whose value is resolved to an IRI by pickVal;
 *   type 'module' renders a select of the workspace modules; type 'html' inserts raw markup.
 * @param {function(Object): (Object|Promise<Object>)} onSubmit Receives {fieldName: value}; a result with .error keeps the
 *   form open and shows the message in #ferr, anything else closes it.
 * @param {string} [note] Optional help text (raw HTML) shown under the title.
 * @returns {void}
 * Side effects: after a successful submit calls refreshChanges(), re-shows the selected entity (selIri) and reloads the sidebar list.
 */
function openForm(title, fields, onSubmit, note) {
	const box = $('#modalbox');
	box.innerHTML =
		`<h3>${title}</h3>` +
		(note ? `<div class="dt">${note}</div>` : '') +
		fields
			.map((f) => {
				if (f.type === 'html') return f.html;
				let inp;
				if (f.type === 'textarea') inp = `<textarea name="${f.name}" rows="3">${esc(f.value || '')}</textarea>`;
				else if (f.type === 'select')
					inp = `<select name="${f.name}">${(f.options || []).map(([v, l]) => `<option value="${esc(v)}" ${v === f.value ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
				else if (f.type === 'module')
					inp = `<select name="${f.name}">${modules.map((m) => `<option value="${esc(m)}" ${m === f.value ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select>`;
				else if (f.type === 'entity')
					inp = `<div class="picker"><input name="${f.name}" autocomplete="off" placeholder="search ${f.kind || 'entity'}… (or paste an IRI)" value="${esc(f.value && f.value.startsWith('http') ? short(f.value) : f.value || '')}" data-iri="${esc(f.value && f.value.startsWith('http') ? f.value : '')}" data-kind="${f.kind || ''}" title="${esc(f.value || '')}"><div class="res"></div></div>`;
				else
					inp = `<input name="${f.name}" value="${esc(f.value || '')}" ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''}>`;
				return `<label>${f.label}${f.required ? ' *' : ''}</label>${inp}`;
			})
			.join('') +
		`<div class="err" id="ferr"></div><div class="actions"><button onclick="closeForm()" title="${tip('form', 'cancel')}">Cancel</button><button class="primary" id="fok" title="${tip('form', 'ok')}">OK</button></div>`;
	box.querySelectorAll('.picker input').forEach((inp) => bindPicker(inp, inp.dataset.kind));
	// context-aware autocomplete on every free text field of the form
	box.querySelectorAll('input[name]:not([type=checkbox]):not(.pk),textarea[name]').forEach((el) => {
		const n = el.name;
		const o = FIELD_AC[n];
		if (o === null) return;
		if (o) {
			attachAutocomplete(el, o);
			return;
		}
		// Manchester-syntax fields (expr, sub) get the DL keywords; chain/keys/cls are name lists restricted to the relevant kinds
		if (/^(expr|sub|text|chain|keys|cls)$/.test(n))
			attachAutocomplete(el, {
				keywords: n === 'expr' || n === 'sub',
				statics: n === 'chain' ? ['o'] : [],
				kinds: n === 'chain' ? ['objprop'] : n === 'keys' ? ['dataprop', 'objprop'] : n === 'cls' ? ['class'] : null
			});
	});
	$('#modal').style.display = 'flex';
	// OK: collect values, check required fields, run onSubmit (sync or promise), then refresh the views
	$('#fok').onclick = () => {
		const v = {};
		box.querySelectorAll('[name]').forEach((el) => (v[el.name] = pickVal(el)));
		for (const f of fields)
			if (f.required && !v[f.name]) {
				$('#ferr').textContent = 'Required field: ' + f.label;
				return;
			}
		Promise.resolve(onSubmit(v))
			.then((r) => {
				if (r && r.error) {
					$('#ferr').textContent = r.error;
					return;
				}
				closeForm();
				refreshChanges();
				if (selIri) show(encodeURIComponent(selIri));
				loadList();
			})
			.catch((e) => {
				$('#ferr').textContent = String(e);
			});
	};
}
/** Dialogs parked by modalPush while a nested one is open: {nodes, wide, xd, onRestore}, innermost last. */
const MODAL_STACK = [];
/**
 * Open the next dialog ON TOP of the current one: the content of #modalbox and the expression-dialog state (xdState)
 * are parked until the nested dialog closes; closeForm then pops them back and calls `onRestore` (e.g. to redraw a
 * list that changed). Call it right before the openForm / exprDialog / annotationDialog of the nested dialog.
 * @param {function} [onRestore] Callback run once the parked dialog is back in the DOM.
 * @returns {void}
 */
function modalPush(onRestore) {
	const box = $('#modalbox');
	MODAL_STACK.push({ nodes: [...box.childNodes], wide: box.classList.contains('wide'), xd: xdState, onRestore });
	box.innerHTML = '';
	box.classList.remove('wide');
	xdState = null; // the nested dialog gets its own state; the parked one comes back with modalPop
}
/**
 * Put the dialog parked by the last modalPush back into #modalbox.
 * @returns {boolean} false when no dialog was parked.
 */
function modalPop() {
	const top = MODAL_STACK.pop();
	if (!top) return false;
	const box = $('#modalbox');
	box.innerHTML = '';
	top.nodes.forEach((n) => box.appendChild(n));
	box.classList.toggle('wide', top.wide);
	xdState = top.xd;
	if (top.onRestore) top.onRestore();
	return true;
}
/** Close the current dialog: back to the parked one (modalPush) if any, else hide the modal (#modal). @returns {void} */
function closeForm() {
	if (modalPop()) return;
	$('#modal').style.display = 'none';
	$('#modalbox').classList.remove('wide');
}
// entity pickers: the visible value is the local name, the IRI lives in data-iri
/**
 * Value of a form control. For entity pickers returns the picked IRI (data-iri) when the visible text still
 * matches its local name, otherwise the typed text (a local name or a pasted IRI).
 * @param {HTMLElement} el input / textarea / select with a name attribute.
 * @returns {string}
 */
function pickVal(el) {
	const v = el.value.trim();
	if (el.classList.contains('pk') || el.closest('.picker'))
		return el.dataset.iri && short(el.dataset.iri) === v ? el.dataset.iri : v;
	return v;
}
/**
 * Turn an input into an entity search picker: typing ≥2 chars (not starting with "http") queries
 * GET /api/search (debounced 200 ms, timer in inp._t) and lists matches in the sibling .res dropdown;
 * choosing one stores the IRI in data-iri / title, shows the local name and fires a 'change' event.
 * @param {HTMLInputElement} inp The input (gets class "pk"); its next sibling must be the .res container.
 * @param {string} [kind] Restrict results to this entity kind ('' / undefined = any).
 * @param {function(string, string)} [onPick] Optional callback (iri, name) after a choice.
 * @returns {void}
 */
function bindPicker(inp, kind, onPick) {
	inp.classList.add('pk');
	const res = inp.nextElementSibling;
	inp.addEventListener('input', () => {
		inp.dataset.iri = '';
		inp.title = '';
		clearTimeout(inp._t);
		const q = inp.value;
		if (q.length < 2 || q.startsWith('http')) {
			res.style.display = 'none';
			return;
		}
		inp._t = setTimeout(
			() =>
				api('/api/search', { q }).then((d) => {
					const items = d.items.filter((n) => !kind || n.kind === kind);
					res.innerHTML =
						items
							.map(
								(n) =>
									`<div data-iri="${esc(n.iri)}" data-name="${esc(n.name)}" title="${esc(n.iri)}">${dot(n.kind, n.fuzzy)}${esc(n.name)} <span class="dt">${KL[n.kind] || ''}${n.fuzzy ? ' · fuzzy' : ''}</span></div>`
							)
							.join('') || '<div class="dt">no results</div>';
					res.style.display = 'block';
					res.querySelectorAll('div[data-iri]').forEach(
						(el) =>
							(el.onclick = () => {
								inp.dataset.iri = el.dataset.iri;
								inp.value = el.dataset.name;
								inp.title = el.dataset.iri;
								res.style.display = 'none';
								inp.dispatchEvent(new Event('change', { bubbles: true }));
								if (onPick) onPick(el.dataset.iri, el.dataset.name);
							})
					);
				}),
			200
		);
	});
}
/**
 * Resolve a form value to an IRI: full IRIs pass through, local names are prefixed with the namespace of the kind
 * (NS[kind], default the individuals namespace) with whitespace replaced by '_'.
 * @param {string} v Local name or IRI (falsy values are returned unchanged).
 * @param {string} kind Entity kind key of NS.
 * @returns {string}
 */
function toIri(v, kind) {
	if (!v) return v;
	if (v.startsWith('http')) return v;
	return (NS[kind] || NS.individual) + v.replace(/\s+/g, '_');
}

// ---------- editing: actions ----------
// help text shown under every form that accepts a Manchester-syntax expression
const MANCHESTER_HINT =
	'Manchester syntax: <code>A and B</code>, <code>A or B</code>, <code>not A</code>, <code>p some C</code>, <code>p only C</code>, <code>p value x</code>, <code>p min 2 C</code>, <code>{a, b}</code>, data ranges <code>xsd:integer[&gt;= 200, &lt;= 1000]</code>; names are the local names of the workspace entities (quote names with spaces).';
/**
 * "+" buttons of the entity view: open the form for adding an axiom/assertion about entity `s`.
 * First GET /api/graph_of {iri} to preselect the module declaring the entity as target, then dispatches
 * on `what` (one branch per section of the ontology-editor-like panels; the sections of classes and
 * properties open the tabbed dialogs of exprDialog, titled with the entity name):
 *   type, rel, data, ann                       → POST /api/edit/add (rdf:type, object/data property assertion, annotation)
 *   sub, equiv, disj, domain, range            → class expression dialog: named entity via /api/edit/add or
 *                                                Manchester expression via /api/edit/expr (data property ranges:
 *                                                datatype list + data range editor)
 *   inverse, subprop, equivprop, disjprop      → property tree dialog: named property via /api/edit/add, `inverse P`
 *                                                / property expression via /api/edit/expr
 *   adomain, arange, asuper                    → class tree / datatype list / raw IRI / annotation property tree → /api/edit/add
 *   type_inst                                  → instances dialog: one rdf:type per selected individual (/api/edit/add;
 *                                                new individuals first via /api/edit/create)
 *   gca (general class axiom), dtdef           → POST /api/edit/expr
 *   chain, haskey, disjunion                   → POST /api/edit/collection (members resolved server-side)
 *   char, sameas, different                    → POST /api/edit/add
 *   negobj, negdata                            → POST /api/edit/negative
 * The object property assertion dialog (rel) offers an "Anonymous individual" toggle: the target is then a new
 * anonymous individual described in a mini panel, sent as `o_anon` (see anonPanelSpec).
 * @param {?string} s Subject entity IRI (a named entity or the "_:<id>" of an anonymous individual); null when the
 *   assertion is collected for a NOT yet existing anonymous individual (mini panel: no target module lookup, generic title).
 * @param {string} kind Kind of the subject (class | objprop | dataprop | annprop | datatype | individual).
 * @param {string} what Which axiom to add (see above).
 * @param {function(string, Object): (Object|Promise<Object>)} [submit] Replacement of post(url, payload): receives the
 *   request the dialog would send and returns the result ({error} keeps the dialog open); used by the mini panel
 *   to append the assertion to its local list instead of posting it.
 * @returns {void}
 */
function addAssertion(s, kind, what, submit) {
	const target = { type: 'module', name: 'graph', label: 'Target module' };
	const send = submit || post; // where the dialogs deliver their payload
	(s ? api('/api/graph_of', { iri: s }) : Promise.resolve({})).then((g) => {
		target.value = g.graph || modules[0];
		const cur = curEntity && curEntity.d && curEntity.d.node;
		// dialog title = the displayed entity name (a not yet existing anonymous individual has none)
		const title = !s ? 'Anonymous individual' : cur && cur.iri === s ? cur.name : short(s);
		// property axiom from a property tree / expression tab: named property → triple, `inverse P` or a typed
		// property expression → /api/edit/expr (property expressions are resolved server-side)
		const propAxiom = (pred) => (r) =>
			r.inverse || r.expr
				? post('/api/edit/expr', { s, expr: r.expr || `inverse <${r.o}>`, p: pred, kind, graph: r.graph })
				: post('/api/edit/add', { s, p: pred, o: r.o, graph: r.graph });
		// individuals dialog result → one assertion (s, pred, individual) per chosen individual, new ones declared first
		const eachIndividual = (pred, r) =>
			r.selected.reduce(
				(chain, it) =>
					chain.then((prev) => {
						if (prev && prev.error) return prev; // stop at the first error (shown in the dialog)
						const create = it.isNew
							? post('/api/edit/create', { kind: 'individual', iri: it.iri, label: null, graph: r.graph })
							: Promise.resolve({});
						return create.then((c) => (c && c.error ? c : post('/api/edit/add', pred(it.iri, r.graph))));
					}),
				Promise.resolve({})
			);
		if (what === 'type' && kind === 'individual')
			// class assertion: named class (tree) → rdf:type triple, class expression → /api/edit/expr
			exprDialog({
				title,
				tabs: classTabs(['expr', 'hier', 'data', 'obj']),
				graph: target.value,
				onSubmit: (r) =>
					r.o
						? send('/api/edit/add', { s, p: RDF + 'type', o: r.o, graph: r.graph })
						: send('/api/edit/expr', { s, expr: r.expr, p: RDF + 'type', kind, graph: r.graph })
			});
		else if (what === 'type')
			openForm(
				'Add type (rdf:type)',
				[{ name: 'o', label: 'Class', type: 'entity', kind: 'class', required: true }, target],
				(v) => send('/api/edit/add', { s, p: RDF + 'type', o: toIri(v.o, 'class'), graph: v.graph })
			);
		else if (what === 'rel' || what === 'negobj')
			// object property assertion (negative with negobj): property + individual, both autocompleted; the positive
			// one may target a new anonymous individual instead (toggle beside the individual field → o_anon)
			exprDialog({
				title,
				previewLabel: 'Assertion',
				tabs: [
					tabTwoInputs({
						fields: [
							{ key: 'p', label: 'Enter object property name', placeholder: 'e.g. hasCapital', kind: 'objprop' },
							{ key: 'o', label: 'Enter individual name', placeholder: 'e.g. Rome', kind: 'individual' }
						],
						anon: what === 'rel' ? 'o' : null,
						negative: what === 'negobj'
					})
				],
				graph: target.value,
				onSubmit: (r) =>
					send(what === 'rel' ? '/api/edit/add' : '/api/edit/negative', {
						s,
						p: r.p,
						o: r.o,
						o_anon: r.o_anon,
						graph: r.graph
					})
			});
		else if (what === 'data' || what === 'negdata')
			// data property assertion (negative with negdata): property tree | value, language tag, datatype
			exprDialog({
				title,
				previewLabel: 'Assertion',
				tabs: [tabDataAssertion({ negative: what === 'negdata' })],
				graph: target.value,
				onSubmit: (r) =>
					send(what === 'data' ? '/api/edit/add' : '/api/edit/negative', {
						s,
						p: r.p,
						lit: r.lit,
						dt: r.dt,
						lang: r.lang,
						graph: r.graph
					})
			});
		else if (what === 'ann')
			annotationDialog({
				title: 'Add annotation',
				s,
				file: modules[0],
				onSubmit: (payload) => send('/api/edit/add', payload)
			});
		else if (what === 'sub' || what === 'equiv' || what === 'disj' || what === 'domain' || what === 'range') {
			// named class OR a Manchester class expression
			const pred = {
				sub: RDFS + 'subClassOf',
				equiv: OWLNS + 'equivalentClass',
				disj: OWLNS + 'disjointWith',
				domain: RDFS + 'domain',
				range: RDFS + 'range'
			}[what];
			const dataRange = kind === 'dataprop' && what === 'range'; // range of a data property is a datatype / data range, not a class
			// result of the dialogs: a picked entity → plain triple, anything else → Manchester expression
			const classAxiom = (r) =>
				r.o
					? post('/api/edit/add', { s, p: pred, o: r.o, graph: r.graph })
					: post('/api/edit/expr', { s, expr: r.expr, p: pred, kind, graph: r.graph });
			// tab order of the 4-tab class expression dialog, per section
			const order = {
				'class:sub': ['hier', 'obj', 'expr', 'data'],
				'class:equiv': ['obj', 'expr', 'hier', 'data'],
				'objprop:domain': ['data', 'hier', 'expr', 'obj'],
				'objprop:range': ['expr', 'data', 'hier', 'obj'],
				'dataprop:domain': ['data', 'obj', 'expr', 'hier']
			}[kind + ':' + what];
			if (order) exprDialog({ title, tabs: classTabs(order), graph: target.value, onSubmit: classAxiom });
			else if (kind === 'class' && what === 'disj')
				exprDialog({
					title,
					tabs: [tabClassTree(), tabEditor({ title: 'Expression editor' })],
					graph: target.value,
					onSubmit: classAxiom
				});
			else if (dataRange)
				exprDialog({
					title,
					tabs: [tabDatatypeList(), tabEditor(DATA_RANGE_TAB)],
					graph: target.value,
					onSubmit: classAxiom
				});
			else
				openForm(
					{ sub: 'SubClass Of', equiv: 'Equivalent To', disj: 'Disjoint With', domain: 'Domain', range: 'Range' }[what],
					[
						{
							name: 'o',
							label: dataRange ? 'Datatype (xsd:… or a fuzzy datatype)' : 'Named class',
							type: 'entity',
							kind: dataRange ? '' : 'class'
						},
						{
							name: 'expr',
							label: dataRange ? '…or data range (Manchester syntax)' : '…or class expression (Manchester syntax)',
							type: 'textarea',
							placeholder: dataRange
								? 'xsd:decimal[>= 0, <= 100]'
								: 'TerritorialSystem and (povertyRate some LowPoverty)'
						},
						target
					],
					(v) => {
						// the expression wins over the named entity; a bare name for a data range is taken as an xsd: type
						if (v.expr && v.expr.trim())
							return post('/api/edit/expr', { s, expr: v.expr.trim(), p: pred, kind, graph: v.graph });
						if (!v.o) return { error: 'choose a named entity or write an expression' };
						return post('/api/edit/add', {
							s,
							p: pred,
							o: dataRange && !v.o.startsWith('http') ? XSDNS + v.o : toIri(v.o, 'class'),
							graph: v.graph
						});
					},
					MANCHESTER_HINT
				);
		} else if (what === 'char')
			openForm(
				'Property characteristic',
				[
					{
						name: 'o',
						label: 'Type',
						type: 'select',
						options: (kind === 'objprop'
							? [
									'FunctionalProperty',
									'InverseFunctionalProperty',
									'TransitiveProperty',
									'SymmetricProperty',
									'AsymmetricProperty',
									'ReflexiveProperty',
									'IrreflexiveProperty'
								]
							: ['FunctionalProperty']
						).map((t) => [OWLNS + t, 'owl:' + t])
					},
					target
				],
				(v) => post('/api/edit/add', { s, p: RDF + 'type', o: v.o, graph: v.graph })
			);
		else if (what === 'inverse')
			exprDialog({
				title,
				previewLabel: 'Property',
				tabs: [tabPropertyTree({ kind: 'objprop' })],
				graph: target.value,
				onSubmit: (r) => post('/api/edit/add', { s, p: OWLNS + 'inverseOf', o: r.o, graph: r.graph })
			});
		else if (what === 'subprop' && (kind === 'objprop' || kind === 'dataprop'))
			exprDialog({
				title,
				previewLabel: 'Property',
				tabs: [tabPropertyTree({ kind, inverse: kind === 'objprop' })],
				graph: target.value,
				onSubmit: propAxiom(RDFS + 'subPropertyOf')
			});
		else if (what === 'subprop')
			openForm(
				'rdfs:subPropertyOf',
				[{ name: 'o', label: 'Super-property', type: 'entity', kind, required: true }, target],
				(v) => post('/api/edit/add', { s, p: RDFS + 'subPropertyOf', o: toIri(v.o, kind), graph: v.graph })
			);
		else if (what === 'gca')
			// one text holding the whole axiom; split at the axiom keyword, both sides go to /api/edit/expr as today
			exprDialog({
				title,
				tabs: [
					tabEditor({
						label: 'General class axiom (Manchester syntax)',
						placeholder: 'povertyRate some HighPoverty SubClassOf BasicNeedsStress',
						hint:
							'Two class expressions separated by <code>SubClassOf</code>, <code>EquivalentTo</code> or <code>DisjointWith</code>. ' +
							MANCHESTER_HINT,
						ac: { statics: GCA_KW },
						preview: false
					})
				],
				graph: target.value,
				onSubmit: (r) => {
					const parts = splitGca(r.expr);
					if (!parts)
						return { error: 'write the two sides of the axiom separated by SubClassOf, EquivalentTo or DisjointWith' };
					if (!parts.sub || !parts.expr) return { error: 'both sides of the axiom are required' };
					return post('/api/edit/expr', {
						s: '',
						sub: parts.sub,
						expr: parts.expr,
						p: parts.p,
						kind: 'class',
						graph: r.graph
					});
				}
			});
		else if (what === 'sameas' || what === 'different')
			// individuals list dialog: one owl:sameAs / owl:differentFrom per chosen individual
			exprDialog({
				title,
				tabs: [tabIndividualsList()],
				graph: target.value,
				onSubmit: (r) =>
					eachIndividual(
						(iri, graph) => ({ s, p: OWLNS + (what === 'sameas' ? 'sameAs' : 'differentFrom'), o: iri, graph }),
						r
					)
			});
		else if (what === 'equivprop' && (kind === 'objprop' || kind === 'dataprop'))
			exprDialog({
				title,
				previewLabel: 'Property',
				tabs: [tabPropertyTree({ kind, inverse: kind === 'objprop' })],
				graph: target.value,
				onSubmit: propAxiom(OWLNS + 'equivalentProperty')
			});
		else if (what === 'disjprop' && (kind === 'objprop' || kind === 'dataprop'))
			// object properties: tree + property expression editor (`inverse P`); data properties: the tree only
			exprDialog({
				title,
				previewLabel: 'Property',
				tabs:
					kind === 'objprop'
						? [tabPropertyTree({ kind, title: 'Property hierarchy' }), tabEditor(PROP_EXPR_TAB)]
						: [tabPropertyTree({ kind })],
				graph: target.value,
				onSubmit: propAxiom(OWLNS + 'propertyDisjointWith')
			});
		else if (what === 'equivprop' || what === 'disjprop')
			openForm(
				what === 'equivprop' ? 'Equivalent property' : 'Disjoint property',
				[{ name: 'o', label: 'Property', type: 'entity', kind, required: true }, target],
				(v) =>
					post('/api/edit/add', {
						s,
						p: OWLNS + (what === 'equivprop' ? 'equivalentProperty' : 'propertyDisjointWith'),
						o: toIri(v.o, kind),
						graph: v.graph
					})
			);
		else if (what === 'chain')
			// "p o q [o …]" → owl:propertyChainAxiom of this property (members resolved by /api/edit/collection)
			exprDialog({
				title,
				tabs: [
					tabEditor({
						single: true,
						label: 'Property chain (property names separated by " o ")',
						placeholder: 'hasLocation o hasDistance',
						after: '→ ' + title,
						hint:
							'The chain <code>p o q</code> is a sub-property of this property: whenever x p y and y q z, then x ' +
							esc(title) +
							' z.',
						ac: { keywords: false, statics: ['o'], kinds: ['objprop'] },
						preview: false
					})
				],
				graph: target.value,
				onSubmit: (r) => {
					const items = r.expr.split(/\s+o\s+/).map((x) => x.trim());
					if (items.length < 2) return { error: 'write at least two properties separated by " o "' };
					return post('/api/edit/collection', { s, p: OWLNS + 'propertyChainAxiom', items, graph: r.graph });
				}
			});
		else if (what === 'haskey')
			// space / comma separated property names (quoted names allowed) → owl:hasKey collection
			exprDialog({
				title,
				tabs: [
					tabEditor({
						label: 'Key properties (object or data properties, separated by spaces or commas)',
						placeholder: 'hasISO3 hasName',
						rows: 4,
						hint: 'Two individuals of this class with the same values for every key property are the same individual.',
						ac: { keywords: false, kinds: ['objprop', 'dataprop'] },
						preview: false
					})
				],
				graph: target.value,
				onSubmit: (r) =>
					post('/api/edit/collection', {
						s,
						p: OWLNS + 'hasKey',
						items: r.expr.match(/'[^']*'|[^,\s]+/g) || [],
						graph: r.graph
					})
			});
		else if (what === 'disjunion')
			// classes picked in the tree (sent as <IRI>) or one class expression per line → owl:disjointUnionOf
			exprDialog({
				title,
				previewLabel: 'Members',
				tabs: [
					tabClassTree({ multi: true }),
					tabEditor({
						title: 'Expression editor',
						label: 'Class expressions (Manchester syntax, one per line)',
						placeholder: 'City\nRuralArea\nhasPopulation some LowPopulation',
						lines: true,
						rows: 8
					})
				],
				graph: target.value,
				onSubmit: (r) =>
					post('/api/edit/collection', {
						s,
						p: OWLNS + 'disjointUnionOf',
						items: r.os ? r.os.map((iri) => `<${iri}>`) : r.exprs,
						graph: r.graph
					})
			});
		else if (what === 'dtdef')
			// datatype definition: a datatype picked in the list (sent as <IRI>) or a data range → owl:equivalentClass
			exprDialog({
				title,
				previewLabel: 'Data range',
				tabs: [tabDatatypeList(), tabEditor(DATA_RANGE_TAB)],
				graph: target.value,
				onSubmit: (r) =>
					post('/api/edit/expr', {
						s,
						expr: r.expr || `<${r.o}>`,
						p: OWLNS + 'equivalentClass',
						kind: 'datatype',
						graph: r.graph
					})
			});
		else if (what === 'adomain' || what === 'arange' || what === 'asuper')
			// annotation property: class tree / datatype list / raw IRI (domain, range) or the annotation property tree (super)
			exprDialog({
				title,
				previewLabel: what === 'asuper' ? 'Property' : 'Target',
				tabs: {
					adomain: () => [tabClassTree({ title: 'Select class' }), tabRawIri()],
					arange: () => [
						tabClassTree({ title: 'Select class' }),
						tabDatatypeList({ title: 'Select datatype' }),
						tabRawIri()
					],
					asuper: () => [tabPropertyTree({ kind: 'annprop', title: 'Annotation property hierarchy' })]
				}[what](),
				graph: target.value,
				onSubmit: (r) =>
					post('/api/edit/add', {
						s,
						p: RDFS + (what === 'adomain' ? 'domain' : what === 'arange' ? 'range' : 'subPropertyOf'),
						o: r.o,
						graph: r.graph
					})
			});
		else if (what === 'type_inst')
			// one rdf:type assertion per selected individual; new individuals are declared first (/api/edit/create)
			exprDialog({
				title,
				tabs: [tabIndividualsList()],
				graph: target.value,
				onSubmit: (r) => eachIndividual((iri, graph) => ({ s: iri, p: RDF + 'type', o: s, graph }), r)
			});
	});
}

/**
 * Remove one asserted triple (row action ✕): confirms, POSTs /api/edit/remove and re-renders the entity.
 * Arguments come from argsOf(): the literal fields are null for an object triple, `o` is null for a literal.
 * @param {string} s Subject IRI. @param {string} p Predicate IRI. @param {?string} o Object IRI.
 * @param {?string} lit Literal value. @param {?string} dt Literal datatype IRI. @param {?string} lang Language tag.
 * @param {string} graph Module file holding the triple.
 * @returns {void}
 */
function removeAssertion(s, p, o, lit, dt, lang, graph) {
	if (!confirm('Remove this assertion from module ' + graph + '?')) return;
	post('/api/edit/remove', { s, p, o: o || undefined, lit: lit == null ? undefined : lit, graph }).then((r) => {
		if (r.error) alert(r.error);
		refreshChanges();
		show(encodeURIComponent(selIri));
	});
}

/**
 * Split an IRI into [namespace, local name] at the last '#' or '/'.
 * @param {string} iri
 * @returns {[string, string]}
 */
function splitIri(iri) {
	const cut = Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/')) + 1;
	return [iri.slice(0, cut), iri.slice(cut)];
}

/**
 * "Rename entity" form (row menu → rename): the namespace is kept, only the local name changes; the rename is
 * propagated to every module by /api/edit/rename and the selection follows the new IRI.
 * @param {string} iri Entity IRI.
 * @returns {void}
 */
function renameEntity(iri) {
	const [ns, local] = splitIri(iri);
	openForm(
		'Rename entity',
		[
			{ type: 'html', html: `<label>Namespace (unchanged)</label><div class="iri">${esc(ns)}</div>` },
			{ name: 'local', label: 'New local name', value: local, required: true }
		],
		(v) => {
			const iri2 = ns + v.local.replace(/\s+/g, '_');
			return post('/api/edit/rename', { iri, new_iri: iri2 }).then((r) => {
				if (!r.error) selIri = iri2;
				return r;
			});
		},
		'The rename is propagated to every module where the entity appears. The namespace is changed from the "Active Ontology" view (Ontology prefixes tab).'
	);
}

/**
 * Delete an entity with every assertion involving it, in all modules (header "delete" button), after confirmation.
 * @param {string} iri Entity IRI.
 * @returns {void}
 */
function deleteEntity(iri) {
	if (!confirm('Delete ' + iri + ' and ALL the assertions involving it (in all modules)?')) return;
	post('/api/edit/delete', { iri }).then((r) => {
		if (r.error) {
			alert(r.error);
			return;
		}
		selIri = null;
		$('#detail').innerHTML = `<div class="empty">Entity deleted (${r.removed} assertions). Remember to save.</div>`;
		refreshChanges();
		loadList();
	});
}

/**
 * Sidebar "+ new": create an entity of the current list kind. Datatypes first ask what to create (fuzzy datatype
 * with a membership function, fuzzy modifier, or a plain declaration); every other kind goes to newEntityPlain.
 * @param {string} [kind] Entity kind (default: the kind of the active sidebar list).
 * @returns {void}
 */
function newEntity(kind) {
	kind = kind || listKind();
	if (kind !== 'datatype') {
		newEntityPlain(kind);
		return;
	}
	openForm(
		'New datatype',
		[
			{
				name: 'what',
				label: 'What to create',
				type: 'select',
				options: [
					['fuzzy', 'Fuzzy datatype (membership function)'],
					['modifier', 'Fuzzy modifier'],
					['plain', 'Plain datatype (declaration only)']
				],
				value: 'fuzzy'
			}
		],
		(v) => {
			// the chosen form opens after this one has closed
			if (v.what === 'fuzzy') setTimeout(fuzzyDatatypeForm, 50);
			else if (v.what === 'modifier') setTimeout(fuzzyModifierForm, 50);
			else setTimeout(() => newEntityPlain('datatype'), 50);
			return {};
		}
	);
}
/**
 * Form for a new named entity (kind, local name or IRI, namespace, optional label, target module).
 * POST /api/edit/create {kind, iri, label, graph}; on success selIri = new IRI (the view opens it).
 * The target module defaults to the file of the active ontology (axioms.js) or the first module.
 * @param {string} kind Entity kind preselected in the "Type" select.
 * @returns {void}
 */
function newEntityPlain(kind) {
	openForm(
		'New entity: ' + (KL[kind] || kind),
		[
			{
				name: 'kind',
				label: 'Type',
				type: 'select',
				options: Object.entries(KL)
					.filter(([k]) => k !== 'ontology')
					.map(([k, l]) => [k, l]),
				value: kind
			},
			{ name: 'name', label: 'Local name (or full IRI)', required: true, placeholder: 'e.g. MyClass' },
			{ name: 'ns', label: 'Namespace (used if the name is not an IRI)', value: NS[kind] || NS.individual },
			{ name: 'label', label: 'rdfs:label (optional)' },
			{
				name: 'graph',
				label: 'Target module',
				type: 'module',
				value: activeOnt ? (ontoData?.ontologies.find((o) => o.iri === activeOnt) || {}).file : modules[0]
			}
		],
		(v) => {
			const iri = entityIri(v.name, v.ns);
			return post('/api/edit/create', { kind: v.kind, iri, label: v.label || null, graph: v.graph }).then((r) => {
				if (!r.error) selIri = iri;
				return r;
			});
		}
	);
}

// ---------- editing: pending changes ----------
/**
 * Refresh the pending-changes widget in the header: GET /api/changes ({changes:[{op,graph,s,p,o,is_lit}]}).
 * Updates the #chchip counter (class "dirty" when > 0) and CHN, lists the changes in #chlist.
 * @returns {void}
 */
let CHN = 0; // pending-changes count, kept current by refreshChanges (enables Save / Discard in the File menu)
function refreshChanges() {
	api('/api/changes', {}).then((d) => {
		const n = d.changes.length,
			chip = $('#chchip');
		CHN = n; // read by the File menu (menubar.js) to enable Save / Discard
		$('#chchiptxt').textContent = 'changes: ' + n; // the caret icon next to it must survive the update
		chip.className = 'chip chipmenu' + (n ? ' dirty' : '');
		$('#chlist').innerHTML = n
			? d.changes
					.map(
						(c) =>
							`<div class="ch"><b>${c.op}</b> <span class="dt">[${esc(c.graph || '')}]</span> ${esc(short(c.s || ''))} ${c.p ? esc(short(c.p)) : ''} ${c.o ? esc(c.is_lit ? '"' + c.o.slice(0, 60) + '"' : short(c.o)) : ''}</div>`
					)
					.join('')
			: '<div class="dt">no pending changes</div>';
	});
}
/** Click on #chchip: show/hide the #chlist dropdown. @returns {void} */
function toggleChanges() {
	const l = $('#chlist');
	l.style.display = l.style.display === 'block' ? 'none' : 'block';
}
/**
 * "💾 Save" button: POST /api/save writes the pending changes to the .owl files (with .bak backups) and starts a reindex.
 * Shows the result in an alert ({saved:[{file,mode}]} or {error}), refreshes the changes widget and restarts the index poller.
 * @returns {void}
 */
function saveChanges() {
	if (!confirm('Write the changes to the .owl files? (automatic .bak backup; the index is then rebuilt)')) return;
	$('#chchiptxt').textContent = 'saving…';
	post('/api/save', {}).then((r) => {
		if (r.error) {
			alert('Save error: ' + r.error);
			return;
		}
		alert(
			'Saved:\n' +
				(r.saved || []).map((x) => x.file + ' (' + x.mode + ')').join('\n') +
				'\n\nIndex rebuilding (see the bar at the top).'
		);
		refreshChanges();
		ixWasRunning = false;
		ixRefresh();
	});
}
/**
 * "Discard" button: POST /api/discard drops every pending change, then refreshes the widget, the current entity and the list.
 * @returns {void}
 */
function discardChanges() {
	if (!confirm('Discard all pending changes?')) return;
	post('/api/discard', {}).then(() => {
		refreshChanges();
		if (selIri) show(encodeURIComponent(selIri));
		loadList();
	});
}
refreshChanges(); // initial state of the changes widget at page load

// ---------- IRIs of new entities (sidebar "+ new", nested "Create a new Named individual" dialog) ----------
/**
 * {prefix: namespace} known to the workspace: the prefixes declared in the module headers (the active ontology's
 * first, as in the server-side display names) plus the canonical owl / rdfs / rdf / xsd ones.
 * @returns {Object<string,string>}
 */
function knownPrefixes() {
	const out = { owl: OWLNS, rdfs: RDFS, rdf: RDF, xsd: XSDNS };
	const pf = (ontoData && ontoData.prefixes) || {};
	[activeFile(), ...Object.keys(pf)].forEach((f) =>
		(pf[f] || []).forEach(([p, ns]) => {
			if (p && !(p in out)) out[p] = ns;
		})
	);
	return out;
}
/**
 * Default namespace of the active ontology: the xmlns of its module header (GET /api/ontology prefixes, prefix ''),
 * else the individuals namespace of NS.
 * @returns {string}
 */
function defaultNamespace() {
	const pf = ontoData && (ontoData.prefixes || {})[activeFile()];
	const d = pf && pf.find(([p]) => p === '');
	return d ? d[1] : NS.individual;
}
/**
 * IRI of an entity from a typed name: a full IRI (http(s):, urn:) passes through; `prefix:local` with a known prefix
 * (knownPrefixes) resolves to that namespace; anything else is appended to `ns` (default: defaultNamespace()) with
 * spaces replaced by '_'.
 * @param {string} name Typed text.
 * @param {string} [ns] Namespace for plain names.
 * @returns {string} '' for an empty name.
 */
function entityIri(name, ns) {
	name = (name || '').trim();
	if (!name) return '';
	if (/^(https?|urn):/i.test(name)) return name;
	const m = /^([\w.-]+):(\S+)$/.exec(name);
	const pns = m && knownPrefixes()[m[1]];
	if (pns) return pns + m[2];
	return (ns || defaultNamespace()) + name.replace(/\s+/g, '_');
}
/**
 * Nested dialog "Create a new Named individual" (on top of the current one): Name — a short name, a full IRI or
 * prefix:name — and IRI, auto-generated from the name (entityIri) while the IRI field has not been edited by hand,
 * editable. OK is enabled only when the IRI is valid and unused: not in `o.used` and unknown to the index
 * (GET /api/entity, debounced). On OK `o.onOk(iri, name)` runs, then the dialog below is restored and `o.onRestore`
 * called (e.g. to redraw its list). The individual itself is created later by the caller (POST /api/edit/create).
 * @param {{used?: (Map|Set), onOk: function(string, string), onRestore?: function}} o
 * @returns {void}
 */
function newIndividualDialog(o) {
	modalPush(o.onRestore);
	openForm(
		'Create a new Named individual',
		[
			{ name: 'name', label: 'Name', placeholder: 'Short name or full IRI or prefix:name', required: true },
			{ name: 'iri', label: 'IRI', placeholder: 'IRI (auto-generated)', required: true },
			{ type: 'html', html: '<div class="dt" id="niinfo" style="margin-top:6px;min-height:16px"></div>' }
		],
		(v) => {
			o.onOk(v.iri.trim(), v.name.trim());
			return {};
		},
		`The IRI is built from the name with the default namespace of the active ontology (<code>${esc(defaultNamespace())}</code>); a full IRI or a known prefix (e.g. <code>sdf:Name</code>) is used as such.`
	);
	const box = $('#modalbox'),
		name = box.querySelector('[name=name]'),
		iri = box.querySelector('[name=iri]'),
		ok = $('#fok'),
		info = $('#niinfo');
	let touched = false, // the IRI field was edited by hand: stop deriving it from the name
		timer = null,
		seq = 0;
	ok.disabled = true;
	// validate the IRI: syntax, local duplicates, then (debounced) the index
	const check = () => {
		const v = iri.value.trim();
		ok.disabled = true;
		clearTimeout(timer);
		if (!/^(https?:\/\/|urn:)\S+$/i.test(v)) {
			info.textContent = v ? 'enter a valid IRI (http://…, https://… or urn:…)' : '';
			return;
		}
		if (o.used && o.used.has(v)) {
			info.textContent = 'this IRI is already in the selection';
			return;
		}
		info.textContent = 'checking…';
		timer = setTimeout(() => {
			const my = ++seq;
			api('/api/entity', { iri: v }).then((d) => {
				if (my !== seq || !document.contains(iri)) return; // a newer check, or the dialog is gone
				const free = !!d.error;
				ok.disabled = !free;
				info.textContent = free
					? 'IRI available'
					: `this IRI is already used by a ${(KL[d.node.kind] || 'entity').toLowerCase()}`;
			});
		}, 250);
	};
	name.addEventListener('input', () => {
		if (!touched) iri.value = entityIri(name.value);
		check();
	});
	iri.addEventListener('input', () => {
		touched = iri.value.trim() !== '';
		check();
	});
	name.focus();
}

// ---------- annotation dialog (property list | Literal / Entity IRI / IRI / Property values) ----------
/** Built-in annotation properties always offered in the annotation dialog (label → IRI). */
const BUILTIN_ANN_PROPS = [
	[OWLNS + 'backwardCompatibleWith', 'owl:backwardCompatibleWith'],
	[OWLNS + 'deprecated', 'owl:deprecated'],
	[OWLNS + 'incompatibleWith', 'owl:incompatibleWith'],
	[OWLNS + 'priorVersion', 'owl:priorVersion'],
	[OWLNS + 'versionInfo', 'owl:versionInfo'],
	[RDFS + 'comment', 'rdfs:comment'],
	[RDFS + 'isDefinedBy', 'rdfs:isDefinedBy'],
	[RDFS + 'label', 'rdfs:label'],
	[RDFS + 'seeAlso', 'rdfs:seeAlso']
];
/**
 * Modal to create or edit an annotation: on the left the annotation properties (the built-in ones plus
 * every annotation property of the workspace, filterable with autocompletion), on the right the value as
 * a Literal (text, language tag, datatype), an Entity IRI (autocompleted picker), a plain IRI or
 * Property values — a new anonymous individual described in a mini panel (anonPanelHtml: annotations, types,
 * object / data / negative property assertions collected through the usual dialogs), sent as `o_anon`.
 * @param {Object} o
 * @param {string} o.title      Dialog title.
 * @param {?string} o.s         Subject IRI (entity, ontology or anonymous individual; null inside a mini panel).
 * @param {string} [o.file]     Default target module.
 * @param {Object} [o.existing] Current value when editing: {p, lit, lang, dt, o}.
 * @param {function(Object): Promise} o.onSubmit Receives the payload of POST /api/edit/add
 *        ({s, p, graph} + {lit, lang, dt} | {o} | {o_anon}); must return the API result (or a promise of it).
 * @returns {void}
 */
function annotationDialog(o) {
	const ex = o.existing || {};
	const mode0 = ex.o ? (ex.o.startsWith('http') ? 'entity' : 'iri') : 'literal';
	const dts = [
		...new Set([
			XSDNS + 'string',
			...(ex.dt ? [ex.dt] : []),
			...XSD_TYPES.map((t) => XSDNS + t),
			RDF + 'PlainLiteral',
			RDF + 'XMLLiteral'
		])
	];
	const html = `<div class="anndlg">
  <div class="annprops">
    <input id="annfilter" class="pk" placeholder="Filter properties…" autocomplete="off">
    <div id="annlist" class="treebox"><span class="dt" style="padding:6px">loading…</span></div>
  </div>
  <div class="annval">
    <div id="atabs" class="atabs">${[
			['literal', 'Literal'],
			['entity', 'Entity IRI'],
			['iri', 'IRI'],
			['anon', 'Property values']
		]
			.map(([k, l]) =>
				tabBtn(
					'am',
					k,
					l,
					k === mode0,
					`document.querySelector('#modalbox [name=mode]').value='${k}';document.querySelectorAll('#atabs button').forEach(b=>b.classList.toggle('on',b.dataset.am==='${k}'));document.querySelectorAll('#modalbox [data-ap]').forEach(d=>d.hidden=d.dataset.ap!=='${k}')`,
					'anntab'
				)
			)
			.join('')}</div>
    <input type="hidden" name="p" value="${esc(ex.p || RDFS + 'comment')}"><input type="hidden" name="mode" value="${mode0}">
    <div data-ap="literal" ${mode0 === 'literal' ? '' : 'hidden'}>
      <label>Value</label><textarea name="lit" rows="8">${esc(ex.lit || '')}</textarea>
      <label>Language tag</label><input name="lang" value="${esc(ex.lang || '')}" placeholder="e.g. en (empty = none)">
      <label>Datatype</label><select name="dt">${dts.map((t) => `<option value="${esc(t)}" ${t === (ex.dt || XSDNS + 'string') ? 'selected' : ''}>${esc(t.startsWith(XSDNS) ? 'xsd:' + short(t) : t.startsWith(RDF) ? 'rdf:' + short(t) : short(t))}</option>`).join('')}</select>
    </div>
    <div data-ap="entity" ${mode0 === 'entity' ? '' : 'hidden'}>
      <label>Entity IRI</label><div class="picker"><input name="ent" data-kind="" placeholder="search entity… (or paste an IRI)" autocomplete="off" value="${esc(mode0 === 'entity' ? short(ex.o) : '')}" data-iri="${esc(mode0 === 'entity' ? ex.o : '')}"><div class="res"></div></div>
    </div>
    <div data-ap="iri" ${mode0 === 'iri' ? '' : 'hidden'}>
      <label>IRI</label><input name="iri" value="${esc(mode0 === 'iri' ? ex.o : '')}" placeholder="http://…">
    </div>
    <div data-ap="anon" hidden>
      <div class="dt" style="margin-top:8px">The value is a new anonymous individual: describe it below — each "+" opens the usual dialog and adds the assertion to the list (✕ removes it).</div>
      ${anonPanelHtml('annanon')}
    </div>
    <label>Module</label><select name="graph">${modules.map((m) => `<option value="${esc(m)}" ${m === o.file ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select>
  </div></div>`;
	openForm(o.title, [{ type: 'html', html }], (v) => {
		if (!v.p) return { error: 'choose an annotation property' };
		const payload = { s: o.s, p: v.p, graph: v.graph };
		if (v.mode === 'literal') {
			if (!v.lit) return { error: 'the value is required' };
			payload.lit = v.lit;
			payload.lang = v.lang || null;
			payload.dt = v.lang || v.dt === XSDNS + 'string' ? null : v.dt; // plain / language-tagged strings carry no datatype
		} else if (v.mode === 'anon') {
			payload.o_anon = anonPanelSpec('annanon'); // a new anonymous individual (possibly without assertions)
		} else {
			const target = v.mode === 'entity' ? v.ent : v.iri;
			if (!target) return { error: 'the IRI is required' };
			if (/\s/.test(target)) return { error: 'an IRI cannot contain spaces' };
			payload.o = target.startsWith('http') || target.includes(':') ? target : target; // pasted / picked IRI
		}
		return o.onSubmit(payload);
	});
	$('#modalbox').classList.add('wide');
	anonPanelInit('annanon');
	// property list: built-ins + the annotation properties of the workspace, filterable
	api('/api/list', { kind: 'annprop', page: 0 }).then((d) => {
		const props = new Map(BUILTIN_ANN_PROPS);
		(d.items || []).forEach((n) => {
			if (!props.has(n.iri)) props.set(n.iri, n.name);
		});
		const all = [...props.entries()].sort((a, b) => a[1].toLowerCase().localeCompare(b[1].toLowerCase()));
		const draw = (f) => {
			const q = (f || '').toLowerCase();
			const cur = document.querySelector('#modalbox [name=p]').value;
			$('#annlist').innerHTML =
				all
					.filter(([iri, l]) => !q || l.toLowerCase().includes(q) || iri.toLowerCase().includes(q))
					.map(
						([iri, l]) =>
							`<div class="item ${iri === cur ? 'sel' : ''}" title="${esc(iri)}" onclick="document.querySelector('#modalbox [name=p]').value='${esc(iri)}';document.querySelectorAll('#annlist .item').forEach(x=>x.classList.toggle('sel',x.title==='${esc(iri)}'))">${dot('annprop')}${esc(l)}</div>`
					)
					.join('') || '<span class="dt" style="padding:6px">no property matches</span>';
		};
		draw('');
		const filt = $('#annfilter');
		filt.oninput = () => draw(filt.value.trim());
		attachAutocomplete(filt, {
			single: true,
			keywords: false,
			kinds: ['annprop'],
			onPick: (it) => {
				if (it.iri) {
					document.querySelector('#modalbox [name=p]').value = it.iri;
					if (!props.has(it.iri)) all.push([it.iri, it.name]);
				}
				draw('');
			}
		});
	});
}

// ---------- import wizard (local file / URL / ontology already in the workspace) ----------
/**
 * "+ import" of the Ontology info header: one dialog with three options — a local .owl file (path
 * + Browse… + recent locations; its ontology IRI is read from the header), a document on the web
 * (its URL becomes the import IRI) or an ontology already loaded in the workspace. Adds the
 * owl:imports statement with POST /api/edit/add and reloads the panel.
 * @param {string} iri Ontology IRI (subject).
 * @param {string} file Module file holding the header.
 * @returns {void}
 */
function importWizard(iri, file) {
	const others = (ontoData?.ontologies || []).filter((x) => x.iri !== iri);
	const html = `<div class="wizard">
  <div class="dt" style="margin-bottom:8px">Please choose an option:</div>
  <label class="wopt"><input type="radio" name="itype" value="file" checked onchange="wizShow('file')"> Import an ontology contained in a local file</label>
  <label class="wopt"><input type="radio" name="itype" value="url" onchange="wizShow('url')"> Import an ontology contained in a document located on the web</label>
  <label class="wopt"><input type="radio" name="itype" value="ws" onchange="wizShow('ws')"> Import an ontology that is already loaded in the workspace</label>
  <div data-wp="file" class="wpane">
    <label>Path</label>
    <div style="display:flex;gap:8px;align-items:center"><input name="path" style="flex:1" placeholder="/path/to/ontology.owl"><button type="button" class="ibtn" onclick="pickFile()" title="Choose the .owl file to import with the system file dialog (its path is filled in here)">${ic('folder')} Browse…</button></div>
    <div class="dt" style="margin-top:8px">Recent locations</div>
    <div id="wrecent" class="treebox" style="max-height:160px;border:1px solid var(--line);border-radius:6px"><span class="dt" style="padding:6px">loading…</span></div>
    <div class="dt" style="margin-top:8px">The ontology IRI is read from the file header. For the import to resolve, the file must live in the workspace folder (or be mapped in catalog-v001.xml).</div>
  </div>
  <div data-wp="url" class="wpane" hidden>
    <label>URL</label><input name="url" placeholder="Enter the URL to open from (the physical URL of the document)">
  </div>
  <div data-wp="ws" class="wpane" hidden>
    <label>Ontology</label><select name="wsiri">${others.map((x) => `<option value="${esc(x.iri)}">${esc(short(x.iri))}  (${esc(x.file || 'not indexed')})</option>`).join('') || '<option value="">no other ontology in the workspace</option>'}</select>
  </div></div>`;
	openForm('Import ontology', [{ type: 'html', html }], (v) => {
		const add = (o) =>
			post('/api/edit/add', { s: iri, p: OWLNS + 'imports', o, graph: file }).then((r) => {
				ontReload();
				return r;
			});
		if (v.itype === 'url')
			return v.url && /^https?:\/\/\S+$/.test(v.url) ? add(v.url) : { error: 'enter a valid http(s) URL' };
		if (v.itype === 'ws') return v.wsiri ? add(v.wsiri) : { error: 'no ontology selected' };
		if (!v.path) return { error: 'enter or browse a file path' };
		return api('/api/ontology_iri', { path: v.path }).then((r) => {
			if (r.error) return r;
			if (
				!r.same_dir &&
				!confirm(
					`${r.file} is not in the workspace folder: the import will not resolve until the file is copied there or mapped in catalog-v001.xml. Add the import anyway?`
				)
			)
				return { error: 'cancelled' };
			return add(r.iri);
		});
	});
	// recent locations: the files of the recent workspaces, clicking one fills the path
	api('/api/workspace', {}).then((w) => {
		const paths = [];
		[w.current, ...(w.recent || [])].forEach((ws) => (ws?.files || []).forEach((f) => paths.push(ws.dir + '/' + f)));
		const uniq = [...new Set(paths)];
		$('#wrecent').innerHTML =
			uniq
				.map(
					(p) =>
						`<div class="item" onclick="document.querySelector('#modalbox [name=path]').value=${esc(JSON.stringify(p))}">${esc(p)}</div>`
				)
				.join('') || '<span class="dt" style="padding:6px">none</span>';
	});
}
/** Show one pane of the import wizard (file | url | ws). @param {string} k Pane key. */
function wizShow(k) {
	document.querySelectorAll('#modalbox [data-wp]').forEach((d) => (d.hidden = d.dataset.wp !== k));
}

// ---------- expression dialogs (the "+" buttons of the description sections) ----------
// One generic tabbed dialog (exprDialog: title, ordered tabs, preview line, footer with the target module and
// Cancel / OK enabled by the active tab's value()) whose tabs come from small composable factories: tabClassTree,
// tabPropertyTree (kind), tabRestriction (object / data), tabEditor (autocompleted text: class expressions, data
// ranges, whole axioms, name lists, chains), tabDatatypeList, tabRawIri, tabIndividualsList, tabDataAssertion
// (value / language / datatype form), tabTwoInputs. Each "+" of addAssertion is just a tab list + a submit mapping.
const XD_RTYPES = [
	['some', 'Some (existential)'],
	['only', 'Only (universal)'],
	['min', 'Min (min cardinality)'],
	['exactly', 'Exactly (exact cardinality)'],
	['max', 'Max (max cardinality)']
]; // restriction types of the restriction creators
const XD_CARD = ['min', 'exactly', 'max']; // restriction types that take a cardinality
const XD_ROOT_IRI = { class: OWLNS + 'Thing' }; // selectable synthetic root of a hierarchy pane (per kind)
// axiom keywords completed by the general class axiom editor (besides the DL keywords of MANCHESTER_KW)
const GCA_KW = ['SubClassOf', 'EquivalentTo', 'DisjointWith', 'inverse'];
const GCA_PRED = {
	subclassof: RDFS + 'subClassOf',
	equivalentto: OWLNS + 'equivalentClass',
	disjointwith: OWLNS + 'disjointWith'
};
// options of the editor tab for data ranges (data property ranges, datatype definitions)
const DATA_RANGE_TAB = {
	title: 'Data range expression',
	label: 'Data range (Manchester syntax)',
	placeholder: 'xsd:decimal[>= 0, <= 100]',
	hint: 'A datatype, optionally with facets — <code>xsd:integer[&gt;= 200, &lt;= 1000]</code>, <code>xsd:string[length 3]</code> — or an enumeration of literals <code>{1, 2, 3}</code>; declared (fuzzy) datatypes by name.',
	ac: { kinds: ['datatype'] }
};
// options of the editor tab for property expressions (Disjoint With of an object property)
const PROP_EXPR_TAB = {
	title: 'Property expression editor',
	label: 'Property expression (Manchester syntax)',
	placeholder: 'inverse hasPart',
	hint: 'A property name, or <code>inverse P</code> for the inverse of an object property.',
	ac: { keywords: false, statics: ['inverse'], kinds: ['objprop'] }
};
/**
 * The four class expression tabs in the order the section wants them.
 * @param {string[]} order Keys among 'hier' (class hierarchy), 'obj' / 'data' (restriction creators), 'expr' (editor).
 * @returns {Object[]} Tab descriptors.
 */
const classTabs = (order) =>
	order.map((k) =>
		({
			hier: () => tabClassTree(),
			obj: () => tabRestriction('objprop'),
			data: () => tabRestriction('dataprop'),
			expr: () => tabEditor({ placeholder: 'TerritorialSystem and (povertyRate some LowPoverty)' })
		})[k]()
	);
/**
 * State of the open expression dialog (one dialog at a time, like the modal itself):
 *   tabs    descriptors of the tabs (see exprDialog), tab = key of the active one
 *   panes   key → {kind, multi} of every pickable pane (tree or datatype list) of the dialog
 *   roots   kind → nodes of GET /api/tree (loaded once per kind), datatypes = [{iri, name, fuzzy}] once loaded
 *   names   iri → displayed name (from the trees / lists / autocomplete picks), used to write the expressions
 *   sel     pane key → selected IRI (single-select panes), msel = pane key → Set of IRIs (multi-select panes)
 *   filter  pane key → filter text, exp = pane key → "Expand all" state, timers = debounce timers of the filters
 */
let xdState = null;
/** `<label>Module</label><select name="graph">` footer control shared by the dialogs. @param {string} graph Preselected module. */
const moduleSelectHtml = (graph) =>
	`<label>Module</label><select name="graph">${modules.map((m) => `<option value="${esc(m)}" ${m === graph ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select>`;
/**
 * Displayed name of an entity in Manchester form: the name shown in the trees / lists (it may carry a prefix
 * such as `sdf:City`, accepted by the parser), quoted when it contains spaces or brackets.
 * @param {string} iri Entity IRI.
 * @returns {string}
 */
function xdName(iri) {
	const n = (xdState && xdState.names.get(iri)) || short(iri);
	return /[\s()\[\]{},]/.test(n) ? `'${n}'` : n;
}
/**
 * Markup of a pickable pane: optional heading, filter box and the tree / list container (#xdt_<key>).
 * @param {string} key Pane key (registered in xdState.panes by the tab factory).
 * @param {string} title Heading (empty = none).
 * @param {string} ph Placeholder of the filter box.
 * @returns {string}
 */
const xdPaneHtml = (key, title, ph) =>
	`<div class="xdcol">${title ? `<div class="xdlbl">${esc(title)}</div>` : ''}<div class="listsearch"><input id="xdf_${key}" placeholder="${esc(ph)}" autocomplete="off" oninput="xdFilter('${key}',this.value)"></div><div id="xdt_${key}" class="treebox"><span class="dt" style="padding:6px">loading…</span></div></div>`;
/**
 * "Restriction type" select + "Cardinality" number of a restriction creator (the number is enabled by
 * xdUpdate only for min / exactly / max).
 * @param {string} id 'obj' | 'data' (suffix of the control ids #xdrt_<id> / #xdn_<id>).
 * @returns {string}
 */
const xdRestrictionRowHtml = (id) =>
	`<div class="xdrow"><label for="xdrt_${id}">Restriction type</label><select id="xdrt_${id}" onchange="xdUpdate()">${XD_RTYPES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select><label for="xdn_${id}">Cardinality</label><input type="number" id="xdn_${id}" min="0" step="1" value="1" disabled oninput="xdUpdate()"></div>`;
// ---- tab factories: each returns {key, title, html, panes?, init?, text?(), value()} ----
// panes   = pickable panes the tab needs: key → {kind, multi} (trees / datatype list, loaded by exprDialog)
// init()  = called once the pane is in the DOM (autocompletion, data)
// text()  = the expression shown in the preview line ('' when incomplete; no text() = no preview line)
// value() = the result of the tab: null while incomplete, else {o: iri} (named entity), {os: [iri…]}
//           (multi-selection), {expr: text} (expression) or {exprs: [text…]} (one expression per line),
//           {selected: [{iri, name, isNew}]} (individuals), {p, lit, lang, dt} (data value), {p, o} (two inputs)
/**
 * "Class hierarchy" tab: the class tree (filter box, "Expand all", root owl:Thing — selectable too).
 * @param {Object} [o] {multi: true} toggles a multi-selection (value {os: [iri…]}) instead of a single class ({o});
 *   title overrides the tab title.
 * @returns {Object} Tab descriptor.
 */
function tabClassTree(o) {
	o = o || {};
	return {
		key: 'hier',
		title: o.title || 'Class hierarchy',
		panes: { hier: { kind: 'class', multi: !!o.multi } },
		html:
			xdPaneHtml('hier', '', 'Filter classes…') +
			(o.multi
				? '<div class="dt" style="margin-top:6px">Click a class to add it to the selection, click it again to remove it.</div>'
				: ''),
		text: () =>
			o.multi ? [...xdState.msel.hier].map(xdName).join(', ') : xdState.sel.hier ? xdName(xdState.sel.hier) : '',
		value: () =>
			o.multi
				? xdState.msel.hier.size
					? { os: [...xdState.msel.hier] }
					: null
				: xdState.sel.hier
					? { o: xdState.sel.hier }
					: null
	};
}
/**
 * Restriction creator tab: "Restricted property" tree | "Restriction filler" (class tree for object properties,
 * datatype list — xsd: built-ins + declared datatypes — for data properties), restriction type and cardinality
 * (enabled for min / exactly / max). Expression: `P some F` | `P only F` | `P min N F` | `P exactly N F` | `P max N F`.
 * @param {string} kind 'objprop' (Object restriction creator) | 'dataprop' (Data restriction creator).
 * @returns {Object} Tab descriptor; value = {expr}.
 */
function tabRestriction(kind) {
	const obj = kind === 'objprop';
	const id = obj ? 'obj' : 'data'; // pane keys and control ids differ so both creators can live in one dialog
	const pk = obj ? 'oprop' : 'dprop',
		fk = obj ? 'ofill' : 'dtype';
	const expr = () => {
		const st = xdState;
		if (!st.sel[pk] || !st.sel[fk]) return '';
		const rt = $('#xdrt_' + id).value;
		const n = Math.max(0, parseInt($('#xdn_' + id).value, 10) || 0);
		return `${xdName(st.sel[pk])} ${rt} ${XD_CARD.includes(rt) ? n + ' ' : ''}${xdName(st.sel[fk])}`;
	};
	return {
		key: id,
		title: obj ? 'Object restriction creator' : 'Data restriction creator',
		panes: { [pk]: { kind }, [fk]: { kind: obj ? 'class' : 'datatype' } },
		html:
			`<div class="xdcols">${xdPaneHtml(pk, 'Restricted property', obj ? 'Filter object properties…' : 'Filter data properties…')}${xdPaneHtml(fk, 'Restriction filler', obj ? 'Filter classes…' : 'Filter datatypes…')}</div>` +
			xdRestrictionRowHtml(id),
		text: expr,
		value: () => (expr() ? { expr: expr() } : null)
	};
}
/**
 * Editor tab: a textarea (or one input line with o.single, optionally followed by the fixed text o.after) with
 * autocompletion — class expressions, data ranges, property expressions, whole axioms, name lists, chains.
 * @param {Object} [o] title, label, placeholder, hint (raw HTML), rows; single, after; ac = attachAutocomplete
 *   options (default: entities + DL keywords); lines: true → value {exprs: [one per non-empty line]};
 *   preview: false → no preview line (the text is not an expression).
 * @returns {Object} Tab descriptor; value = {expr: text} | {exprs}.
 */
function tabEditor(o) {
	o = o || {};
	const text = () => (($('#xdexpr') || {}).value || '').trim();
	const attrs = `id="xdexpr" placeholder="${esc(o.placeholder || '')}" oninput="xdUpdate()" onchange="xdUpdate()"`;
	const field = o.single
		? `<div class="xdrow"><input ${attrs} style="flex:1" autocomplete="off">${o.after ? `<span class="xdafter">${esc(o.after)}</span>` : ''}</div>`
		: `<textarea ${attrs} rows="${o.rows || 7}"></textarea>`;
	return {
		key: 'expr',
		title: o.title || 'Class expression editor',
		html: `<label for="xdexpr">${esc(o.label || 'Class expression (Manchester syntax)')}</label>${field}<div class="dt" style="margin-top:6px">${o.hint || MANCHESTER_HINT}</div>`,
		init: () => {
			attachAutocomplete($('#xdexpr'), Object.assign({ keywords: true, statics: [], kinds: null }, o.ac || {}));
			$('#xdexpr').focus();
		},
		text: o.preview === false ? undefined : text,
		value: () => {
			const t = text();
			if (!t) return null;
			return o.lines
				? {
						exprs: t
							.split('\n')
							.map((x) => x.trim())
							.filter(Boolean)
					}
				: { expr: t };
		}
	};
}
/**
 * Property hierarchy tab: one filterable property tree (single select); with o.inverse an "Inverse Property"
 * checkbox turns the value into the anonymous inverse (`inverse P`).
 * @param {Object} o {kind: 'objprop' | 'dataprop', inverse: bool, title}.
 * @returns {Object} Tab descriptor; value = {o: iri, inverse: bool}.
 */
function tabPropertyTree(o) {
	const inv = () => !!(o.inverse && ($('#xdinv') || {}).checked);
	return {
		key: 'prop',
		title: o.title || (o.kind === 'objprop' ? 'Object property hierarchy' : 'Data property hierarchy'),
		panes: { prop: { kind: o.kind } },
		html:
			xdPaneHtml('prop', '', `Filter ${(KL[o.kind] || 'properties').toLowerCase()}…`) +
			(o.inverse
				? '<label class="xdchk"><input type="checkbox" id="xdinv" onchange="xdUpdate()"> Inverse Property (the value is <code>inverse P</code>)</label>'
				: ''),
		text: () => (xdState.sel.prop ? (inv() ? 'inverse ' : '') + xdName(xdState.sel.prop) : ''),
		value: () => (xdState.sel.prop ? { o: xdState.sel.prop, inverse: inv() } : null)
	};
}
/**
 * Datatype list tab (data / annotation property ranges): flat filterable single-select list of the declared
 * datatypes (fuzzy ones included) and the built-ins (xsd:*, owl:real, owl:rational, rdf:PlainLiteral,
 * rdf:XMLLiteral, rdf:langString, rdfs:Literal), sorted case-insensitively.
 * @param {Object} [o] {title}.
 * @returns {Object} Tab descriptor; value = {o: iri}.
 */
function tabDatatypeList(o) {
	o = o || {};
	return {
		key: 'dtl',
		title: o.title || 'Built-in datatypes',
		panes: { dtl: { kind: 'datatype' } },
		html: xdPaneHtml('dtl', '', 'Filter datatypes…'),
		text: () => (xdState.sel.dtl ? xdName(xdState.sel.dtl) : ''),
		value: () => (xdState.sel.dtl ? { o: xdState.sel.dtl } : null)
	};
}
/**
 * Data property assertion tab (the only tab of the dialog of an individual's data property assertions): the data
 * property tree on the left, on the right the literal value (textarea), an optional language tag and the
 * datatype (none first, then xsd:decimal / string / integer / dateTime / boolean, the other xsd: types and the
 * declared datatypes of the workspace). Language tag and datatype are mutually exclusive (xdExclusive); the
 * preview shows `P value "v"^^xsd:type` / `"v"@lang` (wrapped in `not (…)` for a negative assertion) and the
 * value is checked against the datatype (literalValid): an invalid one is flagged and blocks OK.
 * @param {Object} [o] {negative: true} for a negative data property assertion.
 * @returns {Object} Tab descriptor; value = {p, lit, lang|null, dt|null}.
 */
function tabDataAssertion(o) {
	o = o || {};
	const lit = () => (($('#xdv_lit') || {}).value || '').trim();
	const lang = () => (($('#xdv_lang') || {}).value || '').trim();
	const dt = () => ($('#xdv_dt') || {}).value || '';
	const error = () => (lit() ? literalValid(lit(), dt()) : null);
	const text = () => {
		if (!xdState.sel.dprop || !lit()) return '';
		const t = `${xdName(xdState.sel.dprop)} value ${litText(lit(), dt(), lang())}`;
		return o.negative ? `not (${t})` : t;
	};
	const first = ['decimal', 'string', 'integer', 'dateTime', 'boolean'];
	const xsd = [...first, ...XSD_TYPES.filter((t) => !first.includes(t))];
	return {
		key: 'dva',
		title: (o.negative ? 'Negative data' : 'Data') + ' property assertion',
		panes: { dprop: { kind: 'dataprop' } },
		html: `<div class="xdcols">${xdPaneHtml('dprop', 'Data property', 'Filter data properties…')}<div class="xdcol"><div class="xdlbl">Value</div><div class="xdvbody">
  <label for="xdv_lit">Value</label><textarea id="xdv_lit" rows="7" oninput="xdUpdate()" onchange="xdUpdate()"></textarea>
  <label for="xdv_lang">Language tag</label><input id="xdv_lang" placeholder="e.g. en (empty = none)" autocomplete="off" oninput="xdExclusive('lang')">
  <label for="xdv_dt">Datatype</label><select id="xdv_dt" onchange="xdExclusive('dt')"><option value="">(none)</option>${xsd.map((t) => `<option value="${XSDNS + t}">xsd:${t}</option>`).join('')}</select>
</div></div></div>`,
		// the declared datatypes (fuzzy ones included) follow the xsd: types in the select; every datatype name is
		// registered for the preview (xdName)
		init: () =>
			xdLoadDatatypes().then((dts) => {
				const sel = $('#xdv_dt');
				if (!sel || !xdState) return;
				dts.forEach((d) => xdState.names.set(d.iri, d.name));
				dts
					.filter((d) => !d.builtin)
					.forEach((d) => sel.insertAdjacentHTML('beforeend', `<option value="${esc(d.iri)}">${esc(d.name)}</option>`));
			}),
		text,
		error,
		value: () =>
			xdState.sel.dprop && lit() && !error()
				? { p: xdState.sel.dprop, lit: lit(), lang: lang() || null, dt: dt() || null }
				: null
	};
}
/**
 * Language tag and datatype of the data assertion tab are mutually exclusive: typing a language tag resets the
 * datatype to (none), choosing a datatype clears the language tag; then the preview is refreshed.
 * @param {string} which 'lang' | 'dt' — the control just edited.
 * @returns {void}
 */
function xdExclusive(which) {
	const lang = $('#xdv_lang'),
		dt = $('#xdv_dt');
	if (which === 'lang' && lang.value.trim()) dt.value = '';
	else if (which === 'dt' && dt.value) lang.value = '';
	xdUpdate();
}
/** "Edit raw IRI" tab (annotation property domains / ranges): one input holding a full IRI. @returns {Object} value = {o: iri} */
function tabRawIri() {
	const text = () => (($('#xdiri') || {}).value || '').trim();
	const valid = (t) => /^https?:\/\/\S+$/.test(t) || /^urn:\S+$/.test(t);
	return {
		key: 'iri',
		title: 'Edit raw IRI',
		html: '<label for="xdiri">IRI</label><input id="xdiri" placeholder="http://…" autocomplete="off" oninput="xdUpdate()"><div class="dt" style="margin-top:6px">Full IRI of the entity (it need not be declared in the workspace).</div>',
		text,
		value: () => (valid(text()) ? { o: text() } : null)
	};
}
/**
 * Tabbed dialog of the "+" buttons (class expressions, property expressions, datatypes): the same modal as the
 * annotation dialog, a tab bar (.atabs), one pane per tab, a preview line with the expression the active tab
 * holds, the target module and Cancel / OK — OK stays disabled until the active tab holds a complete value.
 * The pickable panes (trees of GET /api/tree, datatype list of XSD_TYPES + GET /api/list) are loaded once per
 * kind, each with a filter box (autocompleted; a picked suggestion selects the entity) and "Expand all".
 * @param {Object} o
 * @param {string} o.title Dialog title (entity name).
 * @param {Object[]} o.tabs Tab descriptors (tabClassTree, tabRestriction, tabEditor, …); the first one is active.
 * @param {string} [o.graph] Preselected target module.
 * @param {string} [o.previewLabel] Label of the preview line (default "Expression").
 * @param {function(Object): (Object|Promise<Object>)} o.onSubmit Receives value() of the active tab + {tab, graph};
 *   returns the API result (an {error} keeps the dialog open).
 * @returns {void}
 */
function exprDialog(o) {
	const tabs = o.tabs;
	xdState = {
		tabs,
		tab: tabs[0].key,
		panes: {},
		roots: {},
		datatypes: null,
		names: new Map(),
		sel: {},
		msel: {},
		filter: {},
		exp: {},
		timers: {}
	};
	const st = xdState;
	tabs.forEach((t) => Object.assign(st.panes, t.panes || {}));
	Object.entries(st.panes).forEach(([k, pn]) => {
		st.exp[k] = true;
		if (pn.multi) st.msel[k] = new Set();
	});
	Object.entries(XD_ROOT_IRI).forEach(([k, iri]) => st.names.set(iri, TREE_ROOT[k]));
	const html = `<div class="xdlg">
  ${tabs.length > 1 ? `<div class="atabs" id="xdtabs">${tabs.map((t) => tabBtn('xt', t.key, esc(t.title), t.key === st.tab, `xdTab('${t.key}')`, 'xtab')).join('')}</div>` : ''}
  ${tabs.map((t) => `<div data-xp="${t.key}" class="xdpane" ${t.key === st.tab ? '' : 'hidden'}>${t.html}</div>`).join('')}
  <div class="xdprev"><span class="dt">${esc(o.previewLabel || 'Expression')}</span> <code id="xdprev">—</code></div>
  ${moduleSelectHtml(o.graph)}</div>`;
	openForm(esc(o.title), [{ type: 'html', html }], (v) => {
		const t = st.tabs.find((x) => x.key === st.tab);
		const val = t.value();
		if (!val) return { error: 'the active tab does not hold a complete value yet' };
		return o.onSubmit({ ...val, tab: t.key, graph: v.graph });
	});
	$('#modalbox').classList.add('wide');
	$('#fok').disabled = true;
	tabs.forEach((t) => t.init && t.init());
	// filter boxes: autocompletion restricted to the kind of the pane; a picked suggestion selects the entity
	Object.entries(st.panes).forEach(([key, pn]) =>
		attachAutocomplete($('#xdf_' + key), {
			single: true,
			keywords: false,
			kinds: [pn.kind],
			onPick: (it) => {
				if (!it.iri) return;
				st.names.set(it.iri, it.name);
				xdPick(key, it.iri);
			}
		})
	);
	[...new Set(Object.values(st.panes).map((p) => p.kind))].forEach(xdLoadKind);
	xdUpdate(); // initial preview / OK state
}
/**
 * Load the data of every pane of a kind: the hierarchy (GET /api/tree) or, for datatypes, XSD_TYPES plus all the
 * pages of GET /api/list kind=datatype (declared datatypes + OWL 2 built-ins, sorted case-insensitively); then draws
 * the panes. Ignored when the dialog was closed meanwhile.
 * @param {string} kind 'class' | 'objprop' | 'dataprop' | 'datatype'.
 * @returns {void}
 */
function xdLoadKind(kind) {
	const st = xdState;
	const draw = () => {
		if (xdState !== st) return;
		Object.keys(st.panes)
			.filter((k) => st.panes[k].kind === kind)
			.forEach(xdDrawPane);
	};
	if (kind === 'datatype') {
		xdLoadDatatypes().then((dts) => {
			st.datatypes = dts;
			dts.forEach((d) => st.names.set(d.iri, d.name));
			draw();
		});
		return;
	}
	api('/api/tree', { kind }).then((d) => {
		const walk = (n) => {
			st.names.set(n.iri, n.name);
			(n.equivalent || []).forEach((e) => st.names.set(e.iri, e.name));
			(n.children || []).forEach(walk);
		};
		(d.roots || []).forEach(walk);
		st.roots[kind] = d.roots || [];
		draw();
	});
}
/**
 * All the datatypes: XSD_TYPES plus every page of GET /api/list kind=datatype (declared datatypes, fuzzy ones
 * included, and the OWL 2 built-ins the API appends), deduplicated by IRI and sorted case-insensitively by name.
 * @returns {Promise<Object[]>} [{iri, name, fuzzy, builtin}].
 */
function xdLoadDatatypes() {
	const dts = new Map(XSD_TYPES.map((t) => [XSDNS + t, { iri: XSDNS + t, name: 'xsd:' + t, builtin: true }]));
	const more = (page) =>
		api('/api/list', { kind: 'datatype', page }).then((d) => {
			const items = d.items || [];
			items.forEach((n) => {
				if (!dts.has(n.iri)) dts.set(n.iri, { iri: n.iri, name: n.name, fuzzy: n.fuzzy, builtin: !!n.builtin });
			});
			return items.length >= 200 ? more(page + 1) : null; // 200 = PAGE_SIZE of the API
		});
	return more(0).then(() => [...dts.values()].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())));
}
/**
 * Draw one pickable pane: the hierarchy (treeHtml, pruned to the branches matching the filter, which are shown
 * expanded) or the datatype list; the selected rows get .sel. The synthetic root of a class tree (owl:Thing) is
 * made selectable too.
 * @param {string} key Pane key.
 * @returns {void}
 */
function xdDrawPane(key) {
	const st = xdState;
	const box = st && $('#xdt_' + key);
	if (!box) return;
	const pn = st.panes[key];
	const f = (st.filter[key] || '').toLowerCase();
	const isSel = (iri) => (pn.multi ? st.msel[key].has(iri) : st.sel[key] === iri);
	if (pn.kind === 'datatype') {
		if (!st.datatypes) return;
		box.innerHTML =
			st.datatypes
				.filter((d) => !f || d.name.toLowerCase().includes(f))
				.map(
					(d) =>
						`<div class="item${isSel(d.iri) ? ' sel' : ''}" title="${esc(d.iri)}" onclick="xdPick('${key}','${esc(d.iri)}')">${dot('datatype', d.fuzzy)}${esc(d.name)}</div>`
				)
				.join('') || '<span class="dt" style="padding:6px">no datatype matches</span>';
		return;
	}
	const roots = st.roots[pn.kind];
	if (!roots) return;
	// prune the tree to the matching branches (a node stays when it matches or one of its descendants does)
	const prune = (n) => {
		const kids = (n.children || []).map(prune).filter(Boolean);
		return !f || n.name.toLowerCase().includes(f) || kids.length ? { ...n, children: kids } : null;
	};
	const shown = roots.map(prune).filter(Boolean);
	const rootIri = XD_ROOT_IRI[pn.kind];
	if (!shown.length && !(rootIri && !f)) {
		box.innerHTML = '<span class="dt" style="padding:6px">nothing matches</span>';
		return;
	}
	box.innerHTML = treeHtml(shown, pn.kind, {
		click: (iri) => `xdPick('${key}','${iri}')`,
		expanded: st.exp[key] || !!f,
		expandJs: `xdState.exp['${key}']=this.checked;treeSetAll(this.checked,'#xdt_${key}')`,
		selected: pn.multi ? null : st.sel[key]
	});
	if (rootIri) {
		// the synthetic top row (owl:Thing) has no link target in treeHtml: make it pickable like the other rows
		const a = box.querySelector('.tree > ul > li > .row a.ent');
		if (a) {
			a.setAttribute('onclick', `xdPick('${key}','${rootIri}')`);
			if (isSel(rootIri)) a.closest('.row').classList.add('sel');
		}
	}
	if (pn.multi)
		box.querySelectorAll('a.ent[onclick]').forEach((a) => {
			const m = /xdPick\('[^']*','([^']*)'\)/.exec(a.getAttribute('onclick'));
			if (m && st.msel[key].has(m[1])) a.closest('.row').classList.add('sel');
		});
}
/**
 * Click on a row of a pane: select it (single) or toggle it in the selection (multi), redraw, refresh the preview / OK.
 * @param {string} key Pane key.
 * @param {string} iri Entity IRI.
 * @returns {void}
 */
function xdPick(key, iri) {
	const st = xdState;
	if (!st) return;
	const pn = st.panes[key];
	if (pn.multi) {
		if (st.msel[key].has(iri)) st.msel[key].delete(iri);
		else st.msel[key].add(iri);
	} else st.sel[key] = iri;
	xdDrawPane(key);
	xdUpdate();
}
/** Debounced (250 ms) redraw of a pane while typing in its filter box. @param {string} key Pane key. @param {string} v Text. */
function xdFilter(key, v) {
	const st = xdState;
	if (!st) return;
	clearTimeout(st.timers[key]);
	st.timers[key] = setTimeout(() => {
		st.filter[key] = v.trim();
		xdDrawPane(key);
	}, 250);
}
/** Activate a tab of the expression dialog (tab bar + panes), then refresh the preview / OK. @param {string} k Tab key. */
function xdTab(k) {
	if (!xdState) return;
	xdState.tab = k;
	document.querySelectorAll('#xdtabs button').forEach((b) => b.classList.toggle('on', b.dataset.xt === k));
	document.querySelectorAll('#modalbox [data-xp]').forEach((d) => (d.hidden = d.dataset.xp !== k));
	xdUpdate();
}
/**
 * Refresh the dialog after any change: the cardinality inputs follow the restriction type (enabled for
 * min / exactly / max only), the preview line shows the expression of the active tab, OK is enabled only when
 * the active tab holds a complete value.
 * @returns {void}
 */
function xdUpdate() {
	const st = xdState;
	if (!st) return;
	['obj', 'data'].forEach((id) => {
		const s = $('#xdrt_' + id),
			n = $('#xdn_' + id);
		if (s && n) n.disabled = !XD_CARD.includes(s.value);
	});
	const t = st.tabs.find((x) => x.key === st.tab);
	const pv = $('#xdprev');
	if (pv) {
		pv.parentNode.hidden = !t.text; // tabs without an expression (free text, lists) have no preview line
		const err = t.error && t.error(); // a tab may flag its value (e.g. a literal failing its datatype)
		pv.textContent = ((t.text && t.text()) || '—') + (err ? ` — ${err}` : '');
		pv.parentNode.classList.toggle('bad', !!err);
	}
	const ok = $('#fok');
	if (ok) ok.disabled = !t.value();
}
/**
 * Split a general class axiom written in one line at its first top-level axiom keyword (outside parentheses,
 * brackets, braces and quotes; case-insensitive): `A SubClassOf B`, `A EquivalentTo B`, `A DisjointWith B`.
 * @param {string} text Manchester text of the whole axiom.
 * @returns {?{sub: string, expr: string, p: string}} Left side, right side and predicate IRI; null without a keyword.
 */
function splitGca(text) {
	const re = /\b(SubClassOf|EquivalentTo|DisjointWith)\b/gi;
	let m;
	while ((m = re.exec(text))) {
		const before = text.slice(0, m.index);
		const quotes = (before.match(/'/g) || []).length;
		const unq = before.replace(/'[^']*'/g, '');
		const depth = (unq.match(/[(\[{]/g) || []).length - (unq.match(/[)\]}]/g) || []).length;
		if (quotes % 2 === 0 && depth === 0)
			return { sub: before.trim(), expr: text.slice(m.index + m[0].length).trim(), p: GCA_PRED[m[1].toLowerCase()] };
	}
	return null;
}
// ---- individuals list tab (instances of a class, same / different individuals) ----
/**
 * Individuals list tab: a toolbar with "New individual" (the nested "Create a new Named individual" dialog,
 * newIndividualDialog; the individual is created on submit and joins the selection) and "Remove selected" (clears
 * the selection, disabled when empty); a filter box searched server-side (GET /api/list kind=individual q=…, one
 * page of 200 rows at a time with the shared pager — the workspace holds ~400k individuals, so the list is never
 * loaded whole); a sortable name header (ascending / descending order of the shown page) and the rows: clicking
 * toggles the row in the multi-selection (highlighted); new individuals are pinned on top with a "new" badge.
 * State in xdState.ind = {page, q, desc, items, total, sel: Map iri → {name, fuzzy, isNew}, timer}.
 * @returns {Object} Tab descriptor; value = {selected: [{iri, name, isNew}]}.
 */
function tabIndividualsList() {
	return {
		key: 'inds',
		title: 'Individuals',
		html: `<div class="xdbar">
    <button type="button" class="ibtn" title="Create a new individual and add it to the selection" onclick="insNew()">${ic('add')} New individual</button>
    <button type="button" class="ibtn" id="insrm" title="Remove the selected individuals from the selection" onclick="insClear()" disabled>${ic('delete')} Remove selected</button>
    <span class="dt" id="inscount" style="margin-left:auto">nothing selected</span>
  </div>
  <div class="listsearch"><input id="insfilter" placeholder="Filter individuals… (searched in the whole workspace)" autocomplete="off" oninput="insFilter(this.value)"></div>
  <div class="insl treebox">
    <div id="insrows"><span class="dt" style="padding:6px">loading…</span></div>
  </div>
  <div class="pager" id="inspager"></div>`,
		init: () => {
			xdState.ind = { page: 0, q: '', desc: false, items: [], total: 0, sel: new Map(), timer: null };
			insLoad();
		},
		value: () => {
			const st = xdState.ind;
			return st && st.sel.size
				? { selected: [...st.sel].map(([iri, x]) => ({ iri, name: x.name, isNew: x.isNew })) }
				: null;
		}
	};
}
/** Load the current page of individuals (GET /api/list) and draw the list + pager. @returns {void} */
function insLoad() {
	const st = xdState && xdState.ind;
	if (!st) return;
	api('/api/list', { kind: 'individual', page: st.page, q: st.q }).then((d) => {
		if (!xdState || xdState.ind !== st || !$('#insrows')) return;
		st.items = d.items || [];
		st.total = d.total || 0;
		const pages = Math.max(1, Math.ceil(st.total / 200));
		$('#inspager').innerHTML = pagerHtml(
			st.page,
			pages,
			'xdState.ind.page={p};insLoad()',
			`${st.total.toLocaleString('en')} individuals`
		);
		insDraw();
	});
}
/** Draw the rows: the new individuals first, then the page sorted by name (asc / desc). @returns {void} */
function insDraw() {
	const st = xdState && xdState.ind;
	if (!st || !$('#insrows')) return;
	const row = (iri, name, fuzzy, isNew) =>
		`<div class="item${st.sel.has(iri) ? ' sel' : ''}" title="${esc(iri)}" onclick="insToggle('${esc(iri)}')">${dot('individual', fuzzy)}${esc(name)}${isNew ? ' <span class="xdnew">new</span>' : ''}</div>`;
	const items = [...st.items].sort(
		(a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) * (st.desc ? -1 : 1)
	);
	$('#insrows').innerHTML =
		`<div class="inshdr" onclick="insSort()" title="Sort by name">Name ${st.desc ? '▾' : '▴'}</div>` +
		[...st.sel]
			.filter(([, x]) => x.isNew)
			.map(([iri, x]) => row(iri, x.name, false, true))
			.join('') +
		(items.map((n) => row(n.iri, n.name, n.fuzzy, false)).join('') ||
			'<span class="dt" style="padding:6px">no individual matches</span>');
	insUpdate();
}
/** Refresh the selection counter, the "Remove selected" button and (through xdUpdate) OK. @returns {void} */
function insUpdate() {
	const st = xdState && xdState.ind;
	if (!st) return;
	const n = st.sel.size;
	const c = $('#inscount');
	if (c) c.textContent = n ? `${n} selected` : 'nothing selected';
	const rm = $('#insrm');
	if (rm) rm.disabled = !n;
	xdUpdate();
}
/** Toggle an individual in the selection (click on a row). @param {string} iri @returns {void} */
function insToggle(iri) {
	const st = xdState && xdState.ind;
	if (!st) return;
	if (st.sel.has(iri)) st.sel.delete(iri);
	else {
		const n = st.items.find((x) => x.iri === iri);
		st.sel.set(iri, { name: n ? n.name : short(iri), fuzzy: !!(n && n.fuzzy), isNew: false });
	}
	insDraw();
}
/** "Remove selected": empty the selection. @returns {void} */
function insClear() {
	const st = xdState && xdState.ind;
	if (!st) return;
	st.sel.clear();
	insDraw();
}
/** Toggle the sort order of the shown page. @returns {void} */
function insSort() {
	const st = xdState && xdState.ind;
	if (!st) return;
	st.desc = !st.desc;
	insDraw();
}
/** Debounced (300 ms) server-side filter of the list. @param {string} v Text typed in the filter box. */
function insFilter(v) {
	const st = xdState && xdState.ind;
	if (!st) return;
	clearTimeout(st.timer);
	st.timer = setTimeout(() => {
		st.q = v.trim();
		st.page = 0;
		insLoad();
	}, 300);
}
/**
 * "New individual": the nested "Create a new Named individual" dialog; on OK the new IRI joins the selection
 * (pinned with the "new" badge, created on submit) and the list is redrawn once the dialog is back.
 * @returns {void}
 */
function insNew() {
	const st = xdState && xdState.ind;
	if (!st) return;
	newIndividualDialog({
		used: st.sel,
		onOk: (iri, name) =>
			st.sel.set(iri, {
				name: /^(https?|urn):/i.test(name) ? short(iri) : name.replace(/^[\w.-]+:/, ''),
				fuzzy: false,
				isNew: true
			}),
		onRestore: insDraw
	});
}

// ---- two-input row tab (object property assertions of an individual) ----
/**
 * Two side-by-side autocompleted inputs (e.g. "Enter object property name" + "Enter individual name") with a
 * tip line and a preview `P individual` (`not (P individual)` when negative). A name picked from the suggestions
 * carries its IRI; a typed name is resolved with toIri (a pasted IRI passes through). With `o.anon` = key of the
 * individual field, an "Anonymous individual" checkbox beside it swaps the field for the mini description panel
 * of a new anonymous individual (anonPanelHtml); the value then carries `o_anon` (anonPanelSpec) instead.
 * @param {Object} o {fields: [{key, label, placeholder, kind}, {…}], title, anon: key|null, negative: bool}.
 * @returns {Object} Tab descriptor; value = {<key>: iri, …} once every field is filled (or {p, o_anon}).
 */
function tabTwoInputs(o) {
	const id = (f) => '#xdi_' + f.key;
	const anonOn = () => !!(o.anon && ($('#xdanon') || {}).checked);
	const val = (f) => {
		const el = $(id(f));
		const v = (el.value || '').trim();
		return v && el.dataset.iri && el.dataset.name === v ? el.dataset.iri : toIri(v, f.kind);
	};
	// preview: the typed / picked names in field order (the anonymous individual by its label)
	const text = () => {
		const parts = o.fields.map((f) =>
			f.key === o.anon && anonOn() ? 'Anonymous individual' : (($(id(f)) || {}).value || '').trim()
		);
		if (parts.some((x) => !x)) return '';
		return o.negative ? `not (${parts.join(' ')})` : parts.join(' ');
	};
	return {
		key: 'two',
		title: o.title || 'Assertion',
		html:
			`<div class="xdcols xdaflds">${o.fields
				.map(
					(f) =>
						`<div><label for="xdi_${f.key}">${esc(f.label)}${
							f.key === o.anon
								? `<span class="anonchk"><input type="checkbox" id="xdanon" onchange="xdAnonToggle('${f.key}')"> Anonymous individual</span>`
								: ''
						}</label><div class="acwrap"><input id="xdi_${f.key}" placeholder="${esc(f.placeholder || '')}" autocomplete="off" oninput="xdUpdate()" onchange="xdUpdate()"></div></div>`
				)
				.join('')}</div><div class="dt" style="margin-top:8px">Tip: names auto-complete as you type.</div>` +
			(o.anon ? `<div id="xdanonpanel" hidden>${anonPanelHtml('xdanon')}</div>` : ''),
		init: () => {
			o.fields.forEach((f) =>
				attachAutocomplete($(id(f)), {
					single: true,
					keywords: false,
					kinds: [f.kind],
					onPick: (it) => {
						$(id(f)).dataset.name = it.name;
						xdUpdate();
					}
				})
			);
			if (o.anon) anonPanelInit('xdanon');
			$(id(o.fields[0])).focus();
		},
		text,
		value: () => {
			const r = {};
			for (const f of o.fields) {
				if (f.key === o.anon && anonOn()) {
					r.o_anon = anonPanelSpec('xdanon');
					continue;
				}
				const v = val(f);
				if (!v) return null;
				r[f.key] = v;
			}
			return r;
		}
	};
}
/**
 * "Anonymous individual" checkbox of tabTwoInputs: disable the individual field and show / hide the mini panel.
 * @param {string} key Key of the field the checkbox belongs to.
 * @returns {void}
 */
function xdAnonToggle(key) {
	const on = $('#xdanon').checked;
	$('#xdi_' + key).disabled = on;
	$('#xdanonpanel').hidden = !on;
	xdUpdate();
}

// ---------- ontology header editing ----------
/** Invalidate the cached ontology payload (ontoData, axioms.js), re-render the Ontology info panel and the changes widget. @returns {void} */
function ontReload() {
	ontoData = null;
	renderOntology();
	refreshChanges();
}
/**
 * Form to change the IRI of an owl:Ontology (POST /api/edit/rename {iri, new_iri}); on success activeOnt is updated.
 * @param {string} iri Current ontology IRI.
 * @returns {void}
 */
function renameOntologyIri(iri) {
	openForm(
		'Rename ontology IRI',
		[{ name: 'new_iri', label: 'New full IRI', value: iri, required: true }],
		(v) =>
			post('/api/edit/rename', { iri, new_iri: v.new_iri }).then((r) => {
				if (!r.error) {
					activeOnt = v.new_iri;
					ontReload();
				}
				return r;
			}),
		'Updates owl:Ontology and every owl:imports referencing it; on save catalog-v001.xml is updated too. Entity IRIs do NOT change (use "Ontology prefixes").'
	);
}
/**
 * Inline edit of the ontology IRI (the "Ontology IRI" field of the header): same rename as
 * renameOntologyIri, committed on change (Enter / blur). Empty or unchanged values are ignored.
 * @param {string} iri Current ontology IRI.
 * @param {string} value New IRI typed in the field.
 * @returns {void}
 */
function ontSetIri(iri, value) {
	if (!value || value === iri) return;
	if (/\s/.test(value)) {
		alert('The IRI cannot contain spaces');
		return;
	}
	post('/api/edit/rename', { iri, new_iri: value }).then((r) => {
		if (r.error) alert(r.error);
		else activeOnt = value;
		ontReload();
	});
}
/**
 * Inline edit of owl:versionIRI: removes the previous value (if any) and adds the new one (if not
 * empty) on the ontology node (POST /api/edit/remove + /api/edit/add), then reloads the panel.
 * @param {string} iri Ontology IRI (subject).
 * @param {string} file Module file holding the header.
 * @param {string} oldV Current version IRI ('' when none).
 * @param {string} value New version IRI ('' = remove).
 * @returns {void}
 */
function ontSetVersion(iri, file, oldV, value) {
	if (value === oldV) return;
	if (/\s/.test(value)) {
		alert('The version IRI cannot contain spaces');
		return;
	}
	const P = OWLNS + 'versionIRI';
	const rm = oldV ? post('/api/edit/remove', { s: iri, p: P, o: oldV, graph: file }) : Promise.resolve({});
	rm.then((r) => (r.error || !value ? r : post('/api/edit/add', { s: iri, p: P, o: value, graph: file }))).then((r) => {
		if (r && r.error) alert(r.error);
		ontReload();
	});
}
/**
 * Form to add an annotation (label / comment / versionInfo / seeAlso) to an ontology header (POST /api/edit/add).
 * @param {string} iri Ontology IRI (subject).
 * @param {string} file Module file holding the header.
 * @returns {void}
 */
function ontAddAnnotation(iri, file) {
	annotationDialog({
		title: 'Ontology annotation',
		s: iri,
		file,
		onSubmit: (payload) =>
			post('/api/edit/add', payload).then((r) => {
				ontReload();
				return r;
			})
	});
}
/**
 * Remove an ontology header annotation after confirmation (POST /api/edit/remove), then ontReload().
 * @param {string} iri Ontology IRI.
 * @param {string} p Annotation property IRI.
 * @param {string} value Literal value.
 * @param {?string} lang Language tag (not sent).
 * @param {string} file Module file.
 * @returns {void}
 */
function ontRemoveAnnotation(iri, p, value, lang, file) {
	if (!confirm('Remove this annotation?')) return;
	post('/api/edit/remove', { s: iri, p, lit: value, graph: file }).then(() => ontReload());
}
/**
 * Form to add an owl:imports statement to an ontology header (POST /api/edit/add {s, p: owl:imports, o}).
 * @param {string} iri Ontology IRI.
 * @param {string} file Module file.
 * @returns {void}
 */
function ontAddImport(iri, file) {
	importWizard(iri, file);
}
/**
 * Remove an owl:imports statement after confirmation (POST /api/edit/remove), then ontReload().
 * @param {string} iri Ontology IRI.
 * @param {string} o Imported ontology IRI.
 * @param {string} file Module file.
 * @returns {void}
 */
function ontRemoveImport(iri, o, file) {
	if (!confirm('Remove the import ' + o + '?')) return;
	post('/api/edit/remove', { s: iri, p: OWLNS + 'imports', o, graph: file }).then(() => ontReload());
}
/**
 * "Ontology prefixes" → rename a namespace: every IRI starting with `ns` is rewritten in all modules
 * (POST /api/edit/rename_ns {old_ns, new_ns} → {entities, graphs}). Shows a summary alert and reloads the panel.
 * @param {string} ns Current namespace (ending with # or /).
 * @returns {void}
 */
function renameNamespace(ns) {
	openForm(
		'Rename namespace',
		[
			{ type: 'html', html: `<label>Current namespace</label><div class="iri">${esc(ns)}</div>` },
			{ name: 'new_ns', label: 'New namespace (ending with # or /)', value: ns, required: true }
		],
		(v) =>
			post('/api/edit/rename_ns', { old_ns: ns, new_ns: v.new_ns }).then((r) => {
				if (!r.error) {
					alert(`Renamed ${r.entities} entities in ${r.graphs.length} modules (pending: Save to write).`);
					ontReload();
				}
				return r;
			}),
		'Bulk operation: every IRI starting with this namespace is rewritten in all modules (including xmlns/xml:base in the header and the catalog). For the individuals namespace this means ~400k entities.'
	);
}

// ---------- fuzzy entities (fuzzy-dl-owl2 constructs) ----------
// membership shape → names of its numeric parameters (in order; the form shows only these)
const SHAPES = {
	crisp: ['a', 'b'],
	leftshoulder: ['a', 'b'],
	rightshoulder: ['a', 'b'],
	linear: ['a', 'b'],
	triangular: ['a', 'b', 'c'],
	trapezoidal: ['a', 'b', 'c', 'd'],
	modified: []
};
/**
 * Escape a value for XML text / attribute content (&, <, >, ").
 * @param {*} s
 * @returns {string}
 */
const escXml = (s) =>
	String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const SDFNS = 'http://www.semanticweb.org/ontologies/fuzzydl_ontology#'; // namespace of the fuzzy annotations
/** Local name of the fuzzy annotation property (Ontology Info setting; '' = crisp classical ontology). */
const fuzzyLbl = () => (uiConfig.fuzzy_label === undefined ? 'fuzzyLabel' : uiConfig.fuzzy_label);
/** Full IRI used when WRITING fuzzy annotations: the configured name in the sdf namespace. */
const fuzzyPropIri = () => SDFNS + (fuzzyLbl() || 'fuzzyLabel');
/**
 * Attributes of the inner element (Datatype / Modifier / Concept) of a fuzzyLabel XML, as a plain object
 * (e.g. {type:'trapezoidal', a:'20', b:'40', …}); used to prefill the edit forms.
 * @param {string} xml fuzzyLabel literal.
 * @returns {Object<string,string>} Empty object if unparsable.
 */
function fuzzyLabelAttrs(xml) {
	try {
		const d = new DOMParser().parseFromString(xml, 'text/xml');
		const el = d.querySelector('Datatype,Modifier,Concept');
		const o = {};
		if (el) for (const a of el.attributes) o[a.name] = a.value;
		return o;
	} catch (e) {
		return {};
	}
}
/**
 * Form to create a fuzzy datatype (membership function) or edit the fuzzyLabel of an existing one.
 * Fields: name/namespace (new only), target module, base xsd type (new only), domain k1/k2, shape,
 * parameters a…d, modifier + base datatype (shape "modified") and a live SVG preview (#fzprev / #fzval).
 * On OK (after validateFuzzy):
 *   - existing: POST /api/edit/remove of the old fuzzy label, then /api/edit/add of the new one;
 *   - new: POST /api/edit/raw with an RDF/XML rdfs:Datatype block (fuzzy label, label, owl:equivalentClass
 *     restricting the base datatype to [k1,k2]) plus the equivalent triples for the index; selIri = new IRI.
 * @param {{iri:string, lit:?string, graph:string, bounds:?{kmin:number,kmax:number}}} [existing] Datatype being edited (undefined = create).
 * @returns {void}
 */
function fuzzyDatatypeForm(existing) {
	// existing = {iri, lit, graph, bounds}: edit the membership function of a datatype in place
	const shapeOpts = Object.keys(SHAPES).map((s) => [s, s]);
	const ex = existing ? fuzzyLabelAttrs(existing.lit || '') : {};
	const bd = (existing && existing.bounds) || {};
	const nameFields = existing
		? [
				{
					type: 'html',
					html: `<label>Datatype</label><div>${esc(short(existing.iri))} <span class="dt">${esc(existing.iri)}</span></div>`
				}
			]
		: [
				{ name: 'name', label: 'Name (local)', required: true, placeholder: 'e.g. HighPoverty' },
				{ name: 'ns', label: 'Namespace', value: NS.datatype }
			];
	openForm(
		existing ? 'Edit fuzzy datatype: ' + short(existing.iri) : 'New fuzzy datatype (membership function)',
		[
			...nameFields,
			{
				name: 'graph',
				label: 'Target module',
				type: 'module',
				value:
					(existing && existing.graph) ||
					(ontoData?.ontologies.find((o) => o.iri === activeOnt) || {}).file ||
					modules[0]
			},
			...(existing
				? []
				: [
						{
							name: 'base',
							label: 'Base datatype (owl:onDatatype)',
							type: 'select',
							options: [
								[XSDNS + 'decimal', 'xsd:decimal'],
								[XSDNS + 'integer', 'xsd:integer'],
								[XSDNS + 'double', 'xsd:double']
							],
							value: XSDNS + 'decimal'
						}
					]),
			{
				name: 'k1',
				label: existing ? 'Domain minimum k1 (from the datatype definition)' : 'Domain minimum k1 (xsd:minInclusive)',
				value: String(bd.kmin ?? '0'),
				required: true
			},
			{
				name: 'k2',
				label: existing ? 'Domain maximum k2 (from the datatype definition)' : 'Domain maximum k2 (xsd:maxInclusive)',
				value: String(bd.kmax ?? '100'),
				required: true
			},
			{
				name: 'shape',
				label: 'Membership shape',
				type: 'select',
				options: shapeOpts,
				value: ex.type || 'trapezoidal'
			},
			{ name: 'a', label: 'a', value: ex.a ?? '20' },
			{ name: 'b', label: 'b', value: ex.b ?? '40' },
			{ name: 'c', label: 'c', value: ex.c ?? '60' },
			{ name: 'd', label: 'd', value: ex.d ?? '80' },
			{
				name: 'modifier',
				label: 'Modifier (only for "modified")',
				type: 'entity',
				kind: 'datatype',
				value: ex.modifier ? NS.datatype + ex.modifier : ''
			},
			{
				name: 'mbase',
				label: 'Base datatype (only for "modified")',
				type: 'entity',
				kind: 'datatype',
				value: ex.base ? NS.datatype + ex.base : ''
			},
			{ type: 'html', html: '<label>Preview</label><div id="fzprev"></div><div id="fzval" class="err"></div>' }
		],
		(v) => {
			const err = validateFuzzy(v);
			if (err) return { error: err };
			const p = {};
			SHAPES[v.shape].forEach((k) => (p[k] = v[k]));
			const attrs =
				v.shape === 'modified'
					? `modifier="${escXml(short(v.modifier))}" base="${escXml(short(v.mbase))}"`
					: Object.entries(p)
							.map(([k, x]) => `${k}="${x}"`)
							.join(' ');
			const fl = `<fuzzyOwl2 fuzzyType="datatype">\n\t<Datatype type="${v.shape}" ${attrs}/>\n</fuzzyOwl2>\n`;
			if (existing) {
				// replace the fuzzyLabel literal only (the [k1,k2] definition is an anonymous axiom: edit it from Datatype Definitions)
				const s = existing.iri;
				const chain = existing.lit
					? post('/api/edit/remove', { s, p: fuzzyPropIri(), lit: existing.lit, graph: existing.graph })
					: Promise.resolve({});
				return chain.then((r) =>
					r.error ? r : post('/api/edit/add', { s, p: fuzzyPropIri(), lit: fl, graph: v.graph })
				);
			}
			const iri = v.ns + v.name.replace(/\s+/g, '_');
			// one rdfs:Datatype restriction (xsd:minInclusive / xsd:maxInclusive facet) on the base datatype
			const restr = (facet, val) =>
				`            <rdfs:Datatype>\n                <owl:onDatatype rdf:resource="${v.base}"/>\n                <owl:withRestrictions rdf:parseType="Collection">\n                    <rdf:Description>\n                        <xsd:${facet} rdf:datatype="${XSDNS}decimal">${val}</xsd:${facet}>\n                    </rdf:Description>\n                </owl:withRestrictions>\n            </rdfs:Datatype>`;
			const xml = `    <rdfs:Datatype rdf:about="${iri}" xmlns:xsd="${XSDNS}" xmlns:sdf="${SDFNS}">\n        <sdf:${fuzzyLbl() || 'fuzzyLabel'}>${escXml(fl)}</sdf:${fuzzyLbl() || 'fuzzyLabel'}>\n        <rdfs:label xml:lang="en">${escXml(v.name)}</rdfs:label>\n        <owl:equivalentClass>\n            <rdfs:Datatype>\n                <owl:intersectionOf rdf:parseType="Collection">\n${restr('minInclusive', v.k1)}\n${restr('maxInclusive', v.k2)}\n                </owl:intersectionOf>\n            </rdfs:Datatype>\n        </owl:equivalentClass>\n    </rdfs:Datatype>`;
			// the same facts as plain triples so the index reflects them before Save
			const triples = [
				{ s: iri, p: RDF + 'type', o: RDFS + 'Datatype' },
				{ s: iri, p: RDFS + 'label', lit: v.name, lang: 'en' },
				{ s: iri, p: fuzzyPropIri(), lit: fl }
			];
			return post('/api/edit/raw', {
				graph: v.graph,
				xml,
				triples,
				subject: iri
			}).then((r) => {
				if (!r.error) selIri = iri;
				return r;
			});
		},
		'fuzzy-dl-owl2 semantics: crisp/leftshoulder/rightshoulder (a,b), triangular (a,b,c), trapezoidal (a,b,c,d) with k1 ≤ a ≤ … ≤ k2; linear = ramp (0,0)→(a,b)→(1,1) on the normalized domain (a, b ∈ [0,1], b = degree at the knee). The datatype is declared with owl:equivalentClass restricted to [k1,k2] as required by the library.'
	);
	// live update on every input: show only the parameters of the chosen shape, validate, redraw the preview
	// ("modified" previews μ' = modifier(μ_base) asynchronously, debounced in window._mpT)
	const upd = () => {
		const v = {};
		$('#modalbox')
			.querySelectorAll('[name]')
			.forEach((el) => (v[el.name] = pickVal(el)));
		const keys = SHAPES[v.shape] || [];
		['a', 'b', 'c', 'd'].forEach((k) => {
			const el = $('#modalbox').querySelector(`[name=${k}]`);
			el.style.display = keys.includes(k) ? '' : 'none';
			el.previousElementSibling.style.display = keys.includes(k) ? '' : 'none';
		});
		['modifier', 'mbase'].forEach((k) => {
			const el = $('#modalbox').querySelector(`[name=${k}]`).closest('.picker');
			el.style.display = v.shape === 'modified' ? '' : 'none';
			el.previousElementSibling.style.display = v.shape === 'modified' ? '' : 'none';
		});
		const err = validateFuzzy(v);
		$('#fzval').textContent = err || '';
		if (v.shape === 'modified') {
			if (v.modifier && v.mbase) {
				clearTimeout(window._mpT);
				window._mpT = setTimeout(
					() => modifiedPreview(toIri(v.modifier, 'datatype'), toIri(v.mbase, 'datatype'), '#fzprev'),
					250
				);
			} else
				$('#fzprev').innerHTML =
					'<span class="dt">choose a modifier and a base datatype to see μ\'(x) = modifier(μ_base(x))</span>';
		} else if (!err) {
			const p = {};
			keys.forEach((k) => (p[k] = parseFloat(v[k])));
			p.k1 = parseFloat(v.k1);
			p.k2 = parseFloat(v.k2);
			$('#fzprev').innerHTML = fuzzySVGdomain(v.shape, p);
		} else $('#fzprev').innerHTML = '';
	};
	$('#modalbox')
		.querySelectorAll('[name]')
		.forEach((el) => {
			el.addEventListener('input', upd);
			el.addEventListener('change', upd);
		});
	upd();
}
/**
 * Validate the values of the fuzzy datatype form.
 * Rules: numeric k1 ≤ k2 and parameters; parameters non-decreasing (a ≤ b ≤ …); for 'linear' a,b ∈ [0,1],
 * for the other shapes all parameters inside [k1,k2]; 'modified' needs modifier and base datatype.
 * @param {Object<string,string>} v Form values ({shape, k1, k2, a, b, c, d, modifier, mbase}).
 * @returns {?string} Error message or null when valid.
 */
function validateFuzzy(v) {
	if (v.shape === 'modified') return v.modifier && v.mbase ? null : 'modified: modifier and base datatype are required';
	const keys = SHAPES[v.shape];
	const nums = keys.map((k) => parseFloat(v[k]));
	const k1 = parseFloat(v.k1),
		k2 = parseFloat(v.k2);
	if ([k1, k2, ...nums].some(isNaN)) return 'missing numeric parameters';
	if (k1 > k2) return 'k1 must be ≤ k2';
	for (let i = 1; i < nums.length; i++) if (nums[i - 1] > nums[i]) return `${keys[i - 1]} ≤ ${keys[i]} required`;
	if (v.shape === 'linear') {
		if (nums[0] < 0 || nums[0] > 1) return 'linear: a is the knee abscissa on the normalized domain → 0 ≤ a ≤ 1';
		if (nums[1] < 0 || nums[1] > 1) return 'linear: b is the membership degree at the knee → 0 ≤ b ≤ 1';
	} else if (nums[0] < k1 || nums[nums.length - 1] > k2) return `parameters must lie in [k1,k2] = [${k1},${k2}]`;
	return null;
}
/**
 * SVG plot of a membership function over the explicit datatype domain [k1,k2] (all shapes, incl. crisp and linear).
 * @param {string} shape leftshoulder | rightshoulder | trapezoidal | triangular | crisp | linear.
 * @param {Object<string,number>} p Parameters plus k1, k2 (k1/k2 are axis bounds, not ticks).
 * @returns {string} Inline <svg> (430×168), '' for unknown shapes.
 */
function fuzzySVGdomain(shape, p) {
	// like fuzzySVG but the x-range is the datatype domain [k1,k2]
	const x0 = p.k1,
		x1 = p.k2;
	let pts;
	if (shape === 'leftshoulder')
		pts = [
			[x0, 1],
			[p.a, 1],
			[p.b, 0],
			[x1, 0]
		];
	else if (shape === 'rightshoulder')
		pts = [
			[x0, 0],
			[p.a, 0],
			[p.b, 1],
			[x1, 1]
		];
	else if (shape === 'trapezoidal')
		pts = [
			[x0, 0],
			[p.a, 0],
			[p.b, 1],
			[p.c, 1],
			[p.d, 0],
			[x1, 0]
		];
	else if (shape === 'triangular')
		pts = [
			[x0, 0],
			[p.a, 0],
			[p.b, 1],
			[p.c, 0],
			[x1, 0]
		];
	else if (shape === 'crisp')
		pts = [
			[x0, 0],
			[p.a, 0],
			[p.a, 1],
			[p.b, 1],
			[p.b, 0],
			[x1, 0]
		];
	else if (shape === 'linear')
		pts = [
			[x0, 0],
			[x0 + p.a * (x1 - x0), p.b],
			[x1, 1]
		]; // fuzzyDL: knee (a,b) on the normalized domain
	else return '';
	const W = 430,
		H = 168,
		L = 34,
		R = 14,
		T = 14,
		B = 36,
		iw = W - L - R,
		ih = H - T - B;
	const X = (x) => (L + ((x - x0) / (x1 - x0 || 1)) * iw).toFixed(1),
		Y = (y) => (T + (1 - y) * ih).toFixed(1);
	const path = pts.map((q, i) => (i ? 'L' : 'M') + X(q[0]) + ' ' + Y(q[1])).join(' ');
	let ticks;
	if (shape === 'linear') {
		const kx = x0 + p.a * (x1 - x0); // knee: a is normalized, b is a degree
		ticks =
			`<line x1="${X(kx)}" y1="${Y(0)}" x2="${X(kx)}" y2="${Y(p.b)}" stroke="#66727f" stroke-dasharray="2 2"/><text x="${X(kx)}" y="${+Y(0) + 16}" text-anchor="middle" font-size="10" fill="#66727f">a=${p.a} (x=${kx.toFixed(1)})</text>` +
			`<line x1="${L}" y1="${Y(p.b)}" x2="${X(kx)}" y2="${Y(p.b)}" stroke="#66727f" stroke-dasharray="2 2"/><text x="${L + 4}" y="${+Y(p.b) - 3}" font-size="10" fill="#66727f">b=${p.b}</text>`;
	} else
		ticks = Object.entries(p)
			.filter(([k]) => k !== 'k1' && k !== 'k2')
			.map(
				([k, v]) =>
					`<text x="${X(v)}" y="${+Y(0) + 16}" text-anchor="middle" font-size="10" fill="#66727f">${k}=${v}</text><line x1="${X(v)}" y1="${Y(0)}" x2="${X(v)}" y2="${+Y(0) + 4}" stroke="#66727f"/>`
			)
			.join('');
	return `<svg width="${W}" height="${H}" style="background:#fcfdff;border:1px solid var(--line);border-radius:8px"><line x1="${L}" y1="${Y(1)}" x2="${W - R}" y2="${Y(1)}" stroke="#e4e8ee" stroke-dasharray="3 3"/><line x1="${L}" y1="${Y(0)}" x2="${W - R}" y2="${Y(0)}" stroke="#aab2bd"/><line x1="${L}" y1="${Y(0)}" x2="${L}" y2="${T}" stroke="#aab2bd"/><text x="${L - 6}" y="${+Y(1) + 4}" text-anchor="end" font-size="10" fill="#66727f">1</text><text x="${L - 6}" y="${+Y(0) + 4}" text-anchor="end" font-size="10" fill="#66727f">0</text><text x="${L}" y="${H - 3}" font-size="10" fill="#66727f">k1=${x0}</text><text x="${W - R}" y="${H - 3}" text-anchor="end" font-size="10" fill="#66727f">k2=${x1}</text><path d="${path} L${X(x1)} ${Y(0)} L${X(x0)} ${Y(0)} Z" fill="rgba(52,87,176,.12)"/><path d="${path}" fill="none" stroke="#3457b0" stroke-width="2.2"/>${ticks}<text x="${(L + W - R) / 2}" y="${H - 3}" text-anchor="middle" font-size="10" fill="#66727f">μ(x) — ${shape}</text></svg>`;
}
// ---------- draggable membership-function editor (plots of the entity page) ----------
// membership degree of each shape parameter: where its handle sits on the plot
const FZ_MU = {
	leftshoulder: { a: 1, b: 0 },
	rightshoulder: { a: 0, b: 1 },
	triangular: { a: 0, b: 1, c: 0 },
	trapezoidal: { a: 0, b: 1, c: 1, d: 0 },
	crisp: { a: 1, b: 1 }
};
window._fzedit = {}; // state of the editable plots of the current entity page, by container id
/**
 * Editable membership plot: the domain SVG plus one draggable handle per shape parameter.
 * Dragging moves a/b/c/d horizontally within [k1,k2] (order preserved); "save shape" replaces
 * the fuzzy annotation as a pending change (undoable), "reset" restores the stored values.
 */
function fzEditablePlot(f, bd, lit, graph) {
	const id = 'fz' + Math.random().toString(36).slice(2);
	window._fzedit[id] = { shape: f.type, p: { ...f.p }, orig: { ...f.p }, k1: bd.kmin, k2: bd.kmax, lit, graph, s: selIri };
	return `<div id="${id}" style="position:relative;width:430px">${fzPlotHtml(id)}</div>`;
}
/** Inner HTML of one editable plot (SVG + handles + save/reset row); re-rendered on every drag step. */
function fzPlotHtml(id) {
	const e = window._fzedit[id];
	const L = 34,
		T = 14,
		iw = 430 - 34 - 14,
		ih = 168 - 14 - 36;
	const X = (x) => L + ((x - e.k1) / (e.k2 - e.k1 || 1)) * iw;
	const handles = Object.keys(e.p)
		.map(
			(k) =>
				`<span onpointerdown="fzDown(event,'${id}','${k}')" title="drag to move ${k}" style="position:absolute;left:${(X(e.p[k]) - 6).toFixed(1)}px;top:${(T + (1 - FZ_MU[e.shape][k]) * ih - 5).toFixed(1)}px;width:12px;height:12px;border-radius:50%;background:#3457b0;border:2px solid #fff;box-shadow:0 0 3px rgba(0,0,0,.4);cursor:ew-resize;touch-action:none"></span>`
		)
		.join('');
	const dirty = JSON.stringify(e.p) !== JSON.stringify(e.orig);
	return (
		fuzzySVGdomain(e.shape, Object.assign({}, e.p, { k1: e.k1, k2: e.k2 })) +
		handles +
		(dirty
			? `<div style="margin-top:2px"><button class="ibtn" onclick="fzApply('${id}')" title="Replace the membership function with the dragged shape (a pending change: save the files from the File menu)">save shape</button><button class="ibtn" onclick="fzReset('${id}')">reset</button> <span class="dt">${Object.entries(e.p)
					.map(([k, v]) => `${k}=${v}`)
					.join(' ')}</span></div>`
			: '')
	);
}
/** Pointer-down on a handle: horizontal drag until pointer-up, clamped to [k1,k2] and to the neighbour parameters. */
function fzDown(ev, id, k) {
	ev.preventDefault();
	const e = window._fzedit[id];
	const rect = document.querySelector(`#${id} svg`).getBoundingClientRect();
	const L = 34,
		iw = 430 - 34 - 14;
	const r = e.k2 - e.k1,
		dg = r >= 100 ? 1 : r >= 10 ? 2 : 3;
	const move = (mv) => {
		let x = e.k1 + ((mv.clientX - rect.left - L) / iw) * r;
		x = +Math.min(e.k2, Math.max(e.k1, x)).toFixed(dg);
		const ks = Object.keys(e.p),
			i = ks.indexOf(k);
		if (i > 0) x = Math.max(x, e.p[ks[i - 1]]);
		if (i < ks.length - 1) x = Math.min(x, e.p[ks[i + 1]]);
		e.p[k] = x;
		document.getElementById(id).innerHTML = fzPlotHtml(id);
	};
	const up = () => {
		document.removeEventListener('pointermove', move);
		document.removeEventListener('pointerup', up);
	};
	document.addEventListener('pointermove', move);
	document.addEventListener('pointerup', up);
}
/** "save shape": replace the fuzzy annotation of the entity with the dragged parameters (two journal ops). */
function fzApply(id) {
	const e = window._fzedit[id];
	const attrs = Object.entries(e.p)
		.map(([k, v]) => `${k}="${v}"`)
		.join(' ');
	const fl = `<fuzzyOwl2 fuzzyType="datatype">\n\t<Datatype type="${e.shape}" ${attrs}/>\n</fuzzyOwl2>\n`;
	post('/api/edit/remove', { s: e.s, p: fuzzyPropIri(), lit: e.lit, graph: e.graph })
		.then((r) => (r.error ? r : post('/api/edit/add', { s: e.s, p: fuzzyPropIri(), lit: fl, graph: e.graph })))
		.then((r) => {
			if (r.error) alert(r.error);
			else {
				refreshChanges();
				show(e.s);
			}
		});
}
/** "reset": back to the stored shape. */
function fzReset(id) {
	const e = window._fzedit[id];
	e.p = { ...e.orig };
	document.getElementById(id).innerHTML = fzPlotHtml(id);
}
/**
 * Form to create a fuzzy modifier (an rdfs:Datatype with fuzzyType="modifier") or edit an existing one.
 * Fields: name/namespace (new only), module, type (linear c | triangular a,b,c), live preview (#fmprev / #fmval).
 * On OK (after validateModifier): existing → remove old fuzzyLabel + add the new one; new → POST /api/edit/raw
 * with the rdfs:Datatype block (fuzzy label, label) and its triples; selIri = new IRI.
 * @param {{iri:string, lit:?string, graph:string}} [existing] Modifier being edited (undefined = create).
 * @returns {void}
 */
function fuzzyModifierForm(existing) {
	// existing = {iri, lit, graph}: edit in place
	const ex = existing ? fuzzyLabelAttrs(existing.lit || '') : {};
	openForm(
		existing ? 'Edit fuzzy modifier: ' + short(existing.iri) : 'New fuzzy modifier',
		[
			...(existing
				? [
						{
							type: 'html',
							html: `<label>Modifier</label><div>${esc(short(existing.iri))} <span class="dt">${esc(existing.iri)}</span></div>`
						}
					]
				: [
						{ name: 'name', label: 'Name (local)', required: true, placeholder: 'e.g. very' },
						{ name: 'ns', label: 'Namespace', value: NS.datatype }
					]),
			{
				name: 'graph',
				label: 'Target module',
				type: 'module',
				value:
					(existing && existing.graph) ||
					(ontoData?.ontologies.find((o) => o.iri === activeOnt) || {}).file ||
					modules[0]
			},
			{
				name: 'type',
				label: 'Type',
				type: 'select',
				options: [
					['linear', 'linear (c > 0)'],
					['triangular', 'triangular (a, b, c)']
				],
				value: ex.type || 'linear'
			},
			{ name: 'a', label: 'a', value: ex.a ?? '0' },
			{ name: 'b', label: 'b', value: ex.b ?? '0.5' },
			{ name: 'c', label: 'c', value: ex.c ?? '0.8' },
			{
				type: 'html',
				html: '<label>Preview: input degree x → modified degree μ\'(x)</label><div id="fmprev"></div><div id="fmval" class="err"></div>'
			}
		],
		(v) => {
			const err = validateModifier(v);
			if (err) return { error: err };
			const attrs = v.type === 'linear' ? `c="${v.c}"` : `a="${v.a}" b="${v.b}" c="${v.c}"`;
			const fl = `<fuzzyOwl2 fuzzyType="modifier">\n\t<Modifier type="${v.type}" ${attrs}/>\n</fuzzyOwl2>\n`;
			if (existing) {
				const s = existing.iri;
				const chain = existing.lit
					? post('/api/edit/remove', { s, p: fuzzyPropIri(), lit: existing.lit, graph: existing.graph })
					: Promise.resolve({});
				return chain.then((r) =>
					r.error ? r : post('/api/edit/add', { s, p: fuzzyPropIri(), lit: fl, graph: v.graph })
				);
			}
			const iri = v.ns + v.name.replace(/\s+/g, '_');
			const xml = `    <rdfs:Datatype rdf:about="${iri}" xmlns:sdf="${SDFNS}">\n        <sdf:${fuzzyLbl() || 'fuzzyLabel'}>${escXml(fl)}</sdf:${fuzzyLbl() || 'fuzzyLabel'}>\n        <rdfs:label xml:lang="en">${escXml(v.name)}</rdfs:label>\n    </rdfs:Datatype>`;
			return post('/api/edit/raw', {
				graph: v.graph,
				xml,
				triples: [
					{ s: iri, p: RDF + 'type', o: RDFS + 'Datatype' },
					{ s: iri, p: RDFS + 'label', lit: v.name, lang: 'en' },
					{ s: iri, p: fuzzyPropIri(), lit: fl }
				],
				subject: iri
			}).then((r) => {
				if (!r.error) selIri = iri;
				return r;
			});
		},
		'fuzzy-dl-owl2: modifiers are declared as rdfs:Datatype with fuzzyType="modifier"; they are used in "modified" concepts (e.g. (very Tall)). linear(c): ramp (0,0)→(a,b)→(1,1) with a=c/(c+1), b=1/(c+1); triangular(a,b,c): triangle on [0,1].'
	);
	// live update: a/b only for triangular, validate, redraw the preview
	const upd = () => {
		const v = {};
		$('#modalbox')
			.querySelectorAll('[name]')
			.forEach((el) => (v[el.name] = el.value.trim()));
		['a', 'b'].forEach((k) => {
			const el = $('#modalbox').querySelector(`[name=${k}]`);
			const show = v.type === 'triangular';
			el.style.display = show ? '' : 'none';
			el.previousElementSibling.style.display = show ? '' : 'none';
		});
		const err = validateModifier(v);
		$('#fmval').textContent = err || '';
		$('#fmprev').innerHTML = err ? '' : modifierSVG(v);
	};
	$('#modalbox')
		.querySelectorAll('[name]')
		.forEach((el) => {
			el.addEventListener('input', upd);
			el.addEventListener('change', upd);
		});
	upd();
}
/**
 * Validate the fuzzy modifier form: linear needs c > 0; triangular needs numeric 0 ≤ a ≤ b ≤ c ≤ 1.
 * @param {Object<string,string>} v Form values ({type, a, b, c}).
 * @returns {?string} Error message or null.
 */
function validateModifier(v) {
	if (v.type === 'linear') return parseFloat(v.c) > 0 ? null : 'linear: c > 0';
	const a = parseFloat(v.a),
		b = parseFloat(v.b),
		c = parseFloat(v.c);
	if ([a, b, c].some(isNaN)) return 'missing numeric parameters';
	if (!(a <= b && b <= c)) return 'triangular: a ≤ b ≤ c';
	if (a < 0 || c > 1) return 'triangular: parameters in [0,1]';
	return null;
}
/**
 * SVG plot of a modifier function on [0,1]×[0,1] (input degree → modified degree), with the identity as a dotted guide.
 * @param {{type:string, a?:string|number, b?:string|number, c:string|number}} v Modifier type and parameters (strings are parsed).
 * @returns {string} Inline <svg> (430×168).
 */
function modifierSVG(v) {
	let pts, title;
	if (v.type === 'linear') {
		const c = parseFloat(v.c),
			a = c / (c + 1),
			b = 1 / (c + 1);
		pts = [
			[0, 0],
			[a, b],
			[1, 1]
		];
		title = `linear-modifier(${c}) — knee (a=${a.toFixed(3)}, b=${b.toFixed(3)})`;
	} else {
		const a = parseFloat(v.a),
			b = parseFloat(v.b),
			c = parseFloat(v.c);
		pts = [
			[0, 0],
			[a, 0],
			[b, 1],
			[c, 0],
			[1, 0]
		];
		title = `triangular-modifier(${a}, ${b}, ${c})`;
	}
	const W = 430,
		H = 168,
		L = 34,
		R = 14,
		T = 14,
		B = 36,
		iw = W - L - R,
		ih = H - T - B;
	const X = (x) => (L + x * iw).toFixed(1),
		Y = (y) => (T + (1 - y) * ih).toFixed(1);
	const path = pts.map((q, i) => (i ? 'L' : 'M') + X(q[0]) + ' ' + Y(q[1])).join(' ');
	return `<svg width="${W}" height="${H}" style="background:#fcfdff;border:1px solid var(--line);border-radius:8px"><line x1="${L}" y1="${Y(1)}" x2="${W - R}" y2="${Y(1)}" stroke="#e4e8ee" stroke-dasharray="3 3"/><line x1="${L}" y1="${Y(0)}" x2="${W - R}" y2="${Y(0)}" stroke="#aab2bd"/><line x1="${L}" y1="${Y(0)}" x2="${L}" y2="${T}" stroke="#aab2bd"/><line x1="${X(0)}" y1="${Y(0)}" x2="${X(1)}" y2="${Y(1)}" stroke="#ccc" stroke-dasharray="2 3"/><text x="${L - 6}" y="${+Y(1) + 4}" text-anchor="end" font-size="10" fill="#66727f">1</text><text x="${L - 6}" y="${+Y(0) + 4}" text-anchor="end" font-size="10" fill="#66727f">0</text><text x="${L}" y="${H - 3}" font-size="10" fill="#66727f">x=0</text><text x="${W - R}" y="${H - 3}" text-anchor="end" font-size="10" fill="#66727f">x=1</text><path d="${path} L${X(1)} ${Y(0)} L${X(0)} ${Y(0)} Z" fill="rgba(122,75,179,.12)"/><path d="${path}" fill="none" stroke="#7a4bb3" stroke-width="2.2"/><text x="${(L + W - R) / 2}" y="${H - 3}" text-anchor="middle" font-size="10" fill="#66727f">${esc(title)}</text></svg>`;
}
/**
 * Form to define (or replace) the fuzzy concept of a class: the fuzzyLabel with <Concept type="…">.
 * Supported types: weightedSum/weightedSumZero/weightedMinimum/weightedMaximum (weighted components),
 * owa/choquet/sugeno/quasisugeno (Weights + Names), qowa (quantifier + Names), modified (modifier + base concept).
 * Components are dynamic rows in #fzrows (weight input .fw + class picker .fc) added by window.fzAddRow().
 * On OK: validation per type (Σw ≤ 1, one weight = 1, …), then POST /api/edit/remove of the old fuzzyLabel
 * (if any), /api/edit/add of the new one (no explicit graph: the server picks the declaring module).
 * @param {string} classIri Class IRI.
 * @param {?{lit:string, graph:string, parsed:?Object}} existing Current fuzzyLabel (parsed by parseFuzzy) used to prefill the rows, or null.
 * @returns {void}
 */
function fuzzyConceptForm(classIri, existing) {
	const types = [
		['weightedSum', 'weightedSum (Σw ≤ 1)'],
		['weightedSumZero', 'weightedSumZero (Σw ≤ 1)'],
		['weightedMinimum', 'weightedMinimum (one weight = 1)'],
		['weightedMaximum', 'weightedMaximum (one weight = 1)'],
		['owa', 'OWA (weights + concepts)'],
		['choquet', 'Choquet (weights + concepts)'],
		['sugeno', 'Sugeno (weights + concepts)'],
		['quasisugeno', 'Quasi-Sugeno (weights + concepts)'],
		['qowa', 'Quantified OWA (quantifier + concepts)'],
		['modified', 'modified (modifier + base concept)']
	];
	openForm(
		'Fuzzy concept for ' + short(classIri),
		[
			{ name: 'type', label: 'Aggregation type', type: 'select', options: types, value: 'weightedSum' },
			{ name: 'modifier', label: 'Modifier (modified)', type: 'entity', kind: 'datatype' },
			{ name: 'quantifier', label: 'Quantifier (qowa, a fuzzy datatype)', type: 'entity', kind: 'datatype' },
			{ name: 'mbase', label: 'Base concept (modified)', type: 'entity', kind: 'class' },
			{
				type: 'html',
				html: `<label>Components (weight + concept)</label><div id="fzrows"></div><span class="expand" onclick="fzAddRow()">+ add component</span>`
			}
		],
		(v) => {
			// component rows: {w: weight text, c: class IRI or local name}; rows without a class are ignored
			const rows = [...document.querySelectorAll('#fzrows .fzrow')]
				.map((r) => ({ w: r.querySelector('.fw').value.trim(), c: pickVal(r.querySelector('.fc')) }))
				.filter((r) => r.c);
			let inner;
			const t = v.type;
			if (t === 'modified') {
				if (!v.modifier || !v.mbase) return { error: 'modifier and base concept are required' };
				inner = `<Concept type="modified" modifier="${escXml(short(v.modifier))}" base="${escXml(short(v.mbase))}"/>`;
			} else if (t === 'qowa') {
				if (!v.quantifier || !rows.length) return { error: 'quantifier and concepts are required' };
				inner = `<Concept type="qowa" quantifier="${escXml(short(v.quantifier))}">\n\t\t<Names>${rows.map((r) => `<Name>${escXml(short(r.c))}</Name>`).join('')}</Names>\n\t</Concept>`;
			} else {
				if (!rows.length) return { error: 'add at least one component' };
				const ws = rows.map((r) => parseFloat(r.w));
				if (ws.some(isNaN)) return { error: 'missing numeric weights' };
				if ((t === 'weightedSum' || t === 'weightedSumZero') && ws.reduce((a, b) => a + b, 0) > 1.0000001)
					return { error: 'the sum of the weights must be ≤ 1' };
				if ((t === 'weightedMinimum' || t === 'weightedMaximum') && !ws.some((w) => w === 1))
					return { error: 'at least one weight must be 1' };
				// weighted* use nested <Concept type="weighted" value= base=>; the aggregation operators use parallel <Weights>/<Names> lists
				if (t.startsWith('weighted'))
					inner = `<Concept type="${t}">\n${rows.map((r) => `\t\t<Concept type="weighted" value="${r.w}" base="${escXml(short(r.c))}"/>`).join('\n')}\n\t</Concept>`;
				else
					inner = `<Concept type="${t}">\n\t\t<Weights>${rows.map((r) => `<Weight>${r.w}</Weight>`).join('')}</Weights>\n\t\t<Names>${rows.map((r) => `<Name>${escXml(short(r.c))}</Name>`).join('')}</Names>\n\t</Concept>`;
			}
			const fl = `<fuzzyOwl2 fuzzyType="concept">\n\t${inner}\n</fuzzyOwl2>\n`;
			const chain = existing
				? post('/api/edit/remove', {
						s: classIri,
						p: fuzzyPropIri(),
						lit: existing.lit,
						graph: existing.graph
					})
				: Promise.resolve({});
			return chain.then((r0) =>
				// a failed removal of the previous label must not be followed by the add
				r0 && r0.error ? r0 : post('/api/edit/add', { s: classIri, p: fuzzyPropIri(), lit: fl })
			);
		},
		'fuzzy-dl-owl2: one fuzzyLabel per class (the existing one is replaced). Concept/modifier names are the local names (after #). "nominal" is not supported by the FuzzyDL writer.'
	);
	/** Append one component row (weight + class picker + ✕) to #fzrows; global because the "+ add component" link calls it inline. */
	window.fzAddRow = () => {
		const d = document.createElement('div');
		d.className = 'fzrow';
		d.style = 'display:flex;gap:6px;margin-top:4px';
		d.innerHTML = `<input class="fw" placeholder="weight" style="width:80px" value="0.5"><div class="picker" style="flex:1"><input class="fc" placeholder="search class…" autocomplete="off"><div class="res"></div></div><span class="rm" onclick="this.parentNode.remove()">✕</span>`;
		$('#fzrows').appendChild(d);
		bindPicker(d.querySelector('.fc'), 'class');
	};
	// prefill: one row per parsed component (base = local name in CLASSNS, or a full IRI for OWA) and the aggregation type
	if (existing && existing.parsed) {
		(existing.parsed.parts || []).forEach((p) => {
			fzAddRow();
			const r = $('#fzrows').lastChild;
			r.querySelector('.fw').value = p.w;
			const iri = p.base ? CLASSNS + p.base : p.iri || '';
			const fc = r.querySelector('.fc');
			fc.dataset.iri = iri;
			fc.value = short(iri);
			fc.title = iri;
		});
		const sel = $('#modalbox [name=type]');
		if (existing.parsed.type) sel.value = existing.parsed.type === 'OWA' ? 'owa' : existing.parsed.type;
	} else fzAddRow();
}
/**
 * Form to attach a fuzzy truth degree to an assertion: a fuzzyLabel axiom annotation with <Degree value="…"/>
 * (POST /api/edit/axiom_ann_add). Parameters identify the triple as in removeAssertion.
 * @param {string} s Subject IRI.
 * @param {string} p Predicate IRI.
 * @param {?string} o Object IRI.
 * @param {?string} lit Literal value.
 * @param {?string} dt Literal datatype IRI.
 * @param {?string} lang Language tag.
 * @param {string} graph Module file.
 * @returns {void}
 */
function axiomDegreeForm(s, p, o, lit, dt, lang, graph) {
	openForm(
		'Fuzzy degree of the assertion',
		[
			{
				type: 'html',
				html: `<div class="dt">${esc(short(s))} — ${esc(short(p))} — ${esc(lit != null ? lit : short(o || ''))}</div>`
			},
			{ name: 'value', label: 'Truth degree (0..1)', value: '0.8', required: true }
		],
		(v) => {
			const d = parseFloat(v.value);
			if (!(d >= 0 && d <= 1)) return { error: 'degree in [0,1]' };
			return post('/api/edit/axiom_ann_add', {
				s,
				p,
				o: o || undefined,
				lit: lit == null ? undefined : lit,
				dt: dt || undefined,
				lang: lang || undefined,
				graph,
				value: `<fuzzyOwl2 fuzzyType="axiom">\n\t<Degree value="${d}"/>\n</fuzzyOwl2>\n`
			});
		},
		'fuzzy-dl-owl2: fuzzyLabel annotation on the axiom (owl:Axiom) with <Degree value=…/>; without annotation the degree is 1.0.'
	);
}
/**
 * Remove every axiom annotation of an assertion after confirmation (POST /api/edit/axiom_ann_remove without `prop`),
 * then refresh the changes widget and the current entity. Same parameters as axiomDegreeForm.
 * @returns {void}
 */
function removeDegree(s, p, o, lit, dt, lang, graph) {
	if (!confirm('Remove the fuzzy degree from this assertion?')) return;
	post('/api/edit/axiom_ann_remove', {
		s,
		p,
		o: o || undefined,
		lit: lit == null ? undefined : lit,
		dt: dt || undefined,
		lang: lang || undefined,
		graph
	}).then(() => {
		refreshChanges();
		show(encodeURIComponent(selIri));
	});
}

// ---------- detail ----------

// ---------- entity view (ontology-editor-like panels: Annotations / Characteristics / Description / Property assertions) ----------
// inline SVG icons for the per-row action buttons (help = explain, label = annotate, edit, del, add = "+", menu = burger)
const ICON = {
	// Material Design icon paths (24px viewBox)
	help: '<svg viewBox="0 0 24 24"><path d="M11 18h2v-2h-2v2zm1-16C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-14c-2.21 0-4 1.79-4 4h2c0-1.1.9-2 2-2s2 .9 2 2c0 2-3 1.75-3 5h2c0-2.25 3-2.5 3-5 0-2.21-1.79-4-4-4z"/></svg>',
	label:
		'<svg viewBox="0 0 24 24"><path d="M17.63 5.84C17.27 5.33 16.67 5 16 5L5 5.01C3.9 5.01 3 5.9 3 7v10c0 1.1.9 1.99 2 1.99L16 19c.67 0 1.27-.33 1.63-.84L22 12l-4.37-6.16zM16 17H5V7h11l3.55 5L16 17z"/></svg>',
	del: '<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM8 9h8v10H8V9zm7.5-5-1-1h-5l-1 1H5v2h14V4z"/></svg>',
	edit: '<svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM5.92 19H5v-.92l9.06-9.06.92.92L5.92 19zM20.71 5.63l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83a1 1 0 0 0 0-1.41z"/></svg>',
	add: '<svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>',
	menu: '<svg viewBox="0 0 24 24"><path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>'
};
// property characteristics (owl:*Property types) offered as checkboxes per property kind, and their labels
const CHARS = {
	objprop: [
		'FunctionalProperty',
		'InverseFunctionalProperty',
		'TransitiveProperty',
		'SymmetricProperty',
		'AsymmetricProperty',
		'ReflexiveProperty',
		'IrreflexiveProperty'
	],
	dataprop: ['FunctionalProperty']
};
const CHAR_LABEL = {
	FunctionalProperty: 'Functional',
	InverseFunctionalProperty: 'Inverse functional',
	TransitiveProperty: 'Transitive',
	SymmetricProperty: 'Symmetric',
	AsymmetricProperty: 'Asymmetric',
	ReflexiveProperty: 'Reflexive',
	IrreflexiveProperty: 'Irreflexive'
};
// built-in annotation properties: literals with these predicates always go to the Annotations panel (never to data assertions)
const ANN_PREDS = new Set([
	RDFS + 'label',
	RDFS + 'comment',
	RDFS + 'seeAlso',
	RDFS + 'isDefinedBy',
	OWLNS + 'versionInfo',
	OWLNS + 'deprecated',
	OWLNS + 'priorVersion',
	OWLNS + 'backwardCompatibleWith',
	OWLNS + 'incompatibleWith'
]);
let curEntity = null; // {d: /api/entity payload, ax: /api/entity_axioms payload} of the entity shown in #detail

// ---- rows and sections shared by the entity view (show), the anonymous-individual cards and the mini panels ----
/**
 * JS expression yielding an IRI, safe to embed in onclick="…" attributes whatever the IRI contains.
 * @param {string} iri
 * @returns {string}
 */
const jsIri = (iri) => `decodeURIComponent('${encodeURIComponent(iri)}')`;
/**
 * One panel row: value + "[module]" tag + action icons.
 * @param {string} inner Value markup. @param {string} [actions] Action icons markup. @param {string} [mod] Module file.
 * @returns {string} HTML.
 */
const prow = (inner, actions, mod) =>
	`<div class="prow"><div class="val">${inner}${mod ? ` <span class="mod" title="asserted in ${esc(mod)}">${esc(mod)}</span>` : ''}</div>${actions || ''}</div>`;
/**
 * A titled section of a panel: uppercase title with the number of rows, an optional "+" button, optional extra
 * markup, then the rows. A section without any body collapses to its title line (class "blank", "+" still active).
 * @param {string} title Section title. @param {string} [plus] Markup of the "+" button (see plusBtn).
 * @param {string} [rows] Row markup (prow). @param {string} [extra] Markup appended to the title line.
 * @returns {string} HTML.
 */
function sectHtml(title, plus, rows, extra) {
	const body = (rows || '').trim();
	const n = body.split('class="prow').length - 1;
	// data-sect lets rows be appended later (inferred rows of an individual, inference.js)
	return `<div class="psec${body ? '' : ' blank'}" data-sect="${esc(title)}"><div class="ptitle">${title}${n ? ` <span class="pcount">(${n})</span>` : ''} ${plus || ''}${extra || ''}</div>${body}</div>`;
}
/**
 * Tooltip of a "+" button: TIPS.plus["<kind>:<what>"], else TIPS.plus[what], else "Add <label>"; "{name}" in the
 * text becomes the subject name (or "this entity").
 * @param {string} kind Kind of the subject. @param {string} what addAssertion key.
 * @param {string} [label] Section title (fallback). @param {string} [name] Subject name.
 * @returns {string} Attribute-safe text.
 */
const plusTip = (kind, what, label, name) =>
	tip('plus', [kind + ':' + what, what], { name: name || 'this entity' }, 'Add ' + (label || ''));
/**
 * "+" button of a section: opens addAssertion(what) on the subject.
 * @param {string} S JS expression of the subject IRI (jsIri). @param {string} kind Kind of the subject.
 * @param {string} what addAssertion key. @param {string} [label] Section title (fallback of the tooltip).
 * @param {string} [name] Subject name, quoted in the tooltip.
 * @returns {string} HTML.
 */
const plusBtn = (S, kind, what, label, name) =>
	`<button class="plus" title="${plusTip(kind, what, label, name)}" onclick="addAssertion(${S},'${kind}','${what}')">${ICON.add}</button>`;
/**
 * Argument list "(s, p, o, lit, dt, lang, graph)" of the row actions (removeAssertion, editAssertion, …) as JS source.
 * @param {string} S JS expression of the subject IRI. @param {Object} g Statement group. @param {Object} v Value.
 * @returns {string}
 */
function argsOf(S, g, v) {
	const lit = 'lit' in v;
	return `${S},'${esc(g.piri)}',${lit ? 'null' : `'${esc(v.iri)}'`},${lit ? `decodeURIComponent('${encodeURIComponent(v.lit)}')` : 'null'},${lit && v.dt_iri ? `'${esc(v.dt_iri)}'` : 'null'},${lit && v.lang ? `'${esc(v.lang)}'` : 'null'},'${esc(v.graph || '')}'`;
}
/**
 * The four action icons of a named-triple row: explain, annotate (highlighted when annotations exist), edit, remove.
 * @param {string} S JS expression of the subject IRI. @param {Object} g Statement group. @param {Object} v Value.
 * @returns {string} HTML.
 */
function rowActs(S, g, v) {
	const a = argsOf(S, g, v);
	const na = (v.axiom_ann || []).length;
	return (
		`<span class="acts">${actIcon('', 'explain', `explainAxiom(${a})`)}` +
		actIcon(na ? ' has' : '', na ? 'annHas' : 'ann', `annotateAxiom(${a})`, { n: na }) +
		actIcon('', 'edit', `editAssertion(${a})`) +
		actIcon(' del', 'del', `removeAssertion(${a})`) +
		`</span>`
	);
}
/**
 * One row action icon (a keyboard-reachable span with role=button): the tooltip of TIPS.act[key] is also its
 * accessible label; the icon follows the key (explain → ?, ann* → label, edit* → pencil, del → bin, assert → +).
 * @param {string} cls Extra class(es) with a leading space ('' | ' del' | ' has').
 * @param {string} key TIPS.act key. @param {string} js Inline onclick code. @param {Object} [vars] Placeholders of the text.
 * @returns {string} HTML.
 */
function actIcon(cls, key, js, vars) {
	const t = tip('act', key, vars);
	const icon =
		key === 'explain'
			? 'help'
			: key.startsWith('ann')
				? 'label'
				: key.startsWith('edit')
					? 'edit'
					: key === 'del'
						? 'del'
						: 'add';
	return `<span class="act${cls}" role="button" tabindex="0" aria-label="${t}" title="${t}" onclick="${js}">${ICON[icon]}</span>`;
}
/**
 * Purple badges for the axiom annotations of a value: "degree x" for fuzzy degrees, else "prop: value…".
 * @param {Object} v Value with optional axiom_ann [{prop, value, graph?}] (the annotations of an anonymous-expression
 *   axiom carry no graph).
 * @returns {string} HTML.
 */
const badges = (v) =>
	(v.axiom_ann || [])
		.map((a) => {
			const m = /Degree value="([^"]+)"/.exec(a.value);
			return ` <span class="badge" style="background:var(--datatype)" title="${esc(a.prop)}${a.graph ? ` [${esc(a.graph)}]` : ''}">${m ? 'degree ' + m[1] : esc(a.prop) + ': ' + esc(a.value.slice(0, 40))}</span>`;
		})
		.join('');
/**
 * Literal value: clamped with a "show all" toggle when longer than 300 chars, plus datatype and language tags.
 * @param {{lit:string, dt?:string, lang?:string}} v
 * @returns {string} HTML.
 */
const litRender = (v) => {
	const long = v.lit.length > 300;
	return (
		`<span class="lit${long ? ' clamp' : ''}">${esc(v.lit)}</span>` +
		(long
			? `<span class="expand" onclick="const l=this.previousSibling;l.classList.toggle('clamp');this.textContent=l.classList.contains('clamp')?'show all ▾':'collapse ▴'">show all ▾</span>`
			: '') +
		(v.dt ? ` <span class="dt">^^${esc(v.dt)}</span>` : '') +
		(v.lang ? ` <span class="dt">[language: ${v.lang}]</span>` : '')
	);
};
/**
 * Entity value: a link, or the inline card of an anonymous individual (kind 'anon').
 * @param {Object} v Entity value of the API.
 * @returns {string} HTML.
 */
const valLink = (v) => (v.kind === 'anon' ? anonCard(v) : entLink(v));
/**
 * True for a statement group whose predicate is an annotation property: built-in (ANN_PREDS), declared
 * (pkind 'annprop') or one of the fuzzy markers.
 * @param {Object} g Statement group of GET /api/entity.
 * @returns {boolean}
 */
const isAnnGroup = (g) =>
	ANN_PREDS.has(g.piri) || g.pkind === 'annprop' || (!!fuzzyLbl() && g.pred === fuzzyLbl());
/**
 * Rows of the annotation and (for individuals, named or anonymous) the type / assertion sections of an entity
 * payload: annotations = annotation-property groups (literal or entity-valued, anonymous individuals as cards) plus,
 * for classes / properties / datatypes, every other literal — the fuzzy markers (fuzzyLabel rendered by fuzzyRender,
 * the fuzzy annotation) are returned apart; types = rdf:type without owl:NamedIndividual; object property assertions = IRI-valued
 * groups outside the rdfs: / owl: vocabularies that are not annotations; data property assertions = the other literals.
 * @param {Object} d GET /api/entity payload. @param {string} S JS expression of the subject IRI. @param {string} kind Kind of the subject.
 * @returns {{ann:string, fuzzy:string, types?:string, obj?:string, data?:string}} HTML rows per section.
 */
function individualRows(d, S, kind) {
	const isInd = kind === 'individual' || kind === 'anon';
	const row = (g, v, inner) => prow(inner + badges(v), rowActs(S, g, v), v.graph);
	const pred = (g) => `<b style="font-size:12px">${esc(g.pred)}</b> `;
	const groups = (test) => d.out.filter((g) => g.values[0] && test(g));
	const rowsOf = (gs, render) => gs.map((g) => g.values.map((v) => row(g, v, render(g, v))).join('')).join('');
	const isFuzzyGroup = (g) => !!fuzzyLbl() && g.pred === fuzzyLbl();
	const annRender = (g, v) =>
		pred(g) +
		('lit' in v
			? `${v.lang ? `<span class="dt">[language: ${esc(v.lang)}]</span>` : ''}<div>${isFuzzyGroup(g) ? fuzzyRender(v.lit, v.graph) : litRender({ ...v, lang: null })}</div>`
			: `<div>${valLink(v)}</div>`);
	const ann = rowsOf(
		groups((g) => !isFuzzyGroup(g) && (isAnnGroup(g) || ('lit' in g.values[0] && !isInd))),
		annRender
	);
	const fuzzy = rowsOf(groups(isFuzzyGroup), annRender);
	if (!isInd) return { ann, fuzzy };
	const types = d.out.find((g) => g.piri === RDF + 'type');
	return {
		ann,
		fuzzy,
		types: types
			? types.values
					.filter((v) => v.name !== 'NamedIndividual')
					.map((v) => row(types, v, valLink(v)))
					.join('')
			: '',
		obj: rowsOf(
			groups(
				(g) =>
					'iri' in g.values[0] &&
					!isAnnGroup(g) &&
					!g.piri.startsWith(RDFS) &&
					!g.piri.startsWith(OWLNS) &&
					g.piri !== RDF + 'type'
			),
			(g, v) => pred(g) + valLink(v)
		),
		data: rowsOf(
			groups((g) => 'lit' in g.values[0] && !isAnnGroup(g)),
			(g, v) => pred(g) + litRender(v)
		)
	};
}
/**
 * The description sections of an individual-like node (named or anonymous), each with its "+" button: annotations
 * (fuzzy markers included), types, object / data property assertions and the negative ones (file-only, hence a note
 * instead of rows).
 * @param {Object} d GET /api/entity payload. @param {string} S JS expression of the subject IRI.
 * @param {Object} [rows] Precomputed individualRows(d, S, 'individual').
 * @returns {{ann:string, types:string, obj:string, data:string, negobj:string, negdata:string}} HTML sections.
 */
function individualSections(d, S, rows) {
	const r = rows || individualRows(d, S, 'individual');
	const sect = (title, what, body) => sectHtml(title, plusBtn(S, 'individual', what, title, d.node.name), body);
	return {
		ann: sect('Annotations', 'ann', r.ann + r.fuzzy),
		types: sect('Types', 'type', r.types),
		obj: sect('Object property assertions', 'rel', r.obj),
		data: sect('Data property assertions', 'data', r.data),
		negobj: sect(
			'Negative object property assertions',
			'negobj',
			'<span class="dt" style="padding-left:12px">written to the file on Save (not indexed)</span>'
		),
		negdata: sect('Negative data property assertions', 'negdata', '')
	};
}

// ---- anonymous individuals: inline cards ----
const ANON_OPEN = new Set(); // pseudo-IRIs of the cards currently expanded (re-expanded after a re-render)
/**
 * Inline card of an anonymous individual used as a value: diamond icon + node id, collapsed; the description
 * (same sections as a named individual, nested cards for anonymous values) loads on the first expand.
 * @param {{iri:string, name:string}} v Entity value of kind 'anon'.
 * @returns {string} HTML.
 */
function anonCard(v) {
	return `<div class="anon" data-iri="${esc(v.iri)}"><div class="anonhead" onclick="anonToggle(this.parentNode)"><span class="tg">▸</span><span class="anonic">${ic('diamond')}</span>Anonymous individual <code>${esc(v.name)}</code></div><div class="anonbody" hidden></div></div>`;
}
/**
 * Expand / collapse an anonymous-individual card: GET /api/entity of the node, then its sections (individualSections)
 * whose "+" buttons and row actions target the anonymous node; nested cards that were open are re-expanded.
 * @param {Element} card The .anon element. @param {boolean} [open] Force a state (default: toggle).
 * @returns {void}
 */
function anonToggle(card, open) {
	const iri = card.dataset.iri,
		body = card.querySelector(':scope > .anonbody'),
		tg = card.querySelector(':scope > .anonhead .tg');
	const on = open != null ? open : body.hidden;
	if (!on) {
		body.hidden = true;
		tg.textContent = '▸';
		ANON_OPEN.delete(iri);
		return;
	}
	ANON_OPEN.add(iri);
	tg.textContent = '▾';
	body.hidden = false;
	body.innerHTML = '<span class="dt">loading…</span>';
	api('/api/entity', { iri }).then((d) => {
		if (!document.contains(body)) return; // the page was re-rendered meanwhile
		if (d.error) {
			body.innerHTML = '<span class="dt">not found</span>';
			return;
		}
		const s = individualSections(d, jsIri(iri));
		body.innerHTML = s.ann + s.types + s.obj + s.data + s.negobj + s.negdata;
		anonRestore(body);
	});
}
/**
 * Re-expand, inside `root`, the cards that were open before a re-render (ANON_OPEN).
 * @param {Element} root
 * @returns {void}
 */
function anonRestore(root) {
	root.querySelectorAll('.anon').forEach((c) => {
		if (ANON_OPEN.has(c.dataset.iri) && c.querySelector(':scope > .anonbody').hidden) anonToggle(c, true);
	});
}

// ---- mini description panel of a NEW anonymous individual (annotation dialog "Property values", object assertion dialog) ----
/** Local assertion lists of the mini panels currently open: panel id → {annotations, types, obj, data, neg_obj, neg_data}
 *  of entries {api: payload item, html: row text}. */
const ANON_PANELS = {};
/** Sections of a mini panel: title, addAssertion key of its "+", list key of the spec. */
const ANON_SECTIONS = [
	['Annotations', 'ann', 'annotations'],
	['Types', 'type', 'types'],
	['Object property assertions', 'rel', 'obj'],
	['Data property assertions', 'data', 'data'],
	['Negative object property assertions', 'negobj', 'neg_obj'],
	['Negative data property assertions', 'negdata', 'neg_data']
];
/**
 * Markup of a mini panel (filled by anonPanelInit once it is in the DOM).
 * @param {string} id Panel id (unique in the dialog).
 * @returns {string} HTML.
 */
const anonPanelHtml = (id) => `<div class="anonpanel" id="ap_${id}"></div>`;
/** Reset the local lists of a panel and draw it. @param {string} id Panel id. @returns {void} */
function anonPanelInit(id) {
	ANON_PANELS[id] = { annotations: [], types: [], obj: [], data: [], neg_obj: [], neg_data: [] };
	anonPanelDraw(id);
}
/** Draw the six sections of a panel: each entry is a row with its text and a ✕ (remove). @param {string} id @returns {void} */
function anonPanelDraw(id) {
	const box = $('#ap_' + id),
		st = ANON_PANELS[id];
	if (!box || !st) return;
	box.innerHTML = ANON_SECTIONS.map(([title, what, key]) =>
		sectHtml(
			title,
			`<button type="button" class="plus" title="${plusTip('individual', what, title, 'the new anonymous individual')}" onclick="anonPanelAdd('${id}','${what}')">${ICON.add}</button>`,
			st[key]
				.map((e, i) =>
					prow(
						e.html,
						`<span class="rm" role="button" tabindex="0" title="Remove this entry from the list (nothing has been added to the ontology yet)" onclick="anonPanelRemove('${id}','${key}',${i})">✕</span>`
					)
				)
				.join('')
		)
	).join('');
}
/** ✕ of a row: drop the entry and redraw. @param {string} id @param {string} key List key. @param {number} i Index. */
function anonPanelRemove(id, key, i) {
	ANON_PANELS[id][key].splice(i, 1);
	anonPanelDraw(id);
	xdUpdate();
}
/**
 * "+" of a panel section: the same dialog as for a named individual (addAssertion), opened on top of the current
 * dialog (modalPush); its result joins the local list (anonPanelAccept) instead of being posted.
 * @param {string} id Panel id. @param {string} what addAssertion key.
 * @returns {void}
 */
function anonPanelAdd(id, what) {
	modalPush(() => {
		anonPanelDraw(id);
		xdUpdate();
	});
	addAssertion(null, 'individual', what, (url, payload) => {
		anonPanelAccept(id, what, url, payload);
		return {};
	});
}
/**
 * Text of a nested anonymous individual in the local lists.
 * @param {Object} spec anonPanelSpec result.
 * @returns {string} HTML.
 */
const anonSpecText = (spec) =>
	`<span class="anonic">${ic('diamond')}</span> Anonymous individual <span class="dt">(${Object.values(spec).reduce((n, l) => n + l.length, 0)} assertions)</span>`;
/**
 * Turn the request a dialog would send into an entry of the panel's local lists (API item + row text):
 * annotations ({lit, dt, lang} | {o} | {o_anon}), types (named class or Manchester expression), object / data
 * assertions and their negative variants (POST /api/edit/negative).
 * @param {string} id Panel id. @param {string} what addAssertion key. @param {string} url Endpoint. @param {Object} payload Request body.
 * @returns {void}
 */
function anonPanelAccept(id, what, url, payload) {
	const st = ANON_PANELS[id];
	const pn = (iri) => esc(xdName(iri));
	const neg = url.endsWith('/negative');
	const objText = (o, oAnon) => (oAnon ? anonSpecText(oAnon) : pn(o));
	if (what === 'ann') {
		const val = payload.o_anon ? { anon: payload.o_anon } : payload.o != null ? { iri: payload.o } : payload.lit;
		st.annotations.push({
			api: [payload.p, val, payload.dt || null, payload.lang || null],
			html:
				`<b>${pn(payload.p)}</b> ` +
				(typeof val === 'string' ? esc(litText(val, payload.dt, payload.lang)) : objText(payload.o, payload.o_anon))
		});
	} else if (what === 'type') {
		if (payload.expr)
			st.types.push({ api: { expr: payload.expr }, html: `<span class="expr">${esc(payload.expr)}</span>` });
		else st.types.push({ api: payload.o, html: pn(payload.o) });
	} else if (payload.lit != null) {
		(neg ? st.neg_data : st.data).push({
			api: [payload.p, payload.lit, payload.dt || null, payload.lang || null],
			html: `<b>${pn(payload.p)}</b> ${esc(litText(payload.lit, payload.dt, payload.lang))}`
		});
	} else {
		(neg ? st.neg_obj : st.obj).push({
			api: [payload.p, payload.o_anon ? { anon: payload.o_anon } : payload.o],
			html: `<b>${pn(payload.p)}</b> ${objText(payload.o, payload.o_anon)}`
		});
	}
}
/**
 * The `o_anon` payload of a panel: {annotations: [[p, value, dt, lang]…], types: [iri | {expr}…], obj: [[p, o]…],
 * data: [[p, lit, dt, lang]…], neg_obj: [[p, o]…], neg_data: [[p, lit, dt, lang]…]} (POST /api/edit/add).
 * @param {string} id Panel id.
 * @returns {Object}
 */
function anonPanelSpec(id) {
	const st = ANON_PANELS[id] || {};
	const out = {};
	ANON_SECTIONS.forEach(([, , key]) => (out[key] = (st[key] || []).map((e) => e.api)));
	return out;
}
// ---- entity view (show): sticky header + per-entity tab bar, one panel per tab ----
/** Labels of the tabs of the entity view, by tab id (entityPanels decides which ones an entity offers). */
const ENT_TAB_LABEL = { desc: 'Description', ann: 'Annotations', usage: 'Usage', inst: 'Instances', fuzzy: 'Fuzzy' };
/**
 * Row of an axiom involving an anonymous expression (GET /api/entity_axioms item): the DL text, the badges of its
 * annotations and the same four actions as a named triple — edit / remove / annotate work on the expression (matched
 * by its DL text), hence only when subject, predicate and Manchester text are known.
 * @param {Object} a Axiom {kind, dl, odl?, man?, siri?, piri?, module?, ann?}.
 * @returns {string} HTML.
 */
function anonRow(a) {
	const j = JSON.stringify(a).replace(/"/g, '&quot;'); // the whole axiom object is passed as JSON in the onclick
	const editable = a.siri && a.piri && a.man;
	const na = (a.ann || []).length;
	const act = (cls, key, fn) => actIcon(cls, key, `${fn}(${j})`, { n: na });
	return prow(
		`<span class="expr" title="${esc(a.dl)}">${esc(a.odl || a.dl)}</span>${badges({ axiom_ann: a.ann })}`,
		`<span class="acts">${act('', 'explain', 'explainAnon')}${
			editable
				? act(na ? ' has' : '', na ? 'annHas' : 'ann', 'annotateAnon') +
					act('', 'editAnon', 'editAnon') +
					act(' del', 'del', 'removeAnon')
				: ''
		}</span>`,
		a.module
	);
}
/**
 * Context shared by the builders of the entity view: the two API payloads, the node, its kind, the subject expression
 * (S, see jsIri), the outgoing groups by predicate (byP), the annotation / assertion rows (individualRows), the
 * fuzzyLabel value (fzv) and the row builders bound to the entity:
 *   namedRows(piri, render) — rows of the outgoing values of one predicate (+ "… and N more" when truncated);
 *   symRows(piri) — symmetric axioms asserted from the other side (X equivalentClass THIS), actions on the real triple;
 *   bothRows(piri, render) — own + symmetric rows;
 *   own(kind) / ownRows(kind) — own schema axioms of a kind that involve an anonymous expression (named ones are triples);
 *   inf(key, piri) — rows inferred by the reasoner for a hierarchy section (infRows, inference.js; '' when inactive);
 *   A(what, label) — "+" button → addAssertion(what); sect(title, what, rows, extra) — titled section with that button.
 * Side effect: window._curBounds (datatype domain used by fuzzyRender) is set before the rows are built.
 * @param {Object} d GET /api/entity payload. @param {Object} ax GET /api/entity_axioms payload.
 * @returns {Object}
 */
function entityContext(d, ax) {
	const n = d.node;
	const kind = n.kind || '?';
	const S = jsIri(n.iri);
	const isInd = kind === 'individual' || kind === 'anon'; // an anonymous individual gets the individual panels
	const byP = {};
	d.out.forEach((g) => (byP[g.piri] = g));
	window._curBounds = d.bounds || null;
	const E = { d, ax, n, kind, S, isInd, byP, rows: individualRows(d, S, kind) };
	const fz = d.out.find((g) => fuzzyLbl() && g.pred === fuzzyLbl());
	E.fzv = fz && fz.values[0];
	E.fuzzy = !!(n.fuzzy || E.fzv); // the entity has a fuzzy definition → Fuzzy tab
	E.namedRows = (piri, render) => {
		const g = byP[piri];
		if (!g) return '';
		return (
			g.values.map((v) => prow(render(v) + badges(v), rowActs(S, g, v), v.graph)).join('') +
			(g.more ? prow(`<span class="dt">… and ${g.more} more</span>`) : '')
		);
	};
	E.symRows = (piri) => {
		const g = (d.incoming || []).find((x) => x.piri === piri);
		if (!g) return '';
		return g.values
			.filter((v) => v.iri !== n.iri)
			.map((v) =>
				prow(
					entLink(v) +
						` <span class="dt" title="asserted as ${esc(v.name)} → ${esc(short(piri))} → ${esc(n.name)}">(asserted on ${esc(v.name)})</span>`,
					rowActs(jsIri(v.iri), { piri }, { iri: n.iri, graph: v.graph, axiom_ann: v.axiom_ann }),
					v.graph
				)
			)
			.join('');
	};
	E.bothRows = (piri, render) => E.namedRows(piri, render) + E.symRows(piri);
	E.own = (k) => (ax.own || []).filter((a) => a.kind === k && a.anon);
	E.ownRows = (k) => E.own(k).map(anonRow).join('');
	E.inf = (key, piri) => infRows(E, key, piri);
	E.A = (what, label) => plusBtn(S, isInd ? 'individual' : kind, what, label, n.name);
	E.sect = (title, what, rows, extra) => sectHtml(title, what ? E.A(what, title) : '', rows, extra);
	return E;
}
/**
 * An elevated panel of the entity view: colour-coded title "Title: name" and a body.
 * @param {Object} E entityContext. @param {string} title Panel title. @param {string} body Body markup.
 * @param {string} [cls] Extra class of the body (e.g. "chars").
 * @returns {string} HTML.
 */
const panelHtml = (E, title, body, cls) =>
	`<div class="panel ${E.kind}"><h3>${title}: ${esc(E.n.name)}</h3><div class="body${cls ? ' ' + cls : ''}">${body}</div></div>`;
/**
 * Header card of the entity: burger menu (diamond for an anonymous individual), kind dot, label, IRI, delete button,
 * kind badge and module chips.
 * @param {Object} E entityContext.
 * @returns {string} HTML.
 */
function entityHeader(E) {
	const { n, kind, S, d } = E;
	const head =
		kind === 'anon'
			? `<span class="anonic" style="margin-right:6px">${ic('diamond')}</span>`
			: `<span class="burger" title="menu" onclick="entityMenu(event,${S},'${esc(n.name)}')">${ICON.menu}</span>${dot(kind, n.fuzzy)}`;
	return `<div class="card ehdr"><h2 class="ehead">${head}${esc(n.label || n.name)} <span class="dt" style="font-weight:400">—&nbsp;${esc(n.iri)}</span>
<button class="ibtn danger" style="margin-left:auto" onclick="deleteEntity(${S})" title="Delete ${esc(n.name)} and every assertion involving it, in all modules (pending until Save)">${ic('delete')} delete</button></h2>
<div style="margin-top:6px"><span class="badge" style="background:${n.fuzzy ? KCF[kind] || '#f28c28' : KC[kind] || '#999'}">${KL[kind] || kind}${n.fuzzy ? ' · fuzzy' : ''}${n.builtin ? ' · built-in' : ''}</span>${(d.modules || []).map((m) => `<span class="mod">${esc(m)}</span>`).join('')}</div></div>`;
}
/**
 * Tab bar of the entity view (same component as the other tab bars).
 * @param {string[]} ids Tab ids (keys of ENT_TAB_LABEL). @param {string} active Active tab id.
 * @returns {string} HTML.
 */
const entityTabBar = (ids, active) =>
	`<div class="tabs" id="etabs">${ids.map((id) => tabBtn('et', id, ENT_TAB_LABEL[id], id === active, `entTab('${id}')`, 'etab')).join('')}</div>`;
/**
 * Logical sections of the Description tab (left column), mirroring the OWL API's Description view of each entity
 * kind; the second argument of each section is the addAssertion key of its "+" button. While the inferred view is
 * active, the hierarchy sections (Equivalent To, SubClass Of / SubProperty Of) end with the rows inferred by the
 * reasoner (E.inf); the Types / assertion sections of an individual get theirs later (infIndividual, inference.js).
 * @param {Object} E entityContext.
 * @returns {string} HTML.
 */
function descriptionSections(E) {
	const { kind, ax, sect, bothRows, namedRows, ownRows, rows, inf } = E;
	const gci = (k) =>
		(ax.gci || [])
			.filter((a) => a.kind === k)
			.map(anonRow)
			.join('');
	if (kind === 'class')
		return (
			sect(
				'Equivalent To',
				'equiv',
				bothRows(OWLNS + 'equivalentClass', entLink) +
					ownRows('EquivalentClasses') +
					inf('equivalent', OWLNS + 'equivalentClass')
			) +
			sect(
				'SubClass Of',
				'sub',
				namedRows(RDFS + 'subClassOf', entLink) + ownRows('SubClassOf') + inf('parents', RDFS + 'subClassOf')
			) +
			sect('SubClass Of (Anonymous Ancestor)', null, (ax.inherited || []).map(anonRow).join('')) +
			sect('General class axioms', 'gca', gci('GCI')) +
			sect(
				'Disjoint With',
				'disj',
				bothRows(OWLNS + 'disjointWith', entLink) + ownRows('DisjointClasses') + gci('DisjointClasses')
			) +
			sect('Disjoint Union Of', 'disjunion', ownRows('DisjointUnion')) +
			sect('Target for Key', 'haskey', ownRows('HasKey'))
		);
	if (kind === 'objprop')
		return (
			sect(
				'Equivalent To',
				'equivprop',
				bothRows(OWLNS + 'equivalentProperty', entLink) + inf('equivalent', OWLNS + 'equivalentProperty')
			) +
			sect(
				'SubProperty Of',
				'subprop',
				namedRows(RDFS + 'subPropertyOf', entLink) +
					ownRows('SubObjectPropertyOf') +
					inf('parents', RDFS + 'subPropertyOf')
			) +
			sect('Inverse Of', 'inverse', bothRows(OWLNS + 'inverseOf', entLink) + ownRows('InverseObjectProperties')) +
			sect('Domains (intersection)', 'domain', namedRows(RDFS + 'domain', entLink) + ownRows('ObjectPropertyDomain')) +
			sect('Ranges (intersection)', 'range', namedRows(RDFS + 'range', entLink) + ownRows('ObjectPropertyRange')) +
			sect('Disjoint With', 'disjprop', bothRows(OWLNS + 'propertyDisjointWith', entLink)) +
			sect(
				'SuperProperty Of (Chain)',
				'chain',
				(ax.own || [])
					.filter((a) => a.kind === 'SubPropertyChainOf')
					.map(anonRow)
					.join('')
			)
		);
	if (kind === 'dataprop')
		return (
			sect(
				'Equivalent To',
				'equivprop',
				bothRows(OWLNS + 'equivalentProperty', entLink) + inf('equivalent', OWLNS + 'equivalentProperty')
			) +
			sect(
				'SubProperty Of',
				'subprop',
				namedRows(RDFS + 'subPropertyOf', entLink) + inf('parents', RDFS + 'subPropertyOf')
			) +
			sect('Domains (intersection)', 'domain', namedRows(RDFS + 'domain', entLink) + ownRows('DataPropertyDomain')) +
			sect('Ranges', 'range', namedRows(RDFS + 'range', entLink) + ownRows('DataPropertyRange')) +
			sect('Disjoint With', 'disjprop', bothRows(OWLNS + 'propertyDisjointWith', entLink))
		);
	if (kind === 'datatype')
		return sect(
			'Datatype Definitions',
			'dtdef',
			(ax.own || [])
				.filter((a) => a.kind === 'DatatypeDefinition')
				.map(anonRow)
				.join('')
		);
	if (kind === 'annprop')
		return (
			sect('Domains (intersection)', 'adomain', namedRows(RDFS + 'domain', entLink)) +
			sect('Range (intersection)', 'arange', namedRows(RDFS + 'range', entLink)) +
			sect('Superproperties', 'asuper', namedRows(RDFS + 'subPropertyOf', entLink))
		);
	if (E.isInd)
		return (
			sect('Types', 'type', rows.types) + // rdf:type rows without the owl:NamedIndividual declaration
			sect('Same Individual As', 'sameas', bothRows(OWLNS + 'sameAs', valLink)) +
			sect('Different Individuals', 'different', bothRows(OWLNS + 'differentFrom', valLink))
		);
	return '';
}
/**
 * Right column of the Description tab: the Characteristics panel of an object / data property (checkboxes →
 * toggleCharacteristic) or the Property assertions panel of an individual (object / data / negative assertions, the
 * same sections the anonymous-individual cards show); nothing for the other kinds.
 * @param {Object} E entityContext.
 * @returns {string} HTML ('' when the kind has no right column).
 */
function descriptionSide(E) {
	const { kind, S, byP, d, rows } = E;
	if (CHARS[kind]) {
		const have = new Set(((byP[RDF + 'type'] || {}).values || []).map((v) => v.name)); // rdf:type local names already asserted
		const boxes = CHARS[kind]
			.map(
				(c) =>
					`<label><input type="checkbox" ${have.has(c) ? 'checked' : ''} onchange="toggleCharacteristic(${S},'${c}',this.checked)"> ${CHAR_LABEL[c]}</label>`
			)
			.join('');
		return panelHtml(E, 'Characteristics', boxes, 'chars');
	}
	if (E.isInd) {
		const ps = individualSections(d, S, rows);
		return panelHtml(E, 'Property assertions', ps.obj + ps.data + ps.negobj + ps.negdata);
	}
	return '';
}
/**
 * Description tab: the logical sections (plus the note on pending anonymous axioms) and, when the kind has one, the
 * side panel (descriptionSide); the two panels are laid out as a grid by .epanel.desc.
 * @param {Object} E entityContext.
 * @returns {string} HTML.
 */
function descriptionPanel(E) {
	const pending = E.ax.pending
		? `<div class="dt">${E.ax.pending} axiom(s) with anonymous expressions added in this session become visible after Save.</div>`
		: '';
	return panelHtml(E, 'Description', descriptionSections(E) + pending) + descriptionSide(E);
}
/**
 * Button that opens the fuzzy-definition form of a class (fuzzy concept: weighted / OWA / modified) or of a user
 * datatype (membership function or modifier); the current fuzzyLabel (literal, module, parsed form / bounds) is passed
 * so the form edits in place. Empty for the other kinds.
 * @param {Object} E entityContext.
 * @returns {string} HTML.
 */
function fuzzyButton(E) {
	const { kind, n, S, fzv } = E;
	const lit = fzv ? `decodeURIComponent('${encodeURIComponent(fzv.lit)}')` : 'null';
	const name = esc(n.name);
	if (kind === 'class')
		return `<button class="ibtn fzedit" onclick="fuzzyConceptForm(${S},${fzv ? `{lit:${lit},graph:'${esc(fzv.graph || '')}',parsed:parseFuzzy(${lit})}` : 'null'})" title="${fzv ? `Edit the fuzzy concept definition of ${name} (weighted sum, OWA or modified concept)` : `Define ${name} as a fuzzy concept: weighted sum, OWA or modified concept (fuzzyLabel annotation)`}">${fzv ? ic('edit') + ' fuzzy concept' : '+ fuzzy concept'}</button>`;
	if (kind === 'datatype' && !n.builtin) {
		const isMod = fzv && /fuzzyType="modifier"/.test(fzv.lit); // modifier vs membership function → different form
		const ex = `{iri:${S},lit:${lit},graph:'${esc((fzv && fzv.graph) || '')}',bounds:window._curBounds}`;
		const t = !fzv
			? `Define the membership function of ${name} (triangular, trapezoidal, left / right shoulder, linear) or a fuzzy modifier`
			: isMod
				? `Edit the fuzzy modifier ${name} (linear or triangular modifier)`
				: `Edit the membership function of ${name} (shape and parameters, plotted in the row)`;
		return `<button class="ibtn fzedit" onclick="${isMod ? 'fuzzyModifierForm' : 'fuzzyDatatypeForm'}(${ex})" title="${t}">${fzv ? ic('edit') + (isMod ? ' modifier' : ' membership function') : '+ membership function'}</button>`;
	}
	return '';
}
/**
 * Annotations tab: the annotation rows; for a class / datatype without a fuzzy definition the "+ fuzzy concept" /
 * "+ membership function" button sits in the title (once defined, the Fuzzy tab hosts it).
 * @param {Object} E entityContext.
 * @returns {string} HTML.
 */
const annotationsPanel = (E) =>
	panelHtml(E, 'Annotations', E.sect('Annotations', 'ann', E.rows.ann, E.fuzzy ? '' : fuzzyButton(E)));
/**
 * Fuzzy tab (fuzzy entities only): the fuzzy markers — fuzzyLabel rendered by fuzzyRender (membership plot, modifier
 * curve, weighted / OWA aggregation) — with the edit button of the definition.
 * @param {Object} E entityContext.
 * @returns {string} HTML.
 */
/** Rows of the Fuzzy panel when fuzziness is inherited through owl:equivalentClass / owl:equivalentProperty. */
const fuzzyViaRows = (E) =>
	(E.d.fuzzy_via || []).length
		? prow(
				`<b style="font-size:12px">fuzzy through equivalence with</b> <div>${E.d.fuzzy_via.map((v) => entLink(v)).join(', ')}</div>`
			)
		: '';
const fuzzyPanel = (E) => panelHtml(E, 'Fuzzy', E.sect('Fuzzy definition', null, E.rows.fuzzy + fuzzyViaRows(E), fuzzyButton(E)));
/** Instances tab (classes): the paginated list filled by loadInstances into #instances. @param {Object} E @returns {string} */
const instancesPanel = (E) =>
	panelHtml(E, 'Instances', E.sect('Instances', 'type_inst', '<div id="instances" class="dt">…</div>'));
/**
 * Usage tab: the incoming triples (this entity as object, first 200) as a read-only table, then the #usage box filled
 * by loadUsage (as predicate / as datatype / in definitions).
 * @param {Object} E entityContext.
 * @returns {string} HTML.
 */
function usagePanel(E) {
	const { d } = E;
	let h = '';
	if (d.incoming.length) {
		const rowRO = (g) =>
			`<tr><td class="pred" title="${esc(g.pred)}">${esc(g.pred)}</td><td>${g.values.map(entLink).join('<br>')}</td></tr>`;
		h +=
			`<div class="dt" style="margin:4px 0">Referenced by (as object) — ${d.incoming_total.toLocaleString('en')}${d.incoming_total > 200 ? ', first 200' : ''}</div>` +
			`<table class="props">${d.incoming.map(rowRO).join('')}</table>`;
	}
	return panelHtml(E, 'Usage', h + '<div id="usage" class="dt">…</div>');
}
/**
 * The tabs of an entity with their panels: Description, Annotations, Usage for every kind, Instances for classes,
 * Fuzzy for fuzzy entities.
 * @param {Object} E entityContext.
 * @returns {Array<[string, string]>} [tab id, panel HTML] in tab order.
 */
function entityPanels(E) {
	const p = [
		['desc', descriptionPanel(E)],
		['ann', annotationsPanel(E)],
		['usage', usagePanel(E)]
	];
	if (E.kind === 'class') p.push(['inst', instancesPanel(E)]);
	if (E.fuzzy) p.push(['fuzzy', fuzzyPanel(E)]);
	return p;
}
/**
 * Tab to open for an entity kind: the one remembered in uiConfig.ent_tab[kind] when the entity offers it, else
 * Description.
 * @param {string} kind Entity kind. @param {string[]} ids Tab ids offered by the entity.
 * @returns {string} Tab id.
 */
function entTabActive(kind, ids) {
	const want = (uiConfig.ent_tab || {})[kind];
	return ids.includes(want) ? want : 'desc';
}
/**
 * Tab click of the entity view: highlight the button, show only the matching panel (all panels stay in the DOM, the
 * others get `hidden`) and remember the choice per entity kind (uiConfig.ent_tab, POST /api/ui_config).
 * @param {string} id Tab id.
 * @returns {void}
 */
function entTab(id) {
	document.querySelectorAll('#etabs button').forEach((b) => b.classList.toggle('on', b.dataset.et === id));
	document.querySelectorAll('#detail .epanel').forEach((p) => (p.hidden = p.dataset.et !== id));
	const kind = curEntity && curEntity.d.node.kind;
	if (!kind) return;
	const t = (uiConfig.ent_tab = uiConfig.ent_tab || {});
	if (t[kind] !== id) {
		t[kind] = id;
		post('/api/ui_config', { ent_tab: t });
	}
}
/**
 * Switch the entity view to the tab containing `el` when that tab is hidden (deep links: &click= on a "+" of another
 * tab; anything that focuses an element programmatically).
 * @param {Element} el
 * @returns {void}
 */
function entTabReveal(el) {
	const p = el.closest('.epanel');
	if (p && p.hidden) entTab(p.dataset.et);
}
/**
 * Open an entity in the detail panel (#detail): the central function of the Entities tab.
 * Fetches GET /api/entity ({node:{iri,name,label,kind,fuzzy,builtin,id}, out:[{pred,piri,values:[{iri|lit,name,dt,dt_iri,lang,graph,axiom_ann}],more}],
 * incoming, incoming_total, modules, bounds}) and GET /api/entity_axioms ({own, gci, inherited, pending}), builds the
 * context (entityContext) and renders: the sticky block = header card (entityHeader) + tab bar (entityTabBar); one
 * .epanel per tab (entityPanels — every panel is in the DOM, only the active one visible: the remembered tab of the
 * kind, entTabActive). Each row carries explain / annotate / edit / remove actions whose
 * arguments are serialised into inline onclick handlers.
 * Side effects: selIri, curEntity, window._curBounds; loads #instances / #usage asynchronously.
 * @param {string} enc URL-encoded entity IRI (as produced by encodeURIComponent).
 * @returns {void}
 */
function show(enc) {
	const iri = decodeURIComponent(enc);
	selIri = iri;
	if (typeof histVisit === 'function') histVisit(iri); // View → Back / Forward (menubar.js)
	document.querySelectorAll('.item.sel').forEach((x) => x.classList.remove('sel'));
	Promise.all([api('/api/entity', { iri }), api('/api/entity_axioms', { iri })]).then(([d, ax]) => {
		if (d.error) {
			$('#detail').innerHTML = '<div class="empty">not found</div>';
			return;
		}
		curEntity = { d, ax };
		const E = entityContext(d, ax);
		const panels = entityPanels(E);
		const ids = panels.map(([id]) => id);
		const active = entTabActive(E.kind, ids);
		$('#detail').innerHTML =
			`<div class="esticky">${entityHeader(E)}${entityTabBar(ids, active)}</div>` +
			panels
				.map(
					([id, html]) =>
						`<div class="epanel${id === 'desc' ? ' desc' : ''}" data-et="${id}"${id === active ? '' : ' hidden'}>${html}</div>`
				)
				.join('');
		$('#detail').scrollTop = 0;
		anonRestore($('#detail')); // anonymous-individual cards expanded before the re-render stay expanded
		if (E.kind === 'class') loadInstances(iri, 0);
		if (E.n.id != null) loadUsage(iri, 0);
		else $('#usage').textContent = 'built-in datatype, not used in the workspace'; // id null = synthetic built-in node
		if (E.kind === 'individual') infIndividual(iri); // inferred types / values, only while the inferred view is active
	});
}
/**
 * Characteristics checkbox: add or remove the triple <s rdf:type owl:{c}> in the module declaring the property
 * (GET /api/graph_of, then POST /api/edit/add or /api/edit/remove); refreshes changes and re-renders the entity.
 * @param {string} s Property IRI.
 * @param {string} c Characteristic local name (key of CHAR_LABEL).
 * @param {boolean} on Checkbox state.
 * @returns {void}
 */
function toggleCharacteristic(s, c, on) {
	api('/api/graph_of', { iri: s }).then((g) => {
		const graph = g.graph || modules[0];
		post(on ? '/api/edit/add' : '/api/edit/remove', { s, p: RDF + 'type', o: OWLNS + c, graph }).then((r) => {
			if (r.error) alert(r.error);
			refreshChanges();
			show(encodeURIComponent(s));
		});
	});
}
/**
 * Burger menu of the entity header: floating .menu at the click position with Copy IRI / Copy display name /
 * Copy as Markdown / Show IRI in Web browser / Change IRI (renameEntity). Closes on the next click anywhere.
 * @param {MouseEvent} ev Click event (position + propagation stop).
 * @param {string} iri Entity IRI.
 * @param {string} name Display name.
 * @returns {void}
 */
function entityMenu(ev, iri, name) {
	ev.stopPropagation();
	document.querySelectorAll('.menu').forEach((m) => m.remove());
	const m = document.createElement('div');
	m.className = 'menu';
	m.style.left = ev.pageX + 'px';
	m.style.top = ev.pageY + 6 + 'px';
	const cp = (t) => navigator.clipboard.writeText(t).catch(() => prompt('copy:', t)); // clipboard, with a prompt() fallback
	m.innerHTML = `<div data-a="iri">Copy IRI</div><div data-a="name">Copy display name</div><div data-a="md">Copy as Markdown</div><hr><div data-a="web">Show IRI in Web browser</div><hr><div data-a="ren">Change IRI (Rename)…</div>`;
	m.onclick = (e) => {
		const a = e.target.dataset.a;
		m.remove();
		if (a === 'iri') cp(iri);
		else if (a === 'name') cp(name);
		else if (a === 'md') cp(`[${name}](${iri})`);
		else if (a === 'web') window.open(iri, '_blank');
		else if (a === 'ren') renameEntity(iri);
	};
	document.body.appendChild(m);
	setTimeout(() => document.addEventListener('click', () => m.remove(), { once: true }), 0);
}
/**
 * Compact DL-like text of a triple: "a : C" for rdf:type, "p(a, b)" for object triples, 'p(a) = "v"^^dt@lang' for literals.
 * @param {string} s Subject IRI. @param {string} p Predicate IRI. @param {?string} o Object IRI.
 * @param {?string} lit Literal. @param {?string} dt Datatype IRI. @param {?string} lang Language tag.
 * @returns {string} Plain text (not escaped).
 */
function axiomText(s, p, o, lit, dt, lang) {
	const P = short(p);
	if (p === RDF + 'type') return `${short(s)} : ${short(o)}`;
	if (o) return `${P}(${short(s)}, ${short(o)})`;
	return `${P}(${short(s)}) = "${lit}"${dt ? '^^' + short(dt) : ''}${lang ? '@' + lang : ''}`;
}
/**
 * "?" icon of a named-triple row: ontology-editor-like explanation dialog in #modalbox (asserted axiom + module, its axiom
 * annotations, and for fuzzy degrees the feature values of the entity the reasoner used). Reads the annotations from curEntity.
 * Parameters identify the triple as in removeAssertion.
 * @returns {void}
 */
function explainAxiom(s, p, o, lit, dt, lang, graph) {
	const d = curEntity && curEntity.d;
	const g = d && d.out.find((x) => x.piri === p);
	const v = g && g.values.find((x) => (o ? x.iri === o : x.lit === lit));
	const anns = (v && v.axiom_ann) || [];
	let body = `<div class="dt">Explanation for <b>${esc(axiomText(s, p, o, lit, dt, lang))}</b></div>
    <div class="sect"><h3>Explanation 1 — asserted axiom</h3><div class="expr">${esc(axiomText(s, p, o, lit, dt, lang))}</div><div class="dt">Asserted in module <b>${esc(graph || '?')}</b></div></div>`;
	if (anns.length)
		body += `<div class="sect"><h3>Axiom annotations</h3>${anns.map((a) => `<div><b>${esc(a.prop)}</b> <span class="dt">[${esc(a.graph)}]</span><div class="lit">${esc(a.value)}</div></div>`).join('')}</div>`;
	const deg = anns.find((a) => /Degree value=/.test(a.value));
	if (deg && d) {
		const feats = d.out
			.filter((x) => x.values[0] && 'lit' in x.values[0] && !ANN_PREDS.has(x.piri))
			.map((x) => `${x.pred} = ${x.values.map((y) => y.lit).join(', ')}`);
		body += `<div class="sect"><h3>Fuzzy degree</h3><div class="dt">Lower bound materialized by the fuzzyDL reasoner (min-instance) from the asserted feature values and the fuzzy definitions of the class:</div><div class="expr">${feats.map(esc).join('<br>') || '—'}</div></div>`;
	}
	const box = $('#modalbox');
	box.innerHTML = `<h3>Explanation</h3>${body}<div class="actions"><button class="primary" onclick="closeForm()" title="${tip('form', 'close')}">OK</button></div>`;
	$('#modal').style.display = 'flex';
}
/**
 * "?" icon of an anonymous-expression row: explanation dialog with the DL text, module, FuzzyDL and fuzzy-DL renderings.
 * @param {{kind:string, dl:string, module?:string, fuzzy?:boolean, fdl?:string, fm?:string}} a Axiom object from /api/entity_axioms.
 * @returns {void}
 */
function explainAnon(a) {
	const box = $('#modalbox');
	box.innerHTML = `<h3>Explanation</h3><div class="sect"><h3>Asserted axiom (${esc(a.kind)})</h3><div class="expr">${esc(a.dl)}</div><div class="dt">Asserted in module <b>${esc(a.module || '?')}</b>${a.fuzzy ? ' · involves fuzzy entities' : ''}</div></div>
    ${a.fdl ? `<div class="sect"><h3>FuzzyDL</h3><div class="expr">${esc(a.fdl)}</div></div>` : ''}${a.fm && a.fm !== a.dl ? `<div class="sect"><h3>Fuzzy DL</h3><div class="expr">${esc(a.fm)}</div></div>` : ''}
    <div class="dt">Anonymous expressions are stored in the module file: edit them by removing/re-adding the axiom (Manchester syntax in the + forms).</div><div class="actions"><button class="primary" onclick="closeForm()" title="${tip('form', 'close')}">OK</button></div>`;
	$('#modal').style.display = 'flex';
}
/**
 * Label icon of a named-triple row: form to add / replace / remove annotations on the axiom (owl:Axiom reification).
 * Lists the existing annotations (edit → axAnnPrefill, remove → removeAxiomAnn), then a property select
 * (fuzzyLabel degree, rdfs:comment, rdfs:label or a custom annotation property), a degree field and a text field
 * (only the relevant ones are visible). On OK: POST /api/edit/axiom_ann_add {s,p,o|lit,dt,lang,graph,prop,value}.
 * Stores the annotation list in window._axAnns for axAnnPrefill. Parameters identify the triple as in removeAssertion.
 * @returns {void}
 */
function annotateAxiom(s, p, o, lit, dt, lang, graph) {
	const d = curEntity && curEntity.d;
	const g = d && d.out.find((x) => x.piri === p);
	const v = g && g.values.find((x) => (o ? x.iri === o : x.lit === lit));
	const anns = (v && v.axiom_ann) || [];
	const deg = anns.map((a) => /Degree value="([^"]+)"/.exec(a.value)).find(Boolean);
	// the triple arguments re-serialised as JS literals for the inline remove handler
	const args = `${JSON.stringify(s)},${JSON.stringify(p)},${JSON.stringify(o)},${JSON.stringify(lit)},${JSON.stringify(dt)},${JSON.stringify(lang)},${JSON.stringify(graph)}`;
	window._axAnns = anns;
	const existing = anns.length
		? `<label>Existing annotations on this axiom</label><div style="margin-bottom:8px">${anns
				.map((a, i) => {
					const m = /Degree value="([^"]+)"/.exec(a.value);
					return `<div class="prow"><div class="val"><b style="font-size:12px">${esc(a.prop)}</b> <span class="dt">[${esc(a.graph)}]</span><div>${m ? `<span class="badge" style="background:#7a4bb3">degree ${m[1]}</span>` : `<span class="lit">${esc(a.value)}</span>`}</div></div><span class="acts"><span class="act" role="button" tabindex="0" aria-label="Edit this annotation (fills the fields below; OK replaces its value)" title="Edit this annotation (fills the fields below; OK replaces its value)" onclick="axAnnPrefill(${i})">${ICON.edit}</span><span class="act del" role="button" tabindex="0" aria-label="Remove this annotation" title="Remove this annotation" onclick="${esc(`closeForm();removeAxiomAnn(${args},${JSON.stringify(a.prop)})`)}">${ICON.del}</span></span></div>`;
				})
				.join(
					''
				)}<div class="dt">Edit (✎) loads an annotation into the fields below; OK replaces the value of that property.</div></div>`
		: '';
	openForm(
		'Annotate axiom',
		[
			{
				type: 'html',
				html: `<div class="dt" style="margin-bottom:6px">${esc(axiomText(s, p, o, lit, dt, lang))}</div>` + existing
			},
			{
				name: 'prop',
				label: 'Annotation property',
				type: 'select',
				options: [
					[fuzzyPropIri(), (fuzzyLbl() || 'fuzzyLabel') + ' (fuzzy degree)'],
					[RDFS + 'comment', 'rdfs:comment'],
					[RDFS + 'label', 'rdfs:label'],
					['custom', 'other (search below)']
				]
			},
			{ name: 'pc', label: 'Annotation property (if "other")', type: 'entity', kind: 'annprop' },
			{ name: 'degree', label: 'Degree in [0,1] (for fuzzyLabel)', value: deg ? deg[1] : '1.0' },
			{ name: 'text', label: 'Text (for other properties)', type: 'textarea' }
		],
		(v) => {
			const prop = v.prop === 'custom' ? toIri(v.pc, 'annprop') : v.prop;
			let value = v.text;
			if (prop === fuzzyPropIri()) {
				const dg = parseFloat(v.degree);
				if (!(dg >= 0 && dg <= 1)) return { error: 'degree must be in [0,1]' };
				value = `<fuzzyOwl2 fuzzyType="axiom">\n\t<Degree value="${dg}"/>\n</fuzzyOwl2>\n`;
			} else if (!value) return { error: 'text required' };
			return post('/api/edit/axiom_ann_add', {
				s,
				p,
				o: o || undefined,
				lit: lit == null ? undefined : lit,
				dt: dt || undefined,
				lang: lang || undefined,
				graph,
				prop,
				value
			});
		},
		'The annotation is attached to the axiom (owl:Axiom reification), like the fuzzy degrees.'
	);
	// show only the fields that apply to the chosen annotation property
	const box = $('#modalbox'),
		sel = box.querySelector('[name=prop]');
	// hide/show a field together with its <label>; the field may be wrapped by a picker or an autocomplete wrapper
	const vis = (name, on) => {
		const el = box.querySelector(`[name=${name}]`);
		const wrap = el.closest('.picker') || el.closest('.acwrap') || el;
		wrap.style.display = on ? '' : 'none';
		wrap.previousElementSibling.style.display = on ? '' : 'none';
	};
	const upd = () => {
		const fz = sel.value === fuzzyPropIri();
		vis('degree', fz);
		vis('text', !fz);
		vis('pc', sel.value === 'custom');
	};
	sel.addEventListener('change', upd);
	upd();
}
/**
 * Edit icon of an existing axiom annotation (in the annotateAxiom form): copy window._axAnns[i] into the form fields
 * (property select or custom picker, degree or text) and re-apply the field visibility.
 * @param {number} i Index in window._axAnns.
 * @returns {void}
 */
function axAnnPrefill(i) {
	// load an existing axiom annotation into the "Annotate axiom" form
	const a = (window._axAnns || [])[i];
	if (!a) return;
	const box = $('#modalbox');
	const sel = box.querySelector('[name=prop]'),
		pc = box.querySelector('[name=pc]'),
		dg = box.querySelector('[name=degree]'),
		tx = box.querySelector('[name=text]');
	// a.prop may be a full IRI or a short name: map the known short names back to IRIs
	const iri = a.prop.startsWith('http')
		? a.prop
		: a.prop === 'fuzzyLabel'
			? fuzzyPropIri()
			: a.prop === 'comment' || a.prop === 'label'
				? RDFS + a.prop
				: a.prop;
	const opt = [...sel.options].find((o) => o.value === iri || short(o.value) === a.prop);
	if (opt) {
		sel.value = opt.value;
	} else {
		sel.value = 'custom';
		pc.value = a.prop;
		pc.dataset.iri = iri;
		pc.title = iri;
	}
	const m = /Degree value="([^"]+)"/.exec(a.value);
	if (m) dg.value = m[1];
	else tx.value = a.value;
	sel.dispatchEvent(new Event('change')); // re-apply the field visibility for the loaded property
	(m ? dg : tx).focus();
}
// ---- axioms with anonymous expressions (identified by their DL text in the module file) ----
/**
 * Trash icon of an anonymous-expression row: queue the removal of the axiom (POST /api/edit/anon_remove
 * {s, p, dl, graph}); the expression only disappears from the view after Save.
 * @param {{siri:string, piri:string, dl:string, odl?:string, module:string}} a Axiom object (odl = original DL text when the shown one was rewritten).
 * @returns {void}
 */
function removeAnon(a) {
	if (!confirm('Remove the axiom\n' + a.dl + '\nfrom ' + a.module + '? (applied on Save)')) return;
	post('/api/edit/anon_remove', { s: a.siri, p: a.piri, dl: a.odl || a.dl, graph: a.module }).then((r) => {
		if (r.error) alert(r.error);
		refreshChanges();
		alert('Removal queued: it is applied to the file on Save (the expression disappears from the view after Save).');
	});
}
/**
 * Edit icon of an anonymous-expression row: form with the Manchester text of the expression; on OK the new expression
 * is added (POST /api/edit/expr) and the old one queued for removal (POST /api/edit/anon_remove), both applied on Save.
 * @param {{siri:string, piri:string, dl:string, odl?:string, man:string, module:string}} a Axiom object (man = Manchester syntax).
 * @returns {void}
 */
function editAnon(a) {
	const kind = curEntity ? curEntity.d.node.kind : 'class';
	openForm(
		'Edit expression: ' + short(a.piri),
		[
			{ type: 'html', html: `<div class="dt" style="margin-bottom:6px">${esc(a.dl)}</div>` },
			{ name: 'expr', label: 'Expression (Manchester syntax)', type: 'textarea', value: a.man, required: true },
			{ type: 'module', name: 'graph', label: 'Module', value: a.module }
		],
		(v) =>
			post('/api/edit/expr', { s: a.siri, expr: v.expr.trim(), p: a.piri, kind, graph: v.graph })
				.then((r) =>
					r.error ? r : post('/api/edit/anon_remove', { s: a.siri, p: a.piri, dl: a.odl || a.dl, graph: a.module })
				)
				.then((r) => {
					if (!r.error)
						setTimeout(() => alert('Edit queued: the new expression is added and the old one removed on Save.'), 50);
					return r;
				}),
		MANCHESTER_HINT
	);
}
/**
 * Label icon of an anonymous-expression row: annotate the axiom (fuzzy degree, comment, label or custom property).
 * Same form layout as annotateAxiom, but the annotation is written as an owl:Axiom whose annotatedTarget is the
 * expression itself (POST /api/edit/anon_annotate {s, p, man, kind, graph, prop, value}); visible after Save.
 * @param {{siri:string, piri:string, dl:string, man:string, module:string, ann?:{prop:string,value:string}[]}} a Axiom object.
 * @returns {void}
 */
function annotateAnon(a) {
	const deg = (a.ann || []).map((x) => /Degree value="([^"]+)"/.exec(x.value)).find(Boolean);
	const kind = curEntity ? curEntity.d.node.kind : 'class';
	openForm(
		'Annotate axiom',
		[
			{
				type: 'html',
				html:
					`<div class="dt" style="margin-bottom:6px">${esc(a.dl)}</div>` +
					((a.ann || []).length
						? `<label>Existing annotations</label><div style="margin-bottom:8px">${a.ann
								.map((x) => {
									const m = /Degree value="([^"]+)"/.exec(x.value);
									return `<div class="prow"><div class="val"><b style="font-size:12px">${esc(x.prop)}</b><div>${m ? `<span class="badge" style="background:#7a4bb3">degree ${m[1]}</span>` : `<span class="lit">${esc(x.value)}</span>`}</div></div></div>`;
								})
								.join(
									''
								)}<div class="dt">A new value for the same property is added as a further owl:Axiom block (edit the previous one in the file if needed).</div></div>`
						: '')
			},
			{
				name: 'prop',
				label: 'Annotation property',
				type: 'select',
				options: [
					[fuzzyPropIri(), (fuzzyLbl() || 'fuzzyLabel') + ' (fuzzy degree)'],
					[RDFS + 'comment', 'rdfs:comment'],
					[RDFS + 'label', 'rdfs:label'],
					['custom', 'other (search below)']
				]
			},
			{ name: 'pc', label: 'Annotation property (if "other")', type: 'entity', kind: 'annprop' },
			{ name: 'degree', label: 'Degree in [0,1] (for fuzzyLabel)', value: deg ? deg[1] : '1.0' },
			{ name: 'text', label: 'Text (for other properties)', type: 'textarea' }
		],
		(v) => {
			const prop = v.prop === 'custom' ? toIri(v.pc, 'annprop') : v.prop;
			let value = v.text;
			if (prop === fuzzyPropIri()) {
				const dg = parseFloat(v.degree);
				if (!(dg >= 0 && dg <= 1)) return { error: 'degree must be in [0,1]' };
				value = `<fuzzyOwl2 fuzzyType="axiom"><Degree value="${dg}"/></fuzzyOwl2>`;
			} else if (!value) return { error: 'text required' };
			return post('/api/edit/anon_annotate', {
				s: a.siri,
				p: a.piri,
				man: a.man,
				kind,
				graph: a.module,
				prop,
				value
			});
		},
		'The annotation is written as an owl:Axiom whose annotatedTarget is the expression itself (structural match); it appears here after Save.'
	);
	// field visibility per chosen property (same logic as annotateAxiom)
	const box = $('#modalbox'),
		sel = box.querySelector('[name=prop]');
	const vis = (name, on) => {
		const el = box.querySelector(`[name=${name}]`);
		const wrap = el.closest('.picker') || el.closest('.acwrap') || el;
		wrap.style.display = on ? '' : 'none';
		wrap.previousElementSibling.style.display = on ? '' : 'none';
	};
	const upd = () => {
		const fz = sel.value === fuzzyPropIri();
		vis('degree', fz);
		vis('text', !fz);
		vis('pc', sel.value === 'custom');
	};
	sel.addEventListener('change', upd);
	upd();
}
/**
 * Remove one annotation property from an axiom (POST /api/edit/axiom_ann_remove with `prop`), then refresh
 * the changes widget and the current entity. First seven parameters identify the triple as in removeAssertion.
 * @param {string} prop Annotation property IRI to remove.
 * @returns {void}
 */
function removeAxiomAnn(s, p, o, lit, dt, lang, graph, prop) {
	if (!confirm('Remove the annotation ' + short(prop) + ' from this axiom?')) return;
	post('/api/edit/axiom_ann_remove', {
		s,
		p,
		o: o || undefined,
		lit: lit == null ? undefined : lit,
		dt: dt || undefined,
		lang: lang || undefined,
		graph,
		prop
	}).then((r) => {
		if (r.error) alert(r.error);
		refreshChanges();
		show(encodeURIComponent(selIri));
	});
}
/**
 * Pencil icon of a named-triple row: edit the triple as "remove old + add new" (POST /api/edit/remove then /api/edit/add).
 * The form depends on the triple: rdf:type → class picker; string literal on an annotation-like predicate → annotation
 * form (property, value, language); other literal → data property form (property, value, language, datatype);
 * object triple → property + target pickers (target kind inferred from the predicate / current entity kind).
 * Parameters identify the triple as in removeAssertion.
 * @returns {void}
 */
function editAssertion(s, p, o, lit, dt, lang, graph) {
	const target = { type: 'module', name: 'graph', label: 'Module', value: graph };
	const redo = (add) =>
		post('/api/edit/remove', { s, p, o: o || undefined, lit: lit == null ? undefined : lit, graph }).then((r) =>
			r.error ? r : post('/api/edit/add', add)
		);
	if (p === RDF + 'type')
		openForm(
			'Edit type',
			[{ name: 'o', label: 'Class', type: 'entity', kind: 'class', value: o, required: true }, target],
			(v) => redo({ s, p, o: toIri(v.o, 'class'), graph: v.graph })
		);
	// "annotation" heuristic: built-in annotation predicate, or (on a non-individual) a predicate that is not a known
	// numeric feature (#hasValue/#hasYear) and has no typed non-string values; and the literal itself is untyped/string
	else if (
		lit != null &&
		(ANN_PREDS.has(p) ||
			(curEntity &&
				curEntity.d.node.kind !== 'individual' &&
				!/#(hasValue|hasYear)/.test(p) &&
				!curEntity.d.out.find(
					(x) => x.piri === p && x.values[0] && x.values[0].dt_iri && x.values[0].dt_iri !== XSDNS + 'string'
				))) &&
		!(dt && dt !== XSDNS + 'string')
	)
		annotationDialog({
			title: 'Edit annotation',
			s,
			file: graph,
			existing: { p, lit, lang, dt },
			onSubmit: (payload) => redo(payload)
		});
	else if (lit != null)
		openForm(
			'Edit data property assertion',
			[
				{ name: 'p', label: 'Data property', type: 'entity', kind: 'dataprop', value: p, required: true },
				{ name: 'lit', label: 'Value', type: 'textarea', value: lit, required: true },
				{ name: 'lang', label: 'Language Tag', value: lang || '' },
				{
					name: 'dt',
					label: 'Datatype',
					type: 'select',
					options: [...new Set([dt || XSDNS + 'decimal', ...XSD_TYPES.map((t) => XSDNS + t)])].map((t) => [
						t,
						short(t).includes('#') ? t : (t.startsWith(XSDNS) ? 'xsd:' : '') + short(t)
					]),
					value: dt || XSDNS + 'decimal'
				},
				target
			],
			(v) =>
				redo({
					s,
					p: toIri(v.p, 'dataprop'),
					lit: v.lit,
					dt: v.lang ? null : v.dt,
					lang: v.lang || null,
					graph: v.graph
				})
		);
	else {
		// target kind: individuals point to individuals; class-valued predicates to classes; property-to-property axioms keep the entity kind
		const okind = curEntity && curEntity.d.node.kind;
		const tk =
			okind === 'individual'
				? 'individual'
				: p === RDFS + 'domain' ||
					  p === RDFS + 'range' ||
					  p === RDFS + 'subClassOf' ||
					  p === OWLNS + 'equivalentClass' ||
					  p === OWLNS + 'disjointWith'
					? 'class'
					: okind;
		openForm(
			'Edit assertion',
			[
				{ name: 'p', label: 'Property', type: 'entity', value: p, required: true },
				{
					name: 'o',
					label: 'Target',
					type: 'entity',
					kind: tk === 'class' || tk === 'individual' ? tk : '',
					value: o,
					required: true
				},
				target
			],
			(v) => redo({ s, p: v.p.startsWith('http') ? v.p : toIri(v.p, 'objprop'), o: toIri(v.o, tk), graph: v.graph })
		);
	}
}
/**
 * Fill the #usage box of the Usage panel: GET /api/usage {iri, page} → {as_predicate:{total, items:[{s,o,graph}]},
 * as_datatype:{total, items:[{s,pred,lit}]}, in_definitions:[{s,via,graph}], as_object_total}.
 * Renders "used as property" (paginated by 200 with ◀ ▶ links), "used as datatype" and "used in definitions"
 * (grouped by subject, listing the axiom kinds it appears through). No-op if #usage is gone (entity changed meanwhile).
 * @param {string} iri Entity IRI.
 * @param {number} p 0-based page of the as-predicate list.
 * @returns {void}
 */
function loadUsage(iri, p) {
	api('/api/usage', { iri, page: p }).then((u) => {
		const box = $('#usage');
		if (!box || u.error) return;
		let h = '';
		const ap = u.as_predicate;
		if (ap.total) {
			const pages = Math.ceil(ap.total / 200);
			h += `<div style="margin-top:8px;color:var(--txt)"><b>Used as property in ${ap.total.toLocaleString('en')} assertions</b> ${pagerHtml(p, pages, `loadUsage(${JSON.stringify(iri)},{p})`)}</div>
<table class="props">${ap.items.map((x) => `<tr><td style="width:45%">${entLink(x.s)}</td><td>${'lit' in x.o ? `<span class="lit">${esc(x.o.lit.length > 120 ? x.o.lit.slice(0, 120) + '…' : x.o.lit)}</span>${x.o.dt ? ` <span class="dt">^^${esc(x.o.dt)}</span>` : ''}` : entLink(x.o)} <span class="dt">[${esc(x.graph)}]</span></td></tr>`).join('')}</table>`;
		}
		if (u.as_datatype && u.as_datatype.total) {
			h += `<div style="margin-top:8px;color:var(--txt)"><b>Used as datatype of ${u.as_datatype.total.toLocaleString('en')} values</b> <span class="dt">(first ${u.as_datatype.items.length})</span></div>
<table class="props">${u.as_datatype.items.map((x) => `<tr><td style="width:45%">${entLink(x.s)}</td><td><span class="dt">${esc(x.pred)}</span> = ${esc(x.lit)}</td></tr>`).join('')}</table>`;
		}
		if (u.in_definitions && u.in_definitions.length) {
			const by = {};
			u.in_definitions.forEach((x) => {
				(by[x.s.iri] = by[x.s.iri] || { s: x.s, via: new Set(), graph: x.graph }).via.add(x.via);
			});
			h += `<div style="margin-top:8px;color:var(--txt)"><b>Used in the definitions (anonymous axioms) of ${Object.keys(by).length} entities</b></div>
<table class="props">${Object.values(by)
				.map(
					(x) =>
						`<tr><td style="width:45%">${entLink(x.s)}</td><td><span class="dt">via ${[...x.via].map(esc).join(', ')} [${esc(x.graph)}]</span></td></tr>`
				)
				.join('')}</table>`;
		}
		if (!h && !u.as_object_total) h = '<span class="dt">no usage</span>';
		box.innerHTML = h;
		box.className = '';
	});
}
/**
 * Fill the #instances box of a class (Description → Instances): GET /api/instances {iri, page, graph} → {total, items:[node]}.
 * Paginated by 200 with prev/next links; respects the sidebar scope.
 * @param {string} iri Class IRI.
 * @param {number} p 0-based page.
 * @returns {void}
 */
function loadInstances(iri, p) {
	api('/api/instances', { iri, page: p, graph: scopeGraph() }).then((d) => {
		$('#instances').innerHTML =
			(d.total
				? `<div class="dt" style="margin-bottom:6px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">${d.total.toLocaleString('en')} instances ${pagerHtml(p, Math.ceil(d.total / 200), `loadInstances(${JSON.stringify(iri)},{p})`)}</div>`
				: '') +
			(d.items
				.map(
					(n) => `<div class="item" onclick="show('${encodeURIComponent(n.iri)}')">${dot(n.kind)}${esc(n.name)}</div>`
				)
				.join('') || '<span class="dt">none</span>');
	});
}
