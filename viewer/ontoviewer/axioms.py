"""Render the axioms of a module as DL (crisp) or FuzzyDL (fuzzy) text.

TBox/RBox: parsed with rdflib from the module file (cached per mtime) when the file
is small enough to hold anonymous class expressions; otherwise from the index
(named axioms only). ABox: from the index, paginated.

An axiom is "fuzzy" when it involves an entity annotated sdf:isFuzzy or carries a
fuzzy degree (owl:Axiom with fuzzyLabel) → rendered in FuzzyDL syntax
(the one produced by fuzzy_dl_owl2); otherwise in DL notation.
"""

import json
import re
import sqlite3
import xml.etree.ElementTree as ET

import rdflib
from rdflib.namespace import OWL, RDF, RDFS, XSD

from ontoviewer import reasoner, workspace

BASE = "http://www.semanticweb.org/ontologies/fuzzydl_ontology"
FL = rdflib.URIRef(BASE + "#fuzzyLabel")
IS_FUZZY = rdflib.URIRef(BASE + "#isFuzzy")
MAX_TBOX_FILE_MB = 80
_CACHE = {}
FACET = {"minInclusive": "≥", "maxInclusive": "≤", "minExclusive": ">", "maxExclusive": "<"}


def _disk_cache():
    """TBox lists survive server restarts: json next to the index, keyed by file+mtime."""
    p = workspace.db_path().with_suffix(".axioms.json")
    if "disk" not in _CACHE:
        try:
            _CACHE["disk"] = json.loads(p.read_text())
        except Exception:
            _CACHE["disk"] = {}
    return p, _CACHE["disk"]


def short(t):
    s = str(t)
    return s.rsplit("#", 1)[-1].rsplit("/", 1)[-1] if s.startswith("http") else s


def fdl_name(t):
    """FuzzyDL identifier of an entity: the same sanitisation the export and the reasoner use
    (``reasoner.fdl_safe``), so the Axioms tab shows the names the .fdl files really contain."""
    return reasoner.fdl_safe(short(t))


# ------------------------------------------------------------ fuzzyLabel → FDL


def fuzzy_label_fdl(name, xml, bounds=None):
    """(define-fuzzy-concept …) / (define-modifier …) / (define-concept …) from a fuzzyLabel.
    bounds = (k1, k2) of the datatype definition, as FuzzyDL expects."""
    try:
        root = ET.fromstring(xml.strip())
    except ET.ParseError:
        return None
    ft = root.get("fuzzyType")
    if ft == "datatype":
        d = root.find("Datatype")
        t = d.get("type")
        if t == "modified":
            return f"(define-concept {name} ({fdl_name(d.get('modifier'))} {fdl_name(d.get('base'))}))"
        ps = ", ".join(d.get(k) for k in "abcd" if d.get(k) is not None)
        k1, k2 = bounds if bounds else ("k1", "k2")
        return f"(define-fuzzy-concept {name} {t.replace('shoulder', '-shoulder')}({k1}, {k2}, {ps}))"
    if ft == "modifier":
        m = root.find("Modifier")
        if m.get("type") == "linear":
            return f"(define-modifier {name} linear-modifier({m.get('c')}))"
        return f"(define-modifier {name} triangular-modifier({m.get('a')}, {m.get('b')}, {m.get('c')}))"
    if ft == "concept":
        c = root.find("Concept")
        t = c.get("type")
        if t == "modified":
            return f"(define-concept {name} ({fdl_name(c.get('modifier'))} {fdl_name(c.get('base'))}))"
        if t.startswith("weighted") and t != "weighted":
            kw = {
                "weightedSum": "w-sum",
                "weightedSumZero": "w-sum-zero",
                "weightedMinimum": "w-min",
                "weightedMaximum": "w-max",
            }.get(t, t)
            parts = " ".join(f"({w.get('value')} {fdl_name(w.get('base'))})" for w in c.findall("Concept"))
            return f"(define-concept {name} ({kw} {parts}))"
        if t in ("owa", "choquet", "sugeno", "quasisugeno"):
            ws = " ".join(w.text for w in c.findall("Weights/Weight"))
            names = " ".join(fdl_name(re.sub(r"^Class\((.*)\)$", r"\1", n.text)) for n in c.findall("Names/Name"))
            return f"(define-concept {name} ({ {'quasisugeno': 'q-sugeno'}.get(t, t)} ({ws}) ({names})))"
        if t == "qowa":
            names = " ".join(fdl_name(n.text) for n in c.findall("Names/Name"))
            return f"(define-concept {name} (q-owa {fdl_name(c.get('quantifier'))} {names}))"
    if ft == "ontology":
        logic = root.find("Fuzzylogic")
        return f"(define-fuzzy-logic {logic.get('logic') if logic is not None else 'lukasiewicz'})"
    return None


