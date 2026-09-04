"""Manchester-syntax class / data-range expressions → RDF/XML fragments for the editor.

Grammar (case-insensitive keywords):
  expr     := conj ( 'or' conj )*
  conj     := unary ( 'and' unary )*
  unary    := 'not' unary | primary
  primary  := '(' expr ')' | '{' name (',' name)* '}' | restriction | name
  restriction := prop ('some'|'only') expr | prop 'value' (name|literal) | prop 'Self'
               | prop ('min'|'max'|'exactly') INT [expr]
  data range (after a data property, or as a datatype definition):
               datatype [ '[' facet value (',' facet value)* ']' ]   facet ∈ >= <= > < length …
Names: local names of the workspace entities (resolved through the index, must be unique),
'quoted names', prefixed xsd:/owl:/rdfs: names, or full IRIs in <…>.
"""

import re
import sqlite3

from ontoviewer import store, workspace

XSD = "http://www.w3.org/2001/XMLSchema#"
OWL = "http://www.w3.org/2002/07/owl#"
RDFS = "http://www.w3.org/2000/01/rdf-schema#"
RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
PREFIXES = {"xsd": XSD, "owl": OWL, "rdfs": RDFS, "rdf": RDF}
FACETS = {
    ">=": "minInclusive",
    "<=": "maxInclusive",
    ">": "minExclusive",
    "<": "maxExclusive",
    "length": "length",
    "minLength": "minLength",
    "maxLength": "maxLength",
    "pattern": "pattern",
}
KEYWORDS = {"and", "or", "not", "some", "only", "value", "min", "max", "exactly", "self"}
INVERSE = "inverse "  # prefix marking an inverse property IRI inside an expression AST
NOT_KEYWORDS = {
    "all": "only (∀)",
    "every": "only (∀)",
    "forall": "only (∀)",
    "exists": "some (∃)",
    "any": "some (∃)",
}  # common mistakes → the Manchester keyword
TOKEN = re.compile(r"""\s*(?:(<[^>]+>)|('[^']*')|("[^"]*")|(>=|<=|[()\[\]{},<>])|([^\s()\[\]{},<>]+))""")


def tokenize(text):
    out, pos = [], 0
    while pos < len(text):
        m = TOKEN.match(text, pos)
        if not m or m.end() == pos:
            if text[pos:].strip():
                raise ExprError(f"unexpected character at {text[pos:pos+10]!r}")
            break
        pos = m.end()
        iri, q1, q2, sym, word = m.groups()
        if iri:
            out.append(("iri", iri[1:-1]))
        elif q1 or q2:
            out.append(("name", (q1 or q2)[1:-1]))
        elif sym:
            out.append(("sym", sym))
        elif word.lower() in KEYWORDS:
            out.append(("kw", word.lower()))
        elif re.fullmatch(r"-?\d+(\.\d+)?", word):
            out.append(("num", word))
        else:
            out.append(("name", word))
    return out


def parse(text, data_range=False):
    """Text → AST (class expression, or data range when data_range=True)."""
    toks = tokenize(text)
    if not toks:
        raise ExprError("empty expression")
    p = Parser(toks, Resolver())
    ast = p.datarange() if data_range else p.expr()
    if p.i != len(toks):
        raise ExprError(f"unexpected trailing token {p.peek()[1]!r}")
    return ast


# ------------------------------------------------------------ RDF/XML rendering


def _esc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace('"', "&quot;")


def _on_property(piri, n):
    """<owl:onProperty> line(s) of a restriction; an INVERSE-marked IRI becomes an anonymous owl:inverseOf property."""
    if piri.startswith(INVERSE):
        return (
            f"{n}<owl:onProperty>\n{n}    <owl:ObjectProperty>\n"
            f'{n}        <owl:inverseOf rdf:resource="{_esc(piri[len(INVERSE):])}"/>\n'
            f"{n}    </owl:ObjectProperty>\n{n}</owl:onProperty>"
        )
    return f'{n}<owl:onProperty rdf:resource="{_esc(piri)}"/>'


