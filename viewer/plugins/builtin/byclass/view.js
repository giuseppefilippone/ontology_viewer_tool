// Built-in view "Individuals by class" — self-contained package (delete this folder to remove the view).
// Shared helpers come from the kit bundle (static/js): see PLUGINS.md.

// ---------- Individuals by class ----------
let bcState = { cls: null, page: 0, q: '', expandAll: true }; // expandAll: initial state of the sub-trees
/**
 * Entry point of the Individuals-by-class tab: a resizable column with the class tree in the sidebar style
 * (filter box, "Expand all", rows with toggle / dot / name / instance count) and, on the right, the paginated
 * direct instances of the selected class (bcLoad). Built once (data-ready flag).
 * Side effects: replaces #tab-byclass; GET /api/tree; binds the autocomplete of #bcfilter and the resize handle.
 */
function renderByClass() {
	const box = $('#tab-byclass');
	if (box.dataset.ready) {
		return;
	}
	box.dataset.ready = '1';
	box.innerHTML = `<div class="card" style="max-width:none"><h2>Individuals by class <span class="count" id="bccount"></span></h2>
    <div style="display:flex;gap:16px;margin-top:8px;min-height:60vh">
      <div id="bccol" class="sidepanel" style="width:${uiConfig.byclass_width || 360}px">
        <div class="listsearch"><input id="bcfilter" placeholder="Filter classes…" autocomplete="off" oninput="bcFilter(this.value)"></div>
        <div id="bctree" class="treebox"><span class="dt">loading…</span></div>
      </div>
      <div id="bcresize" class="vresize" title="drag to resize the class tree"></div>
      <div style="flex:1;min-width:0"><div id="bclist"><span class="dt">select a class to list its asserted instances (direct instances of the class; subclasses are listed under their own node)</span></div></div></div></div>`;
	api('/api/tree', {}).then((d) => {
		window._bcTree = d.roots;
		drawBcTree('');
	});
	attachAutocomplete($('#bcfilter'), {
		single: true,
		keywords: false,
		kinds: ['class'],
		onPick: (it) => it.iri && bcSelect(it.iri) // a picked suggestion selects the class
	});
	makeResizable($('#bcresize'), $('#bccol'), 'byclass_width', 200);
}
/**
 * Draw the class tree into #bctree with the shared sidebar builder (treeHtml). A non-empty filter keeps
 * only the branches whose name contains it (those branches are shown expanded).
 * @param {string} filter Substring typed in #bcfilter (case-insensitive).
 */
function drawBcTree(filter) {
	const f = filter.toLowerCase();
	// prune the tree to the matching branches (a node stays when it matches or one of its descendants does)
	const prune = (n) => {
		const kids = (n.children || []).map(prune).filter(Boolean);
		return !f || n.name.toLowerCase().includes(f) || kids.length ? { ...n, children: kids } : null;
	};
	const roots = (window._bcTree || []).map(prune).filter(Boolean);
	const expanded = bcState.expandAll || !!f;
	$('#bctree').innerHTML = roots.length
		? treeHtml(roots, 'class', {
				click: (iri) => `bcSelect('${iri}')`,
				expanded,
				expandJs: "bcState.expandAll=this.checked;treeSetAll(this.checked,'#bctree')",
				selected: bcState.cls
			})
		: '<span class="dt" style="margin:8px">no classes</span>';
}
/** Debounced (250 ms) redraw of the tree while typing in #bcfilter. */
function bcFilter(v) {
	clearTimeout(window._bcT);
	window._bcT = setTimeout(() => drawBcTree(v.trim()), 250);
}
/** Select a class (highlight its row, reset the page) and list its instances. */
function bcSelect(iri) {
	bcState.cls = iri;
	bcState.page = 0;
	drawBcTree($('#bcfilter').value.trim());
	bcLoad();
}
function bcLoad() {
	const iri = bcState.cls;
	if (!iri) return;
	api('/api/instances', { iri, page: bcState.page, graph: '' }).then((d) => {
		const pages = Math.max(1, Math.ceil(d.total / 200));
		$('#bclist').innerHTML =
			`<div class="ptitle" style="margin-top:0">${esc(short(iri))} — ${d.total.toLocaleString('en')} instances ${pagerHtml(bcState.page, pages, 'bcState.page={p};bcLoad()')}
      <span class="expand" style="margin-left:auto" onclick="openEntity('${esc(iri)}')">open class</span></div>
      <div style="columns:2;column-gap:20px">${d.items.map((n) => `<div class="item" style="break-inside:avoid" onclick="openEntity('${esc(n.iri)}')">${dot(n.kind, n.fuzzy)}${esc(n.name)}</div>`).join('') || '<span class="dt">no direct instances</span>'}</div>`;
	});
}

registerView({
	id: 'byclass',
	title: 'Individuals by class',
	tooltip: 'Class tree with the asserted direct instances of the selected class',
	render: () => renderByClass(),
});