def fuzzy_label_math(name, xml):
    """Fuzzy DL notation of a fuzzyLabel:
    d := ls(a,b) | rs(a,b) | tri(a,b,c) | trz(a,b,c,d) | lin(a,b) | crisp(a,b);  m := lm(c) | tm(a,b,c);
    m(C);  w1·C1 + … + wn·Cn;  @op[W](C1,…,Cn)."""
    try:
        root = ET.fromstring(xml.strip())
    except ET.ParseError:
        return None
    ft = root.get("fuzzyType")
    if ft == "datatype":
        d = root.find("Datatype")
        t = d.get("type")
        if t == "modified":
            return f"{name} ≡ {short(d.get('modifier'))}({short(d.get('base'))})"
        fn = {
            "leftshoulder": "ls",
            "rightshoulder": "rs",
            "triangular": "tri",
            "trapezoidal": "trz",
            "linear": "lin",
            "crisp": "crisp",
        }.get(t, t)
        return f"{name} ≡ {fn}({', '.join(d.get(k) for k in 'abcd' if d.get(k) is not None)})"
    if ft == "modifier":
        m = root.find("Modifier")
        if m.get("type") == "linear":
            return f"{name} ≡ lm({m.get('c')})"
        return f"{name} ≡ tm({m.get('a')}, {m.get('b')}, {m.get('c')})"
    if ft == "concept":
        c = root.find("Concept")
        t = c.get("type")
        if t == "modified":
            return f"{name} ≡ {short(c.get('modifier'))}({short(c.get('base'))})"
        if t == "weightedSum":
            return f"{name} ≡ " + " + ".join(f"{w.get('value')}·{short(w.get('base'))}" for w in c.findall("Concept"))
        if t.startswith("weighted") and t != "weighted":
            op = {"weightedSumZero": "wsum0", "weightedMinimum": "wmin", "weightedMaximum": "wmax"}.get(t, t)
            return (
                f"{name} ≡ @{op}("
                + ", ".join(f"{w.get('value')}·{short(w.get('base'))}" for w in c.findall("Concept"))
                + ")"
            )
        if t in ("owa", "choquet", "sugeno", "quasisugeno"):
            ws = ", ".join(w.text for w in c.findall("Weights/Weight"))
            names = ", ".join(short(re.sub(r"^Class\((.*)\)$", r"\1", n.text)) for n in c.findall("Names/Name"))
            return f"{name} ≡ @{t}[({ws})]({names})"
        if t == "qowa":
            names = ", ".join(short(n.text) for n in c.findall("Names/Name"))
            return f"{name} ≡ @qowa[{short(c.get('quantifier'))}]({names})"
    if ft == "ontology":
        logic = root.find("Fuzzylogic")
        return f"fuzzy logic: {logic.get('logic') if logic is not None else 'lukasiewicz'}"
    return None


def degree_of(xml):
    m = re.search(r'Degree value="([^"]+)"', xml or "")
    return m.group(1) if m else None


# ------------------------------------------------------------ TBox / RBox


