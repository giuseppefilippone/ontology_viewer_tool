"""JSON API of the viewer: route tables mapping URL paths to handler functions.

Calling convention (see ``ontoviewer.http``):
    GET handlers receive the parsed query string ``q``, a dict of lists as returned by
    ``urllib.parse.parse_qs`` (read with ``q.get("iri", [""])[0]``).
    POST handlers receive ``(c, p)``: ``c`` is a sqlite connection from ``editor.connect()`` — or
    None for the routes in ``NO_CONNECTION`` — and ``p`` the JSON payload dict.  The connection is
    committed after the handler returns and closed in every case, so handlers never commit.
    The return value of a handler is serialised as JSON; an exception raised by a POST handler
    becomes ``{"error": str(e)}`` with HTTP 400 (GET handlers are expected not to raise).

Routes implemented in this module:
    POST /api/discard → discard
Every other route is implemented in a sub-module (``entities``, ``ontology``, ``axioms``,
``graphs``, ``editing``, ``reasoning``, ``inference``); the tables below are the single place
binding paths to functions.  ``/api/upload``, ``/api/pdf``, ``/api/reindex`` and
``/api/export_file`` are handled directly by ``ontoviewer.http`` (non-JSON bodies or responses).
"""

from ontoviewer import editor
from ontoviewer.api import axioms, editing, entities, graphs, inference, ontology, plugins, reasoning

# POST routes that do NOT need an editor connection (no index writes): they receive c=None.
# Opening a connection would create an empty index file when none exists (sqlite3.connect), so
# read-only and file-system routes stay out of it.
NO_CONNECTION = {
    "/api/ui_config",
    "/api/workspace/open",
    "/api/workspace/remove",
    "/api/export_fdl",
    "/api/fdl/generate",
    "/api/dlquery",
    "/api/sparql",
    "/api/reasoner/clear",
    "/api/inference/run",
    "/api/inference/stop",
    "/api/inference/individual",
    "/api/inference/export",
    "/api/module/new",
    "/api/serialize",
    "/api/diff",
    "/api/merge",
    "/api/diff/fetch",
    "/api/plugins/remove",
    "/api/indexes/remove",
    "/api/queries/save",
}


def discard(c, p):
    """Drop all pending (unsaved) edits: the journal is undone in reverse order and emptied.

    Payload: unused.  Side effect: ``editor.discard`` reverts the index and commits.
    Returns {"discarded": True}.
    """
    editor.discard(c)
    return {"discarded": True}


# GET: path → handler(q).  api_overview takes no argument, hence the lambda.
GET_ROUTES = {
    "/api/overview": lambda q: ontology.api_overview(),
    "/api/list": entities.api_list,
    "/api/changes": ontology.api_changes,
    "/api/graph_of": ontology.api_graph_of,
    "/api/workspace": ontology.api_workspace,
    "/api/ontology_iri": ontology.api_ontology_iri,
    "/api/pick_file": ontology.api_pick_file,
    "/api/fuzzy": entities.api_fuzzy,
    "/api/usage": entities.api_usage,
    "/api/axioms": axioms.api_axioms,
    "/api/ui_config": ontology.api_ui_config,
    "/api/fdl": axioms.api_fdl,
    "/api/graph": graphs.api_graph,
    "/api/entity_axioms": entities.api_entity_axioms,
    "/api/kg": graphs.api_kg,
    "/api/rules": reasoning.api_rules,
    "/api/search": entities.api_search,
    "/api/entity": entities.api_entity,
    "/api/instances": entities.api_instances,
    "/api/tree": entities.api_tree,
    "/api/index_status": ontology.api_index_status,
    "/api/ontology": ontology.api_ontology,
    "/api/reasoner/work": reasoning.reasoner_work_info,
    "/api/inference/status": inference.inference_status,
    "/api/inference/tbox": inference.inference_tbox,
    "/api/server_log": ontology.api_server_log,
    "/api/plugins": plugins.plugin_list,
    "/api/diff/files": ontology.diff_files,
    "/api/check/empty": ontology.api_check_empty,
    "/api/indexes": ontology.api_indexes,
    "/api/sources": ontology.api_sources,
    "/api/queries": ontology.api_queries,
    "/api/runs": reasoning.api_runs,
    "/api/runs/diff": reasoning.api_runs_diff,
}

# POST: path → handler(c, p).  /api/export_fdl and /api/fdl/generate share one handler (the
# former is the older path still used by parts of the front-end).
POST_ROUTES = {
    "/api/reason/fuzzy": reasoning.reason_fuzzy,
    "/api/reason/classic": reasoning.reason_classic,
    "/api/reasoner/clear": reasoning.reasoner_clear,
    "/api/edit/add": editing.edit_add,
    "/api/edit/remove": editing.edit_remove,
    "/api/edit/create": editing.edit_create,
    "/api/edit/delete": editing.edit_delete,
    "/api/edit/rename": editing.edit_rename,
    "/api/edit/rename_ns": editing.edit_rename_ns,
    "/api/edit/raw": editing.edit_raw,
    "/api/edit/axiom_ann_add": editing.edit_axiom_ann_add,
    "/api/edit/axiom_ann_remove": editing.edit_axiom_ann_remove,
    "/api/save": editing.edit_save,
    "/api/workspace/open": ontology.ws_open,
    "/api/workspace/remove": ontology.ws_remove,
    "/api/export_fdl": axioms.fdl_generate,
    "/api/fdl/generate": axioms.fdl_generate,
    "/api/edit/expr": editing.edit_expr,
    "/api/edit/collection": editing.edit_collection,
    "/api/edit/negative": editing.edit_negative,
    "/api/edit/anon_remove": editing.edit_anon_remove,
    "/api/edit/anon_annotate": editing.edit_anon_annotate,
    "/api/dlquery": reasoning.api_dlquery,
    "/api/sparql": reasoning.api_sparql,
    "/api/rules/add": reasoning.rules_add,
    "/api/rules/remove": reasoning.rules_remove,
    "/api/rules/run": reasoning.rules_run,
    "/api/ui_config": ontology.ui_config_save,
    "/api/discard": discard,
    "/api/inference/run": inference.inference_run,
    "/api/inference/stop": inference.inference_stop,
    "/api/inference/individual": inference.inference_individual,
    "/api/inference/export": inference.inference_export,
    "/api/edit/undo": editing.edit_undo,
    "/api/edit/redo": editing.edit_redo,
    "/api/edit/duplicate": editing.edit_duplicate,
    "/api/edit/convert_class": editing.edit_convert_class,
    "/api/module/new": ontology.module_new,
    "/api/serialize": ontology.api_serialize,
    "/api/diff": ontology.api_diff,
    "/api/merge": ontology.api_merge,
    "/api/diff/fetch": ontology.diff_fetch,
    "/api/plugins/remove": plugins.plugin_remove,
    "/api/indexes/remove": ontology.index_remove,
    "/api/queries/save": ontology.queries_save,
}
