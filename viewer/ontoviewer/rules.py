"""SWRL rules (W3C member submission 2004, RDF/XML concrete syntax used by the OWL API)
and fuzzy rules (Fuzzy OWL 2 style: a fuzzyLabel Degree annotation on the swrl:Imp).

Text syntax:
    Class(?x) ^ objProp(?x, ?y) ^ dataProp(?x, ?v) ^ swrlb:greaterThan(?v, 18) -> Class2(?x)
Atoms: C(?x) class atom · p(?x, ?y) object/data property atom · sameAs/differentFrom(?x, ?y) ·
swrlb:builtin(args…) · arguments are variables (?x), individuals, or literals ("s", 12, 1.5).
Rules are written as one <swrl:Imp rdf:about=…> block (body/head as rdf:parseType Collection,
variables as swrl:Variable) so they can be removed as a block; they are listed from the module
files with rdflib. The FuzzyDL reasoner ignores rules (fuzzy_dl_owl2 has no SWRL support).
"""

import re
import xml.sax.saxutils as sx

import rdflib
from rdflib.namespace import RDF, RDFS

from ontoviewer import config, manchester
from ontoviewer import workspace
from ontoviewer import dlquery

SWRL = "http://www.w3.org/2003/11/swrl#"
SWRLB = "http://www.w3.org/2003/11/swrlb#"
XSD = "http://www.w3.org/2001/XMLSchema#"
VAR = "urn:swrl:var#"
FL = config.fuzzy_label_iri  # configured fuzzy annotation IRI (call at use time)
S = rdflib.Namespace(SWRL)
_CACHE = {}


# ------------------------------------------------------------ evaluation on the index (no insertion)

_RDF_TYPE = str(RDF.type)
_NUM = re.compile(r"^-?\d+(\.\d+)?([eE][-+]?\d+)?$")
ARITH = {
    "add": lambda *x: sum(x),
    "subtract": lambda a, b: a - b,
    "multiply": lambda a, b: a * b,
    "divide": lambda a, b: a / b if b else None,
    "mod": lambda a, b: a % b if b else None,
    "abs": lambda a: abs(a),
}


def _split_atoms(text):
    out, depth, cur = [], 0, ""
    for ch in text:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch in "^∧" and depth == 0:
            out.append(cur.strip())
            cur = ""
        else:
            cur += ch
    if cur.strip():
        out.append(cur.strip())
    return out


def _parse_arg(a, resolver):
    a = a.strip()
    if a.startswith("?"):
        return ("var", a[1:])
    if re.fullmatch(r"-?\d+", a):
        return ("lit", a, XSD + "integer")
    if re.fullmatch(r"-?\d+\.\d+", a):
        return ("lit", a, XSD + "decimal")
    if a[:1] in "\"'" and a[-1:] in "\"'":
        return ("lit", a[1:-1], XSD + "string")
    if a.lower() in ("true", "false"):
        return ("lit", a.lower(), XSD + "boolean")
    return ("ind", resolver.resolve(a, ["individual"])[0])


def parse_rule(text):
    """'body -> head' → {"body": [atoms], "head": [atoms]}; atom = (type, pred, args)."""
    m = re.split(r"\s*(?:->|→|=>)\s*", text.strip(), maxsplit=1)
    if len(m) != 2:
        raise RuleError("a rule needs 'body -> head'")
    resolver = manchester.Resolver()

    def atoms(part):
        out = []
        for a in _split_atoms(part):
            mm = re.fullmatch(r"([^\s(]+)\s*\((.*)\)", a, re.S)
            if not mm:
                raise RuleError(f"bad atom {a!r}")
            pred, args = mm.group(1), [
                x for x in re.split(r",(?![^\"']*[\"'](?:[^\"']*[\"'][^\"']*[\"'])*[^\"']*$)", mm.group(2)) if x.strip()
            ]
            args = [_parse_arg(x, resolver) for x in args]
            if pred.startswith("swrlb:"):
                out.append(("builtin", SWRLB + pred[6:], args))
            elif pred in ("sameAs", "differentFrom", "owl:sameAs", "owl:differentFrom"):
                out.append(("same" if "same" in pred else "different", None, args))
            elif len(args) == 1:
                out.append(("class", resolver.resolve(pred, ["class"])[0], args))
            elif len(args) == 2:
                iri, kind = resolver.resolve(pred, ["objprop", "dataprop"])
                out.append(("objprop" if kind == "objprop" else "dataprop", iri, args))
            else:
                raise RuleError(f"atom {pred} with {len(args)} arguments")
        return out

    return {"body": atoms(m[0]), "head": atoms(m[1])}


