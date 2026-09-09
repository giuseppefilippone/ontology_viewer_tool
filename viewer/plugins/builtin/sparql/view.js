// Built-in view "SPARQL" — self-contained package (delete this folder to remove the view).
// Shared helpers come from the kit bundle (static/js): see PLUGINS.md.

// ---------- SPARQL ----------
const SPARQL_EXAMPLES = [
	['Types of a territorial snapshot', 'SELECT ?type WHERE { terr:Albania_2020 a ?type }'],
	[
		'Poverty rate by snapshot (2020)',
		'SELECT ?s ?v WHERE { ?s dp:povertyRate ?v ; dp:referenceYear 2020 } ORDER BY DESC(?v) LIMIT 50'
	],
	[
		'Instances per class',
		'SELECT ?c (COUNT(?x) AS ?n) WHERE { ?c a owl:Class . ?x a ?c } GROUP BY ?c ORDER BY DESC(?n)'
	],
	[
		'Observations of an indicator for a country',
		'SELECT ?obs ?year ?value WHERE { ?obs op:refersToIndicator ind:Indicator_1.1.1_\\(a\\) ; op:hasLocation ind:Albania ; dp:hasYear ?year ; dp:hasValue ?value } ORDER BY ?year'
	],
	[
		'Fuzzy classes and their labels',
		'SELECT ?c ?fl WHERE { ?c sdf:fuzzyLabel ?fl }'
	],
	['Subclass hierarchy', 'SELECT ?sub ?super WHERE { ?sub rdfs:subClassOf ?super . ?super a owl:Class } LIMIT 200']
];
function renderSparql() {
	const box = $('#tab-sparql');
	if (box.dataset.ready) return;
	box.dataset.ready = '1';
	box.innerHTML = `<div class="card" style="max-width:none"><h2>SPARQL <span class="dt" style="font-weight:400">— queries run on the whole import closure through the SQLite index (rdflib store)</span></h2>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px"><span class="dt">Examples</span><select id="spex" onchange="if(this.value)$('#spq').value=SPARQL_EXAMPLES[this.value][1]"><option value="">—</option>${SPARQL_EXAMPLES.map((e, i) => `<option value="${i}">${esc(e[0])}</option>`).join('')}</select>
      <span class="dt">Prefixes (implicit): sdf: cls: op: dp: dt: ind: terr: owl: rdf: rdfs: xsd:</span></div>
    <textarea id="spq" rows="7" style="width:100%;margin-top:8px;font-family:ui-monospace,Menlo,monospace">${esc(SPARQL_EXAMPLES[1][1])}</textarea>
    <div style="display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap"><button class="ibtn primary" style="margin:0" onclick="runSparql()" title="Run the SPARQL query on the whole import closure (SQLite index) with the row limit and timeout beside">${ic('play')} Execute</button>
      <span class="dt">Row limit</span><select id="splimit"><option>100</option><option selected>1000</option><option>10000</option></select><span class="dt">Timeout</span><select id="sptimeout"><option>60</option><option selected>120</option><option>600</option></select>
      <button class="ibtn" style="margin:0" onclick="sparqlCsv()" title="Download the result table of the last query as a CSV file">${ic('download')} CSV</button><span class="dt" id="spinfo"></span></div>
    <div id="spres" style="margin-top:10px;overflow:auto"><div class="hint">Press <b>Run</b> to execute the query on the whole closure: the result table appears here (CSV export available).</div></div></div>`;
	attachAutocomplete($('#spq'), {
		sparql: true,
		keywords: false,
		statics: [
			'SELECT',
			'WHERE',
			'FILTER',
			'ORDER BY',
			'GROUP BY',
			'LIMIT',
			'OPTIONAL',
			'DISTINCT',
			'COUNT',
			'ASK',
			'CONSTRUCT',
			'a'
		]
	});
}
let spData = null;
function runSparql() {
	const q = $('#spq').value;
	$('#spinfo').textContent = 'running…';
	$('#spres').innerHTML = '';
	post('/api/sparql', { query: q, limit: +$('#splimit').value, timeout: +$('#sptimeout').value }).then((d) => {
		spData = d;
		if (d.error) {
			$('#spinfo').textContent = 'error: ' + d.error;
			$('#spres').innerHTML = d.log ? `<pre class="expr">${esc(d.log)}</pre>` : '';
			return;
		}
		if (d.type === 'ASK') {
			$('#spinfo').textContent = `${d.seconds}s`;
			$('#spres').innerHTML = `<div class="expr">ASK → ${d.result}</div>`;
			return;
		}
		$('#spinfo').textContent =
			`${d.rows.length.toLocaleString('en')} rows${d.truncated ? ' (truncated)' : ''} in ${d.seconds}s`;
		const cell = (v) =>
			v.startsWith('http')
				? `<span class="expand" title="${esc(v)}" onclick="openEntity('${esc(v)}')">${esc(short(v))}</span>`
				: esc(v);
		$('#spres').innerHTML =
			`<table class="props"><tr>${d.vars.map((v) => `<td class="dt" style="font-weight:600">?${esc(v)}</td>`).join('')}</tr>${d.rows.map((r) => `<tr>${r.map((v) => `<td>${cell(v)}</td>`).join('')}</tr>`).join('')}</table>`;
	});
}
function sparqlCsv() {
	const d = spData;
	if (!d || !d.rows) return;
	const q = (s) => (/[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
	downloadText(
		'sparql.csv',
		[d.vars.join(','), ...d.rows.map((r) => r.map(q).join(','))].join('\n'),
		'text/csv;charset=utf-8'
	);
}

registerView({
	id: 'sparql',
	title: 'SPARQL',
	tooltip: 'Run SPARQL queries on the whole import closure through the SQLite index',
	render: () => renderSparql(),
});
