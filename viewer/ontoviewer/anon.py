"""Anonymous individuals: blank nodes used as individuals (annotation values, property assertion targets…).

The blank nodes of an RDF/XML module are either *structural* — class expressions, restrictions,
rdf:Lists, datatype facets, owl:Axiom reifications, negative property assertions, SWRL atoms… — or
*anonymous individuals*.  The viewer renders the former as Manchester / DL text straight from the
files (``ontoviewer.axioms``) and indexes the latter like named entities under the pseudo-IRI
``_:<id>`` (``nodes.kind = 'anon'``), so that the entity panels can show them inline as cards.

The id of an anonymous individual is

- the ``rdf:nodeID`` written in the file when it has one: the files are parsed with rdflib's
  ``preserve_bnode_ids`` (``graph_from_xml``), so the ``BNode`` carries that name; else
- a stable hash of (module file, referring subject, predicate, own statements) — ``stable_id`` —
  so that re-indexing an unchanged file yields the same id and the editor can locate the node
  again at save time by recomputing the ids on the re-parsed block (``node_ids``).

Identical anonymous individuals (same referrer, predicate and statements) collapse into one id.

Entry points: ``graph_from_xml`` (parse), ``file_node_ids`` / ``text_node_ids`` (nodeIDs of a file /
fragment), ``classify`` / ``individuals`` (which blank nodes are individuals), ``node_ids`` (their
ids), ``new_id`` (id of an individual created by the editor), ``iri`` / ``is_anon`` / ``bnode``.
"""

import hashlib
import re
import uuid

import rdflib
from rdflib.namespace import OWL, RDF, RDFS, XSD

SWRL_NS = "http://www.w3.org/2003/11/swrl#"
PREFIX = "_:"  # pseudo-IRI prefix of anonymous individuals in the index and the API
# rdf:type objects that mark a blank node as structural (never an individual)
STRUCT_TYPES = {
    OWL.Restriction,
    OWL.Class,
    OWL.Axiom,
    OWL.Annotation,
    OWL.NegativePropertyAssertion,
    OWL.AllDisjointClasses,
    OWL.AllDifferent,
    OWL.AllDisjointProperties,
    OWL.ObjectProperty,
    OWL.DatatypeProperty,
    OWL.Ontology,
    RDFS.Datatype,
    OWL.DataRange,
    RDF.List,
}
# predicates that only structural blank nodes have as subject
STRUCT_PREDS = {
    OWL.onProperty,
    OWL.someValuesFrom,
    OWL.allValuesFrom,
    OWL.hasValue,
    OWL.hasSelf,
    OWL.minCardinality,
    OWL.maxCardinality,
    OWL.cardinality,
    OWL.minQualifiedCardinality,
    OWL.maxQualifiedCardinality,
    OWL.qualifiedCardinality,
    OWL.onClass,
    OWL.onDataRange,
    OWL.intersectionOf,
    OWL.unionOf,
    OWL.complementOf,
    OWL.oneOf,
    OWL.onDatatype,
    OWL.withRestrictions,
    OWL.datatypeComplementOf,
    OWL.annotatedSource,
    OWL.annotatedProperty,
    OWL.annotatedTarget,
    OWL.members,
    OWL.distinctMembers,
    OWL.sourceIndividual,
    OWL.assertionProperty,
    OWL.targetIndividual,
    OWL.targetValue,
    OWL.inverseOf,
    OWL.propertyChainAxiom,
    OWL.imports,
    RDF.first,
    RDF.rest,
}
NODE_ID = re.compile(r'rdf:nodeID="([^"]+)"')  # rdf:nodeID attribute of an RDF/XML element


def graph_from_xml(path=None, data=None):
    """Parse an RDF/XML file (``path``) or text (``data``) keeping the ``rdf:nodeID`` names as BNode ids.

    Every parse of the viewer goes through here, so a blank node identified in the file keeps
    the same id in the index, in the edit journal and when the file is rewritten (rdflib
    serialises a BNode as ``rdf:nodeID="<id>"``).
    """
    g = rdflib.Graph()
    if data is not None:
        g.parse(data=data, format="xml", preserve_bnode_ids=True)
    else:
        g.parse(path, format="xml", preserve_bnode_ids=True)
    return g


def file_node_ids(path):
    """Set of the ``rdf:nodeID`` values written in an RDF/XML file (streamed line by line)."""
    ids = set()
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            if "rdf:nodeID" in line:
                ids.update(NODE_ID.findall(line))
    return ids