def node_xml(ast, ind="            "):
    """RDF/XML node element for an expression (used in object position)."""
    k = ast[0]
    n = ind + "    "
    if k == "class":
        return f'{ind}<owl:Class rdf:about="{_esc(ast[1])}"/>'
    if k == "datatype" and not ast[2]:
        return f'{ind}<rdfs:Datatype rdf:about="{_esc(ast[1])}"/>'
    if k == "datatype":
        fs = "\n".join(
            f'{n}        <rdf:Description>\n{n}            <xsd:{f} rdf:datatype="{_esc(_facet_dt(ast[1], f))}">{_esc(v)}</xsd:{f}>\n{n}        </rdf:Description>'
            for f, v in ast[2]
        )
        return f'{ind}<rdfs:Datatype>\n{n}<owl:onDatatype rdf:resource="{_esc(ast[1])}"/>\n{n}<owl:withRestrictions rdf:parseType="Collection">\n{fs}\n{n}</owl:withRestrictions>\n{ind}</rdfs:Datatype>'
    if k == "dataOneOf":
        items = "\n".join(
            f"{n}    <rdf:Description><rdf:first>{_esc(v)}</rdf:first></rdf:Description>" for v in ast[1]
        )  # simplified list form
        return f'{ind}<rdfs:Datatype>\n{n}<owl:oneOf rdf:parseType="Collection">\n{items}\n{n}</owl:oneOf>\n{ind}</rdfs:Datatype>'
    if k in ("and", "or"):
        tag = "owl:intersectionOf" if k == "and" else "owl:unionOf"
        return (
            f'{ind}<owl:Class>\n{n}<{tag} rdf:parseType="Collection">\n'
            + "\n".join(node_xml(x, n + "    ") for x in ast[1])
            + f"\n{n}</{tag}>\n{ind}</owl:Class>"
        )
    if k == "not":
        return f"{ind}<owl:Class>\n" + prop_xml("owl:complementOf", ast[1], n) + f"\n{ind}</owl:Class>"
    if k == "oneOf":
        items = "\n".join(f'{n}    <rdf:Description rdf:about="{_esc(i)}"/>' for i in ast[1])
        return (
            f'{ind}<owl:Class>\n{n}<owl:oneOf rdf:parseType="Collection">\n{items}\n{n}</owl:oneOf>\n{ind}</owl:Class>'
        )
    if k in ("some", "only"):
        tag = "owl:someValuesFrom" if k == "some" else "owl:allValuesFrom"
        return (
            f"{ind}<owl:Restriction>\n"
            + _on_property(ast[1], n)
            + "\n"
            + prop_xml(tag, ast[2], n)
            + f"\n{ind}</owl:Restriction>"
        )
    if k == "value":
        v = ast[2]
        val = (
            f'{n}<owl:hasValue rdf:resource="{_esc(v[1])}"/>'
            if v[0] == "ind"
            else f'{n}<owl:hasValue rdf:datatype="{_esc(v[2])}">{_esc(v[1])}</owl:hasValue>'
        )
        return f"{ind}<owl:Restriction>\n" + _on_property(ast[1], n) + f"\n{val}\n{ind}</owl:Restriction>"
    if k == "self":
        return (
            f"{ind}<owl:Restriction>\n"
            + _on_property(ast[1], n)
            + f'\n{n}<owl:hasSelf rdf:datatype="{XSD}boolean">true</owl:hasSelf>\n{ind}</owl:Restriction>'
        )
    if k == "card":
        _, kw, piri, num, filler, pkind = ast
        base = {"min": "minCardinality", "max": "maxCardinality", "exactly": "cardinality"}[kw]
        if filler is None:
            card = f'{n}<owl:{base} rdf:datatype="{XSD}nonNegativeInteger">{num}</owl:{base}>'
        else:
            q = {"min": "minQualifiedCardinality", "max": "maxQualifiedCardinality", "exactly": "qualifiedCardinality"}[
                kw
            ]
            card = f'{n}<owl:{q} rdf:datatype="{XSD}nonNegativeInteger">{num}</owl:{q}>\n' + prop_xml(
                "owl:onDataRange" if pkind == "dataprop" else "owl:onClass", filler, n
            )
        return f"{ind}<owl:Restriction>\n" + _on_property(piri, n) + f"\n{card}\n{ind}</owl:Restriction>"
    raise ExprError(f"cannot render {k}")


