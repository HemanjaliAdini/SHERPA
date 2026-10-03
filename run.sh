#!/usr/bin/env bash
# Start TuringDB (in memory), build the scenario graphs from the repo, then a simulator for each and the C2 screen.
# Two graphs: GRAPH (default evac) is the plain scenario, for free play; DEMO_GRAPH (default evac_demo) also plays
# the scripted demo (scripts/demo_script.py: casualties arriving, a road closed and reopened, a flat UGV battery).
# Ctrl-C stops what this script started.
# TuringDB runs with -in-memory: on disk every commit costs ~30 MB (one per scenario minute fills a disk in a
# day), in memory ~0.04 MB. The graph is rebuilt from the repo on every start, so everyone runs the same graph;
# the run history lasts until TuringDB stops.
# Overrides: TURING_DIR (default ~/.turing), GRAPH (default evac), DEMO_GRAPH (default evac_demo; empty: none),
#   TURING_FRONTEND_PORT (5180), TURING_API_PORT (6666), TURING_UI_PORT (8080)
# VOICE=1 also starts the voice question server (needs `uv sync --extra voice`), VOICE_PORT (6680)
set -euo pipefail
cd "$(dirname "$0")"

TURING_DIR="${TURING_DIR:-$HOME/.turing}"
GRAPH="${GRAPH:-evac}"
DEMO_GRAPH="${DEMO_GRAPH-evac_demo}"
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
  fi
fi

if ! db_up; then
  uv run turingdb start -turing-dir "$TURING_DIR" -p "$API_PORT" -demon -in-memory -ui -ui-port "$UI_PORT"
  started_db=1
fi

# Build each scenario graph from the repo if this TuringDB does not have it yet
build() {  # graph name, then --demo for the scripted demo
  if ! curl -s -m 5 -X POST "http://localhost:$API_PORT/query" -d "LIST GRAPH" | grep -q "\"$1\""; then
    echo "Building graph '$1' from the repo..."
    scripts/build_graph.sh "$@"
  fi
}
build "$GRAPH"
[ -n "$DEMO_GRAPH" ] && build "$DEMO_GRAPH" --demo

# Medic teams and command (PRD 6.16), on each graph; idempotent
uv run python scripts/scene_entities.py "$GRAPH"
[ -n "$DEMO_GRAPH" ] && uv run python scripts/scene_entities.py "$DEMO_GRAPH"

# Simulators, one per graph: each follows its SimControl node (play/pause on the C2 screen), one commit per minute
uv run python scripts/simulate.py "$GRAPH" &
if [ -n "$DEMO_GRAPH" ]; then
  uv run python scripts/simulate.py "$DEMO_GRAPH" &  # a plain background job, so Ctrl-C stops it too
fi

if [ "${VOICE:-0}" = 1 ]; then
  GRAPH="$GRAPH" uv run --extra voice python scripts/voice_server.py &
fi

cd visualizer
[ -d node_modules ] || npm i --no-audit --no-fund

echo
echo "C2 visualizer:        http://localhost:$FRONTEND_PORT/?graph=$GRAPH"
[ -n "$DEMO_GRAPH" ] && echo "Scripted demo:        http://localhost:$FRONTEND_PORT/?graph=$DEMO_GRAPH"
echo "TuringDB visualizer:  http://localhost:$UI_PORT/"
echo "TuringDB API:         http://localhost:$API_PORT/   (graph: $GRAPH)"
echo

# Background + wait so the trap runs as soon as a signal arrives, not after the dev server exits
TURING_FRONTEND_PORT="$FRONTEND_PORT" TURING_API_PORT="$API_PORT" npm run dev &
wait $!
