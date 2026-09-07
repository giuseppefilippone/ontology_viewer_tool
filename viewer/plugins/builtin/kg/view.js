// Built-in view "Knowledge graph" — self-contained package (delete this folder to remove the view).
// Shared helpers come from the kit bundle (static/js): see PLUGINS.md.

// ---------- Knowledge graph of individuals ----------
let kgState = {
	kg: true,
	svg: '#kgsvg',
	count: '#kgcount',
	mode: 'force',
	focus: '',
	hops: 1,
	data: null,
	show: { objprop: true, labels: true, edgeLabels: true },
	pos: {},
	view: { x: 0, y: 0, k: 1 },
	drag: null,
	start: '',
	cls: '',
	depth: 2,
	limit: 150
};
function renderKg() {
	const box = $('#tab-kg');
	if (box.dataset.ready) {
		return;
	}
	box.dataset.ready = '1';
	const cb = (k, l) =>
		`<label class="chk"><input type="checkbox" ${kgState.show[k] ? 'checked' : ''} onchange="kgState.show['${k}']=this.checked;drawGraph(kgState)"> ${l}</label>`;
	box.innerHTML = `<div class="card" style="max-width:none"><h2>Knowledge graph of individuals <span class="count" id="kgcount"></span></h2>
    <div class="gbar">
      <div class="ggroup"><div class="gcap">Scope</div><div class="grow"><select id="kgscope" onchange="kgState.whole=this.value"><option value="">neighbourhood of a start node</option><option value="active">whole graph: active ontology (first N individuals)</option><option value="closure">whole graph: closure (first N individuals)</option></select></div></div>
      <div class="ggroup"><div class="gcap">Start individual</div><div class="grow"><div class="picker"><input id="kgstart" placeholder="search individual…" style="width:220px"><div class="res"></div></div></div></div>
      <div class="ggroup"><div class="gcap">or class (sample)</div><div class="grow"><div class="picker"><input id="kgcls" placeholder="search class…" style="width:190px"><div class="res"></div></div></div></div>
      <div class="ggroup"><div class="gcap">Depth</div><div class="grow"><select id="kgdepth" onchange="kgState.depth=+this.value" title="BFS depth from the start; 'component' follows the assertions until the connected component is exhausted (bounded by Max nodes)"><option value="1">1</option><option value="2" selected>2</option><option value="3">3</option><option value="4">4</option><option value="99">connected component</option></select></div></div>
      <div class="ggroup"><div class="gcap">Max nodes</div><div class="grow"><select id="kglimit" onchange="kgState.limit=+this.value"><option>60</option><option selected>150</option><option>300</option><option>600</option><option>1500</option><option>3000</option></select></div></div>
      <div class="ggroup"><div class="gcap">&nbsp;</div><div class="grow"><button class="btn primary" onclick="loadKg()" title="Load the graph: the neighbourhood of the start individual (or a sample of the class) up to the chosen depth and number of nodes">${ic('play')} Load</button></div></div>
      <div class="gsep"></div>
      <div class="ggroup"><div class="gcap">Layout</div><div class="grow"><select onchange="kgState.mode=this.value;layoutGraph(kgState);fitGraph(kgState);drawGraph(kgState)"><option value="force">Force-directed</option><option value="radial">Radial (by distance from start)</option><option value="hierarchy">Layers (by distance)</option><option value="circle">Circular</option><option value="grid">Grid (alphabetical)</option></select>
<label class="chk"><input type="checkbox" onchange="kgState.uml=this.checked;layoutGraph(kgState);fitGraph(kgState);drawGraph(kgState)"> boxes with types</label></div></div>
      <div class="ggroup"><div class="gcap">Labels</div><div class="grow">${cb('labels', 'nodes')} ${cb('edgeLabels', 'edges')}</div></div>
      <div class="gsep"></div>
      ${graphActionsHtml('kgState')}
    </div>
    <div class="dt" style="margin-top:6px">Nodes = individuals (colour by distance from the start: <span style="color:#b3552b">●</span> start, <span style="color:#3457b0">●</span> 1, <span style="color:#2a9d8f">●</span> 2, <span style="color:#8a6d1a">●</span> 3), edges = object property assertions (both directions, labelled). Hover a node for its types; click to open it. The ABox has 400k individuals: the graph is a neighbourhood or a sample, not the whole ABox.</div>
    <div id="kghint" class="hint" style="margin-top:10px">Pick a <b>start individual</b> (or a class to sample from), choose depth and size, then press <b>Load</b>. Drag nodes, wheel to zoom, click a node to open it.</div>
    <div style="margin-top:10px;border:1px solid var(--line);border-radius:6px;background:var(--panel);height:70vh;overflow:hidden;position:relative"><svg id="kgsvg" width="100%" height="100%" style="display:block;cursor:grab"></svg></div></div>`;
	const clear = (el) => {
		el.value = '';
		el.dataset.iri = '';
		el.title = '';
	};
	bindPicker($('#kgstart'), 'individual', (iri) => {
		kgState.start = iri;
		kgState.cls = '';
		clear($('#kgcls'));
		$('#kgscope').value = '';
		kgState.whole = '';
		loadKg();
	});
	bindPicker($('#kgcls'), 'class', (iri) => {
		kgState.cls = iri;
		kgState.start = '';
		clear($('#kgstart'));
		$('#kgscope').value = '';
		kgState.whole = '';
		loadKg();
	});
	// the field edited last wins: typing in one clears the other; Enter loads (typed names are resolved by name)
	[
		['#kgstart', '#kgcls'],
		['#kgcls', '#kgstart']
	].forEach(([a, b]) => {
		$(a).addEventListener('input', () => {
			if ($(a).value.trim()) {
				clear($(b));
				kgState.start = kgState.cls = '';
			}
		});
		$(a).addEventListener('keydown', (e) => {
			if (e.key === 'Enter') loadKg();
		});
	});
	bindGraphEvents($('#kgsvg'), kgState);
	if (selIri && curEntity && curEntity.d.node.kind === 'individual') {
		kgState.start = selIri;
		$('#kgstart').value = short(selIri);
		$('#kgstart').dataset.iri = selIri;
		loadKg();
	}
}
function resolveName(el, kind) {
	// IRI of a picker/text field: picked IRI, pasted IRI, or exact local name lookup
	const v = el.value.trim();
	if (!v) return Promise.resolve('');
	if (el.dataset.iri && short(el.dataset.iri) === v) return Promise.resolve(el.dataset.iri);
	if (v.startsWith('http')) return Promise.resolve(v);
	return api('/api/search', { q: v }).then((d) => {
		const hit =
			d.items.find((n) => n.kind === kind && n.name === v) ||
			d.items.find((n) => n.kind === kind && n.name.toLowerCase() === v.toLowerCase());
		if (hit) {
			el.dataset.iri = hit.iri;
			el.title = hit.iri;
			return hit.iri;
		}
		return '';
	});
}
async function loadKg() {
	$('#kghint')?.remove(); // first load: drop the placeholder text
	const st = $('#kgstart'),
		cl = $('#kgcls');
	const whole = kgState.whole === 'active' ? fdlFile() || '' : kgState.whole === 'closure' ? 'closure' : '';
	const start = whole ? '' : await resolveName(st, 'individual'),
		cls = whole || start ? '' : await resolveName(cl, 'class');
	if (!whole && !start && !cls) {
		$('#kgcount').textContent =
			st.value.trim() || cl.value.trim()
				? '— unknown name: pick it from the suggestions'
				: '— choose a start individual or a class (or a whole-graph scope)';
		return;
	}
	kgState.start = start;
	kgState.cls = cls;
	$('#kgcount').textContent = '— loading…';
	const params = whole
		? { whole, limit: kgState.limit }
		: start
			? { iri: start, depth: kgState.depth, limit: kgState.limit }
			: { cls, depth: kgState.depth, limit: kgState.limit };
	api('/api/kg', params).then((d) => {
		if (d.error) {
			$('#kgcount').textContent = '— ' + d.error;
			return;
		}
		d.edges.forEach((e) => (e.type = 'objprop'));
		d.graph = whole ? 'kg_' + whole.replace(/\.owl$/, '') : 'kg';
		kgState.data = d;
		kgState.pos = {};
		layoutGraph(kgState);
		fitGraph(kgState);
		drawGraph(kgState);
		$('#kgcount').textContent =
			`— ${d.nodes.length} individuals, ${d.edges.length} assertions${d.total_individuals != null ? ` (of ${d.total_individuals.toLocaleString('en')} in ${whole === 'closure' ? 'the closure' : whole}; edges among the shown individuals only)` : d.truncated ? ' (truncated: raise Max nodes)' : ''}`;
	});
}

registerView({
	id: 'kg',
	title: 'Knowledge graph',
	tooltip: 'Draw individuals and their object property assertions: neighbourhood of a start individual or a sample of a class',
	render: () => renderKg(),
});
