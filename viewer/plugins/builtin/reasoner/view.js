// Built-in view "Reasoner" — self-contained package (delete this folder to remove the view).
// Shared helpers come from the kit bundle (static/js): see PLUGINS.md.

// reasoner.js — Reasoner tab: fuzzy (fuzzy_dl_owl2) and classic (HermiT/Pellet) runs on temporary KBs, work-dir cleanup.
//
// Overview
//   Classic script sharing the global scope with the other files loaded by static/index.html (loaded
//   after core.js, entities.js, axioms.js, graphs.js, query.js; before main.js).
//   The tab (#tab-reasoner) has four cards:
//     - Reasoning scope: the schema modules are always included; individuals are picked explicitly
//       (global `rsel`) and listed as removable chips in #rsel.
//     - Fuzzy reasoner: MILP solver provider select (#rprov), a list of FuzzyDL queries (#rqueries,
//       one .rq row each: query type select .rqt + argument pickers .rqarg), run button, status
//       (#rfstatus) and results (#rfres). POST /api/reason/fuzzy.
//     - Classic reasoner: engine select (#reng), run button, status (#rcstatus), results (#rcres).
//       POST /api/reason/classic.
//     - Inferred view (#infcard, drawn by inference.js): TBox classification whose results are shown
//       next to the asserted axioms (entity pages, class tree).
//     - Reasoner memory: size of data/reasoner_work (#rwork) and a clear button.
//       GET /api/reasoner/work, POST /api/reasoner/clear.
//   Globals defined here: rsel, RQ, RQKIND and the functions below; renderReasoner is called by the
//   main-tab switch in core.js, the others from inline onclick handlers of the markup built here.
//   Globals used from other files: $, api, esc, fmtBytes (core.js); post, short, bindPicker, pickVal
//   (entities.js); infCardDraw (inference.js).
//   DOM ids owned: #tab-reasoner, #rpick, #rsel, #rprov, #rqueries, #rfstatus, #rfres, #reng,
//   #rcstatus, #rcres, #rwork (#infcard belongs to inference.js).

// ---------- reasoner tab ----------
// IRIs of the individuals selected for the reasoning scope (order = insertion order)
let rsel = [];
/**
 * Entry point of the Reasoner tab (called by the main-tab switch in core.js). Builds the markup of
 * the four cards once (flag in #tab-reasoner's data-ready), binds the individual picker #rpick
 * (adds the picked IRI to `rsel`, avoiding duplicates, and clears the input), draws the selection,
 * adds a first empty query row and loads the work-dir size.
 * Side effects: replaces the innerHTML of #tab-reasoner; calls drawRsel(), rqAdd(), loadReasonerWork().
 */
