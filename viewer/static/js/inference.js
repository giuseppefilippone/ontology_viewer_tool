// inference.js — Inferred view: the axioms a classical reasoner (HermiT / Pellet) adds to the asserted ontology, shown
// next to the asserted ones like the "inferred" mode of an ontology editor, and assertable one by one or all at once.
//
// Overview
//   Classic script sharing the global scope with the other files loaded by static/index.html (loaded after
//   reasoner.js, before main.js).
//   - State: INF.tbox = the GET /api/inference/tbox payload while a classification result exists ({engine, when,
//     counts, classes:{iri:{parents,equivalent,unsatisfiable}}, properties:{…}, axioms:[{s,p,o}], nodes:{iri:node}}),
//     null otherwise; INF.poll = timer of the status polling.
//   - Reasoner tab, card "Inferred view" (#infcard, drawn by infCardDraw from renderReasoner): engine select (#infeng),
//     Start (POST /api/inference/run → polling of GET /api/inference/status), Stop (POST /api/inference/stop), counts,
//     unsatisfiable classes, "Assert all into <module>" (one POST /api/edit/add per inferred axiom).
//   - Header chip #infchip ("Inferred: HermiT ✓" / "inferring…" / "inferred: none"), sidebar select #viewsel
//     (Asserted | Inferred hierarchy → loadTree passes inferred=1, core.js).
//   - Entity pages: infRows (called through E.inf by descriptionSections, entities.js) appends the inferred rows to
//     the hierarchy sections of classes / properties; infIndividual (called by show) fetches POST
//     /api/inference/individual lazily for an individual and appends its inferred types / property values to the
//     sections (spinner in the titles meanwhile, errors inline). Every inferred row (.prow.inferred, pale
//     --inf-bg highlight, tooltip "Inferred by <engine>") carries an assert action: infAssert opens a popover with
//     the target module (default: the module declaring the entity, GET /api/graph_of) and posts /api/edit/add; the
//     page is re-rendered, so the row comes back as a normal asserted row.
//   Globals defined here: INF, infActive, infViewOn, infEngineName, infLoad, infPoll, infStart, infStop, infCardDraw,
//   infAssertAll, infRows, infRow, infIndividual, infAssert.
//   Globals used from other files: $, api, esc, entLink, ic, loadList, listKind, selIri, modules, ontoData (core.js /
//   axioms.js); post, short, jsIri, litRender, refreshChanges, show, ICON, RDF, OWLNS, XSDNS (entities.js).

// ---------- state ----------
/** Inferred-view state: tbox = /api/inference/tbox payload (null when inactive), poll = status timer. */
const INF = { tbox: null, poll: null };
/** True while a classification result exists (the inferred rows / tree / chip are shown). @returns {boolean} */
const infActive = () => !!(INF.tbox && INF.tbox.active);
/** True when the sidebar hierarchy is in Inferred mode (result present and #viewsel = inferred). @returns {boolean} */
const infViewOn = () => infActive() && $('#viewsel') && $('#viewsel').value === 'inferred';
/** Display name of the engine of the current result. @returns {string} */
const infEngineName = () => ({ hermit: 'HermiT', pellet: 'Pellet' })[INF.tbox && INF.tbox.engine] || 'the reasoner';

/**
 * Fetch the current result (GET /api/inference/tbox) into INF.tbox and refresh everything that depends on it: the
 * header chip, the sidebar view select, the Reasoner card.
 * @returns {Promise<Object>} the payload.
 */
function infLoad() {
	return api('/api/inference/tbox', {}).then((d) => {
		INF.tbox = d.active ? d : null;
		infChip();
		infViewSel();
		infCardDraw();
		return d;
	});
}
/**
 * Header chip #infchip: "Inferred: <engine> ✓" (ok, "stale" warning when the index changed since the run),
 * "inferring…" (running) or "inferred: none".
 * @param {boolean} [running] a classification is in progress.
 * @returns {void}
 */
