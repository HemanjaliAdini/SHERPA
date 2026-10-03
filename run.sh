#!/usr/bin/env bash
# Start TuringDB (daemon + its UI) and the C2 visualizer. Ctrl-C stops what this script started.
# Overrides: TURING_DIR (default ~/.turing), GRAPH (default evac2), TURING_FRONTEND_PORT (default 5180)
set -euo pipefail
cd "$(dirname "$0")"

TURING_DIR="${TURING_DIR:-$HOME/.turing}"
GRAPH="${GRAPH:-evac2}"
FRONTEND_PORT="${TURING_FRONTEND_PORT:-5180}"
API_PORT=6666

started_db=0
cleanup() {
  trap - EXIT INT TERM
  pkill -P $$ 2>/dev/null || true  # the visualizer dev server
  if [ "$started_db" = 1 ]; then
    echo
    echo "Stopping TuringDB..."
    uv run turingdb stop -turing-dir "$TURING_DIR" || true
  fi
}
trap cleanup EXIT INT TERM

if curl -s -m 2 -o /dev/null -X POST "http://localhost:$API_PORT/query" -d "LIST GRAPH"; then
  echo "TuringDB already running on :$API_PORT, reusing it (it will be left running on exit)"
  curl -s -m 20 -o /dev/null -X POST "http://localhost:$API_PORT/query" -d "LOAD GRAPH $GRAPH" || true
else
  uv run turingdb start -turing-dir "$TURING_DIR" -demon -ui -load "$GRAPH"
  started_db=1
fi

cd visualizer
[ -d node_modules ] || npm i --no-audit --no-fund

echo
echo "C2 visualizer:        http://localhost:$FRONTEND_PORT/"
echo "TuringDB visualizer:  http://localhost:8080/"
echo "TuringDB API:         http://localhost:$API_PORT/   (graph: $GRAPH)"
echo

# Background + wait so the trap runs as soon as a signal arrives, not after the dev server exits
TURING_FRONTEND_PORT="$FRONTEND_PORT" TURING_API_PORT="$API_PORT" npm run dev &
wait $!
