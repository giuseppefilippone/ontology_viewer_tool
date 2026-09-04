"""Ontology Viewer — local ontology-editor-like browser/editor for (fuzzy) OWL 2 ontologies.

Layout:
    config.py        paths and vocabularies
    workspace.py     the set of open ontology files and its SQLite index path
    indexer.py       one-time indexer (.owl → SQLite) with OWL API-style metrics
    store.py         read access to the index
    axioms.py        TBox/ABox extraction and rendering (DL, Manchester, FuzzyDL)
    manchester.py    Manchester-syntax parser/serializer used by the editor and DL queries
    editor.py        journaled edits written back to the RDF/XML files
    reasoner.py      fuzzy (fuzzy_dl_owl2) and classic (HermiT/Pellet) reasoning on temporary KBs
    dlquery.py       DL queries on the index or with a reasoner
    rules.py         SWRL / fuzzy rules: parsing, RDF/XML, evaluation on the index
    sparql_store.py  rdflib store over the index (SPARQL)
    fdl_export.py    FuzzyDL export of an import closure
    pdf.py           LaTeX → PDF for exported tables
    api/             JSON API handlers (entities, ontology, axioms, graphs, editing, reasoning)
    http.py          HTTP server (static files + API routing)

Data flow: ``workspace`` says which .owl files are open → ``indexer`` turns them into
``data/index_<hash>.db`` → ``store`` (and the ``api`` handlers on top of it) read that index →
``http`` serves the JSON to the browser front-end in ``static/``.  Edits go through ``editor``,
which journals them in the index and rewrites the RDF/XML files on save.

The package has no import-time side effects beyond ``indexer`` reading ``workspace.json``;
``server.py`` (outside the package) is the command-line entry point and calls ``http.serve``.
"""