function infChip(running) {
	const c = $('#infchip');
	if (!c) return;
	if (running) {
		c.textContent = 'inferring…';
		c.className = 'chip run';
	} else if (infActive()) {
		c.textContent = `Inferred: ${infEngineName()} ✓`;
		c.className = 'chip ' + (INF.tbox.stale ? 'warn' : 'ok');
		c.title = INF.tbox.stale
			? 'The index changed since the classification: restart it in the Reasoner tab'
			: `Inferred view active (${infEngineName()}, ${INF.tbox.when}): open the Reasoner tab`;
	} else {
		c.textContent = 'inferred: none';
		c.className = 'chip';
		c.title = 'No inferred view: start one in the Reasoner tab';
	}
}
/**
 * Sidebar view select #viewsel: visible only while a result exists; falling back to Asserted (and reloading the
 * tree) when the result disappears.
 * @returns {void}
 */
function infViewSel() {
	const s = $('#viewsel');
	if (!s) return;
	const on = infActive();
	s.style.display = on ? '' : 'none';
	if (!on && s.value === 'inferred') {
		s.value = 'asserted';
		loadList();
	}
}
/**
 * Poll GET /api/inference/status: while running, update the chip / card status and re-poll every 1.5 s; when it
 * stops, reload the result (infLoad), show the error of the run (if any) in the card and refresh the pages that
 * depend on the result (current entity, hierarchy).
 * @returns {void}
 */
function infPoll() {
	clearTimeout(INF.poll);
	api('/api/inference/status', {}).then((st) => {
		if (st.running) {
			infChip(true);
			const s = $('#infstatus');
			if (s)
				s.textContent = `running ${{ hermit: 'HermiT', pellet: 'Pellet' }[st.engine] || st.engine}… ${st.seconds}s`;
			INF.poll = setTimeout(infPoll, 1500);
			return;
		}
		const was = infActive();
		infLoad().then(() => {
			if (st.error) {
				const s = $('#infstatus');
				if (s) s.innerHTML = `<span class="err" style="white-space:pre-wrap">${esc(st.error)}</span>`;
			}
			if (was !== infActive() || infActive()) infRefreshPages();
		});
	});
}
/** Re-render what shows inferred data: the entity open in #detail and the sidebar tree (when hierarchical). @returns {void} */
function infRefreshPages() {
	if (selIri && $('#detail .epanel')) show(encodeURIComponent(selIri));
	if (listKind() !== tab) loadList();
}

// ---------- Reasoner tab card ----------
/** "Start" button: POST /api/inference/run {engine} then poll the status. @returns {void} */
function infStart() {
	const engine = $('#infeng').value;
	$('#infstatus').textContent = 'starting…';
	post('/api/inference/run', { engine }).then((r) => {
		if (!r.started) $('#infstatus').textContent = r.reason || 'not started';
		infPoll();
	});
}
/** "Stop" button: POST /api/inference/stop (drops the result), then refresh chip / select / card / pages. @returns {void} */
function infStop() {
	post('/api/inference/stop', {}).then(() => infLoad().then(infRefreshPages));
}
/**
 * Draw the "Inferred view" card (#infcard of the Reasoner tab) from INF.tbox: description + engine select, Start / Stop
 * buttons and status, then — when a result exists — the counts, the unsatisfiable classes as links and the "Assert all
 * into <module>" row. No-op when the tab has not been rendered yet.
 * @returns {void}
 */
