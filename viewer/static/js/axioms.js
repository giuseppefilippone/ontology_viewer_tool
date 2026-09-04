// axioms.js — Axioms tab (DL / FuzzyDL), LaTeX/PDF export helpers, Ontology info metrics, FDL tab.
//
// Overview
//   Classic script sharing the global scope with the other files loaded by static/index.html, in this
//   order: core.js, entities.js, axioms.js (this file), graphs.js, query.js, reasoner.js, main.js.
//   Sections:
//     1. FDL tab (#tab-fdl): paginated view of the FuzzyDL text generated for the import closure of
//        the active ontology (GET /api/fdl, POST /api/fdl/generate, GET /api/export_file).
//     2. Axioms tab (#tab-axioms): TBox/RBox + paginated ABox of one module or of the closure, shown
//        in DL / fuzzy DL / FuzzyDL notation (GET /api/axioms), with LaTeX and PDF export (POST /api/pdf).
//     3. LaTeX helpers shared by the two exports: texEsc, dlToTex, downloadText, axiomsTex, LONGTABLE_ROWS.
//     4. Fuzzy tab (#tab-fuzzy): entities annotated sdf:isFuzzy grouped by kind and shape (GET /api/fuzzy).
//     5. Ontology info tab (#tab-ontology): ontology header, imports, prefixes, general class axioms,
//        OWL API-style metrics of the active module and of its import closure, breakdown by module with
//        pie charts, CSV / LaTeX / PDF export of the metrics (GET /api/ontology, POST /api/workspace/remove,
//        POST /api/pdf).
//   Globals defined here: fdlState, axState, ontoData, activeOnt, METRIC_GROUPS, LONGTABLE_ROWS, texEsc,
//     window._bp (panels of the bottom tabs of the Ontology info card) and the functions below.
//     renderFdl / renderAxioms / renderFuzzyTab / renderOntology are called by the main-tab switch in
//     core.js; drawOntology by core.js (setCountAnn) and main.js; ensureOnto / ontoData / activeOnt are
//     also used by entities.js, graphs.js and query.js.
//   Globals used from other files: $, api, esc, dot, fmtBytes, countAnn, setCountAnn, fillScope, scope,
//     page, loadList (core.js); post, short, modules, show, renameOntologyIri, ontAddAnnotation,
//     ontRemoveAnnotation, ontAddImport, ontRemoveImport, renameNamespace (entities.js);
//     attachAutocomplete (query.js).
//   DOM ids owned: #tab-fdl (#fdlcount, #fdlq, #fdlinfo, #fdlstats, #fdlbody); #tab-axioms (#axcount,
//     #axgraph, #axnot, #axq, #axbody); #tab-fuzzy; #tab-ontology (#ontsel, #btabs, #bpanel, #annM,
//     #annX, radios name=xscope, #xsep, #xbtn, #xtex, #xpdf, #xinfo, checkboxes .xm).

// ---------- FDL tab: paginated FuzzyDL of the import closure of the active ontology ----------
// page = 0-based page of the .fdl text; q = substring filter (when set the server returns the first
// matching lines of the whole file instead of a page)
let fdlState = { page: 0, q: '' };
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
/**
 * Entry point of the FDL tab (called by the main-tab switch in core.js).
 * Builds the card skeleton (title with #fdlcount, Generate / Download buttons, #fdlq filter box,
 * #fdlinfo status, #fdlstats and #fdlbody placeholders) the first time or when the active module
 * changed (tracked in #tab-fdl's data-file attribute, which also resets `fdlState`), then loads a page.
 * Side effects: replaces the innerHTML of #tab-fdl, attaches the entity autocomplete to #fdlq,
 * calls loadFdl().
 */
function renderFdl() {
	ensureOnto(() => {
		const f = fdlFile();
		const box = $('#tab-fdl');
		if (!f) {
			box.innerHTML = '<div class="empty">no active ontology</div>';
			return;
		}
		if (box.dataset.file !== f) {
			box.dataset.file = f;
			fdlState = { page: 0, q: '' };
			// card header: title + toolbar (generate, download link served by /api/export_file, debounced filter, status)
			box.innerHTML = `<div class="card" style="max-width:none">
      <h2>FuzzyDL of the import closure of ${esc(f)} <span class="count" id="fdlcount"></span></h2>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:8px">
<button class="ibtn" style="margin:0" onclick="fdlGenerate()" title="(Re)generate the .fdl of the closure: TBox via fuzzy_dl_owl2 (FuzzyOwl2ToFuzzyDL), ABox from the index; written to code/viewer/exports/">${ic('refresh')} Generate / refresh</button>
<a class="ibtn" style="margin:0;text-decoration:none" href="/api/export_file?name=${encodeURIComponent(f.replace(/\.owl$/, '') + '.fdl')}" title="Download the generated .fdl file (FuzzyDL reasoner syntax)">${ic('download')} Download .fdl</a>
<input id="fdlq" placeholder="filter lines (substring)…" style="min-width:240px" oninput="clearTimeout(window._fdlT);window._fdlT=setTimeout(()=>{fdlState.q=this.value.trim();fdlState.page=0;loadFdl();},300)">
<span class="dt" id="fdlinfo"></span></div>
      <div id="fdlstats" style="margin-top:10px"></div>
      <div id="fdlbody" style="margin-top:10px"><div class="dt">loading…</div></div></div>`;
			attachAutocomplete($('#fdlq'), { single: true, keywords: false });
		}
		loadFdl();
	});
}
/**
 * Fetches the current page (or the filtered lines) of the generated .fdl and draws it.
 * Side effects: GET /api/fdl {file, page, q}; when the file was never generated (`d.missing`)
 * clears #fdlstats / #fdlcount and shows a hint in #fdlbody, otherwise calls drawFdl(d).
 */
function loadFdl() {
	const f = fdlFile();
	if (!f) return;
	api('/api/fdl', { file: f, page: fdlState.page, q: fdlState.q }).then((d) => {
		if (d.missing) {
			$('#fdlstats').innerHTML = '';
			$('#fdlbody').innerHTML =
				'<div class="dt">not generated yet — click "Generate / refresh" (the closure of SDF_territories takes ≈30 s, of SDF_ext ≈10 s).</div>';
			$('#fdlcount').textContent = '';
			return;
		}
		drawFdl(d);
	});
}
/**
 * "Generate / refresh" button: (re)generates the .fdl of the active module's closure on the server
 * and reloads the first page.
 * Side effects: POST /api/fdl/generate {file}; writes progress / result / error text in #fdlinfo,
 * a placeholder in #fdlbody; resets fdlState.page and calls loadFdl().
 */
function fdlGenerate() {
	const f = fdlFile();
	if (!f) return;
	$('#fdlinfo').textContent = 'generating (fuzzy_dl_owl2 for the TBox, index for the ABox)…';
	$('#fdlbody').innerHTML = '<div class="dt">generating…</div>';
	post('/api/fdl/generate', { file: f })
		.then((r) => {
			if (r.error) {
				$('#fdlinfo').textContent = 'FDL: ' + r.error;
				return;
			}
			$('#fdlinfo').textContent =
				`generated in ${r.seconds}s (TBox via fuzzy_dl_owl2: ${r.converter_files.join(', ') || '—'}; ABox from index: ${r.abox_files.join(', ') || '—'})`;
			fdlState.page = 0;
			loadFdl();
		})
		.catch((e) => {
			$('#fdlinfo').textContent = 'FDL: ' + e;
		});
}
/**
 * Renders one /api/fdl response: the statistics card and the paginated text.
 * @param {Object} d  response of GET /api/fdl: {lines, page, pages, limit, filtered, stats:{lines,
 *   statements, comments, blank, bytes, tbox_lines, abox_lines, instance_class, instance_data, related,
 *   degree_lt1, individuals, concepts_asserted, by_keyword}}.
 * Side effects: sets #fdlcount, #fdlstats (two metrics tables: line/statement counts and per-keyword
 * counts) and #fdlbody (pager + <pre> with the lines; comment lines starting with '#' are dimmed).
 */
