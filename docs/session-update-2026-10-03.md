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

### Voice questions (optional)

A medic asks the C2 page a question out loud ("which casualty on my map right now is the most critical?") and gets
one sentence and a table back, with the answer lit up on the map. Speech to text is
[Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3); the question is matched to one of ~24
known questions with [all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2), and below a
similarity of 0.5 it says it did not understand instead of guessing. Both run locally on CPU.

```bash
uv sync --extra voice                 # torch + NeMo, a few GB; models download on first start (~2.5 GB)
VOICE=1 ./run.sh                      # or on its own: uv run --extra voice python scripts/voice_server.py
```

It answers about whichever graph the page shows (`?graph=` in its address), old or new scenario model.
On the C2 page press **M** (or "Ask by voice"), speak, press **M** again; or type the question. Speech recognition
takes about a minute to load; typed questions work as soon as the server is up. Once the models are downloaded,
`HF_HUB_OFFLINE=1` keeps it fully offline. Questions and their example phrasings are in `scripts/voice_query.py`;
add a phrasing there when a medic's wording is not understood, and run `uv run --extra voice pytest`.

### Automatic scene communication

Short speech bubbles appear automatically beside separate field-medic, command, vehicle, casualty and receiving-team
markers. They follow reports, triage decisions, dispatch, approach (within 500 metres), pickup and handover, and fade
after a few seconds. Click a casualty marker or card to start its linked conversation. Its report goes to its medic; the recorded
triage decision then feeds dispatch, vehicle movement, pickup and receiving-team replies. Only that casualty’s
conversation is shown. Click again to replay its current situation, or Clear to stop.

The startup script adds stationary Medic teams (MED-CAS-* at casualty start locations and MED-* at medical points)
and CMD-1. Routing and simulation still move vehicles and casualties. Communication is simulated from recorded
scenario state; no real radio is connected. Drone entities and drone movement are not part of this scenario.
The previous Radio traffic sidebar and selected-marker dialogue panel are no longer rendered.

## Tests

```bash
uv run pytest                      # routing, dispatch, simulator (uses a scratch graph "simtest" if TuringDB runs)

# Live end to end, with ./run.sh running
cd visualizer && npx playwright test tests/simulator.spec.ts
# Or use installed Chrome: PLAYWRIGHT_CHANNEL=chrome npx playwright test tests/simulator.spec.ts
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
| `scripts/voice_query.py`, `voice_server.py` | spoken questions: intents, answers from the graph, Parakeet + MiniLM server |
| `scripts/extract_basemap.py` | offline basemap for the map |
| `visualizer/` | TuringDB visualizer fork with the C2 page (`src/components/c2`, `src/pages/c2.tsx`) |
| `.claude/plans/layer-1-simulator/plan.md` | the simulator plan, decisions and implementation notes |

## Sidebar casualty radio panel

- Replaced all map speech-bubble rendering with one sidebar panel opened by casualty selection.
- Captures each casualty's observed graph events with sender, recipient and scenario timestamp.
- Preserves separate conversation history while switching casualties; clears on scenario reset.
- History is in browser memory for the page session. Reload begins a new observed history.
- Clicking again does not duplicate messages. Recorded triage changes, including revised choices, are logged.
- Validation: TypeScript/build passed; 4 event tests and live browser panel/triage/history/dispatch/movement/reset flow passed. Scenario reset and paused after browser testing.

## Radio dropdown on graph

- Moved the casualty conversation from the sidebar to a dropdown over the graph.
- Clicking the radio title collapses/expands it; × closes it. Messages are retained while collapsed.
- Selecting another casualty opens its own conversation.

## Assignment-to-radio synchronisation

- Inspected the 15:56 screen recording: CAS-1 became assigned while its visible history stopped at a queued request.
- Radio now reads active mission, casualty status, vehicle coordinates and destination together in one direct query,
  rather than reconstructing assignments from independently fetched map nodes and edges.
- The scenario is polled every second during playback; the latest assignment query also sets assigned/in-transit status.
- Dropdown shows a current vehicle → destination line and captures the actual dispatch and vehicle reply.
- Added a regression test with missing map mission data and tightened live assignment/acknowledgment checks.
