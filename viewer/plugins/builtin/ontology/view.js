// Built-in view "Ontology info" — self-contained package (delete this folder to remove the view).
// Shared helpers come from the kit bundle (static/js): see PLUGINS.md.

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
      <label for="ofzl" title="Local name of the annotation property that marks fuzzy entities (the Fuzzy OWL 2 owlAnnotationLabel). Empty = classical crisp ontology. Fuzziness also propagates through owl:equivalentClass / owl:equivalentProperty to the equivalent entities.">Fuzzy annotation</label>
      <input id="ofzl" value="${esc(uiConfig.fuzzy_label === undefined ? 'fuzzyLabel' : uiConfig.fuzzy_label)}" placeholder="empty = crisp ontology" spellcheck="false" autocomplete="off" onkeydown="if(event.key==='Enter')this.blur()" onchange="ontSetFuzzyLabel(this.value.trim())">
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
	/** Save the fuzzy annotation label (viewer setting, data/ui_config.json) and reload: fuzziness is recomputed everywhere. */
	window.ontSetFuzzyLabel = (name) => {
		if (name === (uiConfig.fuzzy_label === undefined ? 'fuzzyLabel' : uiConfig.fuzzy_label)) return;
		post('/api/ui_config', { fuzzy_label: name }).then(() => location.reload());
	};
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
	// autocomplete of the Fuzzy annotation field — the standard widget of the app
	// (attachAutocomplete), fed with the local names of the annotation properties of the
	// closure of the active ontology (declared ones plus the OWL 2 / RDFS built-ins)
	api('/api/list', { kind: 'annprop', graph: closure.map((i) => by[i]?.file).filter(Boolean).join(',') }).then((r) => {
		const names = [...new Set((r.items || []).map((n) => short(n.iri)))].sort((a, b) => a.localeCompare(b));
		attachAutocomplete($('#ofzl'), { single: true, entities: false, keywords: false, statics: names });
	});
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
		downloadText(`metrics_${short(activeOnt)}_${scope}.csv`, '' + lines.join('\r\n'), 'text/csv;charset=utf-8');
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

registerView({
	id: 'ontology',
	title: 'Ontology info',
	tooltip: 'Header, imports, prefixes and metrics of the active ontology (CSV / LaTeX / PDF export)',
	render: () => renderOntology(),
});