function drawFdl(d) {
	const s = d.stats,
		n = (v) => (v || 0).toLocaleString('en');
	const hsize = fmtBytes;
	$('#fdlcount').textContent = `— ${n(s.statements)} statements, ${hsize(s.bytes)}`;
	// statement keywords (instance, related, define-concept…) sorted by decreasing count
	const kw = Object.entries(s.by_keyword || {}).sort((a, b) => b[1] - a[1]);
	$('#fdlstats').innerHTML =
		`<div class="sect"><h3>Statistics of the FDL text</h3><div class="ocards" style="align-items:flex-start">
    <div style="flex:1;min-width:260px"><table class="metrics">
      <tr><td>Lines</td><td>${n(s.lines)}</td></tr><tr><td>Statements</td><td>${n(s.statements)}</td></tr><tr><td>Comments</td><td>${n(s.comments)}</td></tr><tr><td>Blank</td><td>${n(s.blank)}</td></tr><tr><td>Size</td><td>${hsize(s.bytes)} <span class="dt">(${n(s.bytes)} bytes)</span></td></tr>
      <tr><td>TBox / definitions</td><td>${n(s.tbox_lines)}</td></tr><tr><td>ABox assertions</td><td>${n(s.abox_lines)}</td></tr>
      <tr><td>Class assertions (instance a C d)</td><td>${n(s.instance_class)}</td></tr><tr><td>Data assertions (instance a (= f v))</td><td>${n(s.instance_data)}</td></tr><tr><td>Role assertions (related)</td><td>${n(s.related)}</td></tr>
      <tr><td>Assertions with degree &lt; 1</td><td>${n(s.degree_lt1)}</td></tr><tr><td>Distinct individuals</td><td>${n(s.individuals)}</td></tr><tr><td>Distinct concepts asserted</td><td>${n(s.concepts_asserted)}</td></tr></table></div>
    <div style="flex:1;min-width:260px"><table class="metrics"><tr><td class="dt">Statement keyword</td><td class="dt" style="font-weight:400">count</td></tr>${kw.map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td>${n(v)}</td></tr>`).join('')}</table></div>
  </div></div>`;
	// pager: filtered mode has a single "page" of matches; otherwise prev/next links + "go to page" box (1-based in the UI)
	const pager = d.filtered
		? `<span class="dt">first ${d.lines.length} lines containing "${esc(fdlState.q)}"</span>`
		: pagerHtml(d.page, d.pages, 'fdlState.page={p};loadFdl()', `${d.limit} lines per page`);
	$('#fdlbody').innerHTML =
		`<div class="sect"><h3>FDL ${pager}</h3><pre style="font-family:ui-monospace,Menlo,monospace;font-size:12px;line-height:1.45;white-space:pre;overflow:auto;background:var(--bg2,#f7f7f9);border:1px solid var(--line);border-radius:6px;padding:10px;max-height:70vh">${d.lines.map((l) => (l.startsWith('#') ? `<span style="color:var(--dim)">${esc(l)}</span>` : esc(l))).join('\n') || '<span class="dt">(empty)</span>'}</pre></div>`;
}

// ---------- axioms tab (DL / FuzzyDL) ----------
// graph = module file ('' = closure); page = 0-based ABox page; q = text filter; notation = value of the
// #axnot select (auto | dl | fm | fdl | both); data = last GET /api/axioms response (re-drawn on notation change)
let axState = { graph: '', page: 0, q: '', notation: 'auto', data: null };
/**
 * Entry point of the Axioms tab (called by the main-tab switch in core.js).
 * Builds the card once (flag in #tab-axioms's data-ready): module select #axgraph (options from the
 * global `modules`), notation select #axnot, debounced filter #axq, LaTeX / PDF export buttons, a
 * legend and the #axbody placeholder; then (re)loads the axioms.
 * Side effects: replaces the innerHTML of #tab-axioms, resets axState.graph, attaches the entity
 * autocomplete to #axq, calls loadAxioms().
 */
function renderAxioms() {
	const box = $('#tab-axioms');
	if (!box.dataset.ready) {
		box.dataset.ready = '1';
		axState.graph = '';
		// card header: title + toolbar (module, notation, filter, exports) + legend
		box.innerHTML = `<div class="card" style="max-width:none">
      <h2>Axioms <span class="count" id="axcount"></span></h2>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:8px">
<span class="dt">Module</span><select id="axgraph" onchange="axState.graph=this.value;axState.page=0;loadAxioms()"><option value="">Closure (all modules)</option>${modules.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('')}</select>
<span class="dt">Notation</span><select id="axnot" onchange="axState.notation=this.value;drawAxioms()"><option value="auto">auto (Fuzzy DL ⟨…⟩ if fuzzy, else DL)</option><option value="dl">DL</option><option value="fm">Fuzzy DL</option><option value="fdl">FuzzyDL (reasoner syntax)</option><option value="both">Fuzzy DL + FuzzyDL syntax</option></select>
<input id="axq" placeholder="filter (entity name / text)…" style="min-width:220px" oninput="clearTimeout(window._axT);window._axT=setTimeout(()=>{axState.q=this.value.trim();axState.page=0;loadAxioms();},300)">
<button class="ibtn" style="margin:0" onclick="exportAxiomsLatex()" title="Download the listed axioms (module / notation / filter as selected) as a LaTeX longtable">${ic('download')} Export LaTeX</button>
<button class="ibtn" style="margin:0" onclick="exportAxiomsPdf()" title="Compile the LaTeX longtable of the listed axioms with pdflatex (temporary folder) and download the PDF">${ic('download')} Export PDF</button>
      </div>
      <div class="dt legend" style="margin-top:6px">Legend: ${dot('class', true)} fuzzy axiom (involves <code>isFuzzy</code> entities or degrees) → Fuzzy DL (⟨a:C, n⟩, ⟨(a,b):R, n⟩, ⟨C ⊑ D, n⟩, ls/rs/tri/trz, m(C), w₁·C₁ + …, @op); ${dot('class')} crisp axiom → DL (C(a), r(a,b), ⊑, ≡, fun/trans). The FuzzyDL syntax is the reasoner one (.fdl export). TBox/RBox from the module file (anonymous expressions included), ABox from the index in pages of 500.</div>
      <div id="axbody" style="margin-top:10px"><div class="dt">loading…</div></div></div>`;
		attachAutocomplete($('#axq'), { single: true, keywords: false });
	}
	loadAxioms();
}
/**
 * Fetches the axioms for the current axState (graph, page, q) and draws them.
 * Side effects: GET /api/axioms; stores the response in axState.data; shows a placeholder in #axbody
 * while loading, then calls drawAxioms().
 */
function loadAxioms() {
	$('#axbody').innerHTML = '<div class="dt">loading…</div>';
	api('/api/axioms', { graph: axState.graph, page: axState.page, q: axState.q }).then((d) => {
		axState.data = d;
		drawAxioms();
	});
}
// which text a row shows for the chosen notation: auto = fuzzy DL for fuzzy rows, DL otherwise
/**
 * Picks the plain-text rendering of an axiom for a notation.
 * @param {Object} a  axiom row from /api/axioms: {kind, fuzzy, dl, fm, fdl, module}; `fm` (fuzzy DL)
 *   may be missing for crisp axioms, in which case `dl` is used.
 * @param {string} n  notation: 'dl' | 'fm' | 'fdl' | anything else = auto.
 * @returns {string} the DL / fuzzy DL / FuzzyDL text.
 */
function axPick(a, n) {
	if (n === 'dl') return a.dl;
	if (n === 'fm') return a.fm || a.dl;
	if (n === 'fdl') return a.fdl;
	return a.fuzzy ? a.fm || a.dl : a.dl;
}
/**
 * HTML of the axiom cell for the notation currently selected in axState.notation: FuzzyDL syntax in
 * <code>, 'both' = fuzzy DL line + FuzzyDL line, otherwise the escaped text chosen by axPick.
 * @param {Object} a  axiom row (see axPick).
 * @returns {string} escaped HTML.
 */
function axText(a) {
	const n = axState.notation;
	if (n === 'fdl') return `<code>${esc(a.fdl)}</code>`;
	if (n === 'both') return `${esc(a.fm || a.dl)}<br><code>${esc(a.fdl)}</code>`;
	return esc(axPick(a, n));
}
/**
 * Renders axState.data into #axbody: a statistics section (reconciliation with the OWL API metrics,
 * counts of what is shown, ABox totals) followed by the TBox/RBox table and the paginated ABox table.
 * Uses axState.data = {graph, tbox[], tbox_kinds, tbox_fuzzy, tbox_by_module, abox:{items, total,
 * page}, abox_stats:{axiom, logical, declaration, annotation, ClassAssertion, ObjectPropertyAssertion,
 * DataPropertyAssertion, with_degree, individuals}, limit}. No-op when nothing has been loaded yet.
 * Side effects: sets #axcount and #axbody.
 */
function drawAxioms() {
	const d = axState.data;
	if (!d) return;
	// one table row per axiom: kind (with fuzzy/crisp dot, module as tooltip) + text in the chosen notation
	const row = (a) =>
		`<tr><td style="width:190px" class="dt" title="${esc(a.module || '')}">${dot('class', a.fuzzy)}${esc(a.kind)}</td><td style="font-family:ui-monospace,Menlo,monospace;font-size:12.5px">${axText(a)}</td></tr>`;
	const ab = d.abox,
		pages = Math.max(1, Math.ceil(ab.total / d.limit));
	const f = (v) => (v || 0).toLocaleString('en');
	$('#axcount').textContent = `— ${d.graph}: TBox/RBox ${d.tbox.length} (fuzzy ${d.tbox_fuzzy}) · ABox ${f(ab.total)}`;
	// statistics of what is shown + of the whole ABox
	const pageFz = ab.items.filter((a) => a.fuzzy).length,
		pageKinds = {};
	ab.items.forEach((a) => (pageKinds[a.kind] = (pageKinds[a.kind] || 0) + 1));
	const s = d.abox_stats || {},
		aboxTot = (s.ClassAssertion || 0) + (s.ObjectPropertyAssertion || 0) + (s.DataPropertyAssertion || 0);
	const shown = d.tbox.length + ab.items.length,
		shownFz = d.tbox_fuzzy + pageFz;
	const kindsRows = Object.entries(d.tbox_kinds)
		.sort((a, b) => b[1] - a[1])
		.map(
			([k, v]) =>
				`<tr><td>${esc(k)}</td><td>${f(v)}</td><td>${f(d.tbox.filter((a) => a.kind === k && a.fuzzy).length)}</td></tr>`
		)
		.join('');
	// rows of kind fuzzy-def / fuzzy-logic come from fuzzyLabel annotations: they are not logical axioms,
	// so they are excluded when reconciling the TBox count with the OWL API "Logical axiom count"
	const ANN = new Set(['fuzzy-def', 'fuzzy-logic']),
		tboxLog = d.tbox.filter((a) => !ANN.has(a.kind)).length;
	// statistics section: reconciliation paragraph + two cards (shown / per type / per module; full ABox / current page)
	const stats = `<div class="sect"><h3>Statistics</h3>
    <div class="dt" style="margin-bottom:8px;line-height:1.6"><b>Reconciliation with the OWL API metrics</b> (${d.graph}): total axioms <b>${f(s.axiom)}</b> = logical ${f(s.logical)} + declarations ${f(s.declaration)} + annotation assertions ${f(s.annotation)}.<br>
      Logical ${f(s.logical)} = TBox/RBox ${f(s.logical - aboxTot)} + ABox ${f(aboxTot)}. This tab lists the <b>logical</b> axioms (TBox/RBox ${f(tboxLog)} here${tboxLog !== s.logical - aboxTot ? ', difference ' + f(tboxLog - (s.logical - aboxTot)) + ' due to how disjoint/n-ary axioms are counted' : ''}; ABox ${f(ab.total)}) plus ${f(d.tbox.length - tboxLog)} fuzzy rows derived from annotations (fuzzyLabel: fuzzy definitions and logic), not counted among the logical ones; declarations and annotations are not listed.</div>
    <div class="ocards" style="align-items:flex-start">
      <div style="flex:1;min-width:280px"><div class="dt" style="margin-bottom:4px"><b>Shown</b>: ${f(shown)} axioms (TBox/RBox ${f(d.tbox.length)} + ABox page ${f(ab.items.length)}) — fuzzy ${f(shownFz)} (${shown ? Math.round((100 * shownFz) / shown) : 0}%), crisp ${f(shown - shownFz)}</div>
