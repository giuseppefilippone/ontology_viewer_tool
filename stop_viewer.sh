#!/bin/zsh
# Stop the Ontology Viewer started by ontology_viewer_tool/start_viewer.sh.
#
#   ontology_viewer_tool/stop_viewer.sh [port]       (default 8765)
#
# First asks the server to stop itself (POST /api/shutdown), then falls back to
# killing the recorded PID.
set -u
cd "$(dirname "$0")/viewer"
PORT="${1:-8765}"
PIDFILE=data/viewer.pid

if curl -sf -m 3 -X POST -H 'Content-Type: application/json' -d '{}' \
        "http://localhost:$PORT/api/shutdown" >/dev/null 2>&1; then
    echo "shutdown requested on port $PORT"
else
    echo "no server answering on port $PORT"
fi

if [ -f "$PIDFILE" ]; then
    PID=$(cat "$PIDFILE")
    for i in {1..20}; do
        kill -0 "$PID" 2>/dev/null || break
        sleep 0.25
    done
    if kill -0 "$PID" 2>/dev/null; then
        echo "still alive: killing pid $PID"
        kill "$PID" 2>/dev/null || true
    fi
    rm -f "$PIDFILE"
fi
echo "Ontology Viewer stopped."