def _facet_dt(base, facet):
    return XSD + "string" if facet in ("pattern",) else (XSD + "nonNegativeInteger" if "ength" in facet else base)


def prop_xml(tag, ast, ind):
    """<tag> element holding an expression: rdf:resource for named terms, nested node otherwise."""
    if ast[0] in ("class", "datatype") and (ast[0] == "class" or not ast[2]):
        return f'{ind}<{tag} rdf:resource="{_esc(ast[1])}"/>'
    return f"{ind}<{tag}>\n" + node_xml(ast, ind + "    ") + f"\n{ind}</{tag}>"


def axiom_block(subject_iri, subject_kind, pred_tag, ast, sub_ast=None):
    """A complete RDF/XML block: <owl:Class rdf:about=S><pred>expr</pred></owl:Class>, or for a
    general class axiom (subject_iri None) the anonymous subject expression carrying the predicate."""
    if subject_iri:
        tag = {
            "class": "owl:Class",
            "datatype": "rdfs:Datatype",
            "objprop": "owl:ObjectProperty",
            "dataprop": "owl:DatatypeProperty",
            "annprop": "owl:AnnotationProperty",
            "individual": "owl:NamedIndividual",
        }.get(subject_kind, "rdf:Description")
        return (
            f'    <{tag} rdf:about="{_esc(subject_iri)}">\n' + prop_xml(pred_tag, ast, "        ") + f"\n    </{tag}>\n"
        )
    inner = node_xml(sub_ast, "    ")  # anonymous subject as element
    if inner.endswith("/>"):  # a named subject renders as a self-closing element: open it to hold the predicate
        inner = inner[:-2] + ">\n    </" + inner.strip()[1:].split(" ", 1)[0] + ">"
    head, tail = inner.rsplit("\n", 1)  # insert the predicate before the closing tag
    return head + "\n" + prop_xml(pred_tag, ast, "        ") + "\n" + tail + "\n"


def to_manchester(ast):
    k = ast[0]

    def sh(i):
        if i.startswith(INVERSE):  # inverse property: keyword + local name
            return "inverse " + sh(i[len(INVERSE) :])
        return i.rsplit("#", 1)[-1].rsplit("/", 1)[-1]

    if k == "class":
        return sh(ast[1])
    if k == "datatype":
        # re-parseable form: xsd: prefix for built-ins and the facet symbols (>=, <=, …) the parser accepts
        sym = {v: s for s, v in FACETS.items()}
        name = ("xsd:" + sh(ast[1])) if ast[1].startswith(XSD) else sh(ast[1])
        return name + (f"[{', '.join(f'{sym.get(f, f)} {v}' for f, v in ast[2])}]" if ast[2] else "")
    if k in ("and", "or"):
        return "(" + f" {k} ".join(to_manchester(x) for x in ast[1]) + ")"
    if k == "not":
        return "not " + to_manchester(ast[1])
    if k in ("oneOf", "dataOneOf"):
        return "{" + ", ".join(sh(x) for x in ast[1]) + "}"
    if k in ("some", "only"):
        return f"{sh(ast[1])} {k} {to_manchester(ast[2])}"
    if k == "value":
        return f"{sh(ast[1])} value {sh(ast[2][1]) if ast[2][0] == 'ind' else ast[2][1]}"
    if k == "self":
        return f"{sh(ast[1])} Self"
    if k == "card":
        return f"{sh(ast[2])} {ast[1]} {ast[3]}" + (f" {to_manchester(ast[4])}" if ast[4] else "")
    return "?"


class ExprError(ValueError):
    pass


