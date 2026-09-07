// graphs.js — shared GRAPH ENGINE kit (state, layout, drawing, SVG/DOT/TikZ exports, toolbar);
// the Individuals-by-class / Knowledge-graph / Graph views live in plugins/builtin/<id>/view.js.
// Graph tab (TBox graph with several layouts and the UML view), knowledge graph of individuals, Individuals by class.

/**
 * "Actions" group of a graph toolbar (Reset layout / Fit / SVG), shared by the ontology graph and the knowledge graph.
 * @param {string} st JS name of the state object passed to layoutGraph / fitGraph / drawGraph / exportGraphSvg
 *   ('kgState'), or '' for the ontology graph (the functions default to gState).
 * @returns {string} HTML.
 */
function graphActionsHtml(st) {
	const call = (fn) => `${fn}(${st})`;
	return (
		`<div class="ggroup"><div class="gcap">Actions</div><div class="grow">` +
		`<button class="btn" title="Forget the positions dragged by hand and compute the selected layout again (force-directed: a new arrangement)" onclick="${st || 'gState'}.pos={};${call('layoutGraph')};${call('fitGraph')};${call('drawGraph')}">${ic('refresh')} Reset layout</button>` +
		`<button class="btn" title="Zoom and pan so that the whole graph fits the drawing area" onclick="${call('fitGraph')};${call('drawGraph')}">${ic('fit')} Fit</button>` +
		`<button class="btn" title="Download the current drawing as an SVG file (positions, colours and labels as shown)" onclick="${call('exportGraphSvg')}">${ic('download')} SVG</button>` +
		`<button class="btn" title="Download the shown nodes and edges as a Graphviz .dot file (structure only, lay it out with dot/neato)" onclick="${call('exportGraphDot')}">${ic('download')} DOT</button>` +
		`<button class="btn" title="Download the shown graph as a LaTeX TikZ picture using the current layout positions" onclick="${call('exportGraphTikz')}">${ic('download')} TikZ</button>` +
		`</div></div>`
	);
}
/** Shown nodes/edges of a graph state (positions included) for the text exports. @returns {{nodes, E, pos, base}|null} */
function graphExportData(S) {
	if (!S.data) {
		alert('Load the graph first');
		return null;
	}
	const { nodes, edges } = visibleGraph(S);
	const withPos = nodes.filter((n) => S.pos[n.id]);
	const idx = new Set(withPos.map((n) => n.id));
	return {
		nodes: withPos,
		E: edges.filter((e) => idx.has(e.s) && idx.has(e.o)),
		pos: S.pos,
		base: (S.kg ? 'kg_' : 'graph_') + String(S.data.graph || 'closure').replace(/\.owl$/, ''),
	};
}
/** "DOT" button: Graphviz export of the shown graph (structure + labels; no positions). @returns {void} */
function exportGraphDot(S = gState) {
	const d = graphExportData(S);
	if (!d) return;
	const q = (v) => JSON.stringify(String(v));
	const eopt = (e) =>
		e.type === 'equivalentClass' ? ', dir=none, style=dashed' : e.type === 'disjointWith' ? ', dir=none, style=dotted' : '';
	const txt =
		'digraph G {\n  rankdir=BT;\n  node [shape=box, fontsize=10];\n' +
		d.nodes.map((n) => `  ${q(n.id)} [label=${q(n.name || n.id)}];`).join('\n') +
		'\n' +
		d.E.map((e) => `  ${q(e.s)} -> ${q(e.o)} [label=${q(e.label || e.type)}${eopt(e)}];`).join('\n') +
		'\n}\n';
	downloadText(d.base + '.dot', txt);
}
/** "TikZ" button: LaTeX TikZ export of the shown graph with the current layout positions. @returns {void} */
function exportGraphTikz(S = gState) {
	const d = graphExportData(S);
	if (!d) return;
	const sc = (v) => (v / 100).toFixed(2); // 100 px = 1 TikZ unit
	const nid = {};
	d.nodes.forEach((n, i) => (nid[n.id] = 'n' + i));
	const edge = (e) => {
		const opt = e.type === 'equivalentClass' ? 'dashed' : e.type === 'disjointWith' ? 'dotted' : '->';
		const lab = e.label ? ` node[midway, draw=none, font=\\tiny] {${texEsc(e.label)}}` : '';
		return `  \\draw[${opt}] (${nid[e.s]}) -- (${nid[e.o]})${lab};`;
	};
	const txt =
		`%% TikZ export of the ${S.kg ? 'knowledge' : 'class'} graph (current layout positions; requires \\usepackage{tikz})\n` +
		'\\begin{tikzpicture}[every node/.style={draw, rounded corners, font=\\scriptsize, inner sep=2pt}, >=stealth]\n' +
		d.nodes.map((n) => `  \\node (${nid[n.id]}) at (${sc(d.pos[n.id].x)}, ${sc(-d.pos[n.id].y)}) {${texEsc(n.name || String(n.id))}};`).join('\n') +
		'\n' +
		d.E.map(edge).join('\n') +
		'\n\\end{tikzpicture}\n';
	downloadText(d.base + '.tikz', txt);
}