<table class="metrics"><tr><td class="dt">Type (TBox/RBox)</td><td class="dt" style="font-weight:400">total</td><td class="dt" style="font-weight:400">fuzzy</td></tr>${kindsRows || '<tr><td class="dt">none</td></tr>'}
${
	Object.keys(d.tbox_by_module || {}).length > 1
		? `<tr><td colspan="3" style="padding-top:8px"><b>per module</b></td></tr>` +
			Object.entries(d.tbox_by_module)
				.map(
					([m, v]) =>
						`<tr><td>${esc(m)}</td><td>${f(v)}</td><td>${f(d.tbox.filter((a) => a.module === m && a.fuzzy).length)}</td></tr>`
				)
				.join('')
		: ''
}</table></div>
      <div style="flex:1;min-width:280px"><div class="dt" style="margin-bottom:4px"><b>Full ABox</b> (${d.graph}): ${f(aboxTot)} assertions on ${f(s.individuals)} individuals</div>
<table class="metrics"><tr><td>ClassAssertion</td><td>${f(s.ClassAssertion)}</td></tr><tr><td>ObjectPropertyAssertion</td><td>${f(s.ObjectPropertyAssertion)}</td></tr><tr><td>DataPropertyAssertion</td><td>${f(s.DataPropertyAssertion)}</td></tr><tr><td>with fuzzy degree (owl:Axiom + Degree)</td><td>${f(s.with_degree)}</td></tr>
<tr><td colspan="2" style="padding-top:8px"><b>current page</b></td></tr>${Object.entries(pageKinds)
		.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${f(v)}</td></tr>`)
		.join('')}<tr><td>fuzzy on this page</td><td>${f(pageFz)}</td></tr></table></div>
    </div></div>`;
	// TBox/RBox table (all rows) + ABox table (one page, with prev/next links in the heading)
	$('#axbody').innerHTML =
		stats +
		`<div class="sect"><h3>TBox / RBox <span class="count">(${d.tbox.length} — ${Object.entries(d.tbox_kinds)
			.map(([k, v]) => k + ' ' + v)
			.join(', ')})</span></h3>
      <table class="props">${d.tbox.map(row).join('') || '<tr><td class="dt">no schema axioms in this module</td></tr>'}</table></div>
    <div class="sect"><h3>ABox <span class="count">(${ab.total.toLocaleString('en')} assertions)</span> ${pagerHtml(ab.page, pages, 'axState.page={p};loadAxioms()')}</h3>
      <table class="props">${ab.items.map(row).join('') || '<tr><td class="dt">no assertions</td></tr>'}</table></div>`;
}

// ---------- LaTeX helpers ----------
/**
 * Escapes a string for LaTeX text mode: backslash first (so the escapes added afterwards are not
 * re-escaped), then the special characters & % $ # _ { } get a backslash, ~ and ^ become the
 * \textasciitilde{} / \textasciicircum{} commands.
 * @param {*} s  value converted with String().
 * @returns {string} LaTeX-safe text.
 */