function infCardDraw() {
	const box = $('#infcard');
	if (!box) return;
	const t = INF.tbox;
	const engSel = `<select id="infeng"><option value="hermit">HermiT</option><option value="pellet">Pellet</option></select>`;
	let h = `<h2>Inferred view</h2>
    <div class="dt" style="margin:4px 0 8px">Classifies the TBox/RBox closure (every class and property axiom of the workspace, no individuals) with ${engSel} and shows what the reasoner adds next to the asserted axioms: inferred superclasses / equivalences in the entity pages and the class tree (<b>Inferred</b> view in the Entities sidebar), unsatisfiable classes under <code>owl:Nothing</code>. Individuals are inferred on demand (their 1-hop neighbourhood) when their page opens. Each inferred row can be asserted into a module.</div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <button class="ibtn primary" style="margin:0" onclick="infStart()" title="Classify the TBox/RBox closure with the selected reasoner in the background (the viewer keeps working; the result is saved per workspace)">${ic('play')} Start</button>
      <button class="ibtn" style="margin:0" onclick="infStop()" ${t ? '' : 'disabled'} title="Stop the running classification and discard the current inferred result (the inferred view goes back to none)">${ic('close')} Stop</button>
      <span id="infstatus" class="dt"></span></div>`;
	if (t) {
		const c = t.counts;
		const eng = infEngineName();
		h += `<div style="margin-top:10px"><b>${eng}</b> · ${t.seconds}s · ${esc(t.when)} · KB: ${t.n_classes} classes, ${t.n_properties} properties from ${(t.kb.schema_files || []).join(', ')}${t.stale ? ' <span class="chip warn">index changed since the run</span>' : ''}</div>
      <div class="dt" style="margin-top:6px">inferred subclass axioms: <b>${c.subclass}</b> · equivalences: <b>${c.equivalent}</b> · unsatisfiable classes: <b>${c.unsatisfiable}</b> · property axioms: <b>${c.properties}</b></div>`;
		const unsat = Object.keys(t.classes).filter((i) => t.classes[i].unsatisfiable);
		h += `<div style="margin-top:6px"><b>Unsatisfiable classes:</b> ${
			unsat.length
				? unsat
						.map(
							(i) =>
								`<span style="margin-right:8px">${entLink(t.nodes[i] || { iri: i, name: short(i), kind: 'class' })}</span>`
						)
						.join('')
				: 'none ✓'
		}</div>`;
		h += `<div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span>Assert all into</span>
        <select id="infmod">${modules.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('')}</select>
        <button class="ibtn" style="margin:0" onclick="infAssertAll()" ${t.axioms.length ? '' : 'disabled'} title="Add every inferred subclass / sub-property / equivalence axiom to the selected module as asserted axioms (pending until Save)">${ic('add')} Assert ${t.axioms.length} axiom${t.axioms.length === 1 ? '' : 's'}</button>
        <span id="infasum" class="dt"></span></div>`;
	}
	const cur = $('#infeng') && $('#infeng').value;
	box.innerHTML = h;
	if (cur) $('#infeng').value = cur;
	else if (t) $('#infeng').value = t.engine;
}
/**
 * "Assert all" button: POST /api/edit/add for every inferred TBox axiom (INF.tbox.axioms: subclass, sub-property and
 * equivalence pairs; unsatisfiability is not an axiom) into the module of #infmod, sequentially; then a summary
 * (added / already present / errors), the changes widget and the result (the asserted axioms leave the diff).
 * @returns {void}
 */
function infAssertAll() {
	const t = INF.tbox;
	if (!t || !t.axioms.length) return;
	const graph = $('#infmod').value;
	if (!confirm(`Add ${t.axioms.length} inferred axiom(s) to ${graph} as asserted axioms?`)) return;
	const sum = { added: 0, present: 0, errors: [] };
	const out = $('#infasum');
	out.textContent = 'asserting…';
	t.axioms
		.reduce(
			(chain, a) =>
				chain.then(() =>
					post('/api/edit/add', { s: a.s, p: a.p, o: a.o, graph }).then((r) => {
						if (r.error) sum.errors.push(`${short(a.s)} → ${short(a.o)}: ${r.error}`);
						else if (r.added) sum.added++;
						else sum.present++;
					})
				),
			Promise.resolve()
		)
		.then(() => {
			out.innerHTML =
				`${sum.added} added, ${sum.present} already present` +
				(sum.errors.length
					? `, ${sum.errors.length} error(s): <span class="err">${esc(sum.errors.join('; '))}</span>`
					: '') +
				' — remember to Save.';
			refreshChanges();
			infLoad().then(infRefreshPages);
		});
}

