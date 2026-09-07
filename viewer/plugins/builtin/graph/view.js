// Built-in view "Graph" — self-contained package (delete this folder to remove the view).
// The shared graph ENGINE (state, layout, drawing, exports) is the graphs.js kit.

const GMODES = [
	['hierarchy', 'Hierarchy (layers by subClassOf, top-down)'],
	['radial', 'Radial (subClassOf depth on concentric rings)'],
	['force', 'Force-directed'],
	['circle', 'Circular (nodes on a ring, edges as chords)'],
	['grid', 'Grid (alphabetical, by module)']
];
function renderGraph() {
	ensureOnto(() => {
		const box = $('#tab-graph');
		if (!box.dataset.ready) {
			box.dataset.ready = '1';
			const cb = (k, l) =>
				`<label class="chk"><input type="checkbox" ${gState.show[k] ? 'checked' : ''} onchange="gState.show['${k}']=this.checked;drawGraph()"> ${l}</label>`;
			box.innerHTML = `<div class="card" style="max-width:none">
      <h2>Ontology graph <span class="count" id="gcount"></span></h2>
      <div class="gbar">
<div class="ggroup"><div class="gcap">Scope</div><div class="grow"><select id="gscope" onchange="gState.scope=this.value;loadGraph()"><option value="active">active ontology</option><option value="closure">closure (all modules)</option></select></div></div>
<div class="ggroup"><div class="gcap">Layout</div><div class="grow"><select id="gmode" onchange="gState.mode=this.value;layoutGraph();fitGraph();drawGraph()">${GMODES.map(([k, l]) => `<option value="${k}" ${k === gState.mode ? 'selected' : ''}>${l}</option>`).join('')}</select>
  <label class="chk"><input type="checkbox" ${gState.uml ? 'checked' : ''} onchange="gState.uml=this.checked;layoutGraph();fitGraph();drawGraph()"> UML class boxes</label></div></div>
<div class="gsep"></div>
<div class="ggroup"><div class="gcap">Focus (subgraph from a node)</div><div class="grow"><div class="picker"><input id="gfocus" placeholder="class name…" style="width:210px" oninput="clearTimeout(window._gfT);window._gfT=setTimeout(()=>{gState.focus=this.value.trim();layoutGraph();fitGraph();drawGraph();},300)"><div class="res"></div></div>
  <select id="ghops" onchange="gState.hops=+this.value;layoutGraph();fitGraph();drawGraph()" title="subgraph reachable from the focus node"><option value="1">1 hop</option><option value="2" selected>2 hops</option><option value="3">3 hops</option><option value="999">connected component</option></select></div></div>
<div class="gsep"></div>
<div class="ggroup"><div class="gcap">Edges</div><div class="grow">${cb('subClassOf', 'subClassOf')} ${cb('equivalentClass', 'equivalentClass')} ${cb('disjointWith', 'disjointWith')} ${cb('objprop', 'object properties')} ${cb('dataprop', 'data properties')}</div></div>
<div class="ggroup"><div class="gcap">Labels</div><div class="grow">${cb('labels', 'nodes')} ${cb('edgeLabels', 'edges')}</div></div>
<div class="gsep"></div>
${graphActionsHtml('')}
      </div>
      <div class="dt legend" style="margin-top:6px">Legend: ${dot('class', true)} fuzzy class · ${dot('class')} class · <span style="color:${GCOL.datatype}">■</span> datatype · edges: <span style="color:${GCOL.subClassOf}">— subClassOf</span> · <span style="color:${GCOL.equivalentClass}">– – equivalentClass</span> · <span style="color:${GCOL.disjointWith}">· · disjointWith</span> · <span style="color:${GCOL.objprop}">→ object property</span> · <span style="color:${GCOL.dataprop}">→ data property</span>. UML boxes: name, <span style="color:#00796B">= equivalent</span>, attributes (data properties with range, {func}), <span style="color:#512DA8">⊑/≡ anonymous restrictions</span>; <span style="color:#3F51B5">▷ generalization</span>, labelled associations, {disjoint} dashed. Drag nodes, wheel to zoom, drag the background to pan, click a node to open it.</div>
      <div id="gwrap" style="margin-top:10px;border:1px solid var(--line);border-radius:6px;background:var(--panel);height:72vh;overflow:hidden;position:relative"><svg id="gsvg" width="100%" height="100%" style="display:block;cursor:grab"></svg></div></div>`;
			bindGraphEvents($('#gsvg'), gState);
			bindPicker($('#gfocus'), '', (iri, name) => {
				gState.focus = name;
				layoutGraph();
				fitGraph();
				drawGraph();
			}); // autocomplete on the entities of the closure
		}
		loadGraph();
	});
}
function bindGraphEvents(svg, S) {
	svg.addEventListener(
		'wheel',
		(e) => {
			e.preventDefault();
			const r = svg.getBoundingClientRect(),
				mx = e.clientX - r.left,
				my = e.clientY - r.top,
				v = S.view,
				f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
			v.x = mx - (mx - v.x) * f;
			v.y = my - (my - v.y) * f;
			v.k *= f;
			drawGraph(S);
		},
		{ passive: false }
	);
	svg.addEventListener('mousedown', (e) => {
		const n = e.target.closest('[data-node]');
		const r = svg.getBoundingClientRect();
		S.drag = {
			id: n ? n.dataset.node : null,
			x0: e.clientX,
			y0: e.clientY,
			moved: false,
			vx: S.view.x,
			vy: S.view.y,
			px: n ? S.pos[n.dataset.node].x : 0,
			py: n ? S.pos[n.dataset.node].y : 0
		};
	});
	window.addEventListener('mousemove', (e) => {
		const d = S.drag;
		if (!d) return;
		const dx = e.clientX - d.x0,
			dy = e.clientY - d.y0;
		if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
		if (d.id) {
			S.pos[d.id].x = d.px + dx / S.view.k;
			S.pos[d.id].y = d.py + dy / S.view.k;
		} else {
			S.view.x = d.vx + dx;
			S.view.y = d.vy + dy;
		}
		drawGraph(S);
	});
	window.addEventListener('mouseup', (e) => {
		const d = S.drag;
		S.drag = null;
		if (d && d.id && !d.moved) {
			const n = S.data.nodes.find((x) => String(x.id) === d.id);
			if (n) {
				document.querySelector('#maintabs [data-mt=entities]').click();
				show(encodeURIComponent(n.iri));
			}
		}
	});
}
function loadGraph() {
	const g = gState.scope === 'active' ? fdlFile() : '';
	$('#gcount').textContent = '— loading…';
	api('/api/graph', { graph: g || '' }).then((d) => {
		if (gState.scope === 'active' && !d.nodes.length) {
			// e.g. an annotation-only module: fall back to the closure
			gState.scope = 'closure';
			$('#gscope').value = 'closure';
			$('#gcount').textContent = `— ${esc(g)} declares no classes: showing the closure`;
			return loadGraph();
		}
		gState.data = d;
		gState.pos = {};
		layoutGraph();
		fitGraph();
		drawGraph();
	});
}

registerView({
	id: 'graph',
	title: 'Graph',
	tooltip: 'Draw the class graph of the schema: subclass, equivalence, disjointness and property edges, UML boxes',
	render: () => renderGraph(),
});