const texEsc = (s) =>
	// one pass, so the braces of \textbackslash{} etc. are not escaped again
	String(s).replace(
		/[\\&%$#_{}~^]/g,
		(c) => ({ '\\': '\\textbackslash{}', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}' })[c] || '\\' + c
	);
/**
 * Converts a DL / fuzzy DL axiom text (as produced by the server, with Unicode symbols) to LaTeX in
 * text mode: each DL symbol becomes its math command wrapped in $…$, identifiers (letters, digits,
 * '_', '@', '.', '-') are typeset with \path{} from the url package (upright, literal underscores,
 * breakable at _ . -), plain numbers and the remaining punctuation are escaped with texEsc, and the
 * ellipsis '…' becomes \dots{}. No italics.
 * @param {string} s  axiom text, e.g. "⟨Lithuania_2000:PoorCountry, 0.8⟩".
 * @returns {string} LaTeX fragment.
 */
function dlToTex(s) {
	// DL / fuzzy DL text → LaTeX in text mode: symbols in $…$, identifiers in \path{} (url package:
	// upright, literal underscores, breakable at _ . -), numbers and punctuation plain. No italics.
	const m = {
		'⊑': '\\sqsubseteq',
		'≡': '\\equiv',
		'⊓': '\\sqcap',
		'⊔': '\\sqcup',
		'¬': '\\neg',
		'∃': '\\exists',
		'∀': '\\forall',
		'⊤': '\\top',
		'⊥': '\\bot',
		'≥': '\\geq',
		'≤': '\\leq',
		'⁻': '{}^{-}',
		'⟨': '\\langle',
		'⟩': '\\rangle',
		'·': '\\cdot'
	};
	// split on the DL symbols (capturing group keeps them as odd elements); inside each non-symbol chunk
	// split again on identifier tokens (odd elements = identifiers: numbers stay plain, names → \path{})
	return s
		.split(/([⊑≡⊓⊔¬∃∀⊤⊥≥≤⁻⟨⟩·])/)
		.map((p) =>
			m[p] !== undefined
				? '$' + m[p] + '$'
				: p
						.split(/([A-Za-z0-9_@][A-Za-z0-9_@.\-]*)/)
						.map((x, i) =>
							i % 2 ? (/^[0-9.]+$/.test(x) ? x : '\\path{' + x + '}') : texEsc(x).replace(/…/g, '\\dots{}')
						)
						.join('')
		)
		.join('');
}
/**
 * Triggers a browser download of a text file built client-side (Blob + temporary <a download>).
 * @param {string} name  file name proposed to the user.
 * @param {string} text  file content.
 * @param {string} [mime='text/plain;charset=utf-8']  MIME type of the blob.
 */
function downloadText(name, text, mime) {
	const a = document.createElement('a');
	a.href = URL.createObjectURL(new Blob([text], { type: mime || 'text/plain;charset=utf-8' }));
	a.download = name;
	a.click();
	URL.revokeObjectURL(a.href);
}
/**
 * Builds the LaTeX table of the axioms currently shown (all TBox/RBox rows + the current ABox page),
 * three columns: Type | Fuzzy (a bullet) | Axiom in the notation selected in axState.notation.
 * @param {boolean} longtable  true = longtable environment (multi-page, used for the PDF and for big
 *   exports); false = floating table with tabularx.
 * @returns {{tex: string, name: string}|null} LaTeX source and base file name (axioms_<module>),
 *   or null when nothing has been loaded yet.
 */
function axiomsTex(longtable) {
	// LaTeX of the shown axioms; longtable = multi-page (PDF)
	const d = axState.data;
	if (!d) return null;
	const rows = [...d.tbox, ...d.abox.items];
	const n = axState.notation;
	// axiom cell: FuzzyDL syntax in \texttt, 'both' = fuzzy DL + \newline + FuzzyDL, otherwise dlToTex
	const cell = (a) =>
		n === 'fdl'
			? `\\texttt{${texEsc(a.fdl)}}`
			: n === 'both'
				? `${dlToTex(a.fm || a.dl)} \\newline \\texttt{${texEsc(a.fdl)}}`
				: dlToTex(axPick(a, n));
	const body = rows.map((a) => `${texEsc(a.kind)} & ${a.fuzzy ? '$\\bullet$' : ''} & ${cell(a)} \\\\`).join('\n');
	const caption = `Axioms of \\texttt{${texEsc(d.graph)}} (TBox/RBox ${d.tbox.length}, ABox page ${d.abox.page + 1} of ${Math.max(1, Math.ceil(d.abox.total / d.limit))}).`;
	const label = `tab:axioms-${d.graph.replace(/\.owl$/, '').replace(/[^A-Za-z0-9-]+/g, '-')}`; // labels must stay unescaped
	// leading comment lines: provenance + required packages
	const head = `% Axioms of ${d.graph} — ${rows.length} rows (TBox/RBox ${d.tbox.length} + ABox page ${d.abox.page + 1}); generated by the Ontology Viewer
% requires \\usepackage{booktabs,longtable,tabularx,array,url} and \\urlstyle{same} (identifiers are typeset with \\path)\n`;
	// longtable: fixed-width ragged-right columns (23% + 62% of \textwidth), header repeated on every page
	// (\endfirsthead / \endhead), bottom rule as footer; floating table: tabularx with an X column for the axiom
	const tex = longtable
		? head +
			`\\small
\\begin{longtable}{@{}>{\\raggedright\\arraybackslash}p{0.23\\textwidth} c >{\\raggedright\\arraybackslash}p{0.62\\textwidth}@{}}
\\caption{${caption}}\\label{${label}}\\\\
\\toprule
\\textbf{Type} & \\textbf{Fuzzy} & \\textbf{Axiom} \\\\
\\midrule
\\endfirsthead
\\toprule
\\textbf{Type} & \\textbf{Fuzzy} & \\textbf{Axiom} \\\\
\\midrule
\\endhead
\\bottomrule
\\endfoot
${body}
\\end{longtable}
`
		: head +
			`\\begin{table}[htbp]
\\centering
\\small
\\begin{tabularx}{\\textwidth}{@{}l c >{\\raggedright\\arraybackslash}X@{}}
\\toprule
\\textbf{Type} & \\textbf{Fuzzy} & \\textbf{Axiom} \\\\
\\midrule
${body}
\\bottomrule
\\end{tabularx}
\\caption{${caption}}
\\label{${label}}
\\end{table}
`;
	return { tex, name: `axioms_${d.graph.replace(/\.owl$/, '')}` };
}
const LONGTABLE_ROWS = 40; // above this a floating table overflows the page → longtable
/**
 * "Export LaTeX" button of the Axioms tab: downloads the .tex of the shown axioms (longtable when
 * there are more than LONGTABLE_ROWS rows). No-op when nothing has been loaded.
 * Side effects: browser download via downloadText.
 */
function exportAxiomsLatex() {
	const d = axState.data;
	if (!d) return;
	const t = axiomsTex(d.tbox.length + d.abox.items.length > LONGTABLE_ROWS);
	if (t) downloadText(t.name + '.tex', t.tex);
}
/**
 * "Export PDF" button of the Axioms tab: sends the longtable LaTeX to the server, which compiles it
 * with pdflatex, and downloads the resulting PDF.
 * Side effects: POST /api/pdf {tex, name} (returns the PDF bytes, or 400 + {error}); temporarily
 * appends a "compiling" note to #axcount; alert() on failure; browser download on success.
 * @returns {Promise<void>}
 */
async function exportAxiomsPdf() {
	const t = axiomsTex(true);
	if (!t) return;
	$('#axcount').textContent += ' — compiling pdflatex…';
	const r = await fetch('/api/pdf', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ tex: t.tex, name: t.name })
	});
	$('#axcount').textContent = $('#axcount').textContent.replace(' — compiling pdflatex…', '');
	if (!r.ok) {
		const e = await r.json().catch(() => ({ error: r.statusText }));
		alert('PDF: ' + e.error);
		return;
	}
	const a = document.createElement('a');
	a.href = URL.createObjectURL(await r.blob());
	a.download = t.name + '.pdf';
	a.click();
	URL.revokeObjectURL(a.href);
}
/**
 * Entry point of the Fuzzy tab (called by the main-tab switch in core.js): lists every entity
 * annotated sdf:isFuzzy, one card per kind (datatypes/modifiers, classes, properties, individuals)
 * and, inside each card, one section per sub-group (datatype shape, modifiers, fuzzy concepts,
 * bridge classes, composites). Clicking an entity opens it in the Entities tab.
 * Side effects: GET /api/fuzzy (returns {groups:{kind:[{iri,name,label,kind,fuzzyType,shape}]},
 * total}); replaces the innerHTML of #tab-fuzzy.
 */
