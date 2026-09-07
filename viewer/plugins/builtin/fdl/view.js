// Built-in view "FDL" — self-contained package (delete this folder to remove the view).
// Shared helpers come from the kit bundle (static/js): see PLUGINS.md.

// ---------- FDL tab: paginated FuzzyDL of the import closure of the active ontology ----------
// page = 0-based page of the .fdl text; q = substring filter (when set the server returns the first
// matching lines of the whole file instead of a page)
let fdlState = { page: 0, q: '' };
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

registerView({
	id: 'fdl',
	title: 'FDL',
	tooltip: 'The FuzzyDL (.fdl) text of the closure of the active ontology: generate, browse, download',
	render: () => renderFdl(),
});