class Resolver:
    """Local name → IRI through the index (kind-aware, must be unique)."""

    def __init__(self):
        self.c = sqlite3.connect(workspace.db_path())

    def resolve(self, name, kinds):
        if name.startswith("http"):
            return name, None
        if ":" in name and name.split(":", 1)[0] in PREFIXES:
            pfx, local = name.split(":", 1)
            return PREFIXES[pfx] + local, "datatype" if pfx == "xsd" else None
        marks = ",".join("?" * len(kinds))
        if ":" in name:  # workspace prefix (display names of imported entities): declared prefix or namespace segment
            pfx, local = name.split(":", 1)
            own, others = store.namespace_prefixes()
            ns = {v: k for k, v in {**others, **own}.items()}.get(pfx)  # the active ontology's binding wins
            # the declared namespace itself, plus every namespace below it (sub-namespaces shown with the
            # parent prefix, e.g. sdf:LowPoverty for …/fuzzydl_ontology/datatype#LowPoverty)
            pats = (
                [ns + local, f"{ns.rstrip('#/')}/%#{local}", f"{ns.rstrip('#/')}/%/{local}"]
                if ns
                else [f"%/{pfx}#{local}"]
            )
            rows = self.c.execute(
                f"SELECT iri, kind FROM nodes WHERE kind IN ({marks}) AND ({' OR '.join('iri LIKE ?' for _ in pats)})",
                tuple(kinds) + tuple(pats),
            ).fetchall()
            rows = [r for r in rows if r[0].rsplit("#", 1)[-1].rsplit("/", 1)[-1] == local]
        else:
            rows = self.c.execute(
                f"SELECT iri, kind FROM nodes WHERE kind IN ({marks}) AND (iri LIKE ? OR iri LIKE ?)",
                tuple(kinds) + (f"%#{name}", f"%/{name}"),
            ).fetchall()
            rows = [r for r in rows if r[0].rsplit("#", 1)[-1].rsplit("/", 1)[-1] == name]
        if not rows:
            raise ExprError(f"unknown {'/'.join(kinds)} '{name}'")
        if len(rows) > 1:
            raise ExprError(f"ambiguous name '{name}': " + ", ".join(r[0] for r in rows))
        return rows[0][0], rows[0][1]