function renderFuzzyTab() {
	api('/api/fuzzy', {}).then((d) => {
		const G = d.groups,
			order = ['datatype', 'class', 'objprop', 'dataprop', 'individual', 'annprop'];
		const title = {
			datatype: 'Fuzzy datatypes and modifiers',
			class: 'Fuzzy classes',
			objprop: 'Object property',
			dataprop: 'Data property',
			individual: 'Individuals',
			annprop: 'Annotation property'
		};
		// intro card: total + colour legend
		let h = `<div class="card" style="max-width:none"><h2>Fuzzy entities <span class="count">(${d.total} annotated <code>sdf:isFuzzy true</code>)</span></h2>
      <div class="dt legend" style="margin-top:4px">Colour legend: ${dot('class', true)} fuzzy class · ${dot('class')} crisp class · ${dot('datatype', true)} fuzzy datatype · ${dot('datatype')} crisp datatype. Criterion: fuzzyLabel (datatype, modifiers, weighted/OWA concepts) or a class whose definition depends on fuzzy entities (TerritoryWith* bridge classes, composites).</div></div>`;
		for (const k of order) {
			const items = G[k];
			if (!items || !items.length) continue;
			// sub-group key: datatypes by fuzzyLabel shape (or 'modifiers'); classes = fuzzy concepts (by shape),
			// TerritoryWith*/TerritoryIn* bridge classes, or composites
			const sub = {};
			items.forEach((n) => {
				const key =
					n.kind === 'datatype'
						? n.fuzzyType === 'modifier'
							? 'modifiers'
							: n.shape || 'datatype'
						: n.fuzzyType === 'concept'
							? 'concepts ' + (n.shape || '')
							: n.name.startsWith('TerritoryWith') || n.name.startsWith('TerritoryIn')
								? 'bridge classes (∃feature.Datatype)'
								: 'composites (intersections/aggregations)';
				(sub[key] = sub[key] || []).push(n);
			});
			h += `<div class="card" style="max-width:none;margin-top:14px"><h2>${title[k] || k} <span class="count">(${items.length})</span></h2>`;
			for (const [sk, list] of Object.entries(sub).sort()) {
				h +=
					`<div class="sect"><h3>${esc(sk)} <span class="count">(${list.length})</span></h3><div style="display:flex;flex-wrap:wrap;gap:4px 18px">` +
					list
						.map(
							(n) =>
								`<div class="item" style="padding:2px 6px" onclick="document.querySelector('#maintabs [data-mt=entities]').click();show('${encodeURIComponent(n.iri)}')">${dot(n.kind, true)}${esc(n.name)}${n.label && n.label !== n.name ? ` <span class="dt">${esc(n.label)}</span>` : ''}</div>`
						)
						.join('') +
					`</div></div>`;
			}
			h += `</div>`;
		}
		$('#tab-fuzzy').innerHTML = h;
	});
}
// ontoData = cached GET /api/ontology response ({ontologies:[{iri,file,imports,annotations}], metrics:
// {file:{name:value}}, per_module, prefixes:{file:[[prefix,ns]]}}); activeOnt = IRI of the active ontology
let ontoData = null,
	activeOnt = null;
const METRIC_GROUPS = [
	// same names and order as the OWL API's "Ontology metrics" view
	[
		'Metrics',
		[
			'Axiom',
			'Logical axiom count',
			'Declaration axioms count',
			'Class count',
			'Object property count',
			'Data property count',
			'Individual count',
			'Annotation property count'
		]
	],
	['Class axioms', ['SubClassOf', 'EquivalentClasses', 'DisjointClasses', 'GCI count', 'Hidden GCI Count']],
	[
		'Object property axioms',
		[
			'SubObjectPropertyOf',
			'EquivalentObjectProperties',
			'InverseObjectProperties',
			'DisjointObjectProperties',
			'FunctionalObjectProperty',
			'InverseFunctionalObjectProperty',
			'TransitiveObjectProperty',
			'SymmetricObjectProperty',
			'AsymmetricObjectProperty',
			'ReflexiveObjectProperty',
			'IrreflexiveObjectProperty',
			'ObjectPropertyDomain',
			'ObjectPropertyRange',
			'SubPropertyChainOf'
		]
	],
	[
		'Data property axioms',
		[
			'SubDataPropertyOf',
			'EquivalentDataProperties',
			'DisjointDataProperties',
			'FunctionalDataProperty',
			'DataPropertyDomain',
			'DataPropertyRange'
		]
	],
	[
		'Individual axioms',
		[
			'ClassAssertion',
			'ObjectPropertyAssertion',
			'DataPropertyAssertion',
			'NegativeObjectPropertyAssertion',
			'NegativeDataPropertyAssertion',
			'SameIndividual',
			'DifferentIndividuals'
		]
	],
	['Annotation axioms', ['AnnotationAssertion', 'AnnotationPropertyDomain', 'AnnotationPropertyRangeOf']],
	['Datatype axioms (extra, not among the OWL API axiom types)', ['Datatype count', 'DatatypeDefinition']]
];
/**
 * Entry point of the Ontology info tab (called by the main-tab switch in core.js, by entities.js
 * after edits via ontReload, and once at script load). Draws from the cache when available,
 * otherwise fetches the ontology data first.
 * Side effects: GET /api/ontology; sets `ontoData` and `activeOnt` (the module importing the most =
 * root of the closure); calls drawOntology() and fillScope() (core.js, refreshes the scope select).
 */
function renderOntology() {
	if (ontoData) return drawOntology();
	api('/api/ontology', {}).then((d) => {
		ontoData = d;
		// default active = the module that imports the most (root of the closure)
		activeOnt = [...d.ontologies].sort((a, b) => b.imports.length - a.imports.length)[0]?.iri;
		refreshNames(); // display names depend on the active ontology
		drawOntology();
		fillScope();
	});
}
/**
 * "Remove from index" button: after confirmation, removes the active module from the index and the
 * workspace (the .owl file is not touched) and reloads the page.
 * Side effects: confirm(); POST /api/workspace/remove {file}; alert() on error; location.reload().
 */
function removeFromIndex() {
	const o = (ontoData?.ontologies || []).find((x) => x.iri === activeOnt);
	if (!o || !o.file) return;
	if (
		!confirm(
			`Remove ${o.file} from the index?\nIts statements are deleted from the index and the module leaves the workspace (the .owl file is not touched). Open it again to re-index it.`
		)
	)
		return;
	post('/api/workspace/remove', { file: o.file })
		.then((r) => {
			if (r && r.error) {
				alert(r.error);
				return;
			}
			location.reload();
		})
		.catch((e) => alert(e));
}
/**
 * Import closure of an ontology (depth-first over owl:imports, using `ontoData`).
 * @param {string} iri  ontology IRI.
 * @returns {string[]} IRIs of the ontology itself plus all directly/indirectly imported ones
 *   (unresolved imports are included as IRIs even if they have no module).
 */
function ontClosure(iri) {
	const by = Object.fromEntries(ontoData.ontologies.map((o) => [o.iri, o]));
	const seen = new Set(),
		st = [iri];
	while (st.length) {
		const i = st.pop();
		if (seen.has(i)) continue;
		seen.add(i);
		(by[i]?.imports || []).forEach((x) => st.push(x));
	}
	return [...seen];
}
/**
 * Renders the whole Ontology info tab for `activeOnt` from `ontoData`: the ontology selector,
 * the header card (IRI, location, annotations with add/remove buttons), the bottom-tab card
 * (imports / prefixes / general class axioms), the OWL API-style metrics card (closure vs module),
 * the per-module breakdown card (pie + one column per module) and the export card (CSV / LaTeX / PDF
 * of the selected metrics). Honours the global `countAnn` (annotation axioms included or not).
 * Side effects: replaces the innerHTML of #tab-ontology; sets window._bp (panels of the bottom
 * tabs, read by their inline onclick); binds #ontsel (changes `activeOnt`, redraws, refreshes the
 * sidebar scope and list), #xbtn (CSV download), #xtex (LaTeX download) and #xpdf (POST /api/pdf).
 */
/**
 * Fill the "Active ontology" bar above the main tabs (#ontsel: one option per module of the
 * workspace, the active one selected) and bind its change: the choice updates `activeOnt`,
 * redraws the Ontology info tab and refreshes the scope of the Entities sidebar.
 */
let ontoSub = 'overview'; // sub-tab of the Ontology info tab: overview | metrics | export

/**
 * Re-render what shows entity names (sidebar list / tree and the open entity): names carry a
 * prefix when the entity is not declared in the active ontology, so they change with it.
 */
function refreshNames() {
	if (typeof loadList === 'function') loadList();
	if (typeof selIri !== 'undefined' && selIri) show(encodeURIComponent(selIri));
}

function drawOntBar() {
	const sel = $('#ontsel');
	if (!sel || !ontoData) return;
	sel.innerHTML = ontoData.ontologies
		.map(
			(x) =>
				`<option value="${esc(x.iri)}" ${x.iri === activeOnt ? 'selected' : ''}>${esc(short(x.iri))}  (${esc(x.iri)})</option>`
		)
		.join('');
	sel.onchange = (e) => {
		activeOnt = e.target.value;
		drawOntology();
		fillScope();
		if (scope === 'active') page = 0;
		refreshNames();
	};
}