function renderReasoner() {
	if ($('#tab-reasoner').dataset.ready) return;
	$('#tab-reasoner').dataset.ready = '1';
	// card 1: reasoning scope (explanation + individual picker + selected chips);
	// cards 2-3 side by side: fuzzy reasoner (provider, queries, run, results) and classic reasoner (engine, run, results);
	// card 4: inferred view (inference.js fills #infcard); card 5: reasoner memory (work-dir size + clear button)
	$('#tab-reasoner').innerHTML = `
  <div class="card" style="max-width:none"><h2>Reasoning scope</h2>
    <div class="dt" style="margin:4px 0 8px">The schema (modules without individuals: classes, properties, fuzzy datatypes, fuzzy concepts) is always included. Individuals must be selected explicitly (those mentioned in the queries are added automatically): the ~400k individuals of the full ABox are not tractable by any reasoner. For each included individual, the individuals it references directly (country, series, indicator…) are included too, with their assertions and values.</div>
    <div class="picker" style="max-width:none"><input id="rpick" style="width:100%" placeholder="search and add individuals… (e.g. Lithuania_2000)" autocomplete="off"><div class="res"></div></div>
    <div id="rsel" style="margin-top:6px"></div>
  </div>
  <div class="ocards" style="align-items:stretch">
  <div class="card" style="max-width:none;flex:1;min-width:min(420px,100%)"><h2>Fuzzy reasoner (fuzzy-dl-owl2 / FuzzyDL)</h2>
    <div class="dt" style="margin:4px 0">OWL 2 + fuzzyLabel → FDL → query. Solver MILP: <select id="rprov"><option value="gurobi">gurobi (academic licence)</option><option value="mip">mip (CBC, free)</option><option value="pulp">pulp (CBC)</option><option value="pulp_highs">pulp_highs</option></select></div>
    <div id="rqueries"></div><span class="expand" onclick="rqAdd()" title="Add a FuzzyDL query row (instance / subsumption / satisfiability / defuzzification)">+ add query</span>
    <div style="margin-top:10px"><button class="ibtn primary" style="margin:0" onclick="runFuzzy()" title="Translate the schema and the selected individuals to FuzzyDL and answer the queries above with the chosen MILP solver">${ic('play')} Run fuzzy reasoner</button> <span id="rfstatus" class="dt"></span></div>
    <div id="rfres" style="margin-top:10px"></div>
  </div>
  <div class="card" style="max-width:none;flex:1;min-width:min(420px,100%)"><h2>Classic reasoner (owlready2)</h2>
    <div class="dt" style="margin:4px 0">Engine: <select id="reng"><option value="hermit">HermiT</option><option value="pellet">Pellet</option></select> — consistency, unsatisfiable classes, inferred subclasses and types (fuzzy constructs are ignored: crisp).</div>
    <div style="margin-top:10px"><button class="ibtn primary" style="margin:0" onclick="runClassic()" title="Check consistency and compute the unsatisfiable classes, inferred subclasses and types of the selected individuals with HermiT or Pellet (crisp: fuzzy constructs ignored)">${ic('play')} Run classic reasoner</button> <span id="rcstatus" class="dt"></span></div>
    <div id="rcres" style="margin-top:10px"></div>
  </div></div>
  <div class="card" id="infcard" style="max-width:none;margin-top:14px"></div>
  <div class="card" style="max-width:none"><h2>Reasoner memory</h2>
    <div class="dt" style="margin:4px 0 8px">Every run writes a temporary KB (OWL, FDL, logs) under <code>data/reasoner_work/</code>; nothing is deleted automatically.</div>
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><span id="rwork" class="dt">…</span>
      <button class="btn" onclick="clearReasonerWork()" title="Delete every temporary KB (OWL, FDL, logs) of past reasoner runs under data/reasoner_work/ and free the space">Clear reasoner memory</button></div>
  </div>`;
	bindPicker($('#rpick'), 'individual', (iri) => {
		if (!rsel.includes(iri)) rsel.push(iri);
		$('#rpick').value = '';
		$('#rpick').dataset.iri = '';
		drawRsel();
	});
	drawRsel();
	rqAdd();
	loadReasonerWork();
	infCardDraw();
}
// size of data/reasoner_work (temporary KBs of past runs) → "Reasoner memory" card
/**
 * Fetches the size of the reasoner scratch directory and shows it in #rwork.
 * Side effects: GET /api/reasoner/work (returns {runs, files, bytes}); sets #rwork.
 */
function loadReasonerWork() {
	return api('/api/reasoner/work', {}).then((w) => {
		const el = $('#rwork'); // absent until the Reasoner tab is first rendered (Tools menu calls too)
		if (el) el.textContent = `${w.runs} runs · ${w.files} files · ${fmtBytes(w.bytes)}`;
		return w;
	});
}
/**
 * "Clear reasoner memory" button: after confirmation deletes every temporary KB of past runs, then
 * refreshes #rwork and appends the freed size.
 * Side effects: confirm(); POST /api/reasoner/clear (returns {cleared:{bytes,…}, now}); calls
 * loadReasonerWork(); appends to #rwork.
 */
function clearReasonerWork() {
	if (!confirm('Delete all temporary reasoner files?')) return;
	post('/api/reasoner/clear', {}).then((r) =>
		// wait for the refreshed size before appending, or the GET result would overwrite the suffix
		loadReasonerWork().then(() => {
			const el = $('#rwork');
			if (el) el.textContent += ` (freed ${fmtBytes(r.cleared.bytes)})`;
			else alert(`Reasoner memory cleared (freed ${fmtBytes(r.cleared.bytes)})`);
		})
	);
}
/**
 * Redraws the selected individuals (`rsel`) in #rsel as chips with a ✕ that removes the entry by
 * index (inline onclick) and redraws; shows a "schema only" note when the selection is empty.
 */