class Parser:
    def __init__(self, tokens, resolver):
        self.t, self.i, self.r = tokens, 0, resolver

    def peek(self, k=0):
        return self.t[self.i + k] if self.i + k < len(self.t) else (None, None)

    def take(self, typ=None, val=None):
        tok = self.peek()
        if tok[0] is None or (typ and tok[0] != typ) or (val and tok[1] != val):
            raise ExprError(f"expected {val or typ} near token {self.i + 1} ({tok[1]!r})")
        self.i += 1
        return tok

    # class expressions ----------------------------------------------------
    def expr(self):
        parts = [self.conj()]
        while self.peek() == ("kw", "or"):
            self.take()
            parts.append(self.conj())
        return parts[0] if len(parts) == 1 else ("or", parts)

    def conj(self):
        parts = [self.unary()]
        while self.peek() == ("kw", "and"):
            self.take()
            parts.append(self.unary())
        return parts[0] if len(parts) == 1 else ("and", parts)

    def unary(self):
        if self.peek() == ("kw", "not"):
            self.take()
            return ("not", self.unary())
        return self.primary()

    def primary(self):
        typ, val = self.peek()
        if (typ, val) == ("sym", "("):
            self.take()
            e = self.expr()
            self.take("sym", ")")
            return e
        if (typ, val) == ("sym", "{"):
            self.take()
            inds = []
            while True:
                n = self.take("name")[1] if self.peek()[0] == "name" else self.take("iri")[1]
                inds.append(self.r.resolve(n, ["individual"])[0])
                if self.peek() == ("sym", ","):
                    self.take()
                    continue
                break
            self.take("sym", "}")
            return ("oneOf", inds)
        if typ in ("name", "iri"):
            nxt = self.peek(1)
            if nxt[0] == "kw" and nxt[1] in ("some", "only", "value", "min", "max", "exactly", "self"):
                return self.restriction()
            if typ == "name" and val.lower() == "inverse" and nxt[0] in ("name", "iri"):
                return self.restriction()  # `inverse p some C`
            self.take()
            try:
                iri, kind = self.r.resolve(val, ["class"])
            except ExprError:
                try:  # a property without its restriction keyword: say so instead of "unknown class"
                    self.r.resolve(val, ["objprop", "dataprop"])
                except ExprError:
                    raise ExprError(f"unknown class '{val}'")
                hint = (
                    f" — '{nxt[1]}' is not a Manchester keyword: use {NOT_KEYWORDS[str(nxt[1]).lower()]}"
                    if nxt[0] and str(nxt[1]).lower() in NOT_KEYWORDS
                    else (f" (unexpected '{nxt[1]}' after it)" if nxt[0] else "")
                )
                raise ExprError(
                    f"'{val}' is a property: write '{val} some C', '{val} only C', '{val} value x', '{val} min n C' …"
                    + hint
                )
            return ("class", iri)
        raise ExprError(f"unexpected token {val!r}")

    def restriction(self):
        pname = self.take()[1]
        inverse = str(pname).lower() == "inverse" and self.peek()[0] in ("name", "iri")
        if inverse:
            pname = self.take()[1]
        piri, pkind = self.r.resolve(pname, ["objprop"] if inverse else ["objprop", "dataprop"])
        if inverse:
            piri = INVERSE + piri  # marker prefix, rendered as owl:inverseOf by node_xml / "inverse p" by to_manchester
        kw = self.take("kw")[1]
        if kw == "self":
            return ("self", piri)
        if kw == "value":
            typ, val = self.take()
            if typ == "num" or typ == "name" and pkind == "dataprop":
                return (
                    "value",
                    piri,
                    ("lit", val, XSD + ("decimal" if "." in val else "integer") if typ == "num" else XSD + "string"),
                )
            return ("value", piri, ("ind", self.r.resolve(val, ["individual"])[0]))
        if kw in ("min", "max", "exactly"):
            n = self.take("num")[1]
            filler = None
            if self.peek()[0] in ("name", "iri", "sym") and self.peek() != ("sym", ")"):
                filler = self.datarange() if pkind == "dataprop" else self.unary()
            return ("card", kw, piri, n, filler, pkind)
        # the filler is a primary (W3C grammar): `p some C and D` = `(p some C) and D`
        filler = self.datarange() if pkind == "dataprop" else self.unary()
        return (kw, piri, filler, pkind)

    # data ranges ------------------------------------------------------------
    def datarange(self):
        typ, val = self.take()
        if (typ, val) == ("sym", "("):
            d = self.datarange()
            self.take("sym", ")")
            return d
        if (typ, val) == ("sym", "{"):
            lits = []
            while True:
                lits.append(self.take()[1])
                if self.peek() == ("sym", ","):
                    self.take()
                    continue
                break
            self.take("sym", "}")
            return ("dataOneOf", lits)
        base = self.r.resolve(val, ["datatype"])[0]
        facets = []
        if self.peek() == ("sym", "["):
            self.take()
            while True:
                f = self.take()[1]
                if f not in FACETS:
                    raise ExprError(f"unknown facet {f!r}")
                v = self.take()[1]
                facets.append((FACETS[f], v))
                if self.peek() == ("sym", ","):
                    self.take()
                    continue
                break
            self.take("sym", "]")
        return ("datatype", base, facets)


if __name__ == "__main__":  # self-check
    for txt, dr in [
        ("TerritorialSystem and (povertyRate some LowPoverty)", False),
        ("hasDistanceValue some xsd:integer[>= 200, <= 1000]", False),
        ("not Actor or (hasLocation value Albania)", False),
        ("xsd:decimal[>= 0, <= 100]", True),
    ]:
        a = parse(txt, dr)
        print(to_manchester(a))
        print(node_xml(a))
        print()
    print(
        axiom_block(
            None, None, "rdfs:subClassOf", parse("Phenomenon"), parse("Actor and (hasLocation some CountrySubject)")
        )
    )
