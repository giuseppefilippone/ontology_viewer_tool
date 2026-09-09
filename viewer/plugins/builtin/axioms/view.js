// Built-in view "Axioms" — self-contained package (delete this folder to remove the view).
// Shared helpers come from the kit bundle (static/js): see PLUGINS.md.

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
<button class="ibtn" style="margin:0" onclick="exportAxiomsCsv()" title="Download the listed axioms (module / filter as selected) as a CSV file with the DL, fuzzy DL and FuzzyDL renderings">${ic('download')} Export CSV</button>
<button class="ibtn" style="margin:0" onclick="exportAxiomsLatex()" title="Download the listed axioms (module / notation / filter as selected) as a LaTeX longtable">${ic('download')} Export LaTeX</button>
<button class="ibtn" style="margin:0" onclick="exportAxiomsPdf()" title="Compile the LaTeX longtable of the listed axioms with pdflatex (temporary folder) and download the PDF">${ic('download')} Export PDF</button>
      </div>
      <div class="dt legend" style="margin-top:6px">Legend: ${dot('class', true)} fuzzy axiom (involves fuzzy entities or degrees) → Fuzzy DL (⟨a:C, n⟩, ⟨(a,b):R, n⟩, ⟨C ⊑ D, n⟩, ls/rs/tri/trz, m(C), w₁·C₁ + …, @op); ${dot('class')} crisp axiom → DL (C(a), r(a,b), ⊑, ≡, fun/trans). The FuzzyDL syntax is the reasoner one (.fdl export). TBox/RBox from the module file (anonymous expressions included), ABox from the index in pages of 500.</div>
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
/** "Export CSV" button: the loaded axioms (kind, fuzzy, module, DL, fuzzy DL, FuzzyDL) as CSV. @returns {void} */
function exportAxiomsCsv() {
	const d = axState.data;
	if (!d) return;
	const rows = [...d.tbox, ...d.abox.items];
	downloadText(
		`axioms_${(d.graph || 'closure').replace(/\.owl$/, '')}.csv`,
		'kind,fuzzy,module,dl,fuzzy_dl,fuzzydl_syntax\n' +
			rows.map((a) => [a.kind, a.fuzzy ? 1 : 0, a.module || '', a.dl, a.fm || '', a.fdl].map(csvq).join(',')).join('\n'),
		'text/csv;charset=utf-8'
	);
}
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
 * of the fuzzy layer, one card per kind (datatypes/modifiers, classes, properties, individuals)
 * and, inside each card, one section per sub-group (datatype shape, modifiers, fuzzy concepts,
 * bridge classes, composites). Clicking an entity opens it in the Entities tab.
 * Side effects: GET /api/fuzzy (returns {groups:{kind:[{iri,name,label,kind,fuzzyType,shape}]},
 * total}); replaces the innerHTML of #tab-fuzzy.
 */

registerView({
	id: 'axioms',
	title: 'Axioms',
	tooltip: 'List the axioms of a module or of the closure in DL, Fuzzy DL or FuzzyDL notation; export as LaTeX / PDF',
	render: () => renderAxioms(),
});
