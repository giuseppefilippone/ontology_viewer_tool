// axioms.js — shared LaTeX/CSV KIT (texEsc, dlToTex, downloadText, csvq); the FDL / Axioms /
// Fuzzy / Ontology-info views live in plugins/builtin/<id>/view.js. Original header:
// Axioms tab (DL / FuzzyDL), LaTeX/PDF export helpers, Ontology info metrics, FDL tab.
//
// Overview
//   Classic script sharing the global scope with the other files loaded by static/index.html, in this
//   order: core.js, entities.js, axioms.js (this file), graphs.js, query.js, reasoner.js, main.js.
//   Sections:
//     1. FDL tab (#tab-fdl): paginated view of the FuzzyDL text generated for the import closure of
//        the active ontology (GET /api/fdl, POST /api/fdl/generate, GET /api/export_file).
//     2. Axioms tab (#tab-axioms): TBox/RBox + paginated ABox of one module or of the closure, shown
//        in DL / fuzzy DL / FuzzyDL notation (GET /api/axioms), with LaTeX and PDF export (POST /api/pdf).
//     3. LaTeX helpers shared by the two exports: texEsc, dlToTex, downloadText, axiomsTex, LONGTABLE_ROWS.
//     4. Fuzzy tab (#tab-fuzzy): fuzzy entities (annotation or equivalence) grouped by kind and shape (GET /api/fuzzy).
//     5. Ontology info tab (#tab-ontology): ontology header, imports, prefixes, general class axioms,
//        OWL API-style metrics of the active module and of its import closure, breakdown by module with
//        pie charts, CSV / LaTeX / PDF export of the metrics (GET /api/ontology, POST /api/workspace/remove,
//        POST /api/pdf).
//   Globals defined here: fdlState, axState, ontoData, activeOnt, METRIC_GROUPS, LONGTABLE_ROWS, texEsc,
//     window._bp (panels of the bottom tabs of the Ontology info card) and the functions below.
//     renderFdl / renderAxioms / renderFuzzyTab / renderOntology are called by the main-tab switch in
//     core.js; drawOntology by core.js (setCountAnn) and main.js; ensureOnto / ontoData / activeOnt are
//     also used by entities.js, graphs.js and query.js.
//   Globals used from other files: $, api, esc, dot, fmtBytes, countAnn, setCountAnn, fillScope, scope,
//     page, loadList (core.js); post, short, modules, show, renameOntologyIri, ontAddAnnotation,
//     ontRemoveAnnotation, ontAddImport, ontRemoveImport, renameNamespace (entities.js);
//     attachAutocomplete (query.js).
//   DOM ids owned: #tab-fdl (#fdlcount, #fdlq, #fdlinfo, #fdlstats, #fdlbody); #tab-axioms (#axcount,
//     #axgraph, #axnot, #axq, #axbody); #tab-fuzzy; #tab-ontology (#ontsel, #btabs, #bpanel, #annM,
//     #annX, radios name=xscope, #xsep, #xbtn, #xtex, #xpdf, #xinfo, checkboxes .xm).

// ---------- LaTeX helpers ----------
/**
 * Escapes a string for LaTeX text mode: backslash first (so the escapes added afterwards are not
 * re-escaped), then the special characters & % $ # _ { } get a backslash, ~ and ^ become the
 * \textasciitilde{} / \textasciicircum{} commands.
 * @param {*} s  value converted with String().
 * @returns {string} LaTeX-safe text.
 */
const texEsc = (s) =>
	// one pass, so the braces of \textbackslash{} etc. are not escaped again
	String(s).replace(
		/[\\&%$#_{}~^]/g,
		(c) => ({ '\\': '\\textbackslash{}', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}' })[c] || '\\' + c
	);
/**
 * Converts a DL / fuzzy DL axiom text (as produced by the server, with Unicode symbols) to LaTeX in
 * text mode: each DL symbol becomes its math command wrapped in $…$, identifiers (letters, digits,
 * '_', '@', '.', '-') are typeset with \path{} from the url package (upright, literal underscores,
 * breakable at _ . -), plain numbers and the remaining punctuation are escaped with texEsc, and the
 * ellipsis '…' becomes \dots{}. No italics.
 * @param {string} s  axiom text, e.g. "⟨Lithuania_2000:PoorCountry, 0.8⟩".
 * @returns {string} LaTeX fragment.
 */
function dlToTex(s) {
	// DL / fuzzy DL text → LaTeX in text mode: symbols in $…$, identifiers in \path{} (url package:
	// upright, literal underscores, breakable at _ . -), numbers and punctuation plain. No italics.
	const m = {
		'⊑': '\\sqsubseteq',
		'≡': '\\equiv',
		'⊓': '\\sqcap',
		'⊔': '\\sqcup',
		'¬': '\\neg',
		'∃': '\\exists',
		'∀': '\\forall',
		'⊤': '\\top',
		'⊥': '\\bot',
		'≥': '\\geq',
		'≤': '\\leq',
		'⁻': '{}^{-}',
		'⟨': '\\langle',
		'⟩': '\\rangle',
		'·': '\\cdot'
	};
	// split on the DL symbols (capturing group keeps them as odd elements); inside each non-symbol chunk
	// split again on identifier tokens (odd elements = identifiers: numbers stay plain, names → \path{})
	return s
		.split(/([⊑≡⊓⊔¬∃∀⊤⊥≥≤⁻⟨⟩·])/)
		.map((p) =>
			m[p] !== undefined
				? '$' + m[p] + '$'
				: p
						.split(/([A-Za-z0-9_@][A-Za-z0-9_@.\-]*)/)
						.map((x, i) =>
							i % 2 ? (/^[0-9.]+$/.test(x) ? x : '\\path{' + x + '}') : texEsc(x).replace(/…/g, '\\dots{}')
						)
						.join('')
		)
		.join('');
}
/**
 * Triggers a browser download of a text file built client-side (Blob + temporary <a download>).
 * @param {string} name  file name proposed to the user.
 * @param {string} text  file content.
 * @param {string} [mime='text/plain;charset=utf-8']  MIME type of the blob.
 */
function downloadText(name, text, mime) {
	const a = document.createElement('a');
	a.href = URL.createObjectURL(new Blob([text], { type: mime || 'text/plain;charset=utf-8' }));
	a.download = name;
	a.click();
	URL.revokeObjectURL(a.href);
}