def text_node_ids(xml):
    """Set of the ``rdf:nodeID`` values of an RDF/XML fragment."""
    return set(NODE_ID.findall(xml))


def is_structural(pairs):
    """True when the (predicate, object) pairs of a blank node show it is a structural node."""
    for p, o in pairs:
        if p in STRUCT_PREDS or (p == RDF.type and o in STRUCT_TYPES):
            return True
        if str(p).startswith((SWRL_NS, str(XSD))):  # SWRL atoms, datatype facet nodes
            return True
    return False


def classify(adj, objects):
    """Anonymous individuals among the blank nodes of a graph.

    ``adj`` = {blank node: [(p, o)…]} (subject-position adjacency), ``objects`` = blank nodes seen
    in object position (a node referenced but never described is an empty individual).  Returns
    the set of blank nodes that are not structural.
    """
    return {b for b in adj.keys() | objects if not is_structural(adj.get(b, ()))}


def individuals(g):
    """Anonymous individuals of a graph (``classify`` over its blank nodes)."""
    adj, objects = {}, set()
    for s, p, o in g:
        if isinstance(s, rdflib.BNode):
            adj.setdefault(s, []).append((p, o))
        if isinstance(o, rdflib.BNode):
            objects.add(o)
    return classify(adj, objects)


def _content(g, b):
    """Sorted own statements of a blank node (non-blank objects, N3 literals): the hashed 'content'."""
    return sorted(f"{p} {o.n3()}" for p, o in g.predicate_objects(b) if not isinstance(o, rdflib.BNode))


def stable_id(fname, ref, pred, content):
    """Deterministic id of an anonymous individual without rdf:nodeID: ``genid`` + 12 hex characters of the
    SHA-1 of (module file, referring subject id, predicate, own statements)."""
    return "genid" + hashlib.sha1("|".join([fname, ref, pred, *content]).encode()).hexdigest()[:12]


def _referrer(g, b, ids, inds):
    """Referrer key of an anonymous individual: (id of the subject pointing at it, predicate).

    Named subjects win (the smallest IRI/predicate pair, for determinism); a referring anonymous
    individual contributes its own id once known (None meanwhile); a structural referrer (list
    node, restriction) or no referrer at all gives an empty subject key.
    """
    named = sorted((str(s), str(p)) for s, p in g.subject_predicates(b) if isinstance(s, rdflib.URIRef))
    if named:
        return named[0]
    for s, p in sorted(g.subject_predicates(b), key=lambda sp: (str(sp[1]), str(sp[0]))):
        if s in inds:
            return (ids[s], str(p)) if s in ids else None
        return ("", str(p))
    return ("", "")


def node_ids(g, fname, known, inds=None):
    """{blank node: '_:<id>'} for the anonymous individuals of ``g`` (see the module docstring).

    ``known`` is the set of nodeIDs written in the parsed file / fragment: a node whose BNode name is
    among them keeps it; the others get ``stable_id``, computed top-down from the named referrers so
    that nested anonymous individuals hash the id of their parent.
    """
    inds = individuals(g) if inds is None else inds
    ids = {b: PREFIX + str(b) for b in inds if str(b) in known}
    pending = {b for b in inds if b not in ids}
    while pending:
        done = set()
        for b in pending:
            ref = _referrer(g, b, ids, inds)
            if ref is not None:
                ids[b] = PREFIX + stable_id(fname, ref[0], ref[1], _content(g, b))
                done.add(b)
        if not done:  # referrer cycles among anonymous individuals: content-only ids
            for b in pending:
                ids[b] = PREFIX + stable_id(fname, "", "", _content(g, b))
            break
        pending -= done
    return ids


def new_id():
    """Fresh ``rdf:nodeID`` for an anonymous individual created by the editor (an NCName)."""
    return "genid" + uuid.uuid4().hex[:12]


def iri(node_id):
    """Pseudo-IRI of an anonymous individual from its nodeID."""
    return PREFIX + node_id


def is_anon(value):
    """True for the pseudo-IRI of an anonymous individual (``_:<id>``)."""
    return isinstance(value, str) and value.startswith(PREFIX)


def bnode(value):
    """rdflib BNode of a pseudo-IRI."""
    return rdflib.BNode(value[len(PREFIX) :])
