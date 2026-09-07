// Built-in view "Rules" — self-contained package (delete this folder to remove the view).
// Shared helpers come from the kit bundle (static/js): see PLUGINS.md.

// ---------- SWRL rules (W3C SWRL submission, RDF/XML in the usual RDF/XML form) + fuzzy rules (Fuzzy OWL 2 degree annotation) ----------
function renderRules() {
	const box = $('#tab-rules');
	if (!box.dataset.ready) {
		box.dataset.ready = '1';
		box.innerHTML = `<div class="card" style="max-width:none"><h2>Rules <span class="count" id="rulecount"></span></h2>
      <div class="dt" style="margin-top:4px">SWRL rules of the workspace modules (<code>swrl:Imp</code> with body/head atoms). Syntax: <code>Class(?x) ^ prop(?x, ?y) ^ dataProp(?x, ?v) ^ swrlb:greaterThan(?v, 30) -> Class2(?x)</code>. A <b>fuzzy rule</b> carries a degree in [0,1] as a <code>fuzzyLabel</code> Degree annotation on the rule (Fuzzy OWL 2 axiom style). Note: the FuzzyDL reasoner (fuzzy_dl_owl2) does not evaluate rules; HermiT/Pellet do (DL-safe rules).</div>
      <div class="sect"><h3>Try a rule (without adding it to the ontology)</h3>
<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px"><span class="dt">Examples</span><select id="ruleex" onchange="if(this.value!=='')$('#ruletext').value=RULE_EXAMPLES[this.value][1]"><option value="">—</option>${RULE_EXAMPLES.map((e, i) => `<option value="${i}">${esc(e[0])}</option>`).join('')}</select></div>
<textarea id="ruletext" rows="3" style="width:100%;font-family:ui-monospace,Menlo,monospace" placeholder="TerritorialSystem(?t) ^ povertyRate(?t, ?v) ^ swrlb:greaterThan(?v, 30) -> TerritoryWithHighPoverty(?t)"></textarea>
<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px">
  <button class="ibtn primary" style="margin:0" onclick="runRule()" title="Evaluate the rule without saving it: on the indexed ABox, or with Pellet / HermiT on the schema plus the chosen individuals">${ic('play')} Run</button>
  <span class="dt">Engine</span><select id="rulemode"><option value="index">Asserted data (whole ABox, index)</option><option value="pellet">Pellet reasoner (schema + chosen individuals)</option><option value="hermit">HermiT reasoner (schema + chosen individuals; no swrlb built-ins)</option></select>
  <span class="dt">Individuals (reasoner engines)</span><div class="picker" style="display:inline-block"><input id="ruleind" placeholder="add individual…" style="width:220px"><div class="res"></div></div><span id="ruleinds" class="dt"></span>
  <span class="dt">Max facts</span><select id="rulelimit"><option>100</option><option selected>500</option><option>5000</option></select>
  <button class="ibtn" style="margin:0" onclick="ruleForm($('#ruletext').value)" title="Open the form to add the rule text above to a module as a SWRL rule (optional name, comment and fuzzy degree)">${ic('add')} Add this rule to the ontology</button>
  <span class="dt" id="ruleinfo"></span></div>
<div id="ruleres" style="margin-top:8px"><div class="hint">Pick an example from the list or write a rule, then press <b>Run</b>: the bindings and the derived facts appear here (nothing is added to the ontology unless you use "Add this rule").</div></div></div>
      <div class="sect"><h3>Rules in the workspace <button class="ibtn" onclick="ruleForm()" title="Write a new SWRL rule and add it to a module (optional name, comment and fuzzy degree)">${ic('add')} Add rule</button>
<button class="ibtn" onclick="exportRulesCsv()" title="Download the listed rules (name, module, degree, comment, text) as a CSV file">${ic('download')} CSV</button>
<button class="ibtn" onclick="exportRulesLatex()" title="Download the listed rules as a LaTeX longtable">${ic('download')} LaTeX</button>
<button class="ibtn" onclick="exportRulesPdf()" title="Compile the LaTeX longtable of the listed rules with pdflatex and download the PDF">${ic('download')} PDF</button></h3><div id="rulelist"><span class="dt">loading…</span></div></div></div>`;
		attachAutocomplete($('#ruletext'), {
			keywords: false,
			statics: [
				'swrlb:greaterThan',
				'swrlb:lessThan',
				'swrlb:greaterThanOrEqual',
				'swrlb:lessThanOrEqual',
				'swrlb:equal',
				'swrlb:notEqual',
				'swrlb:add',
				'swrlb:subtract',
				'swrlb:multiply',
				'swrlb:divide',
				'sameAs',
				'differentFrom',
				'->',
				'^'
			]
		});
		window._ruleInds = [];
		bindPicker($('#ruleind'), 'individual', (iri, name) => {
			if (!window._ruleInds.includes(iri)) window._ruleInds.push(iri);
			$('#ruleind').value = '';
			$('#ruleinds').innerHTML = window._ruleInds
				.map(
					(i) =>
						`<span class="badge" style="background:#8b4c9e">${esc(short(i))} <span style="cursor:pointer" onclick="window._ruleInds=window._ruleInds.filter(x=>x!=='${esc(i)}');this.parentNode.remove()">✕</span></span>`
				)
				.join(' ');
		});
	}
	api('/api/rules', {}).then((d) => {
		RULES = d.rules; // kept for the CSV / LaTeX / PDF exports
		$('#rulecount').textContent = `— ${d.rules.length} rule(s)` + (d.error ? ' · ' + d.error : '');
		$('#rulelist').innerHTML =
			d.rules
				.map(
					(
						r
					) => `<div class="prow"><div class="val"><b>${esc(r.label || short(r.iri) || '(anonymous rule)')}</b>${r.degree ? ` <span class="badge" style="background:#7a4bb3">degree ${esc(r.degree)}</span>` : ''} <span class="dt">[${esc(r.module)}]</span><div class="expr" style="margin-top:3px">${esc(r.text)}</div>${r.comment ? `<div class="dt">${esc(r.comment)}</div>` : ''}</div>
<span class="acts">${r.iri ? `<span class="act del" title="Remove rule (on Save the whole block is deleted from the file)" onclick="removeRule('${esc(r.iri)}','${esc(r.module)}')">${ICON.del}</span>` : '<span class="dt" title="anonymous rule (rdf:nodeID): remove it in the file">bnode</span>'}</span></div>`
				)
				.join('') || '<span class="dt">no rules in the workspace</span>';
	});
}
function ruleForm(prefill) {
	openForm(
		'Add SWRL rule',
		[
			{
				name: 'text',
				label: 'Rule (body -> head)',
				type: 'textarea',
				required: true,
				value: prefill || '',
				placeholder:
					'TerritorialSystem(?t) ^ povertyRate(?t, ?v) ^ swrlb:greaterThan(?v, 30) -> TerritoryWithHighPoverty(?t)'
			},
			{ name: 'label', label: 'Name / label' },
			{ name: 'comment', label: 'Comment' },
			{ name: 'degree', label: 'Fuzzy degree in [0,1] (empty = crisp rule)' },
			{
				name: 'graph',
				label: 'Target module',
				type: 'module',
				value: (ontoData?.ontologies.find((o) => o.iri === activeOnt) || {}).file || modules[0]
			}
		],
		(v) =>
			post('/api/rules/add', {
				text: v.text,
				label: v.label,
				comment: v.comment,
				degree: v.degree,
				graph: v.graph
			}).then((r) => {
				if (!r.error) {
					$('#tab-rules').dataset.ready = '';
					renderRules();
				}
				return r;
			}),
		'Atoms: C(?x), p(?x, ?y), sameAs(?x, ?y), differentFrom(?x, ?y), swrlb:builtin(args…); arguments: variables ?x, individuals, literals ("text", 12, 1.5, true). Names are the local names of the workspace entities. The rule becomes visible in the list after Save (it is written to the module file).'
	);
	setTimeout(() => {
		const ta = $('#modalbox textarea[name=text]');
		if (ta) {
			const w = document.createElement('div');
			ta.parentNode.insertBefore(w, ta);
			w.appendChild(ta);
			attachAutocomplete(ta);
		}
	}, 0);
}
function removeRule(iri, graph) {
	if (!confirm('Remove the rule ' + short(iri) + ' from ' + graph + '? (applied on Save)')) return;
	post('/api/rules/remove', { iri, graph }).then((r) => {
		if (r.error) alert(r.error);
		refreshChanges();
		$('#tab-rules').dataset.ready = '';
		renderRules();
	});
}
// ---------- Rules exports (CSV / LaTeX / PDF) ----------
/** Rules of the last /api/rules load, kept for the exports. */
let RULES = [];
/** "CSV" button of the Rules tab: name, module, degree, comment, rule text. @returns {void} */
function exportRulesCsv() {
	downloadText(
		'rules.csv',
		'name,module,degree,comment,rule\n' +
			RULES.map((r) => [r.label || short(r.iri) || '', r.module, r.degree || '', r.comment || '', r.text].map(csvq).join(',')).join('\n'),
		'text/csv;charset=utf-8'
	);
}
/**
 * LaTeX longtable of the listed SWRL rules (shared by the LaTeX and PDF exports).
 * @returns {{tex: string, name: string}|null} null when no rules are loaded.
 */
