"""Paths and constants shared by every module of the viewer.

All runtime data (indexes, workspace files, exports, reasoner scratch dirs, uploads) lives
under ``data/`` next to the package; the browser front-end under ``static/``.

This module defines directory paths (``pathlib.Path``), the RDF vocabularies used to
recognise entities and fuzzy annotations (plus ``fuzzy_label()``, the configurable local
name of the fuzzy annotation property), the list of OWL 2 built-in datatypes and the page
sizes of the paginated API endpoints.  ``data/`` itself is expected
to exist; the modules that need a sub-directory create it themselves (``mkdir``).
"""

import json
import pathlib

from rdflib.namespace import OWL, RDF, RDFS, XSD, Namespace

# ---- directories --------------------------------------------------------------------------
VIEWER_DIR = pathlib.Path(__file__).resolve().parent.parent  # code/viewer
DATA_DIR = VIEWER_DIR / "data"  # runtime files (git-ignored)
STATIC_DIR = VIEWER_DIR / "static"  # index.html, app.css, js/
EXPORTS_DIR = DATA_DIR / "exports"  # generated .fdl files
WORK_DIR = DATA_DIR / "reasoner_work"  # temporary KBs of the reasoners
UPLOADS_DIR = DATA_DIR / "uploads"  # ontologies uploaded from the browser
WS_FILE = DATA_DIR / "workspace.json"  # current workspace (dir + files)
RECENT_FILE = DATA_DIR / "recent.json"  # recently opened workspaces
UI_CONFIG = DATA_DIR / "ui_config.json"  # tab order, sidebar width, flags
BUILD_LOG = DATA_DIR / "build_index.log"  # log of the background index build
LOCK_FILE = DATA_DIR / "index.lock"  # held while an index build runs
# the runtime directories are created on first import (a fresh checkout has no data/)
for _d in (DATA_DIR, EXPORTS_DIR, WORK_DIR, UPLOADS_DIR):
    _d.mkdir(parents=True, exist_ok=True)

# ---- vocabularies (rdflib namespaces; str(...) gives the IRI) -----------------------------
RDF_TYPE = str(RDF.type)
OWL_NS, RDFS_NS, RDF_NS, XSD_NS = str(OWL), str(RDFS), str(RDF), str(XSD)
# Fuzzy OWL 2 encodes membership functions / degrees as XML text in ``fuzzyLabel`` annotations
# (Bobillo & Straccia); the local name of that property is configurable (``fuzzy_label()``).
SDF = Namespace("http://www.semanticweb.org/ontologies/fuzzydl_ontology#")  # Fuzzy OWL 2 vocabulary
FUZZY_LABEL = str(SDF.fuzzyLabel)  # default fuzzy label annotation (full IRI)


def fuzzy_label():
    """Local name of the annotation property that marks fuzzy entities (the Fuzzy OWL 2
    ``owlAnnotationLabel``): ``fuzzy_label`` of data/ui_config.json, default ``fuzzyLabel``.
    An empty value means the workspace is treated as a classical crisp ontology."""
    try:
        return json.load(open(UI_CONFIG)).get("fuzzy_label", "fuzzyLabel") if UI_CONFIG.exists() else "fuzzyLabel"
    except Exception:
        return "fuzzyLabel"


def fuzzy_label_iri():
    """Full IRI used when WRITING fuzzy annotations (labels and degrees): the configured
    local name in the Fuzzy OWL 2 namespace, ``sdf:fuzzyLabel`` by default or when the
    configured label is empty."""
    return str(SDF) + (fuzzy_label() or "fuzzyLabel")


SWRL = Namespace("http://www.w3.org/2003/11/swrl#")
SWRLB = Namespace("http://www.w3.org/2003/11/swrlb#")

# OWL 2 built-in datatypes, shown in the Datatypes list like the OWL API does.
# They are never declared in the ontology files, so the store synthesises their ``kind``
# (see ``store.node_json``) and flags them ``builtin``.
BUILTIN_DATATYPES = [
    str(XSD[t])
    for t in (
        "anyURI base64Binary boolean byte dateTime dateTimeStamp decimal double float hexBinary int integer language "
        "long Name NCName negativeInteger NMTOKEN nonNegativeInteger nonPositiveInteger normalizedString "
        "positiveInteger short string token unsignedByte unsignedInt unsignedLong unsignedShort"
    ).split()
] + [
    str(RDF.PlainLiteral),
    str(RDF.XMLLiteral),
    str(RDF.langString),
    str(RDFS.Literal),
    str(OWL.real),
    str(OWL.rational),
]

# OWL 2 / RDFS built-in annotation properties (never declared in the files): shown in the
# Annotation properties tree and offered by the annotation dialog, like the built-in datatypes
BUILTIN_ANNPROPS = [
    str(RDFS.label),
    str(RDFS.comment),
    str(RDFS.seeAlso),
    str(RDFS.isDefinedBy),
    str(OWL.versionInfo),
    str(OWL.priorVersion),
    str(OWL.backwardCompatibleWith),
    str(OWL.incompatibleWith),
    str(OWL.deprecated),
]


def builtin_name(iri):
    """Prefixed display name of a built-in term (``rdfs:comment``, ``owl:deprecated``, ``xsd:string``)."""
    pfx = (
        "owl:"
        if iri.startswith(OWL_NS)
        else "rdfs:" if iri.startswith(RDFS_NS) else "xsd:" if iri.startswith(XSD_NS) else "rdf:"
    )
    return pfx + iri.rsplit("#", 1)[-1]


# built-in IRI -> entity kind (synthetic nodes of the lists / trees / entity view)
BUILTIN_KIND = {**{b: "datatype" for b in BUILTIN_DATATYPES}, **{b: "annprop" for b in BUILTIN_ANNPROPS}}

# ---- sizes ---------------------------------------------------------------------------------
PAGE_SIZE = 200  # entity lists / instances per page
AXIOM_PAGE = 500  # ABox axioms per page
FDL_PAGE = 500  # FuzzyDL lines per page