def tbox(fname):
    """Schema axioms of one module: list of {kind, fuzzy, dl, fdl, s}."""
    path = workspace.ont_dir() / fname
    key = f"{path}@{path.stat().st_mtime}#v5"  # bump when the item format changes
    if key in _CACHE:
        return _CACHE[key]
    cpath, disk = _disk_cache()
    if key in disk:
        _CACHE[key] = disk[key]
        return disk[key]
    if path.stat().st_size > MAX_TBOX_FILE_MB * 1e6:
        return _store(key, path, _tbox_from_index(fname))
    g = rdflib.Graph()
    g.parse(path, format="xml")
    fuzzy = {s for s in g.subjects(IS_FUZZY, None)}
    fuzzy |= {s for s in g.subjects(FL, None) if isinstance(s, rdflib.URIRef)}
    R = Renderer(g, fuzzy)
    out = []

    def refs(node):
        if isinstance(node, rdflib.URIRef):
            return {node}
        s = set()
        for _, o in g.predicate_objects(node):
            s |= refs(o) if isinstance(o, (rdflib.BNode, rdflib.URIRef)) else set()
        return s

    PRED = {
        "SubClassOf": RDFS.subClassOf,
        "EquivalentClasses": OWL.equivalentClass,
        "DisjointClasses": OWL.disjointWith,
        "ObjectPropertyDomain": RDFS.domain,
        "DataPropertyDomain": RDFS.domain,
        "ObjectPropertyRange": RDFS.range,
        "DataPropertyRange": RDFS.range,
        "SubObjectPropertyOf": RDFS.subPropertyOf,
        "SubDataPropertyOf": RDFS.subPropertyOf,
        "InverseObjectProperties": OWL.inverseOf,
        "DatatypeDefinition": OWL.equivalentClass,
        "GCI": RDFS.subClassOf,
    }
    # annotations of axioms whose target is an anonymous expression (owl:Axiom reification):
    # keyed by (source, predicate, DL text of the target)
    anon_ann = {}
    for ax in g.subjects(RDF.type, OWL.Axiom):
        src, prp, tgt = (
            g.value(ax, OWL.annotatedSource),
            g.value(ax, OWL.annotatedProperty),
            g.value(ax, OWL.annotatedTarget),
        )
        if src is None or prp is None or tgt is None or isinstance(tgt, rdflib.URIRef):
            continue
        anns = [
            {"prop": short(p), "piri": str(p), "value": str(v)}
            for p, v in g.predicate_objects(ax)
            if p not in (RDF.type, OWL.annotatedSource, OWL.annotatedProperty, OWL.annotatedTarget)
        ]
        if anns:
            anon_ann[(str(src), str(prp), R.dl(tgt))] = anns

    def add(kind, s, dl, fdl, extra=None, o=None):
        rs = refs(s) | (extra or set())
        pred = str(PRED.get(kind, ""))
        anns = (
            anon_ann.get((str(s), pred, R.dl(o)))
            if (o is not None and isinstance(o, rdflib.BNode) and isinstance(s, rdflib.URIRef))
            else None
        )
        out.append(
            {
                "kind": kind,
                "fuzzy": bool(rs & fuzzy),
                "dl": dl,
                "fdl": fdl,
                "s": short(s),
                "piri": pred,
                "man": R.man(o) if o is not None else "",
                "smAN": R.man(s) if not named(s) else "",
                "ann": anns or [],
                "siri": str(s) if named(s) else "",
                "oiri": str(o) if (o is not None and named(o)) else "",
                "odl": R.dl(o) if o is not None else "",
                "sdl": R.dl(s) if not named(s) else short(s),
                "anon": not named(s) or (o is not None and not named(o)),
                "refs": sorted(str(x) for x in rs if str(x).startswith("http") and "w3.org" not in str(x)),
            }
        )

    def named(x):
        return isinstance(x, rdflib.URIRef)

    def datatype_def(d):
        """(base type, [(sym, value)…], (k1,k2)|None) of a named datatype definition."""
        base, facets = None, []
        for o in g.objects(d, OWL.equivalentClass):
            stack, seen = [o], set()
            while stack:
                n = stack.pop()
                if n in seen or not isinstance(n, rdflib.BNode):
                    continue
                seen.add(n)
                for p, v in g.predicate_objects(n):
                    if p == OWL.onDatatype:
                        base = short(v)
                    elif short(p) in FACET:
                        facets.append((FACET[short(p)], str(v)))
                    elif isinstance(v, rdflib.BNode):
                        stack.append(v)
                    elif p in (OWL.intersectionOf, OWL.withRestrictions, OWL.unionOf):
                        stack.extend(x for x in rdflib.collection.Collection(g, v))
        lo = [v for s, v in facets if s in ("≥", ">")]
        hi = [v for s, v in facets if s in ("≤", "<")]
        return base, facets, ((lo[0], hi[0]) if lo and hi else None)

    dt_bounds = {d: datatype_def(d) for d in g.subjects(RDF.type, RDFS.Datatype) if named(d)}
    # ontology-level fuzzy logic
    for o in g.subjects(RDF.type, OWL.Ontology):
        for lbl in g.objects(o, FL):
            f = fuzzy_label_fdl(short(o), str(lbl))
            if f:
                out.append(
                    {
                        "kind": "fuzzy-logic",
                        "fuzzy": True,
                        "dl": "",
                        "fdl": f,
                        "fm": fuzzy_label_math("", str(lbl)),
                        "s": short(o),
                    }
                )
    # fuzzy definitions (datatypes, modifiers, concepts) from fuzzyLabel
    for s, lbl in g.subject_objects(FL):
        if not named(s) or (s, RDF.type, OWL.Ontology) in g:
            continue
        f = fuzzy_label_fdl(fdl_name(s), str(lbl), (dt_bounds.get(s) or (None, None, None))[2])
        if f:
            dl = f"{short(s)} : fuzzy " + ("datatype" if (s, RDF.type, RDFS.Datatype) in g else "concept")
            out.append(
                {
                    "kind": "fuzzy-def",
                    "fuzzy": True,
                    "dl": dl,
                    "fdl": f,
                    "fm": fuzzy_label_math(short(s), str(lbl)),
                    "s": short(s),
                }
            )
    # class axioms
    for c in sorted(set(g.subjects(RDF.type, OWL.Class)), key=str):
        if not named(c):
            continue
        for o in g.objects(c, RDFS.subClassOf):
            add("SubClassOf", c, f"{R.dl(c)} ⊑ {R.dl(o)}", f"(implies {R.fdl(c)} {R.fdl(o)})", refs(o), o)
        for o in g.objects(c, OWL.equivalentClass):
            add("EquivalentClasses", c, f"{R.dl(c)} ≡ {R.dl(o)}", f"(define-concept {R.fdl(c)} {R.fdl(o)})", refs(o), o)
        for o in g.objects(c, OWL.disjointWith):
            add("DisjointClasses", c, f"{R.dl(c)} ⊓ {R.dl(o)} ⊑ ⊥", f"(disjoint {R.fdl(c)} {R.fdl(o)})", refs(o), o)
    for c in sorted(set(g.subjects(OWL.disjointUnionOf, None)), key=str):
        mem = list(rdflib.collection.Collection(g, g.value(c, OWL.disjointUnionOf)))
        add(
            "DisjointUnion",
            c,
            f"{short(c)} ≡ {' ⊔ '.join(R.dl(x) for x in mem)} (pairwise disjoint)",
            "; disjoint-union",
            set(x for x in mem if named(x)),
        )
        out[-1]["odl"] = " ⊔ ".join(R.dl(x) for x in mem)
    for c in sorted(set(g.subjects(OWL.hasKey, None)), key=str):
        keys = [short(x) for x in rdflib.collection.Collection(g, g.value(c, OWL.hasKey))]
        add("HasKey", c, f"HasKey({short(c)}: {', '.join(keys)})", "; has-key")
        out[-1]["odl"] = ", ".join(keys)
    # general class axioms: subClassOf / equivalentClass with an anonymous subject
    for s in set(g.subjects(RDFS.subClassOf, None)) | set(g.subjects(OWL.equivalentClass, None)):
        if named(s) or (s, RDF.type, OWL.Restriction) not in g and (s, RDF.type, OWL.Class) not in g:
            continue
        for o in g.objects(s, RDFS.subClassOf):
            add("GCI", s, f"{R.dl(s)} ⊑ {R.dl(o)}", f"(implies {R.fdl(s)} {R.fdl(o)})", refs(o), o)
        for o in g.objects(s, OWL.equivalentClass):
            if not named(o):
                add("GCI", s, f"{R.dl(s)} ≡ {R.dl(o)}", f"(define-concept {R.fdl(s)} {R.fdl(o)})", refs(o), o)
    for adc in g.subjects(RDF.type, OWL.AllDisjointClasses):
        mem = list(rdflib.collection.Collection(g, g.value(adc, OWL.members)))
        members = [R.dl(x) for x in mem]
        out.append(
            {
                "kind": "DisjointClasses",
                "fuzzy": False,
                "dl": "Disjoint(" + ", ".join(members) + ")",
                "fdl": "(disjoint " + " ".join(fdl_name(m) for m in members) + ")",
                "s": members[0] if members else "",
                "siri": "",
                "oiri": "",
                "anon": True,
                "refs": sorted(str(x) for x in mem if named(x)),
            }
        )
    # datatype definitions: crisp constructs (classical DL with facets); the fuzzy
    # membership function is a separate fuzzy-def line
    for d, (base, facets, bounds) in sorted(dt_bounds.items(), key=lambda kv: str(kv[0])):
        if not facets:
            for o in g.objects(d, OWL.equivalentClass):
                add("DatatypeDefinition", d, f"{short(d)} ≡ {R.dl(o)}", "", refs(o), o)
            continue
        dl = f"{short(d)} ≡ {base or 'literal'}[{', '.join(f'{s} {v}' for s, v in facets)}]"
        fdl = (
            f"; {fdl_name(d)}: {base or 'literal'} in [{bounds[0]}, {bounds[1]}] (k1, k2 of the fuzzy concept)"
            if bounds
            else ""
        )
        add("DatatypeDefinition", d, dl, fdl)
        out[-1]["anon"] = True
    # property axioms
    # role characteristics: fun(R)/trans(R) style
    char = {
        OWL.FunctionalProperty: ("fun", "(functional {p})"),
        OWL.InverseFunctionalProperty: ("invfun", "(inverse-functional {p})"),
        OWL.TransitiveProperty: ("trans", "(transitive {p})"),
        OWL.SymmetricProperty: ("sym", "(symmetric {p})"),
        OWL.AsymmetricProperty: ("asym", "; asymmetric {p} (not supported)"),
        OWL.ReflexiveProperty: ("ref", "(reflexive {p})"),
        OWL.IrreflexiveProperty: ("irr", "; irreflexive {p} (not supported)"),
    }
    for kind, typ in (("ObjectProperty", OWL.ObjectProperty), ("DataProperty", OWL.DatatypeProperty)):
        for p in sorted(set(g.subjects(RDF.type, typ)), key=str):
            if not named(p):
                continue
            pn = fdl_name(p)
            for o in g.objects(p, RDFS.domain):
                add(kind + "Domain", p, f"∃{short(p)}.⊤ ⊑ {R.dl(o)}", f"(domain {pn} {R.fdl(o)})", refs(o), o)
            for o in g.objects(p, RDFS.range):
                rng = R.dl(o) if kind == "ObjectProperty" or not named(o) else short(o)
                fr = (
                    f"(range {pn} {R.fdl(o)})"
                    if kind == "ObjectProperty"
                    else f"(range {pn} *{'integer' if 'integer' in str(o) else 'real' if str(o).split('#')[-1] in ('decimal','double','float') else 'string'}*)"
                )
                add(kind + "Range", p, f"⊤ ⊑ ∀{short(p)}.{rng}", fr, refs(o), o)
            for o in g.objects(p, RDFS.subPropertyOf):
                add(
                    "Sub" + kind + "Of",
                    p,
                    f"{short(p)} ⊑ {R.dl(o)}",
                    f"(implies-role {pn} {R.fdl(o) if named(o) else '(inverse ' + fdl_name(g.value(o, OWL.inverseOf)) + ')'})",
                    refs(o),
                    o,
                )
            for o in g.objects(p, OWL.inverseOf):
                add(
                    "InverseObjectProperties",
                    p,
                    f"{short(p)} ≡ {R.dl(o)}⁻",
                    f"(inverse {pn} {fdl_name(o)})",
                    refs(o),
                    o,
                )
            for o in g.objects(p, OWL.equivalentProperty):
                add("Equivalent" + kind, p, f"{short(p)} ≡ {R.dl(o)}", f"; equivalent {pn} {fdl_name(o)}", refs(o), o)
            for o in g.objects(p, OWL.propertyDisjointWith):
                add("Disjoint" + kind, p, f"{short(p)} ⊓ {R.dl(o)} ⊑ ⊥", f"; disjoint {pn} {fdl_name(o)}", refs(o), o)
            ch = g.value(p, OWL.propertyChainAxiom)
            if ch is not None:
                chain = [short(x) for x in rdflib.collection.Collection(g, ch)]
                add("SubPropertyChainOf", p, " ∘ ".join(chain) + f" ⊑ {short(p)}", f"; chain {' '.join(chain)} -> {pn}")
            for t, (name, tpl) in char.items():
                if (p, RDF.type, t) in g:
                    add(
                        {
                            "fun": "FunctionalProperty",
                            "trans": "TransitiveProperty",
                            "sym": "SymmetricProperty",
                            "invfun": "InverseFunctionalProperty",
                        }.get(name, name),
                        p,
                        f"{name}({short(p)})",
                        tpl.format(p=pn),
                    )
    for a in out:  # crisp TBox notation coincides in DL and fuzzy DL
        a.setdefault("fm", a["dl"])
    return _store(key, path, out)