# ------------------------------------------------------------ RDF/XML


def _arg_xml(tag, arg, ind):
    if arg[0] == "var":
        return f'{ind}<{tag} rdf:resource="{VAR}{sx.escape(arg[1])}"/>'
    if arg[0] == "ind":
        return f'{ind}<{tag} rdf:resource="{sx.escape(arg[1])}"/>'
    return f'{ind}<{tag} rdf:datatype="{arg[2]}">{sx.escape(arg[1])}</{tag}>'


def _atom_xml(atom, ind):
    t, pred, args = atom
    n = ind + "    "
    if t == "class":
        return f'{ind}<swrl:ClassAtom>\n{n}<swrl:classPredicate rdf:resource="{sx.escape(pred)}"/>\n{_arg_xml("swrl:argument1", args[0], n)}\n{ind}</swrl:ClassAtom>'
    if t in ("objprop", "dataprop"):
        tag = "swrl:IndividualPropertyAtom" if t == "objprop" else "swrl:DatavaluedPropertyAtom"
        return f'{ind}<{tag}>\n{n}<swrl:propertyPredicate rdf:resource="{sx.escape(pred)}"/>\n{_arg_xml("swrl:argument1", args[0], n)}\n{_arg_xml("swrl:argument2", args[1], n)}\n{ind}</{tag}>'
    if t in ("same", "different"):
        tag = "swrl:SameIndividualAtom" if t == "same" else "swrl:DifferentIndividualsAtom"
        return f'{ind}<{tag}>\n{_arg_xml("swrl:argument1", args[0], n)}\n{_arg_xml("swrl:argument2", args[1], n)}\n{ind}</{tag}>'
    if t == "builtin":
        # explicit rdf:List (rdf:parseType="Collection" cannot hold literals): what the OWL API writes
        def lst(rest, d):
            if not rest:
                return f'{d}<rdf:Description rdf:about="{RDF.nil}"/>'
            a = rest[0]
            first = (
                f'{d}    <rdf:first rdf:resource="{VAR}{sx.escape(a[1])}"/>'
                if a[0] == "var"
                else (
                    f'{d}    <rdf:first rdf:resource="{sx.escape(a[1])}"/>'
                    if a[0] == "ind"
                    else f'{d}    <rdf:first rdf:datatype="{a[2]}">{sx.escape(a[1])}</rdf:first>'
                )
            )
            if len(rest) == 1:
                tail = f'{d}    <rdf:rest rdf:resource="{RDF.nil}"/>'
            else:
                tail = f"{d}    <rdf:rest>\n" + lst(rest[1:], d + "        ") + f"\n{d}    </rdf:rest>"
            return f"{d}<rdf:List>\n{first}\n{tail}\n{d}</rdf:List>"

        return (
            f'{ind}<swrl:BuiltinAtom>\n{n}<swrl:builtin rdf:resource="{sx.escape(pred)}"/>\n{n}<swrl:arguments>\n'
            + lst(args, n + "    ")
            + f"\n{n}</swrl:arguments>\n{ind}</swrl:BuiltinAtom>"
        )
    raise RuleError(t)


def rule_xml(iri, rule, label=None, comment=None, degree=None):
    vars_ = sorted({a[1] for atom in rule["body"] + rule["head"] for a in atom[2] if a[0] == "var"})
    parts = [f'    <swrl:Imp rdf:about="{sx.escape(iri)}" xmlns:swrl="{SWRL}">']
    if label:
        parts.append(f'        <rdfs:label xml:lang="en">{sx.escape(label)}</rdfs:label>')
    if comment:
        parts.append(f'        <rdfs:comment xml:lang="en">{sx.escape(comment)}</rdfs:comment>')
    if degree is not None:
        fl = f'<fuzzyOwl2 fuzzyType="axiom"><Degree value="{degree}"/></fuzzyOwl2>'
        parts.append(
            f'        <sdf:{config.fuzzy_label() or "fuzzyLabel"} xmlns:sdf="http://www.semanticweb.org/ontologies/fuzzydl_ontology#">{sx.escape(fl)}</sdf:{config.fuzzy_label() or "fuzzyLabel"}>'
        )
    for part in ("body", "head"):
        parts.append(f'        <swrl:{part} rdf:parseType="Collection">')
        parts += [_atom_xml(a, "            ") for a in rule[part]]
        parts.append(f"        </swrl:{part}>")
    parts.append("    </swrl:Imp>")
    for v in vars_:
        parts.append(f'    <swrl:Variable rdf:about="{VAR}{sx.escape(v)}" xmlns:swrl="{SWRL}"/>')
    return "\n".join(parts) + "\n"