function drawRsel() {
	$('#rsel').innerHTML = rsel.length
		? rsel
				.map(
					(i, k) =>
						`<span class="mod" style="margin:2px">${esc(short(i))} <span class="rm" title="Remove this individual from the reasoning scope" onclick="rsel.splice(${k},1);drawRsel()">✕</span></span>`
				)
				.join('')
		: '<span class="dt">no individuals selected (schema only)</span>';
}
// FuzzyDL query types → names of their arguments (a, b = individuals; C, D = concepts; R = role; f = feature)
const RQ = {
	sat: [],
	'max-instance': ['a', 'C'],
	'min-instance': ['a', 'C'],
	'all-instances': ['C'],
	'max-subs': ['C', 'D'],
	'min-subs': ['C', 'D'],
	'max-sat': ['C'],
	'min-sat': ['C'],
	'max-related': ['a', 'b', 'R'],
	'min-related': ['a', 'b', 'R'],
	'defuzzify-lom': ['C', 'a', 'f'],
	'defuzzify-mom': ['C', 'a', 'f'],
	'defuzzify-som': ['C', 'a', 'f']
};
// argument name → entity kind searched by its picker
const RQKIND = { a: 'individual', b: 'individual', C: 'class', D: 'class', R: 'objprop', f: 'dataprop' };
/**
 * "+ add query" link: appends a query row (.rq) to #rqueries: a type select (.rqt, options = keys of
 * RQ, default 'min-instance'), the argument pickers container (.rqa) and a ✕ that removes the row.
 * Side effects: appends to #rqueries; calls rqArgs() to build the pickers of the default type.
 */
function rqAdd() {
	const d = document.createElement('div');
	d.className = 'rq';
	d.style = 'display:flex;gap:6px;align-items:center;margin-top:6px;flex-wrap:wrap';
	d.innerHTML = `<select class="rqt" onchange="rqArgs(this)">${Object.keys(RQ)
		.map((k) => `<option>${k}</option>`)
		.join(
			''
		)}</select><span class="rqa" style="display:flex;gap:6px;flex:1"></span><span class="rm" title="Remove this query row" onclick="this.parentNode.remove()">✕</span>`;
	$('#rqueries').appendChild(d);
	d.querySelector('.rqt').value = 'min-instance';
	rqArgs(d.querySelector('.rqt'));
}
/**
 * Rebuilds the argument inputs of a query row for the selected query type: one entity picker
 * (.picker with an .rqarg input carrying data-arg = argument name) per argument of RQ[type], each
 * bound to the autocomplete of the kind given by RQKIND.
 * @param {HTMLSelectElement} sel  the .rqt select of the row (its value = query type).
 * Side effects: replaces the innerHTML of the sibling .rqa container; calls bindPicker on each input.
 */
function rqArgs(sel) {
	const box = sel.parentNode.querySelector('.rqa');
	box.innerHTML = RQ[sel.value]
		.map(
			(a) =>
				`<div class="picker" style="flex:1;min-width:160px"><input class="rqarg" data-arg="${a}" placeholder="${a} (${RQKIND[a]})" autocomplete="off"><div class="res"></div></div>`
		)
		.join('');
	box.querySelectorAll('.rqarg').forEach((inp) => bindPicker(inp, RQKIND[inp.dataset.arg]));
}
/**
 * "Run fuzzy reasoner" button: collects the query rows ({type, args:{name: IRI or typed text}} via
 * pickVal), sends them with the selected individuals and MILP provider, and renders the response:
 * scope stats, error (+ traceback), one table row per query (result or error, "inconsistent KB"
 * flag, seconds), step timings, the generated FDL and the log in collapsible <details>.
 * Side effects: POST /api/reason/fuzzy {individuals, queries, provider} (returns {stats:{schema_files,
 * individuals, triples}, results:[{query, result, error, consistent, seconds}], steps:[{step,
 * seconds}], fdl, log, seconds, error, traceback}); sets #rfstatus and #rfres.
 */