def _store(key, path, out):
    _CACHE[key] = out
    cpath, disk = _disk_cache()
    disk = {k: v for k, v in disk.items() if not k.startswith(str(path) + "@")}  # drop stale mtimes
    disk[key] = out
    _CACHE["disk"] = disk
    try:
        cpath.write_text(json.dumps(disk, ensure_ascii=False))
    except OSError:
        pass
    return out


def _tbox_from_index(fname):
    """Named-only schema axioms for modules too big to parse."""
    c = sqlite3.connect(workspace.db_path())
    c.row_factory = sqlite3.Row
    out = []
    preds = {
        "subClassOf": ("SubClassOf", "{s} ⊑ {o}", "(implies {s} {o})"),
        "domain": ("PropertyDomain", "∃{s}.⊤ ⊑ {o}", "(domain {s} {o})"),
        "range": ("PropertyRange", "⊤ ⊑ ∀{s}.{o}", "(range {s} {o})"),
        "inverseOf": ("InverseObjectProperties", "{s} ≡ {o}⁻", "(inverse {s} {o})"),
        "subPropertyOf": ("SubPropertyOf", "{s} ⊑ {o}", "(implies-role {s} {o})"),
    }
    for r in c.execute(
        """SELECT ns.iri AS s, np.iri AS p, no.iri AS o FROM stmt st
                          JOIN nodes ns ON ns.id=st.s JOIN nodes np ON np.id=st.p JOIN nodes no ON no.id=st.o_id
                          WHERE st.graph=? AND ns.kind IN ('class','objprop','dataprop')""",
        (fname,),
    ).fetchall():
        pn = short(r["p"])
        if pn in preds:
            k, dl, fdl = preds[pn]
            d = dl.format(s=short(r["s"]), o=short(r["o"]))
            out.append(
                {
                    "kind": k,
                    "fuzzy": False,
                    "dl": d,
                    "fm": d,
                    "siri": r["s"],
                    "oiri": r["o"],
                    "anon": False,
                    "refs": [r["o"]],
                    "fdl": fdl.format(s=fdl_name(r["s"]), o=fdl_name(r["o"])),
                    "s": short(r["s"]),
                }
            )
    return out


