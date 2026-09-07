// Built-in view "Fuzzy" — self-contained package (delete this folder to remove the view).
// Shared helpers come from the kit bundle (static/js): see PLUGINS.md.

/** One CSV field: quoted, inner quotes doubled. @returns {string} */
const csvq = (s) => '"' + String(s ?? '').replace(/"/g, '""') + '"';
function renderFuzzyTab() {
	api('/api/fuzzy', {}).then((d) => {
		const G = d.groups,
			order = ['datatype', 'class', 'objprop', 'dataprop', 'individual', 'annprop'];
		const title = {
			datatype: 'Fuzzy datatypes and modifiers',
			class: 'Fuzzy classes',
			objprop: 'Object property',
			dataprop: 'Data property',
			individual: 'Individuals',
			annprop: 'Annotation property'
		};
		// intro card: total + colour legend
		let h = `<div class="card" style="max-width:none"><h2>Fuzzy entities <span class="count">(${d.total} annotated <code>sdf:isFuzzy true</code>)</span></h2>
      <div class="dt legend" style="margin-top:4px">Colour legend: ${dot('class', true)} fuzzy class · ${dot('class')} crisp class · ${dot('datatype', true)} fuzzy datatype · ${dot('datatype')} crisp datatype. Criterion: fuzzyLabel (datatype, modifiers, weighted/OWA concepts) or a class whose definition depends on fuzzy entities (TerritoryWith* bridge classes, composites).</div></div>`;
		for (const k of order) {
			const items = G[k];
			if (!items || !items.length) continue;
			// sub-group key: datatypes by fuzzyLabel shape (or 'modifiers'); classes = fuzzy concepts (by shape),
			// TerritoryWith*/TerritoryIn* bridge classes, or composites
			const sub = {};
			items.forEach((n) => {
				const key =
					n.kind === 'datatype'
						? n.fuzzyType === 'modifier'
							? 'modifiers'
							: n.shape || 'datatype'
						: n.fuzzyType === 'concept'
							? 'concepts ' + (n.shape || '')
							: n.name.startsWith('TerritoryWith') || n.name.startsWith('TerritoryIn')
								? 'bridge classes (∃feature.Datatype)'
								: 'composites (intersections/aggregations)';
				(sub[key] = sub[key] || []).push(n);
			});
			h += `<div class="card" style="max-width:none;margin-top:14px"><h2>${title[k] || k} <span class="count">(${items.length})</span></h2>`;
			for (const [sk, list] of Object.entries(sub).sort()) {
				h +=
					`<div class="sect"><h3>${esc(sk)} <span class="count">(${list.length})</span></h3><div style="display:flex;flex-wrap:wrap;gap:4px 18px">` +
					list
						.map(
							(n) =>
								`<div class="item" style="padding:2px 6px" onclick="document.querySelector('#maintabs [data-mt=entities]').click();show('${encodeURIComponent(n.iri)}')">${dot(n.kind, true)}${esc(n.name)}${n.label && n.label !== n.name ? ` <span class="dt">${esc(n.label)}</span>` : ''}</div>`
						)
						.join('') +
					`</div></div>`;
			}
			h += `</div>`;
		}
		$('#tab-fuzzy').innerHTML = h;
	});
}
const METRIC_GROUPS = [
	// same names and order as the OWL API's "Ontology metrics" view
	[
		'Metrics',
		[
			'Axiom',
			'Logical axiom count',
			'Declaration axioms count',
			'Class count',
			'Object property count',
			'Data property count',
			'Individual count',
			'Annotation property count'
		]
	],
	['Class axioms', ['SubClassOf', 'EquivalentClasses', 'DisjointClasses', 'GCI count', 'Hidden GCI Count']],
	[
		'Object property axioms',
		[
			'SubObjectPropertyOf',
			'EquivalentObjectProperties',
			'InverseObjectProperties',
			'DisjointObjectProperties',
			'FunctionalObjectProperty',
			'InverseFunctionalObjectProperty',
			'TransitiveObjectProperty',
			'SymmetricObjectProperty',
			'AsymmetricObjectProperty',
			'ReflexiveObjectProperty',
			'IrreflexiveObjectProperty',
			'ObjectPropertyDomain',
			'ObjectPropertyRange',
			'SubPropertyChainOf'
		]
	],
	[
		'Data property axioms',
		[
			'SubDataPropertyOf',
			'EquivalentDataProperties',
			'DisjointDataProperties',
			'FunctionalDataProperty',
			'DataPropertyDomain',
			'DataPropertyRange'
		]
	],
	[
		'Individual axioms',
		[
			'ClassAssertion',
			'ObjectPropertyAssertion',
			'DataPropertyAssertion',
			'NegativeObjectPropertyAssertion',
			'NegativeDataPropertyAssertion',
			'SameIndividual',
			'DifferentIndividuals'
		]
	],
	['Annotation axioms', ['AnnotationAssertion', 'AnnotationPropertyDomain', 'AnnotationPropertyRangeOf']],
	['Datatype axioms (extra, not among the OWL API axiom types)', ['Datatype count', 'DatatypeDefinition']]
];

registerView({
	id: 'fuzzy',
	title: 'Fuzzy',
	tooltip: 'Every fuzzy entity of the workspace (sdf:isFuzzy) grouped by kind, with its fuzzy definition',
	render: () => renderFuzzyTab(),
});