// ---------- entity pages ----------
/**
 * Inferred rows of a hierarchy section of a class / property (Equivalent To, SubClass Of, SubProperty Of): the entries
 * of INF.tbox for the entity, minus what the page already shows as asserted (own and symmetric rows); an unsatisfiable
 * class gets an "owl:Nothing" row (not assertable) in Equivalent To.
 * @param {Object} E entityContext (entities.js).
 * @param {string} key 'parents' | 'equivalent'.
 * @param {string} piri Predicate of the section (rdfs:subClassOf, owl:equivalentClass, …).
 * @returns {string} HTML ('' when the inferred view is inactive or nothing is inferred).
 */
function infRows(E, key, piri) {
	if (!infActive()) return '';
	const t = INF.tbox;
	const e = (E.kind === 'class' ? t.classes : t.properties)[E.n.iri];
	if (!e) return '';
	const shown = new Set(((E.byP[piri] || {}).values || []).map((v) => v.iri));
	((E.d.incoming || []).find((g) => g.piri === piri) || { values: [] }).values.forEach((v) => shown.add(v.iri));
	let h = (e[key] || [])
		.filter((iri) => !shown.has(iri))
		.map((iri) => infRow(E.n.iri, piri, t.nodes[iri] || { iri, name: short(iri), kind: E.kind }))
		.join('');
	if (key === 'equivalent' && e.unsatisfiable)
		h += infRow(
			E.n.iri,
			piri,
			t.nodes[OWLNS + 'Nothing'] || { iri: OWLNS + 'Nothing', name: 'owl:Nothing', kind: 'class', builtin: true },
			{
				note: ' <span class="dt">(unsatisfiable class)</span>',
				noassert: true
			}
		);
	return h;
}
/**
 * One inferred row: value (entity link or literal) with the "inferred" tag, the tooltip "Inferred by <engine>" and,
 * unless `o.noassert`, the assert action (infAssert popover).
 * @param {string} s Subject IRI.
 * @param {string} p Predicate IRI.
 * @param {Object} v Value: an entity node {iri, name, kind, …} or a literal {lit, dt} (dt = datatype IRI or null).
 * @param {Object} [o] Options: note (HTML appended to the value), noassert (no action), pred (HTML prefix, e.g. the
 *   property name of an assertion).
 * @returns {string} HTML.
 */
function infRow(s, p, v, o = {}) {
	const lit = 'lit' in v;
	const val = lit ? litRender({ lit: v.lit, dt: v.dt ? short(v.dt) : null }) : entLink(v);
	const args = `event,${jsIri(s)},'${esc(p)}',${lit ? 'null' : `'${esc(v.iri)}'`},${lit ? jsIri(v.lit) : 'null'},${lit && v.dt ? `'${esc(v.dt)}'` : 'null'}`;
	const act = o.noassert ? '' : `<span class="acts">${actIcon('', 'assert', `infAssert(${args})`)}</span>`;
	return `<div class="prow inferred" title="Inferred by ${esc(infEngineName())}"><div class="val">${o.pred || ''}${val}${o.note || ''}<span class="inftag">inferred</span></div>${act}</div>`;
}
/**
 * The section element of the entity view with a given title (data-sect of sectHtml); the anonymous-individual cards
 * nested in the rows are skipped (direct child of a panel body).
 * @param {string} title
 * @returns {Element|null}
 */
const infSection = (title) => document.querySelector(`#detail .epanel .body > .psec[data-sect="${title}"]`);
/**
 * Append rows to a section: the section leaves its "blank" state and its counter is updated.
 * @param {string} title Section title. @param {string} rows HTML rows (prow).
 * @returns {void}
 */
function infAppend(title, rows) {
	const sec = infSection(title);
	if (!sec || !rows) return;
	sec.insertAdjacentHTML('beforeend', rows);
	sec.classList.remove('blank');
	const n = sec.querySelectorAll(':scope > .prow').length;
	let pc = sec.querySelector('.ptitle .pcount');
	if (!pc) {
		pc = document.createElement('span');
		pc.className = 'pcount';
		sec.querySelector('.ptitle').firstChild.after(pc);
	}
	pc.textContent = `(${n})`;
}
/**
 * Inferred types and property values of the individual shown in #detail, requested lazily while the inferred view is
 * active: a spinner in the titles of Types / Object property assertions / Data property assertions during the POST
 * /api/inference/individual {iri, engine} call, then the inferred rows appended to those sections (or the error
 * inline under Types). Ignored when the user moved to another entity meanwhile.
 * @param {string} iri Individual IRI.
 * @returns {void}
 */