# ------------------------------------------------------------ ABox


def _conn():
    c = sqlite3.connect(workspace.db_path())
    c.row_factory = sqlite3.Row
    # ponytail: an index on stmt(graph) makes the planner scan+sort the whole module
    # instead of walking nodes(iri) in order — keep it absent
    c.execute("DROP INDEX IF EXISTS i_graph")
    return c


def abox_stats(fname):
    """Whole-ABox statistics of a module (or closure): assertions by kind, degrees."""
    key = ("stats", str(workspace.db_path()), workspace.db_path().stat().st_mtime, fname)
    if key in _CACHE:
        return _CACHE[key]
    c = _conn()
    # per-module axiom metrics were computed at index time (compute_metrics): sum them
    st = {}
    names = {
        "ClassAssertion": "ClassAssertion",
        "ObjectPropertyAssertion": "ObjectPropertyAssertion",
        "DataPropertyAssertion": "DataPropertyAssertion",
        "individuals": "Individual count",
        "axiom": "Axiom",
        "logical": "Logical axiom count",
        "declaration": "Declaration axioms count",
        "annotation": "AnnotationAssertion",
    }
    for k, mname in names.items():
        st[k] = c.execute(
            "SELECT COALESCE(SUM(value),0) FROM metrics WHERE name=?" + (" AND graph=?" if fname else ""),
            (mname,) + ((fname,) if fname else ()),
        ).fetchone()[0]
    try:
        st["with_degree"] = c.execute(
            "SELECT COUNT(*) FROM axiom_ann" + (" WHERE graph=?" if fname else ""), ((fname,) if fname else ())
        ).fetchone()[0]
    except sqlite3.OperationalError:
        st["with_degree"] = 0
    _CACHE[key] = st
    return st


