# The Golden Hours

Casualty evacuation C2 on a versioned graph (TuringDB), EDTH London 2026. What we build, what is decided and the
plan: [docs/PRD.md](docs/PRD.md).

## Run it

Needs [uv](https://docs.astral.sh/uv/) (`curl -LsSf https://astral.sh/uv/install.sh | sh`) and Node.js.

```bash
uv sync

# 1. Roads for the sector into data/osm/roads.json (once). Either:
uv run python scripts/fetch_osm.py                        # Overpass, slow, resumable
uv run python scripts/extract_pbf.py path/to/ukraine.osm.pbf   # from a Geofabrik download

# 2. Start TuringDB and the C2 map
./run.sh
#    C2 map:              http://localhost:5180/?graph=evac2
#    TuringDB graph view: http://localhost:8080

# 3. In another terminal: build the graph and plan missions
scripts/build_graph.sh evac2
uv run python scripts/routing.py plan evac2
uv run python scripts/routing.py close <osm_way_id> evac2   # close a road, list broken missions
```

### Voice questions (optional)

A medic asks the C2 page a question out loud ("which casualty on my map right now is the most critical?") and gets
one sentence and a table back, with the answer lit up on the map. Speech to text is
[Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3); the question is matched to one of ~24
known questions with [all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2), and below a
similarity of 0.5 it says it did not understand instead of guessing. Both run locally on CPU.

```bash
uv sync --extra voice                 # torch + NeMo, a few GB; models download on first start (~2.5 GB)
VOICE=1 ./run.sh                      # or: GRAPH=evac3 uv run --extra voice python scripts/voice_server.py
```

On the C2 page press **M** (or "Ask by voice"), speak, press **M** again; or type the question. Speech recognition
takes about a minute to load; typed questions work as soon as the server is up. Once the models are downloaded,
`HF_HUB_OFFLINE=1` keeps it fully offline. Questions and their example phrasings are in `scripts/voice_query.py`;
add a phrasing there when a medic's wording is not understood, and run `uv run --extra voice pytest`.

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
| `scripts/voice_query.py`, `voice_server.py` | spoken questions: intents, answers from the graph, Parakeet + MiniLM server |
| `scripts/extract_basemap.py` | offline basemap for the map |
| `visualizer/` | TuringDB visualizer fork with the C2 map page |