# ------------------------------------------------------------ listing (from the files)


def _short(t):
    s = str(t)
    return s.rsplit("#", 1)[-1].rsplit("/", 1)[-1]


def _arg_text(g, a):
    if isinstance(a, rdflib.Literal):
        return f'"{a}"' if a.datatype and "string" in str(a.datatype) else str(a)
    s = str(a)
    if s.startswith(VAR) or (g.value(a, RDF.type) == S.Variable):
        return "?" + _short(s)
    return _short(s)


def _atom_text(g, at):
    t = g.value(at, RDF.type)
    a1, a2 = g.value(at, S.argument1), g.value(at, S.argument2)
    if t == S.ClassAtom:
        return f"{_short(g.value(at, S.classPredicate))}({_arg_text(g, a1)})"
    if t in (S.IndividualPropertyAtom, S.DatavaluedPropertyAtom):
        return f"{_short(g.value(at, S.propertyPredicate))}({_arg_text(g, a1)}, {_arg_text(g, a2)})"
    if t == S.SameIndividualAtom:
        return f"sameAs({_arg_text(g, a1)}, {_arg_text(g, a2)})"
    if t == S.DifferentIndividualsAtom:
        return f"differentFrom({_arg_text(g, a1)}, {_arg_text(g, a2)})"
    if t == S.BuiltinAtom:
        args = []
        lst = g.value(at, S.arguments)
        if lst is not None:
            for x in rdflib.collection.Collection(g, lst):
                v = g.value(x, RDF.value) if isinstance(x, rdflib.BNode) else x
                args.append(_arg_text(g, v))
        return f"swrlb:{_short(g.value(at, S.builtin))}({', '.join(args)})"
    if t == S.DataRangeAtom:
        return f"{_short(g.value(at, S.dataRange))}({_arg_text(g, a1)})"
    return "?"


def list_rules():
    """All swrl:Imp of the workspace modules (small files parsed with rdflib, cached by mtime)."""
    ws = workspace.load()
    out = []
    for f in ws["files"]:
        p = workspace.ont_dir() / f
        if not p.exists() or p.stat().st_size > 80e6:
            continue
        key = (str(p), p.stat().st_mtime)
        if key not in _CACHE:
            g = rdflib.Graph()
            g.parse(p, format="xml")
            rs = []
            for imp in g.subjects(RDF.type, S.Imp):

                def atoms(part):
                    lst = g.value(imp, part)
                    return [_atom_text(g, a) for a in rdflib.collection.Collection(g, lst)] if lst is not None else []

                deg = None
                for lbl in g.objects(imp, rdflib.URIRef(FL())):
                    m = re.search(r'Degree value="([^"]+)"', str(lbl))
                    if m:
                        deg = m.group(1)
                rs.append(
                    {
                        "iri": str(imp) if isinstance(imp, rdflib.URIRef) else "",
                        "bnode": isinstance(imp, rdflib.BNode),
                        "label": str(g.value(imp, RDFS.label) or ""),
                        "comment": str(g.value(imp, RDFS.comment) or ""),
                        "text": " ^ ".join(atoms(S.body)) + " -> " + " ^ ".join(atoms(S.head)),
                        "degree": deg,
                        "module": f,
                    }
                )
            _CACHE[key] = rs
        out += _CACHE[key]
    return out


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _cmp(a, b, f):
    x, y = _num(a), _num(b)
    return f(x, y) if x is not None and y is not None else f(str(a), str(b))


