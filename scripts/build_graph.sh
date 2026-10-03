#!/usr/bin/env bash
# Build the evacuation graph end to end: OSM roads -> parquet -> TuringDB graph -> scenario on top.
# Needs data/osm/roads.json (scripts/fetch_osm.py or scripts/extract_pbf.py) and a running TuringDB (./run.sh).
# Usage: scripts/build_graph.sh [graph_name]   (default: evac2). TuringDB has no DROP GRAPH: use a new name to rebuild.
set -euo pipefail
cd "$(dirname "$0")/.."
GRAPH="${1:-evac2}"

[ -f data/osm/roads.json ] || { echo "data/osm/roads.json missing: run scripts/fetch_osm.py first" >&2; exit 1; }
uv run python scripts/build_roads.py
uv run python -c "from turingdb import TuringDB; TuringDB(host='http://localhost:6666').query(\"LOAD PARQUET 'evac_roads' AS $GRAPH\")"
uv run python scripts/seed_scenario.py "$GRAPH"
echo "graph '$GRAPH' ready. Plan missions with: uv run python scripts/routing.py plan $GRAPH"