function rulesTex() {
	if (!RULES.length) return null;
	const body = RULES.map(
		(r) => `${texEsc(r.label || short(r.iri) || '')} & ${texEsc(r.module)} & ${texEsc(r.degree || '')} & \\texttt{${texEsc(r.text)}} \\\\`
	).join('\n');
	const tex = `% SWRL rules of the workspace (Ontology Viewer export)
% packages: longtable, booktabs
\\begin{longtable}{l l l p{0.55\\textwidth}}
\\caption{SWRL rules of the workspace.}\\label{tab:swrl-rules}\\\\
\\toprule
\\textbf{Rule} & \\textbf{Module} & \\textbf{Degree} & \\textbf{Body $\\rightarrow$ head} \\\\
\\midrule
\\endfirsthead
\\toprule
\\textbf{Rule} & \\textbf{Module} & \\textbf{Degree} & \\textbf{Body $\\rightarrow$ head} \\\\
\\midrule
\\endhead
${body}
\\bottomrule
\\end{longtable}
`;
	return { tex, name: 'rules' };
}
/** "LaTeX" button of the Rules tab. @returns {void} */
function exportRulesLatex() {
	const t = rulesTex();
	if (t) downloadText(t.name + '.tex', t.tex);
}
/** "PDF" button of the Rules tab: compile the longtable with pdflatex (POST /api/pdf). @returns {Promise<void>} */
async function exportRulesPdf() {
	const t = rulesTex();
	if (!t) return;
	const r = await fetch('/api/pdf', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ tex: t.tex, name: t.name })
	});
	if (!r.ok) {
		const e = await r.json().catch(() => ({ error: r.statusText }));
		alert('PDF: ' + e.error);
		return;
	}
	const a = document.createElement('a');
	a.href = URL.createObjectURL(await r.blob());
	a.download = t.name + '.pdf';
	a.click();
}

registerView({
	id: 'rules',
	title: 'Rules',
	tooltip: 'SWRL and fuzzy rules of the workspace: try a rule on the data, add rules to a module',
	render: () => renderRules(),
});
