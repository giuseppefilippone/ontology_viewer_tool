"""Entry point of the Ontology Viewer.

Usage:  python3 server.py [port]     (default 8765; builds the index in the background if missing)
Then open http://localhost:<port> — the browser is the GUI.

This script only parses the optional port argument and hands over to ``ontoviewer.http.serve``,
which blocks until Ctrl+C.  Run it from ``code/viewer`` (the background indexer is spawned
with that directory as cwd, see ``ontoviewer.api.ontology.api_reindex``).
"""

import sys

from ontoviewer.http import serve

if __name__ == "__main__":
    # optional first argument: TCP port (a non-numeric value raises ValueError on purpose)
    serve(int(sys.argv[1]) if len(sys.argv) > 1 else 8765)