// ---------- Graph tab: TBox graph of the active ontology / closure (force layout, plain SVG) ----------
const GCOL = {
	class: '#3457b0',
	classFuzzy: '#f28c28',
	datatype: '#2a9d8f',
	datatypeFuzzy: '#e6a700',
	subClassOf: '#777',
	equivalentClass: '#2a9d8f',
	disjointWith: '#b03a8c',
	objprop: '#3457b0',
	dataprop: '#8a6d1a'
};
let gState = {
	scope: 'active',
	mode: 'hierarchy',
	uml: true,
	focus: '',
	hops: 2,
	data: null,
	show: {
		subClassOf: true,
		equivalentClass: true,
		disjointWith: false,
		objprop: true,
		dataprop: false,
		labels: true,
		edgeLabels: false
	},
	pos: {},
	view: { x: 0, y: 0, k: 1 },
	drag: null
};
function visibleGraph(S = gState) {
	const d = S.data,
		sh = S.show;
	if (!d) return { nodes: [], edges: [] };
	let edges = d.edges.filter((e) => sh[e.type]);
	const used = new Set();
	edges.forEach((e) => {
		used.add(e.s);
		used.add(e.o);
	});
	let nodes = S.kg ? d.nodes.slice() : d.nodes.filter((n) => n.kind === 'class' || used.has(n.id)); // datatypes only when an edge reaches them
	if (S.focus) {
		// neighbourhood of one node (any edge type of the data), N hops
		const f = S.focus.toLowerCase();
		const start = d.nodes.filter((n) => n.name.toLowerCase() === f);
		const st = start.length ? start : d.nodes.filter((n) => n.name.toLowerCase().includes(f));
		if (st.length) {
			const keep = new Set(st.map((n) => n.id));
			let fr = [...keep];
			for (let h = 0; h < S.hops; h++) {
				const nx = [];
				d.edges.forEach((e) => {
					if (fr.includes(e.s) && !keep.has(e.o)) {
						keep.add(e.o);
						nx.push(e.o);
					}
					if (fr.includes(e.o) && !keep.has(e.s)) {
						keep.add(e.s);
						nx.push(e.s);
					}
				});
				fr = nx;
			}
			nodes = d.nodes.filter((n) => keep.has(n.id));
			edges = edges.filter((e) => keep.has(e.s) && keep.has(e.o));
		}
	}
	return { nodes, edges };
}
function classLayers(nodes, S = gState) {
	// depth of every node along subClassOf (roots = 0); datatypes go one layer below their users
	const d = S.data,
		ids = new Set(nodes.map((n) => n.id));
	const parents = {};
	d.edges
		.filter((e) => e.type === 'subClassOf' && ids.has(e.s) && ids.has(e.o))
		.forEach((e) => (parents[e.s] = parents[e.s] || []).push(e.o));
	const depth = {};
	const dep = (id, seen) => {
		if (depth[id] != null) return depth[id];
		if (seen.has(id)) return 0;
		seen.add(id);
		const ps = parents[id] || [];
		depth[id] = ps.length ? 1 + Math.max(...ps.map((p) => dep(p, seen))) : 0;
		return depth[id];
	};
	if (S.kg) {
		nodes.forEach((n) => {
			depth[n.id] = n.depth || 0;
		});
		return depth;
	}
	nodes.forEach((n) => {
		if (n.kind === 'class') dep(n.id, new Set());
	});
	const maxC = Math.max(0, ...nodes.filter((n) => n.kind === 'class').map((n) => depth[n.id] || 0));
	nodes.forEach((n) => {
		if (n.kind !== 'class') depth[n.id] = maxC + 1;
	});
	return depth;
}
// UML box: header (name) + '= equivalent' lines + attribute lines + restriction lines
function umlLines(n) {
	const L = [];
	(n.equiv || []).forEach((e) => L.push({ t: '= ' + e, cls: 'eq' }));
	(n.types || []).forEach((t) => L.push({ t: ': ' + t, cls: 'attr' }));
	(n.attrs || []).forEach((a) => L.push({ t: `${a.name}: ${a.range}${a.func ? ' {func}' : ''}`, cls: 'attr' }));
	(n.restr || []).forEach((r) => L.push({ t: r, cls: 'restr' }));
	return L;
}
function umlBox(n) {
	const lines = umlLines(n);
	const w = Math.max(90, 8 + 7.2 * Math.max(n.name.length + 2, ...lines.map((l) => l.t.length)));
	const h = 24 + (lines.length ? 6 + 15 * lines.length : 0);
	return { w: Math.min(w, 420), h, lines };
}
function nodeSize(S, n) {
	return S.uml ? umlBox(n) : { w: n.name.length * 7 + 30, h: 22 };
} // footprint used by the layouts (label included)
function layoutGraph(S = gState) {
	const { nodes, edges } = visibleGraph(S);
	const N = nodes.length;
	if (!N) return;
	const pos = (S.pos = {});
	const mode = S.mode;
	const SZ = {};
	nodes.forEach((n) => (SZ[n.id] = nodeSize(S, n)));
	const avgW = nodes.reduce((a, n) => a + SZ[n.id].w, 0) / N,
		avgH = nodes.reduce((a, n) => a + SZ[n.id].h, 0) / N;
	const byName = (a, b) => a.name.localeCompare(b.name);
	if (mode === 'hierarchy' || mode === 'radial') {
		const depth = classLayers(nodes, S);
		const layers = {};
		nodes.forEach((n) => (layers[depth[n.id]] = layers[depth[n.id]] || []).push(n));
		const L = Object.keys(layers)
			.map(Number)
			.sort((a, b) => a - b);
		// barycenter ordering: sort each layer by the mean x of the already placed neighbours (parents), then alphabetically
		const idx = new Map(nodes.map((n) => [n.id, n]));
		const nb = {};
		edges.forEach((e) => {
			(nb[e.s] = nb[e.s] || []).push(e.o);
			(nb[e.o] = nb[e.o] || []).push(e.s);
		});
		let placed = {};
		L.forEach((l) => {
			const arr = layers[l];
			arr.forEach((n) => {
				const ref = (nb[n.id] || []).filter((j) => placed[j] != null);
				n._bc = ref.length ? ref.reduce((s, j) => s + placed[j], 0) / ref.length : null;
			});
			arr.sort((a, b) => (a._bc == null) - (b._bc == null) || a._bc - b._bc || byName(a, b));
			arr.forEach((n, i) => {
				placed[n.id] = i;
			});
		});
		if (mode === 'hierarchy') {
			// wide layers wrap into rows; rows sized by the tallest node, columns by each node's width
			let y = 0;
			L.forEach((l) => {
				const arr = layers[l],
					perRow = Math.max(S.uml ? 4 : 6, Math.ceil(Math.sqrt(arr.length * (S.uml ? 2 : 3))));
				let rowY = y,
					rows = [];
				for (let i = 0; i < arr.length; i += perRow) rows.push(arr.slice(i, i + perRow));
				rows.forEach((row, ri) => {
					const ws = row.map((n) => SZ[n.id].w),
						gap = S.uml ? 40 : 24,
						tot = ws.reduce((a, b) => a + b + gap, 0) - gap;
					let x = -tot / 2 + (ri % 2 ? gap : 0);
					const hmax = Math.max(...row.map((n) => SZ[n.id].h));
					row.forEach((n, i) => {
						pos[n.id] = { x: x + ws[i] / 2, y: rowY + hmax / 2 };
						x += ws[i] + gap;
					});
					rowY += hmax + (S.uml ? 50 : 24);
				});
				y = rowY + (S.uml ? 90 : 80);
			});
		} else {
			let r = 0;
			L.forEach((l) => {
				const arr = layers[l];
				if (l === 0 && arr.length === 1) {
					pos[arr[0].id] = { x: 0, y: 0 };
					r = avgH + 120;
					return;
				}
				r = Math.max(r + avgH + 130, (arr.length * (avgW + 20)) / (2 * Math.PI));
				arr.forEach((n, i) => {
					const a = (i / arr.length) * 2 * Math.PI - Math.PI / 2;
					pos[n.id] = { x: Math.cos(a) * r, y: Math.sin(a) * r };
				});
			});
		}
	} else if (mode === 'circle') {
		const arr = [...nodes].sort(
			(a, b) => (a.module || '').localeCompare(b.module || '') || a.kind.localeCompare(b.kind) || byName(a, b)
		);
		const per = arr.reduce((a, n) => a + Math.max(SZ[n.id].w, SZ[n.id].h) + 16, 0);
		const r = Math.max(200, per / (2 * Math.PI));
		arr.forEach((n, i) => {
			const a = (i / arr.length) * 2 * Math.PI - Math.PI / 2;
			pos[n.id] = { x: Math.cos(a) * r, y: Math.sin(a) * r };
		});
	} else if (mode === 'grid') {
		const arr = [...nodes].sort((a, b) => (a.module || '').localeCompare(b.module || '') || byName(a, b));
		const cols = Math.ceil(Math.sqrt(arr.length * 2));
		const cw = Math.max(...arr.map((n) => SZ[n.id].w)) + 30,
			rh = Math.max(...arr.map((n) => SZ[n.id].h)) + 20;
		arr.forEach((n, i) => {
			pos[n.id] = { x: (i % cols) * cw, y: Math.floor(i / cols) * rh };
		});
	} else {
		// force-directed (Fruchterman–Reingold), deterministic start on a circle; k grows with the node footprint
		const W = Math.max(900, Math.sqrt(N) * Math.max(140, avgW + 60)),
			H = W * 0.7,
			k = Math.sqrt((W * H) / N) * 0.9;
		nodes.forEach((n, i) => {
			pos[n.id] = {
				x: W / 2 + Math.cos((i / N) * 2 * Math.PI) * W * 0.4,
				y: H / 2 + Math.sin((i / N) * 2 * Math.PI) * H * 0.4
			};
		});
		const idx = new Map(nodes.map((n, i) => [n.id, i]));
		const E = edges.filter((e) => idx.has(e.s) && idx.has(e.o));
		let t = W / 8;
		for (let it = 0; it < 300; it++) {
			const disp = nodes.map(() => ({ x: 0, y: 0 }));
			for (let i = 0; i < N; i++)
				for (let j = i + 1; j < N; j++) {
					const a = pos[nodes[i].id],
						b = pos[nodes[j].id];
					let dx = a.x - b.x,
						dy = a.y - b.y,
						d = Math.hypot(dx, dy) || 0.01;
					const f = (k * k) / d;
					dx /= d;
					dy /= d;
					disp[i].x += dx * f;
					disp[i].y += dy * f;
					disp[j].x -= dx * f;
					disp[j].y -= dy * f;
				}
			E.forEach((e) => {
				const i = idx.get(e.s),
					j = idx.get(e.o),
					a = pos[e.s],
					b = pos[e.o];
				let dx = a.x - b.x,
					dy = a.y - b.y,
					d = Math.hypot(dx, dy) || 0.01;
				const f = (d * d) / k;
				dx /= d;
				dy /= d;
				disp[i].x -= dx * f;
				disp[i].y -= dy * f;
				disp[j].x += dx * f;
				disp[j].y += dy * f;
			});
			nodes.forEach((n, i) => {
				const p = pos[n.id],
					d = Math.hypot(disp[i].x, disp[i].y) || 0.01,
					m = Math.min(d, t);
				p.x += (disp[i].x / d) * m;
				p.y += (disp[i].y / d) * m;
			});
			t *= 0.97;
		}
	}
}
function drawUml(S, nodes, E, pos, v) {
	const svg = $(S.svg || '#gsvg');
	const box = {};
	nodes.forEach((n) => (box[n.id] = umlBox(n)));
	const clip = (a, b, bw, bh) => {
		const dx = b.x - a.x,
			dy = b.y - a.y;
		if (!dx && !dy) return a;
		const sx = Math.abs(dx) > 1e-6 ? bw / 2 / Math.abs(dx) : 1e9,
			sy = Math.abs(dy) > 1e-6 ? bh / 2 / Math.abs(dy) : 1e9,
			t = Math.min(sx, sy);
		return { x: b.x - dx * t, y: b.y - dy * t };
	}; // point where the a→b line leaves box b
	const col = {
		subClassOf: '#3F51B5',
		equivalentClass: '#00897B',
		disjointWith: '#C2185B',
		objprop: '#424242',
		dataprop: '#6D4C41'
	}; // Material: indigo 500, teal 600, pink 700, grey 800
	const edgeSvg = E.filter((e) => e.type !== 'dataprop')
		.map((e) => {
			const a = pos[e.s],
				b = pos[e.o],
				A = box[e.s],
				B = box[e.o];
			const p1 = clip(b, a, A.w, A.h),
				p2 = clip(a, b, B.w, B.h);
			const mk =
				e.type === 'subClassOf'
					? ' marker-end="url(#uml-gen)"'
					: e.type === 'objprop'
						? ' marker-end="url(#uml-arrow)"'
						: '';
			const dash =
				e.type === 'disjointWith'
					? ' stroke-dasharray="4 3"'
					: e.type === 'equivalentClass'
						? ' stroke-dasharray="7 4"'
						: '';
			const lbl =
				e.type === 'objprop'
					? e.label
					: e.type === 'disjointWith'
						? '{disjoint}'
						: e.type === 'equivalentClass'
							? '{equivalent}'
							: '';
			const mx = (p1.x + p2.x) / 2,
				my = (p1.y + p2.y) / 2;
			return (
				`<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="${col[e.type]}" stroke-width="${e.type === 'subClassOf' ? 1.8 : 1.2}"${dash}${mk}><title>${esc(e.type)}${e.label ? ' ' + esc(e.label) : ''}</title></line>` +
				(lbl && S.show.edgeLabels !== false
					? `<text x="${mx}" y="${my - 4}" font-size="10" fill="${col[e.type]}" text-anchor="middle" paint-order="stroke" stroke="#fff" stroke-width="3" style="pointer-events:none">${esc(lbl)}</text>`
					: '')
			);
		})
		.join('');
	const nodeSvg = nodes
		.map((n) => {
			const p = pos[n.id],
				B = box[n.id],
				x = p.x - B.w / 2,
				y = p.y - B.h / 2;
			const fill = n.kind === 'datatype' ? '#E0F2F1' : n.fuzzy ? '#FFF3E0' : '#FFFFFF';
			const stroke = n.kind === 'datatype' ? '#00897B' : n.fuzzy ? '#FB8C00' : '#3F51B5';
			const headBg = n.kind === 'datatype' ? '#B2DFDB' : n.fuzzy ? '#FFE0B2' : '#E8EAF6';
			const head = `<rect x="${x}" y="${y}" width="${B.w}" height="24" rx="4" fill="${headBg}"/><rect x="${x}" y="${y + 18}" width="${B.w}" height="6" fill="${headBg}"/><text x="${p.x}" y="${y + 16}" font-size="12" font-weight="600" text-anchor="middle" fill="#1A237E" style="pointer-events:none">${esc(n.name)}</text>`;
			const sep = B.lines.length
				? `<line x1="${x}" y1="${y + 24}" x2="${x + B.w}" y2="${y + 24}" stroke="${stroke}" stroke-opacity=".5"/>`
				: '';
			const body = B.lines
				.map(
					(l, i) =>
						`<text x="${x + 6}" y="${y + 24 + 6 + 15 * (i + 1) - 4}" font-size="11" fill="${l.cls === 'eq' ? '#00796B' : l.cls === 'restr' ? '#512DA8' : '#212121'}" style="pointer-events:none">${esc(l.t.length > 56 ? l.t.slice(0, 55) + '…' : l.t)}</text>`
				)
				.join('');
			return `<g data-node="${n.id}" style="cursor:pointer"><title>${esc(n.name)}${(n.restr || []).map((r) => '\n' + r).join('')}</title><rect x="${x}" y="${y}" width="${B.w}" height="${B.h}" rx="4" fill="${fill}" stroke="${stroke}" stroke-width="${n.fuzzy ? 1.8 : 1.2}" filter="url(#uml-shadow)"/>${head}${sep}${body}</g>`;
		})
		.join('');
	const defs = `<filter id="uml-shadow" x="-5%" y="-5%" width="110%" height="120%"><feDropShadow dx="0" dy="1.5" stdDeviation="1.5" flood-color="#000" flood-opacity=".18"/></filter><marker id="uml-gen" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="12" markerHeight="12" orient="auto-start-reverse"><path d="M0,0 L12,6 L0,12 z" fill="#fff" stroke="#3F51B5" stroke-width="1.2"/></marker><marker id="uml-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10" fill="none" stroke="#424242" stroke-width="1.4"/></marker>`;
	svg.innerHTML = `<defs>${defs}</defs><rect width="100%" height="100%" fill="#fff"/><g transform="translate(${v.x},${v.y}) scale(${v.k})" font-family="system-ui,sans-serif">${edgeSvg}${nodeSvg}</g>`;
}
function fitGraph(S = gState) {
	// scale/translate so that all visible nodes fit the container
	const svg = $(S.svg || '#gsvg');
	if (!svg) return;
	const { nodes } = visibleGraph(S);
	const pos = S.pos;
	const pts = nodes.map((n) => pos[n.id]).filter(Boolean);
	if (!pts.length) return;
	const r = svg.getBoundingClientRect();
	const xs = pts.map((p) => p.x),
		ys = pts.map((p) => p.y);
	const minX = Math.min(...xs) - 80,
		maxX = Math.max(...xs) + 160,
		minY = Math.min(...ys) - 40,
		maxY = Math.max(...ys) + 40;
	const k = Math.min(r.width / (maxX - minX), r.height / (maxY - minY), 1.6);
	S.view = { k, x: (r.width - (maxX + minX) * k) / 2, y: (r.height - (maxY + minY) * k) / 2 };
}
function drawGraph(S = gState) {
	const svg = $(S.svg || '#gsvg');
	if (!svg || !S.data) return;
	const { nodes, edges } = visibleGraph(S),
		pos = S.pos,
		v = S.view,
		sh = S.show;
	const idx = new Set(nodes.map((n) => n.id));
	const E = edges.filter((e) => idx.has(e.s) && idx.has(e.o));
	$(S.count || '#gcount').textContent =
		`— ${S.data.graph}: ${nodes.length} nodes, ${E.length} edges shown (${S.data.nodes.length} / ${S.data.edges.length} in total)`;
	const KGC = ['#b3552b', '#3457b0', '#2a9d8f', '#8a6d1a', '#6c757d'];
	const col = (n) =>
		S.kg
			? n.seed
				? '#b3552b'
				: KGC[Math.min(4, n.depth || 0)]
			: n.kind === 'datatype'
				? n.fuzzy
					? GCOL.datatypeFuzzy
					: GCOL.datatype
				: n.fuzzy
					? GCOL.classFuzzy
					: GCOL.class;
	if (S.uml) {
		drawUml(S, nodes, E, pos, v);
		return;
	}
	const dash = { equivalentClass: '6 4', disjointWith: '2 4' };
	const edgeSvg = E.map((e) => {
		const a = pos[e.s],
			b = pos[e.o];
		const dx = b.x - a.x,
			dy = b.y - a.y,
			d = Math.hypot(dx, dy) || 1,
			ux = dx / d,
			uy = dy / d;
		const x1 = a.x + ux * 9,
			y1 = a.y + uy * 9,
			x2 = b.x - ux * 11,
			y2 = b.y - uy * 11;
		const arrow =
			e.type === 'objprop' || e.type === 'dataprop' || e.type === 'subClassOf'
				? ` marker-end="url(#arr-${e.type})"`
				: '';
		const lbl =
			sh.edgeLabels && e.label
				? `<text x="${(a.x + b.x) / 2}" y="${(a.y + b.y) / 2 - 3}" font-size="9" fill="${GCOL[e.type]}" text-anchor="middle" style="pointer-events:none">${esc(e.label)}</text>`
				: '';
		return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${GCOL[e.type]}" stroke-width="1.2"${dash[e.type] ? ` stroke-dasharray="${dash[e.type]}"` : ''}${arrow}><title>${esc(e.type)}${e.label ? ' ' + esc(e.label) : ''}</title></line>${lbl}`;
	}).join('');
	const deg = {};
	E.forEach((e) => {
		deg[e.s] = (deg[e.s] || 0) + 1;
		deg[e.o] = (deg[e.o] || 0) + 1;
	});
	const fs = Math.max(9, Math.min(13, 11 / Math.sqrt(v.k))); // labels stay readable when zoomed out
	const showLbl = sh.labels && (nodes.length <= 120 || v.k >= 0.9);
	const nodeSvg = nodes
		.map((n) => {
			const p = pos[n.id],
				c = col(n),
				r = 6 + Math.min(6, Math.sqrt(deg[n.id] || 0));
			const shape =
				n.kind === 'datatype'
					? `<rect x="${p.x - r}" y="${p.y - r}" width="${2 * r}" height="${2 * r}" rx="2" fill="${c}" stroke="#fff" stroke-width="1.5"/>`
					: `<circle cx="${p.x}" cy="${p.y}" r="${r}" fill="${c}" stroke="#fff" stroke-width="1.5"/>`;
			const lbl = showLbl
				? `<text x="${p.x + r + 3}" y="${p.y + 4}" font-size="${fs}" fill="#222" paint-order="stroke" stroke="#fff" stroke-width="3" stroke-linejoin="round" style="pointer-events:none">${esc(n.name)}</text>`
				: '';
			return `<g data-node="${n.id}" style="cursor:pointer"><title>${esc(n.name)} (${n.kind}${n.fuzzy ? ', fuzzy' : ''}${n.module ? ', ' + esc(n.module) : ''}${n.types && n.types.length ? ': ' + esc(n.types.join(', ')) : ''})</title>${shape}${lbl}</g>`;
		})
		.join('');
	const defs = ['objprop', 'dataprop', 'subClassOf']
		.map(
			(t) =>
				`<marker id="arr-${t}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${GCOL[t]}"/></marker>`
		)
		.join('');
	svg.innerHTML = `<defs>${defs}</defs><rect width="100%" height="100%" fill="#fff"/><g transform="translate(${v.x},${v.y}) scale(${v.k})" font-family="system-ui,sans-serif">${edgeSvg}${nodeSvg}</g>`;
}
function exportGraphSvg(S = gState) {
	const svg = $(S.svg || '#gsvg');
	if (!svg || !S.data) return;
	const r = svg.getBoundingClientRect();
	const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(r.width)}" height="${Math.round(r.height)}" viewBox="0 0 ${Math.round(r.width)} ${Math.round(r.height)}">${svg.innerHTML}</svg>`;
	downloadText(`graph_${(S.data.graph || 'kg').replace(/\.owl$/, '')}.svg`, xml, 'image/svg+xml');
}
