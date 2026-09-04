// query.js — DL Query (Manchester syntax, autocompletion), Help tables, SWRL / fuzzy rules, SPARQL.

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
// autocomplete for Manchester expressions: entities of the closure (index search) + keywords
const MANCHESTER_KW = [
	'some',
	'only',
	'value',
	'min',
	'max',
	'exactly',
	'Self',
	'and',
	'or',
	'not',
	'owl:Thing',
	'owl:Nothing',
	'xsd:integer',
	'xsd:decimal',
	'xsd:string',
	'xsd:boolean'
]; // DL keywords (∃ some, ∀ only)
// opts: {kinds:[entity kinds]|null, statics:[strings], entities:bool, sparql:bool (insert prefix:name), single:bool (whole value = one name)}
const SPARQL_PFX = {
	'http://www.semanticweb.org/ontologies/fuzzydl_ontology#': 'sdf:',
	'http://www.semanticweb.org/ontologies/fuzzydl_ontology/class#': 'cls:',
	'http://www.semanticweb.org/ontologies/fuzzydl_ontology/object-property#': 'op:',
	'http://www.semanticweb.org/ontologies/fuzzydl_ontology/data-property#': 'dp:',
	'http://www.semanticweb.org/ontologies/fuzzydl_ontology/datatype#': 'dt:',
	'http://www.semanticweb.org/ontologies/fuzzydl_ontology/individuals#': 'ind:',
	'http://www.semanticweb.org/ontologies/fuzzydl_ontology/territories#': 'terr:',
	'http://www.w3.org/2002/07/owl#': 'owl:',
	'http://www.w3.org/2000/01/rdf-schema#': 'rdfs:',
	'http://www.w3.org/1999/02/22-rdf-syntax-ns#': 'rdf:',
	'http://www.w3.org/2001/XMLSchema#': 'xsd:'
};
function attachAutocomplete(ta, opts) {
	opts = Object.assign(
		{ entities: true, keywords: true, kinds: null, statics: [], sparql: false, single: false, onPick: null },
		opts || {}
	);
	if (!ta || ta.dataset.ac) return;
	ta.dataset.ac = '1';
	if (!ta.parentNode.classList.contains('acwrap')) {
		const w = document.createElement('div');
		w.className = 'acwrap';
		w.style.cssText =
			'position:relative;display:' +
			(ta.tagName === 'TEXTAREA' ? 'block' : 'inline-block') +
			';width:' +
			(ta.tagName === 'TEXTAREA' ? '100%' : 'auto');
		ta.parentNode.insertBefore(w, ta);
		w.appendChild(ta);
	}
	const box = document.createElement('div');
	box.className = 'res';
	box.style.cssText =
		'display:none;position:absolute;z-index:40;max-height:220px;overflow:auto;background:#fff;border:1px solid var(--line);border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.15);font-size:13px;min-width:260px';
	ta.parentNode.style.position = 'relative';
	ta.parentNode.appendChild(box);
	let items = [],
		sel = 0,
		word = '',
		start = 0;
	const place = () => {
		box.style.left = '0px';
		box.style.top = ta.offsetTop + ta.offsetHeight + 2 + 'px';
	};
	const hide = () => {
		box.style.display = 'none';
		items = [];
	};
	const draw = () => {
		if (!items.length) {
			hide();
			return;
		}
		box.innerHTML = items
			.map(
				(it, i) =>
					`<div data-i="${i}" style="padding:5px 10px;cursor:pointer;display:flex;gap:6px;align-items:center;${i === sel ? 'background:#eef2ff' : ''}">${it.kind ? dot(it.kind, it.fuzzy) : '<span class="dt" style="width:10px;display:inline-block"></span>'}<span>${esc(it.name)}</span><span class="dt">${it.kind ? KL[it.kind] || '' : 'keyword'}</span></div>`
			)
			.join('');
		place();
		box.style.display = 'block';
		box.querySelectorAll('[data-i]').forEach(
			(el) =>
				(el.onmousedown = (e) => {
					e.preventDefault();
					pick(+el.dataset.i);
				})
		);
	};
	const fmt = (it) => {
		if (!it.iri) return it.name;
		if (opts.sparql) {
			for (const [ns, p] of Object.entries(SPARQL_PFX)) if (it.iri.startsWith(ns)) return p + it.iri.slice(ns.length);
			return '<' + it.iri + '>';
		}
		return /[\s()\[\]{},]/.test(it.name) ? `'${it.name}'` : it.name;
	};
	const pick = (i) => {
		const it = items[i];
		if (!it) return;
		const v = ta.value;
		const name = fmt(it);
		if (opts.single) {
			ta.value = name;
			if (it.iri) {
				ta.dataset.iri = it.iri;
				ta.title = it.iri;
			}
			hide();
			ta.dispatchEvent(new Event('input', { bubbles: true }));
			ta.dispatchEvent(new Event('change', { bubbles: true }));
			if (opts.onPick) opts.onPick(it); // e.g. open the picked entity
			return;
		}
		ta.value = v.slice(0, start) + name + ' ' + v.slice(ta.selectionStart);
		const c = start + name.length + 1;
		ta.setSelectionRange(c, c);
		hide();
		ta.focus();
		ta.dispatchEvent(new Event('change', { bubbles: true }));
	};
	ta.addEventListener('input', () => {
		const v = opts.single ? ta.value : ta.value.slice(0, ta.selectionStart);
		const m = opts.single ? [v, v] : /([A-Za-z0-9_:.@'?-]+)$/.exec(v);
		if (!m || m[1].length < (opts.statics.length || opts.keywords ? 1 : 2)) {
			hide();
			return;
		}
		word = m[1];
		start = opts.single ? 0 : ta.selectionStart - word.length;
		clearTimeout(ta._acT);
		ta._acT = setTimeout(() => {
			const w = word.replace(/^'/, '').replace(/^[a-z]+:/, '');
			const wl = w.toLowerCase();
			const st = opts.statics
				.filter((k) => k.toLowerCase().startsWith(wl) || k.toLowerCase().includes(wl))
				.map((k) => ({ name: k }));
			const kw = opts.keywords
				? MANCHESTER_KW.filter((k) => k.toLowerCase().startsWith(wl)).map((k) => ({ name: k }))
				: [];
			if (!opts.entities || w.length < 2) {
				items = [...st, ...kw];
				sel = 0;
				draw();
				return;
			}
			api('/api/search', { q: w }).then((d) => {
				let ents = d.items.filter((n) => n.kind && n.kind !== 'ontology');
				const kinds = typeof opts.kinds === 'function' ? opts.kinds() : opts.kinds;
				if (kinds) ents = ents.filter((n) => kinds.includes(n.kind));
				else ents = ents.filter((n) => n.kind !== 'individual' || w.length >= 3);
				items = [...st, ...kw, ...ents.slice(0, 12)];
				sel = 0;
				draw();
			});
		}, 150);
	});
	ta.addEventListener('keydown', (e) => {
		if (box.style.display === 'none') return;
		if (e.key === 'ArrowDown') {
			sel = Math.min(items.length - 1, sel + 1);
			draw();
			e.preventDefault();
		} else if (e.key === 'ArrowUp') {
			sel = Math.max(0, sel - 1);
			draw();
			e.preventDefault();
		} else if (e.key === 'Enter' || e.key === 'Tab') {
			pick(sel);
			e.preventDefault();
		} else if (e.key === 'Escape') {
			hide();
		}
	});
	ta.addEventListener('blur', () => setTimeout(hide, 150));
}
let dlData = null;
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

// ---------- Help: keywords, their Description Logic meaning and their natural-language meaning ----------
const HELP_TABLES = [
	[
		'Class expressions (Manchester syntax — DL Query, expression fields, general class axioms)',
		['Keyword / syntax', 'Description Logic', 'Meaning'],
		[
			['<code>A and B</code>', 'A ⊓ B', 'Individuals that belong to both A and B (intersection).'],
			['<code>A or B</code>', 'A ⊔ B', 'Individuals that belong to A or to B (union).'],
			['<code>not A</code>', '¬A', 'Individuals that do not belong to A (complement).'],
			[
				'<code>p some C</code>',
				'∃p.C',
				'Individuals having at least one p-successor that is a C (existential restriction).'
			],
			[
				'<code>p only C</code>',
				'∀p.C',
				'Individuals all of whose p-successors are C (universal restriction; an individual with no p-successor satisfies it).'
			],
			['<code>p value a</code>', '∃p.{a}', 'Individuals related through p to the specific individual (or literal) a.'],
			['<code>p Self</code>', '∃p.Self', 'Individuals related to themselves through p.'],
			[
				'<code>p min n C</code>',
				'≥ n p.C',
				'Individuals with at least n p-successors that are C (unqualified when C is omitted).'
			],
			['<code>p max n C</code>', '≤ n p.C', 'Individuals with at most n p-successors that are C.'],
			['<code>p exactly n C</code>', '= n p.C', 'Individuals with exactly n p-successors that are C.'],
			[
				'<code>{a, b, c}</code>',
				'{a, b, c}',
				'The class whose members are exactly the listed individuals (nominal / enumeration).'
			],
			['<code>owl:Thing</code>', '⊤', 'The top class: every individual.'],
			['<code>owl:Nothing</code>', '⊥', 'The bottom class: no individual (unsatisfiable).'],
			[
				'<code>( … )</code>',
				'( … )',
				'Grouping; <code>and</code> binds tighter than <code>or</code>, <code>not</code> applies to the following expression.'
			],
			[
				"<code>'Name with spaces'</code>",
				'—',
				'Quote a local name that contains spaces; plain names are the local names of the workspace entities (autocompleted).'
			]
		]
	],
	[
		'Data ranges (data properties, datatype definitions)',
		['Syntax', 'Description Logic', 'Meaning'],
		[
			[
				'<code>xsd:integer</code>, <code>xsd:decimal</code>, <code>xsd:string</code>, <code>xsd:boolean</code>',
				'datatype',
				'A built-in XML Schema datatype.'
			],
			[
				'<code>xsd:decimal[>= 0, <= 100]</code>',
				'decimal[≥ 0, ≤ 100]',
				'Values of the datatype restricted by facets: <code>&gt;=</code> minInclusive, <code>&lt;=</code> maxInclusive, <code>&gt;</code> minExclusive, <code>&lt;</code> maxExclusive, <code>length</code>, <code>minLength</code>, <code>maxLength</code>, <code>pattern</code>.'
			],
			['<code>{1, 2, 3}</code>', '{1, 2, 3}', 'Enumeration of literal values.'],
			[
				'<code>f some D</code>',
				'∃f.D',
				'Individuals with a value of the data property f in the data range D (e.g. a fuzzy datatype).'
			]
		]
	],
	[
		'Axioms (as shown in the Axioms tab and in the entity panels)',
		['Axiom', 'Description Logic', 'Meaning'],
		[
			[
				'SubClass Of',
				'C ⊑ D',
				'Every C is a D (class inclusion). With an anonymous subject it is a general class axiom (GCI).'
			],
			[
				'Equivalent To',
				'C ≡ D',
				'C and D have exactly the same individuals (a class with such an axiom is a <i>defined</i> class, icon ≡).'
			],
			['Disjoint With', 'C ⊓ D ⊑ ⊥', 'No individual belongs to both C and D.'],
			['Disjoint Union Of', 'C ≡ C₁ ⊔ … ⊔ Cₙ, Cᵢ ⊓ Cⱼ ⊑ ⊥', 'C is the union of pairwise disjoint classes.'],
			['Domain (object/data property)', '∃p.⊤ ⊑ C', 'Whatever has a p-value is a C.'],
			['Range', '⊤ ⊑ ∀p.C', 'Every p-value is a C (or a value of the datatype, for data properties).'],
			['SubProperty Of', 'p ⊑ q', 'Whenever p(a, b) holds, q(a, b) holds.'],
			['Inverse Of', 'p ≡ q⁻', 'p(a, b) holds exactly when q(b, a) holds.'],
			['SuperProperty Of (Chain)', 'p₁ ∘ p₂ ⊑ q', 'If p₁(a, b) and p₂(b, c) then q(a, c).'],
			[
				'Target for Key',
				'HasKey(C: p₁ … pₙ)',
				'Two named C individuals with the same values for the key properties are the same individual.'
			],
			['Types / ClassAssertion', 'C(a) — fuzzy DL: a:C', 'The individual a is an instance of C.'],
			[
				'Object / data property assertion',
				'p(a, b) — fuzzy DL: (a,b):p',
				'a is related to b (or to the value b) through p.'
			],
			['Same / Different individuals', 'a = b · a ≠ b', 'a and b denote the same individual / different individuals.'],
			['Negative property assertion', '¬p(a, b)', 'a is NOT related to b through p.']
		]
	],
	[
		'Property characteristics',
		['Characteristic', 'Description Logic', 'Meaning'],
		[
			['Functional', 'fun(p): ⊤ ⊑ ≤ 1 p', 'Each individual has at most one p-value.'],
			['Inverse functional', 'fun(p⁻)', 'Each value is the p-value of at most one individual (p works like a key).'],
			['Transitive', 'trans(p)', 'p(a, b) and p(b, c) imply p(a, c).'],
			['Symmetric', 'sym(p): p ≡ p⁻', 'p(a, b) implies p(b, a).'],
			['Asymmetric', 'asym(p)', 'p(a, b) excludes p(b, a).'],
			['Reflexive', 'ref(p)', 'Every individual is p-related to itself.'],
			['Irreflexive', 'irr(p)', 'No individual is p-related to itself.']
		]
	],
	[
		'Fuzzy DL (FuzzyDL syntax of fuzzy_dl_owl2 in brackets)',
		['Construct', 'Fuzzy DL notation', 'Meaning'],
		[
			[
				'Fuzzy class assertion (degree)',
				'⟨a:C, n⟩ — [(instance a C n)]',
				'a belongs to C with degree at least n ∈ [0,1] (the degrees shown next to types are lower bounds).'
			],
			[
				'Fuzzy role assertion',
				'⟨(a,b):R, n⟩ — [(related a b R n)]',
				'a is related to b through R with degree at least n.'
			],
			['Fuzzy inclusion', '⟨C ⊑ D, n⟩ — [(implies C D n)]', 'C is included in D with degree at least n.'],
			[
				'Left-shoulder datatype',
				'ls(a, b) — [left-shoulder(k1, k2, a, b)]',
				'Membership 1 up to a, decreasing linearly to 0 at b (e.g. LowPoverty).'
			],
			[
				'Right-shoulder datatype',
				'rs(a, b) — [right-shoulder(k1, k2, a, b)]',
				'Membership 0 up to a, increasing linearly to 1 at b (e.g. HighPoverty).'
			],
			['Triangular datatype', 'tri(a, b, c) — [triangular(k1, k2, a, b, c)]', 'Membership 0 at a, 1 at b, 0 at c.'],
			[
				'Trapezoidal datatype',
				'trz(a, b, c, d) — [trapezoidal(k1, k2, a, b, c, d)]',
				'Membership 0 at a, 1 between b and c, 0 at d.'
			],
			[
				'Crisp / linear datatype',
				'crisp(a, b) · lin(a, b)',
				'Membership 1 exactly in [a, b] / a linear ramp on the normalized domain.'
			],
			[
				'Datatype definition (k1, k2)',
				'D ≡ decimal[≥ k1, ≤ k2]',
				'The crisp range of values the fuzzy datatype is defined on.'
			],
			[
				'Modifier',
				'lm(c) · tm(a, b, c) — [linear-modifier(c) · triangular-modifier(a,b,c)]',
				'A function [0,1]→[0,1] applied to a membership degree (e.g. very).'
			],
			['Modified concept / datatype', 'very(C) — [(very C)]', 'The concept whose membership is modifier(μ_C(x)).'],
			[
				'Weighted sum',
				'0.35·A + 0.25·B + … — [(w-sum (0.35 A) (0.25 B) …)]',
				'Membership = weighted sum of the memberships of the components (weights sum to 1).'
			],
			[
				'Weighted min / max',
				'@wmin, @wmax — [(w-min …), (w-max …)]',
				'Membership = min/max of weighted component memberships.'
			],
			[
				'OWA / quantifier-guided OWA',
				'@owa[(w₁…wₙ)](C₁…Cₙ) — [(owa (w…) (C…))]',
				'Ordered weighted averaging: weights apply to the memberships sorted in decreasing order.'
			],
			[
				'Choquet / Sugeno / quasi-Sugeno',
				'@choquet, @sugeno, @quasisugeno',
				'Fuzzy integrals with respect to a fuzzy measure given by the weights.'
			],
			[
				'Fuzzy logic',
				'Łukasiewicz / Zadeh / Gödel — [(define-fuzzy-logic lukasiewicz)]',
				'The t-norm used for ⊓, ⊔, ¬ and ⊑ (Łukasiewicz: a ⊗ b = max(0, a+b−1)).'
			]
		]
	],
	[
		'SWRL rules (Rules tab)',
		['Syntax', 'Logic', 'Meaning'],
		[
			['<code>C(?x)</code>', 'C(x)', 'Class atom: x is a C.'],
			['<code>p(?x, ?y)</code>', 'p(x, y)', 'Object / data property atom.'],
			['<code>sameAs(?x, ?y)</code> · <code>differentFrom(?x, ?y)</code>', 'x = y · x ≠ y', 'Identity atoms.'],
			[
				'<code>swrlb:greaterThan(?v, 30)</code>',
				'built-in',
				'Built-in comparison/arithmetic/string predicates (swrlb: namespace).'
			],
			[
				'<code>body -> head</code>, atoms joined by <code>^</code>',
				'∀x… body → head',
				'Horn rule: if every body atom holds, the head atoms hold (DL-safe rules, evaluated by HermiT/Pellet, not by FuzzyDL).'
			],
			['Fuzzy rule degree', '⟨rule, n⟩', 'A degree annotation (fuzzyLabel) on the rule, Fuzzy OWL 2 style.']
		]
	],
	[
		'DL Query — "Query for"',
		['Option', 'Meaning'],
		[
			['Direct superclasses', 'Named classes that subsume the query expression with nothing in between.'],
			['Superclasses', 'All named classes that subsume the query expression (transitively).'],
			['Equivalent classes', 'Named classes equivalent to the query expression.'],
			['Direct subclasses / Subclasses', 'Named classes subsumed by the query expression (directly / transitively).'],
			[
				'Instances',
				'Individuals that satisfy the expression (evaluated on the asserted data of the index, with the subclass closure).'
			],
			[
				'Asserted vs HermiT',
				'Asserted: hierarchy read from the index (named classes). HermiT: the reasoner classifies the schema modules with a temporary class ≡ query (instances always come from the index).'
			]
		]
	]
];
function renderHelp() {
	const box = $('#tab-help');
	if (box.dataset.ready) return;
	box.dataset.ready = '1';
	box.innerHTML = `<div class="card" style="max-width:none"><h2>Help — keywords and notation</h2>
    <div class="dt" style="margin-top:4px">Notation: standard DL notation; fuzzy DL notation with degrees ⟨…, n⟩; FuzzyDL syntax = fuzzy_dl_owl2 reasoner input (.fdl export).</div>
    ${HELP_TABLES.map(([title, cols, rows]) => `<div class="sect"><h3>${title}</h3><div style="overflow-x:auto"><table class="props" style="font-size:13px"><tr>${cols.map((c) => `<td class="dt" style="font-weight:600">${c}</td>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c, i) => `<td style="${i === 0 ? 'white-space:nowrap;' : i === 1 ? 'font-family:ui-monospace,Menlo,monospace;white-space:nowrap;' : ''}vertical-align:top;padding:5px 10px 5px 0">${c}</td>`).join('')}</tr>`).join('')}</table></div></div>`).join('')}</div>`;
}
const RULE_EXAMPLES = [
	[
		'High poverty from the poverty rate',
		'TerritorialSystem(?t) ^ povertyRate(?t, ?v) ^ swrlb:greaterThan(?v, 30) -> TerritoryWithHighPoverty(?t)'
	],
	[
		'Basic-needs stress: poverty and unemployment',
		'TerritorialSystem(?t) ^ povertyRate(?t, ?p) ^ unemploymentRate(?t, ?u) ^ swrlb:greaterThan(?p, 20) ^ swrlb:greaterThan(?u, 10) -> BasicNeedsStress(?t)'
	],
	[
		'Clean-energy access ≥ 95 %',
		'TerritorialSystem(?t) ^ cleanEnergyAccessRate(?t, ?e) ^ swrlb:greaterThanOrEqual(?e, 95) -> TerritoryWithHighCleanEnergyAccess(?t)'
	],
	[
		'Extreme poverty of a country from an SDG 1.1.1 observation',
		'Observation(?o) ^ refersToIndicator(?o, Indicator_1.1.1_(a)) ^ hasLocation(?o, ?c) ^ hasValue(?o, ?v) ^ swrlb:greaterThan(?v, 40) -> ExtremePoverty(?c)'
	],
	[
		'Short distances (< 200 km)',
		'Distance(?d) ^ hasDistanceValue(?d, ?km) ^ swrlb:lessThan(?km, 200) -> ShortDistance(?d)'
	],
	[
		'Snapshots of the same country in consecutive years (arithmetic built-in)',
		'TerritorialSystem(?t) ^ hasLocation(?t, ?c) ^ referenceYear(?t, ?y) ^ TerritorialSystem(?u) ^ hasLocation(?u, ?c) ^ referenceYear(?u, ?y2) ^ swrlb:add(?y2, ?y, 1) -> differentFrom(?t, ?u)'
	],
	[
		'Decline: negative growth and rising unemployment',
		'TerritorialSystem(?t) ^ economicGrowthRate(?t, ?g) ^ unemploymentRate(?t, ?u) ^ swrlb:lessThan(?g, 0) ^ swrlb:greaterThan(?u, 12) -> EconomicStress(?t)'
	]
];
function runRule() {
	const text = $('#ruletext').value.trim();
	if (!text) {
		$('#ruleinfo').textContent = 'write a rule (or pick an example)';
		return;
	}
	const mode = $('#rulemode').value;
	$('#ruleinfo').textContent = 'running…';
	$('#ruleres').innerHTML = '';
	post('/api/rules/run', {
		text,
		mode: mode === 'index' ? 'index' : 'reasoner',
		engine: mode,
		individuals: window._ruleInds || [],
		limit: +$('#rulelimit').value
	}).then((d) => {
		if (d.error) {
			const inc = /inconsistent/i.test(d.error);
			$('#ruleinfo').textContent = inc
				? 'the rule makes the knowledge base INCONSISTENT for the chosen individuals (e.g. its head asserts a class disjoint from their types)'
				: 'error: ' + d.error;
			$('#ruleres').innerHTML = inc
				? `<pre class="expr">${esc(d.error.slice(0, 600))}</pre>`
				: d.log
					? `<pre class="expr">${esc(d.log)}</pre>`
					: '';
			return;
		}
		if (d.mode === 'pellet' || d.inferred_types) {
			// reasoner output
			$('#ruleinfo').textContent =
				`${d.engine || ''} ${d.seconds}s · ${d.classes} classes, ${d.individuals} individuals in the temporary KB`;
			$('#ruleres').innerHTML =
				`<div class="ptitle">Inferred types (${(d.inferred_types || []).length})</div>${(d.inferred_types || []).map(([i, t]) => `<div class="prow"><div class="val">${esc(short(t))}(<span class="expand" onclick="openEntity('${esc(i)}')">${esc(short(i))}</span>)</div></div>`).join('') || '<span class="dt">none — remember to add the individuals the rule should fire on</span>'}
${(d.unsatisfiable || []).length ? `<div class="err">unsatisfiable: ${d.unsatisfiable.map(short).join(', ')}</div>` : ''}`;
			return;
		}
		$('#ruleinfo').textContent =
			`${d.bindings.toLocaleString('en')} bindings · ${d.facts.length} derived facts (${d.new} not yet asserted)${d.truncated ? ' · truncated' : ''}`;
		$('#ruleres').innerHTML =
			`<div class="ptitle">Derived facts</div><div style="columns:2;column-gap:20px">${d.facts.map((f) => `<div style="break-inside:avoid;font-size:13px">${f.asserted ? '<span class="dt" title="already asserted">✓</span>' : '<span style="color:#2a9d8f" title="new (not asserted)">＋</span>'} ${f.s ? `<span class="expand" onclick="openEntity('${esc(f.s)}')">${esc(f.fact)}</span>` : esc(f.fact)}</div>`).join('') || '<span class="dt">no binding satisfies the body</span>'}</div>
      ${d.samples.length ? `<div class="ptitle" style="margin-top:10px">Bindings (first ${d.samples.length})</div><div style="overflow:auto"><table class="props"><tr>${d.vars.map((v) => `<td class="dt" style="font-weight:600">?${esc(v)}</td>`).join('')}</tr>${d.samples.map((b) => `<tr>${d.vars.map((v) => `<td>${esc(b[v] ?? '')}</td>`).join('')}</tr>`).join('')}</table></div>` : ''}`;
	});
}

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
      <div class="sect"><h3>Rules in the workspace <button class="ibtn" onclick="ruleForm()" title="Write a new SWRL rule and add it to a module (optional name, comment and fuzzy degree)">${ic('add')} Add rule</button></h3><div id="rulelist"><span class="dt">loading…</span></div></div></div>`;
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
		'SELECT ?c ?label WHERE { ?c sdf:isFuzzy true ; a owl:Class ; rdfs:label ?label }'
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
