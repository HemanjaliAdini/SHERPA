# The Golden Hours

Casualty evacuation C2 on a versioned graph (TuringDB), EDTH London 2026. What we build, what is decided and the
plan: [docs/PRD.md](docs/PRD.md).

You play the medic: read each casualty's MIST report and set its triage category and mobility. The system does the
logistics (which vehicle, where, which route) and a simulator runs the scenario, one TuringDB commit per scenario
minute.

## Run it

Needs [uv](https://docs.astral.sh/uv/) (`curl -LsSf https://astral.sh/uv/install.sh | sh`) and Node.js.

```bash
uv sync
./run.sh            # then open http://localhost:5180/?graph=evac
```

`run.sh` starts TuringDB **in memory**, builds the scenario graph `evac` from the repo (`data/osm/roads.json` +
`scripts/seed_scenario.py`, a few seconds), then the simulator and the C2 screen. Everyone who pulls the same commit
runs the same graph; nothing is stored on disk, and the run history lasts until TuringDB stops. Why in memory: on disk
every TuringDB commit costs ~30 MB, and the simulator makes one per scenario minute.

**On the screen:** triage every card (Litter = needs a stretcher, Ambulatory = can sit or walk), press **Play**, pick a
speed (scenario minutes per second), **Pause**, **Reset** to start again (the history is kept). **Manual** shows the
manual mission planner, hidden by default.

From the terminal:

```bash
uv run python scripts/simulate.py --reset evac               # same as the Reset button
uv run python scripts/routing.py close <osm_way_id> evac     # close a road both ways, list broken missions
```

To refresh the roads from OpenStreetMap (slow; the repo already has `data/osm/roads.json`):
`uv run python scripts/fetch_osm.py`, or `uv run python scripts/extract_pbf.py path/to/ukraine.osm.pbf`.

## Tests

```bash
uv run pytest                      # routing, dispatch, simulator (uses a scratch graph "simtest" if TuringDB runs)

# Live end to end, with ./run.sh running
cd visualizer && npx playwright test tests/simulator.spec.ts
```

## Layout

| Path | What |
|---|---|
| `scripts/fetch_osm.py`, `extract_pbf.py` | OSM roads for the sector |
| `scripts/build_roads.py` | roads → `Junction` / `ROAD` parquet for `LOAD PARQUET` |
| `scripts/build_graph.sh` | builds a graph end to end: roads, `LOAD PARQUET`, scenario |
| `scripts/seed_scenario.py` | medical points, vehicles, untriaged casualties with MIST reports, simulator clock |
| `scripts/routing.py` | route search with computed travel time, automatic dispatch, road closure |
| `scripts/simulate.py` | the simulator: ticks, movement, pickups and drops, reset |
| `scripts/seed_toy_graph.py` | 13-junction test graph, no OSM needed |
| `scripts/extract_basemap.py` | offline basemap for the map |
| `visualizer/` | TuringDB visualizer fork with the C2 page (`src/components/c2`, `src/pages/c2.tsx`) |
| `.claude/plans/layer-1-simulator/plan.md` | the simulator plan, decisions and implementation notes |