def abox(fname, page, limit, fuzzy_ids, q=""):
    """Assertions of a module (or of the whole closure when fname is empty) from the
    index: types, object/data property assertions."""
    c = _conn()
    st_ = abox_stats(fname)
    if not (st_["ClassAssertion"] + st_["ObjectPropertyAssertion"] + st_["DataPropertyAssertion"]):
        return {"total": 0, "page": 0, "items": []}
    like = f"%{q}%" if q else None
    where = (
        ("st.graph=? AND " if fname else "")
        + "ns.kind='individual' AND np.iri NOT LIKE 'http://www.w3.org/2000/01/rdf-schema#%' AND np.kind IS NOT 'annprop'"
    )
    par = [fname] if fname else []
    if like:
        where += " AND ns.iri LIKE ?"
        par.append(like)
    # join order fixed (CROSS JOIN): unfiltered → walk stmt through i_s in subject order
    # (= file order, no sort); filtered → scan nodes for the LIKE first, then i_s lookups
    frm = (
        "nodes ns CROSS JOIN stmt st INDEXED BY i_s ON st.s=ns.id CROSS JOIN nodes np ON np.id=st.p"
        if like
        else "stmt st INDEXED BY i_s CROSS JOIN nodes ns ON ns.id=st.s CROSS JOIN nodes np ON np.id=st.p"
    )
    not_decl = """NOT (np.iri='http://www.w3.org/1999/02/22-rdf-syntax-ns#type' AND st.o_id IN
                  (SELECT id FROM nodes WHERE iri='http://www.w3.org/2002/07/owl#NamedIndividual'))"""
    ckey = ("count", str(workspace.db_path()), workspace.db_path().stat().st_mtime, fname, q)
    if ckey not in _CACHE:
        if not q:  # unfiltered total = logical ABox axioms already counted at index time
            _CACHE[ckey] = st_["ClassAssertion"] + st_["ObjectPropertyAssertion"] + st_["DataPropertyAssertion"]
        else:
            _CACHE[ckey] = c.execute(f"SELECT COUNT(*) FROM {frm} WHERE {where} AND {not_decl}", par).fetchone()[0]
    total = _CACHE[ckey]
    rows = c.execute(
        f"""SELECT ns.iri AS s, np.iri AS p, np.kind AS pk, no.iri AS o, no.id AS oid, st.o_lit, st.dt
                         FROM {frm} LEFT JOIN nodes no ON no.id=st.o_id
                         WHERE {where} AND {not_decl}
                         ORDER BY st.s, st.rowid LIMIT ? OFFSET ?""",
        par + [limit, page * limit],
    ).fetchall()
    # degrees (owl:Axiom) for the rows of this page
    deg = {}
    try:
        for r in c.execute(
            """SELECT ns.iri AS s, np.iri AS p, no.iri AS o, a.value FROM axiom_ann a
                              JOIN nodes ns ON ns.id=a.s JOIN nodes np ON np.id=a.p LEFT JOIN nodes no ON no.id=a.o_id
                              """
            + ("WHERE a.graph=?" if fname else ""),
            ((fname,) if fname else ()),
        ).fetchall():
            d = degree_of(r["value"])
            if d:
                deg[(r["s"], r["p"], r["o"])] = d
    except sqlite3.OperationalError:
        pass
    out = []
    for r in rows:
        s, p = short(r["s"]), short(r["p"])
        sf, pf = fdl_name(r["s"]), fdl_name(r["p"])

        # dl: C(a), r(a,b); fm: fuzzy DL a:C, (a,b):R, ⟨…, n⟩ with degree
        def fm(core, d):
            return f"⟨{core}, {d}⟩" if d else core

        if p == "type":
            d = deg.get((r["s"], r["p"], r["o"]))
            fz = d is not None or r["oid"] in fuzzy_ids
            out.append(
                {
                    "kind": "ClassAssertion",
                    "fuzzy": fz,
                    "dl": f"{short(r['o'])}({s})" + (f"  ≥ {d}" if d else ""),
                    "fm": fm(f"{s}:{short(r['o'])}", d),
                    "fdl": f"(instance {sf} {fdl_name(r['o'])} {d or '1.0'})",
                    "s": s,
                }
            )
        elif r["o_lit"] is not None:
            v = r["o_lit"]
            if r["dt"] and short(r["dt"]) == "MissingValue":
                v = f"{v} (MissingValue)"
            out.append(
                {
                    "kind": "DataPropertyAssertion",
                    "fuzzy": False,
                    "dl": f"{p}({s}, {v})",
                    "fm": f"({s}, {v}):{p}",
                    "fdl": f"(instance {sf} (= {pf} {r['o_lit']}) 1.0)",
                    "s": s,
                }
            )
        else:
            d = deg.get((r["s"], r["p"], r["o"]))
            out.append(
                {
                    "kind": "ObjectPropertyAssertion",
                    "fuzzy": d is not None,
                    "dl": f"{p}({s}, {short(r['o'])})" + (f"  ≥ {d}" if d else ""),
                    "fm": fm(f"({s}, {short(r['o'])}):{p}", d),
                    "fdl": f"(related {sf} {fdl_name(r['o'])} {pf} {d or '1.0'})",
                    "s": s,
                }
            )
    return {"total": total, "page": page, "items": out}