function drawOntology() {
	const d = ontoData,
		by = Object.fromEntries(d.ontologies.map((o) => [o.iri, o]));
	const o = by[activeOnt];
	if (!o) return;
	const ANN_AX = ['AnnotationAssertion', 'AnnotationPropertyDomain', 'AnnotationPropertyRangeOf'];
	// metrics of one ontology (by IRI → its file); when annotations are excluded, subtract them from
	// 'Axiom' and zero the three annotation metrics (copy: the cached data is never modified)
	const mOf = (iri) => {
		const m = { ...(d.metrics[by[iri]?.file] || {}) };
		if (!countAnn) {
			const a = ANN_AX.reduce((s, k) => s + (m[k] || 0), 0);
			m['Axiom'] = (m['Axiom'] || 0) - a;
			ANN_AX.forEach((k) => (m[k] = 0));
		}
		return m;
	};
	const own = mOf(activeOnt);
	// "count annotations" checkbox (same control appears in the metrics and export cards, different ids)
	const annBox = (id) =>
		`<label class="dt" style="display:inline-flex;align-items:center;gap:5px;vertical-align:middle;font-weight:400;text-transform:none;margin-left:12px;cursor:pointer" title="If unchecked, Axiom and the totals exclude the annotation axioms (AnnotationAssertion, AnnotationPropertyDomain, AnnotationPropertyRangeOf)"><input type="checkbox" id="${id}" ${countAnn ? 'checked' : ''} onchange="setCountAnn(this.checked)"> count annotations</label>`;
	const closure = ontClosure(activeOnt);
	// closure totals = sum of every metric over all modules of the closure
	const sum = {};
	closure.forEach((i) => {
		for (const [k, v] of Object.entries(mOf(i))) sum[k] = (sum[k] || 0) + v;
	});
	const fmt = (v) => (v || 0).toLocaleString('en');
	drawOntBar();
	// the IRI is passed to the inline handlers URL-encoded (safe inside single quotes) and decoded there
	const oenc = encodeURIComponent(o.iri);
	// header card: IRI (+ rename), location, annotations (+ add / ✕ remove)
	// header card: editable Ontology IRI and Version IRI (committed on Enter / blur), location, annotations
	const venc = encodeURIComponent(o.version || '');
	const header = `<div class="card" style="margin-bottom:14px">
    <h2>Ontology header</h2>
    <div class="hdrf">
      <label for="oiri">Ontology IRI</label>
      <input id="oiri" value="${esc(o.iri)}" spellcheck="false" onkeydown="if(event.key==='Enter')this.blur()" onchange="ontSetIri(decodeURIComponent('${oenc}'),this.value.trim())">
      <label for="overs">Ontology Version IRI</label>
      <input id="overs" value="${esc(o.version || '')}" placeholder="e.g. ${esc(o.iri)}/1.0.0" spellcheck="false" onkeydown="if(event.key==='Enter')this.blur()" onchange="ontSetVersion(decodeURIComponent('${oenc}'),'${esc(o.file || '')}',decodeURIComponent('${venc}'),this.value.trim())">
      <label>Location</label>
      <span>${esc(o.file || '—')}</span>
    </div>
    <div class="sect"><h3>Annotations <button class="ibtn" onclick="ontAddAnnotation(decodeURIComponent('${oenc}'),'${esc(o.file || '')}')" title="Add an annotation to the ontology header (e.g. rdfs:comment, dc:title, owl:versionInfo)">+ annotation</button></h3>${
			o.annotations.length
				? o.annotations
						.map(
							(a) =>
								`<div style="margin:5px 0"><b style="font-size:12px">${esc(a.pred)}</b> <span class="rm" title="Remove this annotation from the ontology header" onclick="ontRemoveAnnotation(decodeURIComponent('${oenc}'),'${esc(a.piri || '')}',decodeURIComponent('${encodeURIComponent(a.value)}'),'${esc(a.lang || '')}','${esc(o.file || '')}')">✕</span><div class="lit">${esc(a.value)}</div></div>`
						)
						.join('')
				: '<span class="dt">none</span>'
		}</div>
  </div>`;
	// one imported ontology, OWL API style: IRI, short name + axiom counts, location (or unresolved)
	const impInfo = (i) => {
		const t = by[i],
			m = mOf(i);
		return `<div style="margin:6px 0 10px"><b>&lt;${esc(i)}&gt;</b>
      <div style="margin-left:18px"><div>${esc(short(i))} <span class="dt">(${fmt(m['Axiom'])} axioms, ${fmt(m['Logical axiom count'])} logical axioms)</span></div>
      <div class="subm">Ontology IRI: &lt;${esc(i)}&gt;</div>
      <div class="subm">Location: ${t && t.file ? esc(t.file) : '<i>unresolved (missing from the catalog / not indexed)</i>'}</div></div></div>`;
	};
	const indirect = closure.filter((i) => i !== activeOnt && !o.imports.includes(i));
	const prefixes = (d.prefixes || {})[o.file] || [];
	const gci = own['GCI count'] || 0;
	// panels of the bottom tabs; the prefix ✎ button is offered only for non-W3C namespaces
	const bottomPanels = {
		imports: `<div class="sect"><h3>Direct imports <button class="ibtn" onclick="ontAddImport(decodeURIComponent('${oenc}'),'${esc(o.file || '')}')" title="Add an owl:imports statement: an ontology in a local file, at a URL or already loaded in the workspace">+ import</button></h3>${o.imports.length ? o.imports.map((i) => impInfo(i) + `<span class="rm" style="margin-left:24px" title="Remove this owl:imports statement from the header (the imported file is not touched)" onclick="ontRemoveImport(decodeURIComponent('${oenc}'),'${esc(i)}','${esc(o.file || '')}')">✕ remove import</span>`).join('') : '<span class="dt">none</span>'}</div>
      <div class="sect"><h3>Indirect imports</h3>${indirect.length ? indirect.map(impInfo).join('') : '<span class="dt">none</span>'}</div>`,
		prefixes: `<div class="sect"><h3>Prefixes <span class="dt" style="font-weight:400;text-transform:none">(✎ = rename the namespace in ALL modules: changes the IRIs of every entity using it)</span></h3><table class="props">${
			prefixes
				.map(
					([p, i]) =>
						`<tr><td class="pred" style="width:110px">${esc(p)}:</td><td class="iri" style="font-size:13px;color:var(--txt)">${esc(i)} ${i.includes('semanticweb.org') || !i.includes('w3.org') ? `<button class="ibtn" onclick="renameNamespace('${esc(i)}')" title="Rename this namespace in every module: the IRI of each entity using it changes accordingly">✎</button>` : ''}</td></tr>`
				)
				.join('') || '<tr><td class="dt">none</td></tr>'
		}</table></div>`,
		gca: `<div class="sect"><h3>General class axioms</h3>${
			gci
				? `<div>${gci} GCIs in this module (SubClassOf with anonymous subject) — not indexed in detail.</div>`
				: '<span class="dt">No general class axioms in this module (GCI count = 0).</span>'
		}</div>`
	};
	// exposed globally because the tab buttons swap panels from an inline onclick
	window._bp = bottomPanels;
	// bottom-tab card (#btabs buttons + #bpanel content), imports shown first
	const imports = `<div class="card">
    <div id="btabs">
      ${[
				['imports', 'Ontology imports'],
				['prefixes', 'Ontology prefixes'],
				['gca', 'General class axioms']
			]
				.map(([k, l]) =>
					tabBtn(
						'bt',
						k,
						l,
						k === 'imports',
						`document.querySelectorAll('#btabs button').forEach(x=>x.classList.remove('on'));this.classList.add('on');document.getElementById('bpanel').innerHTML=window._bp['${k}']`,
						'btab'
					)
				)
				.join('')}
    </div>
    <div id="bpanel">${bottomPanels.imports}</div>
  </div>`;
	// metrics card: one table per METRIC_GROUPS group, columns Closure | Module
	const metrics = `<div class="card" style="max-width:none">
    <h2>Ontology metrics ${annBox('annM')}</h2>
    <div class="subm" style="margin-top:4px">Column <b>Closure</b> = active ontology + all imported ones ( ${closure.length} modules); column <b>Module</b> = the active file only.${countAnn ? '' : ' <b>Annotations excluded</b>: Axiom net of the annotation axioms.'}</div>
    <div class="mgrid">${METRIC_GROUPS.map(
			([g, keys]) =>
				`<div class="sect"><h3>${g}</h3><table class="metrics">
      <tr><td></td><td class="dt" style="font-weight:400">Closure</td><td class="dt" style="font-weight:400">Module</td></tr>` +
				keys
					.map((k) => `<tr><td>${k}</td><td>${fmt(sum[k])}</td><td style="color:var(--dim)">${fmt(own[k])}</td></tr>`)
					.join('') +
				`</table></div>`
		).join('')}</div>
  </div>`;
	// ---- breakdown of every metric by module of the closure (table + pie per metric) ----
	const PALETTE = ['#3457b0', '#e07b39', '#2a9d8f', '#b03a8c', '#8a6d1a', '#6c757d'];
	// one entry per module of the closure with its colour and metrics
	const mods = closure.map((iri, i) => ({
		iri,
		name: short(iri),
		file: by[iri]?.file,
		color: PALETTE[i % PALETTE.length],
		m: mOf(iri)
	}));
	const allKeys = METRIC_GROUPS.flatMap(([, ks]) => ks);
	const legend = mods
		.map(
			(x) =>
				`<span style="display:inline-flex;align-items:center;gap:5px;margin-right:14px"><span style="width:12px;height:12px;border-radius:3px;background:${x.color};display:inline-block"></span>${esc(x.name)}<span class="dt">(${esc(x.file || '?')})</span></span>`
		)
		.join('');
	// table rows: a group heading row, then per metric: name | pie | one cell per module (value + %) | closure total
	const brRows = METRIC_GROUPS.map(
		([g, keys]) =>
			`<tr><td colspan="${mods.length + 3}" style="padding-top:10px"><b>${g}</b></td></tr>` +
			keys
				.map((k) => {
					const tot = sum[k] || 0;
					return (
						`<tr><td>${k}</td><td>${pieSVG(mods.map((x) => ({ v: x.m[k] || 0, color: x.color, title: `${x.name}: ${fmt(x.m[k])} (${tot ? Math.round((100 * (x.m[k] || 0)) / tot) : 0}%)` })))}</td>` +
						mods
							.map(
								(x) =>
									`<td style="color:${x.color}">${fmt(x.m[k])}<div class="dt" style="font-weight:400">${tot ? Math.round((100 * (x.m[k] || 0)) / tot) : 0}%</div></td>`
							)
							.join('') +
						`<td>${fmt(tot)}</td></tr>`
					);
				})
				.join('')
	).join('');
	const breakdown = `<div class="card" style="max-width:none;margin-top:14px">
    <h2>Metrics breakdown by ontology <span class="count">(closure of ${esc(short(activeOnt))}: ${mods.length} modules)</span></h2>
    <div style="margin:8px 0 4px">${legend}</div>
    <div style="overflow-x:auto"><table class="metrics"><tr><td></td><td></td>${mods.map((x) => `<td class="dt" style="font-weight:600;color:${x.color}">${esc(x.name)}</td>`).join('')}<td class="dt" style="font-weight:600">Closure</td></tr>${brRows}</table></div>
  </div>`;
	// ---- CSV export ----
	// export card: scope radios (module / closure / both / breakdown), CSV separator, three export buttons,
	// and one checkbox per metric (.xm) grouped as in METRIC_GROUPS with all/none shortcuts
	const exportCard = `<div class="card" style="max-width:none;margin-top:14px">
    <h2>Export metrics (CSV / LaTeX / PDF) ${annBox('annX')}</h2>
    <div style="display:flex;gap:24px;flex-wrap:wrap;margin-top:8px">
      <div><div class="dt" style="margin-bottom:4px">What to export</div>
<label style="display:block"><input type="radio" name="xscope" value="module" checked> Active module only (${esc(short(activeOnt))})</label>
<label style="display:block"><input type="radio" name="xscope" value="closure"> Closure (total)</label>
<label style="display:block"><input type="radio" name="xscope" value="both"> Both (module + closure)</label>
<label style="display:block"><input type="radio" name="xscope" value="breakdown"> Breakdown by module (one column per ontology + closure)</label>
<div class="dt" style="margin:10px 0 4px">Separator</div>
<select id="xsep"><option value=";">; (Excel, European locales)</option><option value=",">, (standard)</option><option value="\t">tab</option></select>
<div style="margin-top:12px"><button id="xbtn" class="btn" title="Download the selected metrics for the chosen scope as a CSV file (separator above)">${ic('download')} Export CSV</button>
<button id="xtex" class="btn" title="Download the selected metrics for the chosen scope as a LaTeX table">${ic('download')} Export LaTeX</button>
<button id="xpdf" class="btn" title="Compile the LaTeX table of the selected metrics with pdflatex (temporary folder) and download the PDF">${ic('download')} Export PDF</button>
<span id="xinfo" class="dt" style="margin-left:8px"></span></div>
      </div>
      <div style="flex:1;min-width:300px"><div class="dt" style="margin-bottom:4px">Metrics to export
<span class="expand" onclick="document.querySelectorAll('.xm').forEach(c=>c.checked=true)">all</span> ·
<span class="expand" onclick="document.querySelectorAll('.xm').forEach(c=>c.checked=false)">none</span></div>
<div style="columns:2;column-gap:20px">${METRIC_GROUPS.map(
		([g, keys]) =>
			`<div style="break-inside:avoid;margin-bottom:6px"><b style="font-size:12px">${g}</b>` +
			keys
				.map(
					(k) =>
						`<label style="display:block;font-size:13px"><input type="checkbox" class="xm" value="${k}" checked> ${k}</label>`
				)
				.join('') +
			`</div>`
	).join('')}</div>
      </div>
    </div></div>`;
	// layout: sub-tabs Overview (header | imports/prefixes/GCAs), Metrics (tables + breakdown), Export;
	// every panel stays in the DOM (inactive ones hidden) so the export buttons can be bound below
	const SUBS = [
		['overview', 'Overview'],
		['metrics', 'Metrics'],
		['export', 'Export']
	];
	const otabs = `<div id="otabs">${SUBS.map(([k, l]) =>
		tabBtn(
			'ot',
			k,
			l,
			k === ontoSub,
			`ontoSub='${k}';document.querySelectorAll('#otabs button').forEach(x=>x.classList.toggle('on',x.dataset.ot==='${k}'));document.querySelectorAll('#tab-ontology .opanel').forEach(p=>p.hidden=p.dataset.op!=='${k}')`,
			'otab'
		)
	).join('')}</div>`;
	const panel = (k, inner) => `<div class="opanel" data-op="${k}" ${k === ontoSub ? '' : 'hidden'}>${inner}</div>`;
	$('#tab-ontology').innerHTML =
		otabs +
		panel(
			'overview',
			`<div class="ocards"><div style="flex:1;min-width:min(420px,100%)">${header}</div><div style="flex:1;min-width:min(420px,100%)">${imports}</div></div>`
		) +
		panel('metrics', metrics + breakdown) +
		panel('export', exportCard);
	/**
	 * Reads the export form: selected metrics and scope, and derives the column names and a row builder.
	 * @returns {{keys: string[], scope: string, cols: string[], rowOf: function(string): number[]}}
	 *   keys = checked metric names; cols = column headings; rowOf(metric) = values, one per column.
	 */
	const exportSel = () => {
		const keys = [...document.querySelectorAll('.xm:checked')].map((c) => c.value);
		const scope = document.querySelector('input[name=xscope]:checked').value;
		let cols, rowOf;
		if (scope === 'module') {
			cols = [short(activeOnt)];
			rowOf = (k) => [own[k] || 0];
		} else if (scope === 'closure') {
			cols = ['closure'];
			rowOf = (k) => [sum[k] || 0];
		} else if (scope === 'both') {
			cols = [short(activeOnt), 'closure'];
			rowOf = (k) => [own[k] || 0, sum[k] || 0];
		} else {
			cols = mods.map((x) => x.name).concat(['closure']);
			rowOf = (k) => mods.map((x) => x.m[k] || 0).concat([sum[k] || 0]);
		}
		return { keys, scope, cols, rowOf };
	};
	/**
	 * "Export CSV" button: downloads the selected metrics as CSV (header row "Metric" + one "Value"
	 * column per scope column), with the separator chosen in #xsep, CRLF line ends and a UTF-8 BOM
	 * so that Excel opens it correctly.
	 * Side effects: browser download via downloadText; status message in #xinfo.
	 */
	$('#xbtn').onclick = () => {
		const { keys, scope, cols, rowOf } = exportSel();
		const sep = $('#xsep').value;
		if (!keys.length) {
			$('#xinfo').textContent = 'select at least one metric';
			return;
		}
		// CSV quoting: wrap in double quotes (doubling inner quotes) when the value contains a quote, separator or newline
		const q = (s) => {
			s = String(s);
			return /[";\n,\t]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
		};
		const lines = [['Metric', ...(cols.length === 1 ? ['Value'] : cols.map((c) => `Value (${c})`))].map(q).join(sep)];
		METRIC_GROUPS.forEach(([g, ks]) =>
			ks.filter((k) => keys.includes(k)).forEach((k) => lines.push([k, ...rowOf(k)].map(q).join(sep)))
		);
		downloadText(`metrics_${short(activeOnt)}_${scope}.csv`, '﻿' + lines.join('\r\n'), 'text/csv;charset=utf-8');
		$('#xinfo').textContent = `${keys.length} metrics × ${cols.length} columns exported`;
	};
	/**
	 * Builds the LaTeX table of the selected metrics: column "Metric" + one right-aligned numeric column
	 * per scope column, one \multicolumn heading row per METRIC_GROUPS group (groups separated by
	 * \midrule), thousands separated by a thin space (\,). Uses longtable above LONGTABLE_ROWS rows,
	 * otherwise a floating tabularx table.
	 * @returns {{tex: string, name: string, info: string}|null} LaTeX source, base file name
	 *   (metrics_<module>_<scope>) and a short summary; null (with a message in #xinfo) when no metric
	 *   is selected.
	 */
	const metricsTex = () => {
		// {tex,name} of the selected metrics, or null
		const { keys, scope, cols, rowOf } = exportSel();
		if (!keys.length) {
			$('#xinfo').textContent = 'select at least one metric';
			return null;
		}
		const fmtN = (v) => String(v).replace(/\B(?=(\d{3})+(?!\d))/g, '\\,'); // thin-space thousands separator
		const body = METRIC_GROUPS.map(([g, ks]) => {
			const rows = ks.filter((k) => keys.includes(k));
			if (!rows.length) return '';
			return (
				`\\multicolumn{${cols.length + 1}}{l}{\\textit{${texEsc(g)}}} \\\\\n` +
				rows.map((k) => `${texEsc(k)} & ${rowOf(k).map(fmtN).join(' & ')} \\\\`).join('\n')
			);
		})
			.filter(Boolean)
			.join('\n\\midrule\n');
		// header: Metric | Value; with several columns "Value" spans them and a second row names each
		const head =
			cols.length === 1
				? `\\textbf{Metric} & \\textbf{Value} \\\\`
				: `\\textbf{Metric} & \\multicolumn{${cols.length}}{c}{\\textbf{Value}} \\\\\n\\cmidrule(lr){2-${cols.length + 1}}\n & ${cols.map((c) => `\\textit{${texEsc(c)}}`).join(' & ')} \\\\`;
		const caption = `Metrics of the ontology \\texttt{${texEsc(short(activeOnt))}}${scope === 'closure' || scope === 'breakdown' ? ' (import closure)' : ''}${countAnn ? '' : ' (annotation axioms excluded)'}.`;
		const label = `tab:metrics-${short(activeOnt).replace(/[^A-Za-z0-9-]+/g, '-')}`; // labels must stay unescaped
		const comment = `% Metrics of ${short(activeOnt)} (${scope})${countAnn ? '' : ' — annotation axioms excluded'} — generated by the Ontology Viewer\n`;
		const nrows = body.split('\n').length;
		// column spec: 'p{0.5\textwidth}' (longtable) or 'X' (tabularx) for the metric name, then one 'r' per value column
		const tex =
			nrows > LONGTABLE_ROWS
				? comment +
					`\\begin{longtable}{p{0.5\\textwidth} ${'r '.repeat(cols.length).trim()}}
\\caption{${caption}}\\label{${label}}\\\\
\\toprule
${head}
\\midrule
\\endfirsthead
\\toprule
${head}
\\midrule
\\endhead
\\bottomrule
\\endfoot
${body}
\\end{longtable}
`
				: comment +
					`\\begin{table}[htbp]
\\centering
\\begin{tabularx}{\\textwidth}{X ${'r '.repeat(cols.length).trim()}}
\\toprule
${head}
\\midrule
${body}
\\bottomrule
\\end{tabularx}
\\caption{${caption}}
\\label{${label}}
\\end{table}
`;
		return {
			tex,
			name: `metrics_${short(activeOnt)}_${scope}`,
			info: `${keys.length} metrics × ${cols.length} columns`
		};
	};
	/**
	 * "Export LaTeX" button of the metrics card: downloads the .tex built by metricsTex.
	 * Side effects: browser download via downloadText; status message in #xinfo.
	 */
	$('#xtex').onclick = () => {
		const t = metricsTex();
		if (!t) return;
		downloadText(t.name + '.tex', t.tex);
		$('#xinfo').textContent = `LaTeX: ${t.info} (requires \\usepackage{tabularx,booktabs})`;
	};
	/**
	 * "Export PDF" button of the metrics card: compiles the LaTeX of metricsTex server-side and
	 * downloads the PDF.
	 * Side effects: POST /api/pdf {tex, name}; status / error message in #xinfo; browser download.
	 */
	$('#xpdf').onclick = async () => {
		const t = metricsTex();
		if (!t) return;
		$('#xinfo').textContent = 'compiling pdflatex…';
		const r = await fetch('/api/pdf', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ tex: t.tex, name: t.name })
		});
		if (!r.ok) {
			const e = await r.json().catch(() => ({ error: r.statusText }));
			$('#xinfo').textContent = 'PDF: ' + e.error;
			return;
		}
		const a = document.createElement('a');
		a.href = URL.createObjectURL(await r.blob());
		a.download = t.name + '.pdf';
		a.click();
		URL.revokeObjectURL(a.href);
		$('#xinfo').textContent = `PDF: ${t.info}`;
	};
}
/**
 * Tiny inline SVG pie chart (28×28 px) used in the metrics breakdown table.
 * @param {{v: number, color: string, title: string}[]} parts  slices: value, fill colour, tooltip.
 * @returns {string} SVG markup; a grey disc when the total is 0, a full disc when one slice is 100%.
 */
