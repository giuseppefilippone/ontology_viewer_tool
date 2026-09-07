// query.js — shared KIT: Manchester keywords, SPARQL prefixes and the autocomplete used across the app.
// The DL Query / Help / Rules / SPARQL views live in plugins/builtin/<id>/view.js.

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
