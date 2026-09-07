// Built-in view "Help" — self-contained package (delete this folder to remove the view).
// Shared helpers come from the kit bundle (static/js): see PLUGINS.md.

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

registerView({
	id: 'help',
	title: 'Help',
	tooltip: 'Reference tables: DL / Fuzzy DL notation, FuzzyDL and Manchester keywords, SWRL built-ins, SPARQL prefixes',
	render: () => renderHelp(),
});
