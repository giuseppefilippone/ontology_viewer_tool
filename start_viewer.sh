#!/bin/zsh
# Start the Ontology Viewer in the background.
#
#   ontology_viewer_tool/start_viewer.sh [port]      (default 8765)
#
# The server binds to 127.0.0.1 only and opens the browser by itself once it is
# listening. Logs go to ontology_viewer_tool/viewer/data/viewer.log, the PID to
# ontology_viewer_tool/viewer/data/viewer.pid. Stop with ontology_viewer_tool/stop_viewer.sh or with the stop
# button in the page header.
set -euo pipefail
cd "$(dirname "$0")/viewer"
PORT="${1:-8765}"
mkdir -p data
PIDFILE=data/viewer.pid

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "already running (pid $(cat "$PIDFILE")) - http://localhost:$PORT"
    exit 0
fi
if curl -sf -m 2 "http://localhost:$PORT/api/index_status" >/dev/null 2>&1; then
    echo "something is already listening on port $PORT - stop it first (ontology_viewer_tool/stop_viewer.sh $PORT)"
    exit 1
fi

nohup python3 server.py "$PORT" >> data/viewer.log 2>&1 &
echo $! > "$PIDFILE"

# wait until the server answers (up to 15 s: the JS bundle may be rebuilt at startup)
for i in {1..30}; do
    if curl -sf -m 2 "http://localhost:$PORT/" >/dev/null 2>&1; then
        echo "Ontology Viewer started: http://localhost:$PORT (pid $(cat "$PIDFILE"), log: ontology_viewer_tool/viewer/data/viewer.log)"
        exit 0
    fi
    sleep 0.5
done
echo "server did not come up - see ontology_viewer_tool/viewer/data/viewer.log"
exit 1
