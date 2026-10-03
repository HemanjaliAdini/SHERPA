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
./run.sh            # then open http://localhost:5180/?graph=evac       the plain scenario, free play
                    #       or   http://localhost:5180/?graph=evac_demo  the scripted demo
```

`run.sh` starts TuringDB **in memory**, builds two scenario graphs from the repo (`data/osm/roads.json` +
`scripts/seed_scenario.py`, a few seconds each), then a simulator for each and the C2 screen. `evac` is the plain
scenario: five casualties, nothing else happens. `evac_demo` also plays the scripted demo (`scripts/demo_script.py`:
casualties arriving, a road closed and reopened, a UGV whose battery dies with a casualty on board); Reset puts the
script back. `DEMO_GRAPH=` (empty) skips it. Everyone who pulls the same commit
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

A medic asks the C2 page a question out loud, in English or Ukrainian ("which casualty on my map right now is the
most critical?", "хто з поранених зараз найкритичніший?"), and gets one sentence and a table back in the same
language, with the answer lit up on the map. Speech to text is
[Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3); the question is matched to one of 24
known questions with [paraphrase-multilingual-MiniLM-L12-v2](https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2),
and below a similarity of 0.6 it says it did not understand instead of guessing. Both run locally on CPU.

```bash
uv sync --extra voice                 # torch + NeMo, a few GB; models download on first start (~2.5 GB)
VOICE=1 ./run.sh                      # or on its own: uv run --extra voice python scripts/voice_server.py
```

It answers about whichever graph the page shows (`?graph=` in its address), old or new scenario model.
On the C2 page press **M** (or "Ask by voice"), speak, press **M** again; or type the question. Speech recognition
takes about a minute to load; typed questions work as soon as the server is up. Once the models are downloaded,
`HF_HUB_OFFLINE=1` keeps it fully offline. Questions and their English phrasings are in `scripts/voice_query.py`;
everything Ukrainian (phrasings, answers, table headings) is in `scripts/voice_text.py`, for a native speaker to
review. Add a phrasing when a medic's wording is not understood, and run `uv run --extra voice pytest`.

### Casualty radio panel

Click a casualty marker or card to open its radio dropdown over the graph. The map has no speech bubbles.
Messages show sender → recipient and scenario time: report, medic acknowledgment, recorded triage/priority,
command dispatch, assigned vehicle movement/pickup, receiving-team reply and handover or onward transfer.
Each casualty's messages stay readable when you switch cases. Click its title to collapse or expand the conversation, or × to close it.
History is captured while this page is open; reset starts a new history, and page reload starts a new session.

Field reports come from the soldier with the casualty and go to the medical coordinator at R1-A (`MED-R1-A`); no medic
is placed with a casualty. Medic teams at the medical points and command are separate stationary graph entities. Existing simulation and routing still move
vehicles and casualties and choose destinations. Radio text is simulated from graph state; no live radio is connected.
The panel reads each active mission, casualty status, vehicle position and destination together in one query, polled
every second during playback, so a dispatch shows up even when the map's mission nodes lag behind.

### Entity info boxes

Click a vehicle, medical point, medic team or the command post to open its info box over the map (× or Esc closes it).
A vehicle shows casualties aboard out of capacity, who it is collecting and where it delivers, fuel or battery
(`battery_pct`), range left, speed and damage. A medical point shows patients held, casualties on the way, free beds,
medics available, capabilities, equipment and vehicles waiting there. A medic team shows its point;
command shows the scenario totals. `Vehicle.damage` and `MedicalPoint.equipment` are placeholder seed values in
`scripts/seed_scenario.py`; the simulator does not change them.

### Vehicle bases, the forward post and the reserve UGV

Every vehicle has a home point (`Vehicle.base`, the medical point it starts at). When a mission is dispatched, a
banner in the sidebar says which point sent which vehicle, the point's info box lists "Own vehicles sent out", and
the point's medic team says so on the casualty's radio.

- **Near, automatic:** UGV-1 and UGV-2 wait at HP-1 and UGV-3 at the forward post R1-C ("Role 1 forward", on the
  CCP-C to HP-1 road). The dispatcher uses them like any vehicle.
- **Reserve, requested:** UGV-4 is held in reserve at R2B-1 (`status = 'reserve'`, ignored by the dispatcher). The
  simulator asks for it (`reinforce` in `scripts/simulate.py`) when a UGV is out of service (`disabled`, by an event
  or by Mark as lost), even while other UGVs are free, or when a casualty at the front is still waiting after
  dispatch and no UGV is idle. It gets `status = 'requested'` with `arrives_at`, `arrive_point` and
  `request_reason`, is carried by road at 60 km/h, becomes idle at the nearest handover point, and is then
  dispatched normally. The map shows it driving the route while it travels. There is one reserve UGV, so one
  request.
- **Losing a vehicle:** an idle vehicle's info box has **Mark as lost** (`status = 'disabled'`, `damage = 'heavy'`,
  `disabled_by = 'operator'`, the same state as a vehicle stopped by an event); the dispatcher no longer uses it. Reset brings it back.

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
| `scripts/events.py`, `demo_script.py` | events during a run (road closed or slowed, new casualty, battery depleted): applied on the tick, re-routing, stranded casualties, reset; the scripted demo |
| `scripts/seed_toy_graph.py` | 13-junction test graph, no OSM needed |
| `scripts/voice_query.py`, `voice_text.py`, `voice_server.py` | spoken questions in English and Ukrainian: intents, answers from the graph, all Ukrainian text, Parakeet + MiniLM server |
| `scripts/extract_basemap.py` | offline basemap for the map |
| `visualizer/` | TuringDB visualizer fork with the C2 page (`src/components/c2`, `src/pages/c2.tsx`) |
| `.claude/plans/layer-1-simulator/plan.md` | the simulator plan, decisions and implementation notes |
