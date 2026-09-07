// Built-in view "DL Query" — self-contained package (delete this folder to remove the view).
// Shared helpers come from the kit bundle (static/js): see PLUGINS.md.

// ---------- DL Query ----------
function renderDlQuery() {
	const box = $('#tab-dlquery');
	if (box.dataset.ready) return;
	box.dataset.ready = '1';
	const cb = (k, l, on) =>
		`<label style="display:block;font-size:13px;margin:3px 0"><input type="checkbox" class="dlw" value="${k}" ${on ? 'checked' : ''}> ${l}</label>`;
	box.innerHTML = `<div class="card" style="max-width:none"><h2>DL Query</h2>
    <div style="display:flex;gap:18px;margin-top:8px">
      <div style="flex:1;min-width:0">
<div class="ptitle" style="margin-top:0">Query (class expression, Manchester syntax)</div>
<textarea id="dlq" rows="3" style="width:100%;font-family:ui-monospace,Menlo,monospace" placeholder="TerritorialSystem and (povertyRate some LowPoverty)"></textarea>
<div class="dt" style="margin:4px 0 8px">${MANCHESTER_HINT}</div>
<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
  <button class="ibtn primary" style="margin:0" onclick="runDlQuery()" title="Run the class expression (⌘/Ctrl+Enter): asserted mode answers from the index, reasoner mode classifies the schema with HermiT">${ic('play')} Execute</button>
  <button class="ibtn" style="margin:0" onclick="dlAddToOntology()" title="Add the expression to a module as a new defined class (equivalentClass axiom) with the name you choose">${ic('add')} Add to ontology</button>
  <span class="dt">Mode</span><select id="dlmode"><option value="asserted">Asserted (index: subclass closure, instances)</option><option value="reasoner">HermiT reasoner (schema modules; instances from the index)</option></select>
  <span class="dt" id="dlinfo"></span></div>
<div id="dlres" style="margin-top:12px"><div class="hint">Type a class expression above and press <b>Execute</b> — for example <span class="expand" onclick="$('#dlq').value='TerritorialSystem and (povertyRate some LowPoverty)'">TerritorialSystem and (povertyRate some LowPoverty)</span> or <span class="expand" onclick="$('#dlq').value='hasCapital some City'">hasCapital some City</span>. Results (subclasses, instances…) appear here.</div></div></div>
      <div style="width:230px;flex-shrink:0"><div class="ptitle" style="margin-top:0">Query for</div>
${cb('direct_superclasses', 'Direct superclasses')}${cb('superclasses', 'Superclasses')}${cb('equivalent', 'Equivalent classes')}${cb('direct_subclasses', 'Direct subclasses')}${cb('subclasses', 'Subclasses', true)}${cb('instances', 'Instances')}
<div class="ptitle">Result filters</div><input id="dlfilter" placeholder="name contains…" style="width:100%" oninput="drawDlResults()">
<label style="display:block;font-size:13px;margin-top:6px"><input type="checkbox" id="dlthing" checked> Display owl:Thing (in superclass results)</label>
<label style="display:block;font-size:13px"><input type="checkbox" id="dlnothing" checked> Display owl:Nothing (in subclass results)</label></div></div></div>`;
	attachAutocomplete($('#dlq'));
	$('#dlq').addEventListener('keydown', (e) => {
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runDlQuery();
	});
}
function runDlQuery() {
	const expr = $('#dlq').value.trim();
	if (!expr) {
		$('#dlinfo').textContent = 'write a class expression';
		return;
	}
	const wants = [...document.querySelectorAll('.dlw:checked')].map((c) => c.value);
	if (!wants.length) {
		$('#dlinfo').textContent = 'choose what to query for';
		return;
	}
	$('#dlinfo').textContent = 'running…';
	$('#dlres').innerHTML = '';
	post('/api/dlquery', { expr, wants, reasoner: $('#dlmode').value === 'reasoner' }).then((d) => {
		dlData = d;
		if (d.error) {
			$('#dlinfo').textContent = 'error: ' + d.error;
			return;
		}
		$('#dlinfo').textContent =
			`${d.seconds}s · ${d.expression}${d.unsatisfiable ? ' · UNSATISFIABLE' : ''}${d.reasoner_error ? ' · reasoner error: ' + d.reasoner_error.split('\n')[0] : ''}${d.note ? ' · ' + d.note : ''}`;
		drawDlResults();
	});
}
function drawDlResults() {
	const d = dlData;
	if (!d) return;
	const f = ($('#dlfilter').value || '').toLowerCase();
	const groups = [
		['equivalent', 'Equivalent classes'],
		['direct_superclasses', 'Direct superclasses'],
		['superclasses', 'Superclasses'],
		['direct_subclasses', 'Direct subclasses'],
		['subclasses', 'Subclasses'],
		['instances', 'Instances']
	];
	const showThing = $('#dlthing').checked,
		showNothing = $('#dlnothing').checked;
	$('#dlres').innerHTML =
		groups
			.filter(([k]) => d[k])
			.map(([k, l]) => {
				let items = d[k].filter((n) => n.name.toLowerCase().includes(f));
				if (!showThing) items = items.filter((n) => n.name !== 'Thing');
				if (!showNothing) items = items.filter((n) => n.name !== 'Nothing');
				return `<div class="psec"><div class="ptitle">${l} <span class="dt" style="text-transform:none;font-weight:400">(${items.length}${k === 'instances' && d.instances_total > items.length ? ' of ' + d.instances_total.toLocaleString('en') : ''})</span></div>
<div style="columns:${k === 'instances' ? 3 : 2};column-gap:20px">${items.map((n) => `<div class="item" style="break-inside:avoid" onclick="openEntity('${esc(n.iri)}')">${dot(n.kind, n.fuzzy)}${esc(n.name)}</div>`).join('') || '<span class="dt" style="padding-left:10px">none</span>'}</div></div>`;
			})
			.join('') || '<span class="dt">no results</span>';
}
function dlAddToOntology() {
	const expr = $('#dlq').value.trim();
	if (!expr) return;
	openForm(
		'Add the query as a defined class',
		[
			{ name: 'name', label: 'Class name (local)', required: true },
			{ name: 'ns', label: 'Namespace', value: NS.class },
			{
				name: 'graph',
				label: 'Target module',
				type: 'module',
				value: (ontoData?.ontologies.find((o) => o.iri === activeOnt) || {}).file || modules[0]
			},
			{ type: 'html', html: `<label>Equivalent To</label><div class="expr">${esc(expr)}</div>` }
		],
		(v) => {
			const iri = v.ns + v.name.replace(/\s+/g, '_');
			return post('/api/edit/create', { graph: v.graph, iri, kind: 'class', label: v.name }).then((r) =>
				r.error
					? r
					: post('/api/edit/expr', {
							s: iri,
							expr,
							p: OWLNS + 'equivalentClass',
							kind: 'class',
							graph: v.graph
						})
			);
		}
	);
}

registerView({
	id: 'dlquery',
	title: 'DL Query',
	tooltip: 'Ask a class expression in Manchester syntax: super / sub / equivalent classes and instances, from the index or with HermiT',
	render: () => renderDlQuery(),
});