# ------------------------------------------------------------ expressions


class Renderer:
    def __init__(self, g, fuzzy):
        self.g, self.fuzzy = g, fuzzy

    # DL notation ---------------------------------------------------------
    def dl(self, n):
        g = self.g
        if isinstance(n, rdflib.URIRef):
            return {OWL.Thing: "⊤", OWL.Nothing: "⊥"}.get(n, short(n))
        if isinstance(n, rdflib.Literal):
            return f'"{n}"'
        inv = g.value(n, OWL.inverseOf)
        if inv is not None:
            return f"{self.dl(inv)}⁻"
        if (n, RDF.type, OWL.Restriction) in g:
            p = self.dl(g.value(n, OWL.onProperty))
            for pred, sym in ((OWL.someValuesFrom, "∃"), (OWL.allValuesFrom, "∀")):
                v = g.value(n, pred)
                if v is not None:
                    return f"{sym}{p}.{self.dl(v)}"
            v = g.value(n, OWL.hasValue)
            if v is not None:
                return f"∃{p}.{{{self.dl(v)}}}"
            for pred, sym in (
                (OWL.minCardinality, "≥"),
                (OWL.minQualifiedCardinality, "≥"),
                (OWL.maxCardinality, "≤"),
                (OWL.maxQualifiedCardinality, "≤"),
                (OWL.cardinality, "="),
                (OWL.qualifiedCardinality, "="),
            ):
                v = g.value(n, pred)
                if v is not None:
                    q = g.value(n, OWL.onClass) or g.value(n, OWL.onDataRange)
                    return f"{sym}{v} {p}" + (f".{self.dl(q)}" if q is not None else "")
            return f"Restriction({p})"
        for pred, sym in ((OWL.intersectionOf, " ⊓ "), (OWL.unionOf, " ⊔ ")):
            lst = g.value(n, pred)
            if lst is not None:
                return "(" + sym.join(self.dl(x) for x in rdflib.collection.Collection(g, lst)) + ")"
        c = g.value(n, OWL.complementOf)
        if c is not None:
            return f"¬{self.dl(c)}"
        one = g.value(n, OWL.oneOf)
        if one is not None:
            return "{" + ", ".join(self.dl(x) for x in rdflib.collection.Collection(g, one)) + "}"
        dt = g.value(n, OWL.onDatatype)
        if dt is not None:
            return f"{short(dt)}[{', '.join(f'{s} {v}' for s, v in self.facets(n))}]"
        return "…"

    def facets(self, n):
        """[(symbol, value)…] of a datatype restriction node."""
        out = []
        wr = self.g.value(n, OWL.withRestrictions)
        if wr is not None:
            for f in rdflib.collection.Collection(self.g, wr):
                for fp, fv in self.g.predicate_objects(f):
                    out.append((FACET.get(short(fp), short(fp)), str(fv)))
        return out

    # Manchester syntax (editable text of an anonymous expression) ----------------
    def man(self, n):
        g = self.g
        if isinstance(n, rdflib.URIRef):
            s = str(n)
            if s == str(OWL.Thing):
                return "owl:Thing"
            if s == str(OWL.Nothing):
                return "owl:Nothing"
            if s.startswith(str(XSD)):
                return "xsd:" + short(s)
            return short(s) if " " not in short(s) else f"'{short(s)}'"
        if isinstance(n, rdflib.Literal):
            return str(n) if n.datatype and str(n.datatype) != str(XSD.string) else f'"{n}"'
        inv = g.value(n, OWL.inverseOf)
        if inv is not None:
            return f"inverse {self.man(inv)}"
        if (n, RDF.type, OWL.Restriction) in g:
            p = self.man(g.value(n, OWL.onProperty))
            for pred, kw in ((OWL.someValuesFrom, "some"), (OWL.allValuesFrom, "only")):
                v = g.value(n, pred)
                if v is not None:
                    return f"{p} {kw} {self.man(v)}"
            v = g.value(n, OWL.hasValue)
            if v is not None:
                return f"{p} value {self.man(v)}"
            if g.value(n, OWL.hasSelf) is not None:
                return f"{p} Self"
            for pred, kw in (
                (OWL.minCardinality, "min"),
                (OWL.minQualifiedCardinality, "min"),
                (OWL.maxCardinality, "max"),
                (OWL.maxQualifiedCardinality, "max"),
                (OWL.cardinality, "exactly"),
                (OWL.qualifiedCardinality, "exactly"),
            ):
                v = g.value(n, pred)
                if v is not None:
                    q = g.value(n, OWL.onClass) or g.value(n, OWL.onDataRange)
                    return f"{p} {kw} {v}" + (f" {self.man(q)}" if q is not None else "")
        for pred, kw in ((OWL.intersectionOf, " and "), (OWL.unionOf, " or ")):
            lst = g.value(n, pred)
            if lst is not None:
                return "(" + kw.join(self.man(x) for x in rdflib.collection.Collection(g, lst)) + ")"
        c = g.value(n, OWL.complementOf)
        if c is not None:
            return f"not {self.man(c)}"
        one = g.value(n, OWL.oneOf)
        if one is not None:
            return "{" + ", ".join(self.man(x) for x in rdflib.collection.Collection(g, one)) + "}"
        dt = g.value(n, OWL.onDatatype)
        if dt is not None:
            inv_f = {"≥": ">=", "≤": "<=", ">": ">", "<": "<"}
            return f"{self.man(dt)}[{', '.join(f'{inv_f.get(s, s)} {v}' for s, v in self.facets(n))}]"
        return "owl:Thing"

    # FuzzyDL notation ----------------------------------------------------
    def fdl(self, n):
        g = self.g
        if isinstance(n, rdflib.URIRef):
            return {OWL.Thing: "*top*", OWL.Nothing: "*bottom*"}.get(n, fdl_name(n))
        if isinstance(n, rdflib.Literal):
            return str(n)
        if (n, RDF.type, OWL.Restriction) in g:
            p = fdl_name(g.value(n, OWL.onProperty))
            v = g.value(n, OWL.someValuesFrom)
            if v is not None:
                if isinstance(v, rdflib.BNode) and g.value(v, OWL.onDatatype) is not None:
                    # concrete feature restriction: FuzzyDL (>= f v) / (<= f v)
                    fs = [f"({s} {p} {val})" for s, val in self.facets(v) if s in ("≥", "≤", ">", "<")]
                    fs = [x.replace("≥", ">=").replace("≤", "<=") for x in fs]
                    return fs[0] if len(fs) == 1 else "(and " + " ".join(fs) + ")" if fs else f"(some {p} *top*)"
                return f"(some {p} {self.fdl(v)})"
            v = g.value(n, OWL.allValuesFrom)
            if v is not None:
                return f"(all {p} {self.fdl(v)})"
            v = g.value(n, OWL.hasValue)
            if v is not None:
                return f"(= {p} {v})" if isinstance(v, rdflib.Literal) else f"(b-some {p} {self.fdl(v)})"
            return f"(some {p} *top*)   ; cardinality restriction not supported in FuzzyDL"
        for pred, kw in ((OWL.intersectionOf, "and"), (OWL.unionOf, "or")):
            lst = g.value(n, pred)
            if lst is not None:
                return f"({kw} " + " ".join(self.fdl(x) for x in rdflib.collection.Collection(g, lst)) + ")"
        c = g.value(n, OWL.complementOf)
        if c is not None:
            return f"(not {self.fdl(c)})"
        dt = g.value(n, OWL.onDatatype)
        if dt is not None:
            return self.dl(n)
        return "*top*"
