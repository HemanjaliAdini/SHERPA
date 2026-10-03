#!/usr/bin/env bash
# Start TuringDB (daemon + its UI) and the C2 visualizer. Ctrl-C stops what this script started.
# Overrides: TURING_DIR (default ~/.turing), GRAPH (default evac2),
#   TURING_FRONTEND_PORT (5180), TURING_API_PORT (6666), TURING_UI_PORT (8080)
# VOICE=1 also starts the voice question server (needs `uv sync --extra voice`), VOICE_PORT (6680)
set -euo pipefail
cd "$(dirname "$0")"

TURING_DIR="${TURING_DIR:-$HOME/.turing}"
GRAPH="${GRAPH:-evac2}"
FRONTEND_PORT="${TURING_FRONTEND_PORT:-5180}"
API_PORT="${TURING_API_PORT:-6666}"
UI_PORT="${TURING_UI_PORT:-8080}"

started_db=0
cleanup() {
  trap - EXIT INT TERM
  pkill -P $$ 2>/dev/null || true  # the visualizer dev server and the simulator
  if [ "$started_db" = 1 ]; then
    echo
    echo "Stopping TuringDB..."
    uv run turingdb stop -turing-dir "$TURING_DIR" || true
  fi
}
trap cleanup EXIT INT TERM

db_up() { curl -s -m 2 -o /dev/null -X POST "http://localhost:$API_PORT/query" -d "LIST GRAPH"; }

# A TuringDB that this script did not start would otherwise survive Ctrl-C, so offer to take it over.
# RESTART_DB=1 / RESTART_DB=0 answers the question without prompting.
if db_up; then
  restart="${RESTART_DB:-}"
  if [ -z "$restart" ] && [ -t 0 ]; then
    read -r -p "TuringDB is already running on :$API_PORT. Restart it here so Ctrl-C stops it? [Y/n] " answer
    case "$answer" in [nN]*) restart=0 ;; *) restart=1 ;; esac
  fi
  if [ "${restart:-0}" = 1 ]; then
    echo "Stopping the running TuringDB..."
    uv run turingdb stop -turing-dir "$TURING_DIR" || true
    if db_up; then
      echo "Could not stop it (started with a different -turing-dir?). Stop it where it runs, then rerun." >&2
      exit 1
    fi
  else
    echo "Reusing the running TuringDB on :$API_PORT. It will be LEFT RUNNING when you quit."
    curl -s -m 20 -o /dev/null -X POST "http://localhost:$API_PORT/query" -d "LOAD GRAPH $GRAPH" || true
  fi
fi

if ! db_up; then
  uv run turingdb start -turing-dir "$TURING_DIR" -p "$API_PORT" -demon -ui -ui-port "$UI_PORT" -load "$GRAPH"
  started_db=1
fi

# Simulator: follows the SimControl node (play/pause on the C2 screen), writes one commit per scenario minute
uv run python scripts/simulate.py "$GRAPH" &

if [ "${VOICE:-0}" = 1 ]; then
  GRAPH="$GRAPH" uv run --extra voice python scripts/voice_server.py &
fi

cd visualizer
[ -d node_modules ] || npm i --no-audit --no-fund

echo
echo "C2 visualizer:        http://localhost:$FRONTEND_PORT/?graph=$GRAPH"
echo "TuringDB visualizer:  http://localhost:$UI_PORT/"
echo "TuringDB API:         http://localhost:$API_PORT/   (graph: $GRAPH)"
echo

# Background + wait so the trap runs as soon as a signal arrives, not after the dev server exits
TURING_FRONTEND_PORT="$FRONTEND_PORT" TURING_API_PORT="$API_PORT" npm run dev &
wait $!