function runFuzzy() {
	const queries = [...document.querySelectorAll('#rqueries .rq')].map((r) => ({
		type: r.querySelector('.rqt').value,
		args: Object.fromEntries([...r.querySelectorAll('.rqarg')].map((i) => [i.dataset.arg, pickVal(i)]))
	}));
	$('#rfstatus').textContent = 'running… (OWL→FDL conversion + MILP solver; may take minutes)';
	$('#rfres').innerHTML = '';
	post('/api/reason/fuzzy', { individuals: rsel, queries, provider: $('#rprov').value })
		.then((r) => {
			$('#rfstatus').textContent = r.seconds ? `${r.seconds}s` : '';
			let h = `<div class="dt">schema: ${(r.stats?.schema_files || []).join(', ')} · individuals included: ${r.stats?.individuals} · triples: ${r.stats?.triples}</div>`;
			if (r.error)
				h += `<div class="err" style="white-space:pre-wrap">${esc(r.error)}\n${esc(r.traceback || '')}</div>`;
			if (r.results)
				h += `<table class="metrics" style="margin-top:8px">${r.results.map((x) => `<tr><td><code>${esc(x.query)}</code></td><td>${x.error ? '<span class="err">' + esc(x.error) + '</span>' : '<b>' + esc(x.result) + '</b>' + (x.consistent === false ? ' (inconsistent KB)' : '')}</td><td class="dt">${x.seconds ?? ''}s</td></tr>`).join('')}</table>`;
			if (r.steps)
				h += `<div class="dt" style="margin-top:6px">${r.steps.map((s) => s.step + ' ' + s.seconds + 's').join(' · ')}</div>`;
			if (r.fdl)
				h += `<details style="margin-top:8px"><summary class="expand">Generated FDL (${r.fdl.split('\n').length} lines)</summary><pre class="lit dt" style="max-height:300px;overflow:auto">${esc(r.fdl)}</pre></details>`;
			if (r.log)
				h += `<details><summary class="expand">log</summary><pre class="lit dt" style="max-height:200px;overflow:auto">${esc(r.log)}</pre></details>`;
			$('#rfres').innerHTML = h;
		})
		.catch((e) => {
			$('#rfstatus').textContent = 'failed: ' + e;
		});
}
/**
 * "Run classic reasoner" button: runs HermiT or Pellet (owlready2) on the schema plus the selected
 * individuals and renders: scope stats, error (+ traceback) or the unsatisfiable classes, the inferred
 * subclass pairs and the inferred individual types (scrollable lists), and the log.
 * Side effects: POST /api/reason/classic {individuals, engine} (returns {stats:{schema_files,
 * individuals}, classes, individuals, unsatisfiable[], inferred_subclass[[sub, sup]],
 * inferred_types[[ind, cls]], log, seconds, error, traceback}); sets #rcstatus and #rcres.
 */
function runClassic() {
	$('#rcstatus').textContent = 'running… (Java, ~1 min on the schema)';
	$('#rcres').innerHTML = '';
	post('/api/reason/classic', { individuals: rsel, engine: $('#reng').value })
		.then((r) => {
			$('#rcstatus').textContent = r.seconds ? `${r.seconds}s` : '';
			let h = `<div class="dt">schema: ${(r.stats?.schema_files || []).join(', ')} · individuals: ${r.individuals ?? r.stats?.individuals} · classes: ${r.classes ?? ''}</div>`;
			if (r.error)
				h += `<div class="err" style="white-space:pre-wrap">${esc(r.error)}\n${esc(r.traceback || '')}</div>`;
			else {
				h += `<div style="margin-top:6px"><b>Unsatisfiable classes:</b> ${r.unsatisfiable.length ? r.unsatisfiable.map((x) => esc(short(x))).join(', ') : 'none ✓'}</div>`;
				h += `<div style="margin-top:6px"><b>Inferred subclasses (${r.inferred_subclass.length}):</b><div style="max-height:220px;overflow:auto">${r.inferred_subclass.map(([a, b]) => `<div class="dt">${esc(short(a))} ⊑ ${esc(short(b))}</div>`).join('') || '<span class="dt">none</span>'}</div></div>`;
				h += `<div style="margin-top:6px"><b>Inferred types for individuals (${r.inferred_types.length}):</b><div style="max-height:220px;overflow:auto">${r.inferred_types.map(([a, b]) => `<div class="dt">${esc(short(a))} : ${esc(short(b))}</div>`).join('') || '<span class="dt">none</span>'}</div></div>`;
			}
			if (r.log)
				h += `<details><summary class="expand">log</summary><pre class="lit dt" style="max-height:200px;overflow:auto">${esc(r.log)}</pre></details>`;
			$('#rcres').innerHTML = h;
		})
		.catch((e) => {
			$('#rcstatus').textContent = 'failed: ' + e;
		});
}

registerView({
	id: 'reasoner',
	title: 'Reasoner',
	tooltip: 'Run the fuzzy (FuzzyDL) and classic (HermiT / Pellet) reasoners on the schema plus chosen individuals; classify the closure for the inferred view',
	render: () => renderReasoner(),
});