function pieSVG(parts) {
	const tot = parts.reduce((a, p) => a + p.v, 0),
		r = 12,
		cx = 14,
		cy = 14;
	if (!tot)
		return `<svg width="28" height="28"><circle cx="${cx}" cy="${cy}" r="${r}" fill="#e9ecef"/><title>0</title></svg>`;
	// slices drawn clockwise starting at 12 o'clock (angle -π/2); each slice is an arc path from the centre
	let a0 = -Math.PI / 2,
		out = '';
	parts.forEach((p) => {
		if (!p.v) return;
		if (p.v === tot) {
			out += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${p.color}"><title>${esc(p.title)}</title></circle>`;
			return;
		}
		// large-arc flag set when the slice exceeds half the pie
		const a1 = a0 + (2 * Math.PI * p.v) / tot,
			large = a1 - a0 > Math.PI ? 1 : 0;
		const x0 = cx + r * Math.cos(a0),
			y0 = cy + r * Math.sin(a0),
			x1 = cx + r * Math.cos(a1),
			y1 = cy + r * Math.sin(a1);
		out += `<path d="M${cx} ${cy} L${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z" fill="${p.color}" stroke="#fff" stroke-width=".6"><title>${esc(p.title)}</title></path>`;
		a0 = a1;
	});
	return `<svg width="28" height="28" style="vertical-align:middle">${out}</svg>`;
}
// the Ontology info tab is the one shown at start-up: draw it as soon as this script is parsed
renderOntology();
