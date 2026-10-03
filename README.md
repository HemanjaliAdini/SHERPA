# The Golden Hours

Casualty evacuation C2 on a versioned graph (TuringDB), EDTH London 2026. What we build, what is decided and the
plan: [docs/PRD.md](docs/PRD.md).

## Run it

Needs [uv](https://docs.astral.sh/uv/) and Node.js.

```bash
uv sync

# 1. Roads for the sector into data/osm/roads.json (once). Either:
uv run python scripts/fetch_osm.py                        # Overpass, slow, resumable
uv run python scripts/extract_pbf.py path/to/ukraine.osm.pbf   # from a Geofabrik download

# 2. Start TuringDB and the C2 map (http://localhost:5180/)
./run.sh

# 3. In another terminal: build the graph and plan missions
scripts/build_graph.sh evac2
uv run python scripts/routing.py plan evac2
uv run python scripts/routing.py close <osm_way_id> evac2   # close a road, list broken missions
```

TuringDB has no `DROP GRAPH`: to rebuild, use a new graph name (and `GRAPH=<name> ./run.sh`).

## Tests

```bash
uv run pytest
```

## Layout

| Path | What |
|---|---|
| `scripts/fetch_osm.py`, `extract_pbf.py` | OSM roads for the sector |
| `scripts/build_roads.py` | roads → `Junction` / `ROAD` parquet for `LOAD PARQUET` |
| `scripts/seed_scenario.py` | medical points, vehicles, casualties, threat on the real roads |
| `scripts/routing.py` | route search with computed travel time, mission planning, road closure |
| `scripts/seed_toy_graph.py` | 13-junction test graph, no OSM needed |
| `scripts/extract_basemap.py` | offline basemap for the map |
| `visualizer/` | TuringDB visualizer fork with the C2 map page |