def evaluate(text, limit=500, max_bindings=200000):
    """Evaluate a rule on the asserted data of the index: the body is a conjunctive query
    (class atoms with the subclass closure, property atoms, swrlb built-ins); the head atoms
    become derived facts. Returns bindings and facts (flagged when already asserted)."""
    rule = parse_rule(text)
    c = dlquery._conn()
    iri_cache = {}

    def iri_of(i):
        if i not in iri_cache:
            r = c.execute("SELECT iri FROM nodes WHERE id=?", (i,)).fetchone()
            iri_cache[i] = r[0] if r else None
        return iri_cache[i]

    def val(arg, b):  # argument → concrete value under binding b ("ind"→node id, "lit"→str, "var"→bound value)
        if arg[0] == "var":
            return b.get(arg[1])
        if arg[0] == "ind":
            return dlquery._nid(c, arg[1])
        return arg[1]

    cls_cache = {}

    def instances(ciri):
        if ciri not in cls_cache:
            cid = dlquery._nid(c, ciri)
            cls_cache[ciri] = dlquery._instances_of_class(c, cid) if cid is not None else set()
        return cls_cache[ciri]

    # evaluation order by selectivity: property atoms with a constant → small classes → property
    # atoms → large classes (they then act as filters on bound variables) → built-ins last
    def cost(a):
        t, pred, args = a
        if t == "builtin":
            return 10**9
        if t in ("objprop", "dataprop", "same", "different"):
            return 0 if any(x[0] in ("ind", "lit") for x in args) else 10**6
        n = len(instances(pred))
        return n if n < 5000 else 10**7 + n

    body = sorted(rule["body"], key=cost)
    truncated = [False]

    def step(i, b):
        if i == len(body):
            yield b
            return
        t, pred, args = body[i]
        if t == "class":
            x = args[0]
            if x[0] == "var" and x[1] not in b:
                for ind in instances(pred):
                    yield from step(i + 1, {**b, x[1]: ind})
            else:
                v = val(x, b)
                if v in instances(pred):
                    yield from step(i + 1, b)
        elif t in ("objprop", "dataprop"):
            pid = dlquery._nid(c, pred)
            if pid is None:
                return
            x, y = args
            vx, vy = val(x, b), val(y, b)
            data = t == "dataprop"
            if vx is not None:
                rows = c.execute("SELECT o_id, o_lit FROM stmt WHERE s=? AND p=?", (vx, pid)).fetchall()
            elif vy is not None and not data:
                rows = [(vy, None)]
                xs = [r[0] for r in c.execute("SELECT s FROM stmt WHERE p=? AND o_id=?", (pid, vy)).fetchall()]
                for s_ in xs:
                    yield from step(i + 1, {**b, x[1]: s_} if x[0] == "var" else b)
                return
            else:
                rows = None
            if rows is None:  # both unbound: scan the property (bounded)
                n = 0
                for r in c.execute("SELECT s, o_id, o_lit FROM stmt WHERE p=? LIMIT ?", (pid, max_bindings)):
                    n += 1
                    nb = dict(b)
                    if x[0] == "var":
                        nb[x[1]] = r["s"]
                    ov = r["o_lit"] if data else r["o_id"]
                    if y[0] == "var":
                        nb[y[1]] = ov
                    elif val(y, b) != ov:
                        continue
                    yield from step(i + 1, nb)
                if n >= max_bindings:
                    truncated[0] = True
                return
            for r in rows:
                ov = r["o_lit"] if data else r["o_id"]
                if ov is None:
                    continue
                if y[0] == "var":
                    if y[1] in b and b[y[1]] != ov and str(b[y[1]]) != str(ov):
                        continue
                    yield from step(i + 1, {**b, y[1]: ov})
                elif str(val(y, b)) == str(ov):
                    yield from step(i + 1, b)
        elif t in ("same", "different"):
            a1, a2 = val(args[0], b), val(args[1], b)
            if (a1 == a2) == (t == "same"):
                yield from step(i + 1, b)
        elif t == "builtin":
            name = pred.rsplit("#", 1)[-1]
            vals = [val(a, b) for a in args]
            if name in BUILTINS:
                if len(vals) == 2 and vals[0] is not None and vals[1] is not None and BUILTINS[name](vals[0], vals[1]):
                    yield from step(i + 1, b)
            elif name in ARITH:  # first argument receives the result (SWRL convention)
                nums = [_num(v) for v in vals[1:]]
                if all(n is not None for n in nums):
                    res = ARITH[name](*nums)
                    if res is None:
                        return
                    out = args[0]
                    if out[0] == "var" and out[1] not in b:
                        yield from step(i + 1, {**b, out[1]: str(res)})
                    elif _num(val(out, b)) == res:
                        yield from step(i + 1, b)
            else:
                raise RuleError(f"unsupported built-in swrlb:{name}")

    vars_ = sorted({a[1] for atom in rule["body"] + rule["head"] for a in atom[2] if a[0] == "var"})

    def show(v):
        if isinstance(v, int):
            iri = iri_of(v)
            return iri.rsplit("#", 1)[-1].rsplit("/", 1)[-1] if iri else str(v)
        return str(v)

    facts, seen, n_bind, samples = [], set(), 0, []
    for b in step(0, {}):
        n_bind += 1
        if len(samples) < 50:
            samples.append({v: show(b.get(v)) for v in vars_})
        for t, pred, args in rule["head"]:
            if t == "class":
                x = val(args[0], b)
                key = ("type", x, pred)
                if key in seen:
                    continue
                seen.add(key)
                cid = dlquery._nid(c, pred)
                asserted = cid is not None and x in instances(pred)
                facts.append(
                    {
                        "fact": f"{pred.rsplit('#',1)[-1]}({show(x)})",
                        "asserted": asserted,
                        "s": iri_of(x) if isinstance(x, int) else None,
                        "p": _RDF_TYPE,
                        "o": pred,
                    }
                )
            elif t in ("objprop", "dataprop"):
                x, y = val(args[0], b), val(args[1], b)
                key = (pred, x, y)
                if key in seen:
                    continue
                seen.add(key)
                pid = dlquery._nid(c, pred)
                if t == "objprop":
                    asserted = (
                        bool(
                            c.execute("SELECT 1 FROM stmt WHERE s=? AND p=? AND o_id=? LIMIT 1", (x, pid, y)).fetchone()
                        )
                        if isinstance(y, int)
                        else False
                    )
                    facts.append(
                        {
                            "fact": f"{pred.rsplit('#',1)[-1]}({show(x)}, {show(y)})",
                            "asserted": asserted,
                            "s": iri_of(x),
                            "p": pred,
                            "o": iri_of(y) if isinstance(y, int) else None,
                        }
                    )
                else:
                    asserted = bool(
                        c.execute(
                            "SELECT 1 FROM stmt WHERE s=? AND p=? AND o_lit=? LIMIT 1", (x, pid, str(y))
                        ).fetchone()
                    )
                    facts.append(
                        {
                            "fact": f"{pred.rsplit('#',1)[-1]}({show(x)}, {show(y)})",
                            "asserted": asserted,
                            "s": iri_of(x),
                            "p": pred,
                            "lit": str(y),
                        }
                    )
            elif t in ("same", "different"):
                x, y = val(args[0], b), val(args[1], b)
                key = (t, x, y)
                if key in seen:
                    continue
                seen.add(key)
                facts.append(
                    {"fact": f"{'sameAs' if t=='same' else 'differentFrom'}({show(x)}, {show(y)})", "asserted": False}
                )
        if len(facts) >= limit:
            truncated[0] = True
            break
    return {
        "vars": vars_,
        "bindings": n_bind,
        "samples": samples,
        "facts": facts,
        "new": sum(1 for f in facts if not f["asserted"]),
        "truncated": truncated[0],
        "rule": text,
    }


# ------------------------------------------------------------ parsing the text syntax


class RuleError(ValueError):
    pass


BUILTINS = {
    "greaterThan": lambda a, b: _cmp(a, b, lambda x, y: x > y),
    "lessThan": lambda a, b: _cmp(a, b, lambda x, y: x < y),
    "greaterThanOrEqual": lambda a, b: _cmp(a, b, lambda x, y: x >= y),
    "lessThanOrEqual": lambda a, b: _cmp(a, b, lambda x, y: x <= y),
    "equal": lambda a, b: _cmp(a, b, lambda x, y: x == y),
    "notEqual": lambda a, b: not _cmp(a, b, lambda x, y: x == y),
}


if __name__ == "__main__":
    r = parse_rule(
        "TerritorialSystem(?t) ^ povertyRate(?t, ?v) ^ swrlb:greaterThan(?v, 30) -> TerritoryWithHighPoverty(?t)"
    )
    print(rule_xml("http://www.semanticweb.org/ontologies/fuzzydl_ontology#Rule_1", r, "high poverty", degree="0.8"))
    print(len(list_rules()), "rules in the workspace")