function infIndividual(iri) {
	if (!infActive()) return;
	const titles = ['Types', 'Object property assertions', 'Data property assertions'];
	titles.forEach((t) => {
		const sec = infSection(t);
		if (sec)
			sec
				.querySelector('.ptitle')
				.insertAdjacentHTML(
					'beforeend',
					`<span class="infspin" title="inferring with ${esc(infEngineName())}…"></span>`
				);
	});
	post('/api/inference/individual', { iri, engine: INF.tbox.engine }).then((r) => {
		if (selIri !== iri) return;
		document.querySelectorAll('#detail .infspin').forEach((x) => x.remove());
		if (r.error) {
			const sec = infSection('Types');
			if (sec)
				sec.insertAdjacentHTML(
					'beforeend',
					`<div class="err" style="padding-left:10px;white-space:pre-wrap">Inference failed: ${esc(r.error)}</div>`
				);
			return;
		}
		const pred = (p) => `<b style="font-size:12px">${esc(p.name)}</b> `;
		infAppend('Types', r.types.map((v) => infRow(iri, RDF + 'type', v)).join(''));
		infAppend('Object property assertions', r.obj.map((a) => infRow(iri, a.p.iri, a.o, { pred: pred(a.p) })).join(''));
		infAppend(
			'Data property assertions',
			r.data.map((a) => infRow(iri, a.p.iri, { lit: a.lit, dt: a.dt }, { pred: pred(a.p) })).join('')
		);
	});
}
/**
 * Assert action of an inferred row: a popover (.menu) at the click position with the target module (default: the
 * module declaring the subject, GET /api/graph_of) and an "Assert" button → POST /api/edit/add {s, p, o | lit, dt,
 * graph}; on success the changes widget, the result (infLoad) and the page are refreshed, so the row comes back as an
 * asserted one. Closes on any click outside.
 * @param {MouseEvent} ev Click event.
 * @param {string} s Subject IRI. @param {string} p Predicate IRI. @param {?string} o Object IRI.
 * @param {?string} lit Literal value. @param {?string} dt Datatype IRI of the literal.
 * @returns {void}
 */
function infAssert(ev, s, p, o, lit, dt) {
	ev.stopPropagation();
	document.querySelectorAll('.menu').forEach((m) => m.remove());
	const m = document.createElement('div');
	m.className = 'menu infpop';
	m.innerHTML =
		`<span class="dt">Assert into</span> <select>${modules.map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join('')}</select>` +
		`<button class="ibtn primary" style="margin:0" title="Add this inferred axiom to the selected module as an asserted axiom (pending until Save)">${ic('add')} Assert</button>`;
	m.onclick = (e) => e.stopPropagation(); // clicks inside keep the popover open
	document.body.appendChild(m);
	// anchored under the clicked icon (page coordinates: the popover lives in body), kept inside the viewport
	// (measured once in the DOM: the icon sits at the right edge of its row)
	const r = (ev.currentTarget || ev.target).getBoundingClientRect();
	m.style.left = Math.max(8, Math.min(r.left + window.scrollX, window.innerWidth - m.offsetWidth - 12)) + 'px';
	m.style.top = r.bottom + window.scrollY + 4 + 'px';
	const sel = m.querySelector('select');
	api('/api/graph_of', { iri: s }).then((g) => {
		if (g.graph && modules.includes(g.graph)) sel.value = g.graph;
	});
	m.querySelector('button').onclick = () => {
		const body = { s, p, graph: sel.value };
		if (o) body.o = o;
		else {
			body.lit = lit;
			if (dt) body.dt = dt;
		}
		post('/api/edit/add', body).then((r) => {
			m.remove();
			if (r.error) {
				alert(r.error);
				return;
			}
			refreshChanges();
			infLoad().then(infRefreshPages);
		});
	};
	setTimeout(() => document.addEventListener('click', () => m.remove(), { once: true }), 0);
}
