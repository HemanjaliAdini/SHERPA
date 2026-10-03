# The Golden Hours: System Design

Team document, EDTH London (2–4 Oct 2026). **This is the single source of truth**: what we build, what is decided, what
is still open, and the plan. If code and this document disagree, fix one of them the same day. A decision taken while
coding goes into section 6 or 7 before the code is pushed.

---

## 1. The problem

Getting wounded troops to surgery within an hour nearly halved combat deaths in Afghanistan (13.7% → 7.6%). That "golden hour" depended on fast evacuation through uncontested airspace.

Cheap drones have ended that. In Ukraine, casualties are held forward for hours, days or even weeks, evacuated in brief windows by ground robots or on foot, and kept alive by supplies pushed forward to them.

The physiology hasn't changed, but the logistics have. Evacuation is no longer one fast transfer: it is a continuous coordination problem across casualties, routes, windows, assets and resupply. Commanders lack a single live picture of these relationships, so they can't prioritise who moves, when, by what means, and what must reach them first.

**Who is the user or stakeholder?** The C2 (command and control) of a medical brigade, and ambulance coordinators.

**Does this actually work in the real world?** Maybe. To validate with mentors.

**Is it novel, useful and mass-producible?** Yes.

**Dual use.** The same system applies to organising ambulance services, disaster rescue and civilian mass-casualty events.

### Current trauma pathway

```
Point of wounding
      ↓
Stabilisation / triage point
      ↓
Role 1
      ↓
Role 2 / Role 2 enhanced
      ↓
Field hospital
      ↓
Hospital at home
```

- The number of points at each level is a funnel: there are more stabilisation points than Role 1s, and so on.
- Distance from the frontline increases as you go down.
- So does the seniority of the staff, from a soldier with basic first-aid training to a consultant.

---

## 2. Scenario area

Orikhiv–Robotyne–Zaporizhzhia, Zaporizhzhia oblast (Ukraine), box 47.40–47.90 N, 35.00–35.95 E, using OpenStreetMap
roads. Minor roads and tracks are included only near the front (47.40–47.62 N, 35.60–35.95 E). Main roads in view:
T0408, T0803, T0812, T0815. Scenario time: September 2023 (Robotyne). The front line is at about 47.436 N.

The roads are today's OpenStreetMap (2026), not the 2023 network: they reflect the area as the war has left it
(damaged, rebuilt and newly mapped roads and bridges). This works in our favour: the scenario plays on the terrain
as it is now.

![Scenario area around Orikhiv](area-orikhiv.png)

---

## 3. System requirements

### What the system does

1. **Casualties arrive with their information already collected,** as a MIST/MISTAT report or with what is needed
   for a triage decision. Drones and sensors come later. Starting point: there are X casualties with this information.
2. **The medic decides only clinical matters:** triage category and mobility (walking or stretcher), from the report.
3. **The system decides all logistics:** which vehicle goes, the pickup order, which medical point and which route.
   If nothing can take a casualty, it says so ("no resource available").
4. **The system handles changing events,** for example a bridge collapse, or a stabilisation point that is overwhelmed
   or has lost power.
5. **Information arrives asynchronously.** Different messages arrive at different times, and the plan updates from
   each one.
6. **The database tells each UGV where to go next.**
7. **Replay to learn from deployments.** Replaying TuringDB history answers questions such as "if we had one more UGV,
   how many more lives could we have saved?"
8. **Everything is live on a map:** casualties, vehicles, medical points, threats and routes.

### Nice to have

1. **Real detections from drones and devices.** Use a vision model on drone images instead of simulated detections, and gather as much information as possible from drones or electronic devices (such as phones) to feed triage.
2. **Request more resources.** When UGVs or medics are short, send a message or call to one of us, simulating getting more UGVs ready as soon as possible.
3. **Plain-language questions** to a local LLM, translated into graph queries.
4. **A triage suggestion,** possibly based on the NHS Major Incident Triage Tool (below). It only suggests; the medic decides.

![NHS Major Incident Triage Tool](triage-mitt.png)

### Out of scope (deliberately)

- **AI that decides clinical priority.** The system executes the medic's triage; it never sets it.
- **Real patient data.** The scenario is synthetic.
- **Anything that could work as targeting or weapons guidance.** This is casualty care only.
- **Cloud services.** Everything runs on our laptops, offline, as it would in the field.

---

## 4. How it works

```
 OSM roads ──build_roads.py──▶ parquet ──LOAD PARQUET──▶ TuringDB graph ◀── seed_scenario.py (points, vehicles,
                                                          ▲   │                     untriaged casualties, Clock)
                          one commit per scenario minute  │   │ reads Clock, SimControl, roads, missions
                                                          │   ▼
                                                     simulate.py: dispatch (routing.py) + movement
                                                          ▲
              triage, play/pause, speed, reset (writes)   │   reads the graph each tick
                                                     C2 screen (visualizer/, /c2)
```

- **TuringDB** holds the state of the world and its history. Every change (a triage, a mission, a tick, a closed
  bridge) is a commit, so time travel, branches and replay come for free.
- **We play the medics.** On the C2 screen we read each casualty's MIST report and set its category and mobility.
  That is the only decision the user takes.
- **The simulator does the logistics and the time** (`scripts/simulate.py`, started by `run.sh`). Each tick is one
  scenario minute and one commit: it dispatches free vehicles to triaged casualties (most urgent first), moves
  vehicles along their routes, picks casualties up, drops them off, and moves the clock on.
- **Everything hangs off the road network.** Casualties, vehicles and medical points link to their nearest junction
  with `NEAR`. A route is a path of `ROAD` edges between those junctions.
- **A mission** is vehicle → casualty → medical point. A UGV drops at a handover or collection point; the casualty
  then waits for an ambulance to Role 1 or higher (the second leg).

---

## 5. Data model

Status: ✅ in the graph today · 🔜 decided, not built yet · ❓ depends on an open decision (section 7).

### Entities

```
(:Junction {id, lat, lon})                                                         ✅

(:MedicalPoint {id, name, lat, lon, type, capabilities, medics_available,          ✅
                state, free_beds,
                medics_total})                                                     🔜

(:Vehicle {id, type, lat, lon, litter_capacity, ambulatory_capacity, range_km,     ✅
           battery_pct, max_threat, speed_kmh, status})

(:Casualty {id, lat, lon, time_of_injury, status, triage_category, mobility,       ✅
            mist_mechanism, mist_injuries, mist_signs, mist_treatment})

(:Threat {id, type, level, active})                                                ✅

(:Mission {id, status, created_at, eta, progress_m})                               ✅

(:Clock {id, now})                     written only by the simulator              ✅
(:SimControl {id, running, speed, reset})   written only by the C2 screen         ✅
```

### Relationships

```
(:Junction)-[:ROAD {id, geometry, length_m, surface, status, delay_factor,         ✅
                    speed_ugv_kmh, speed_ambulance_kmh, highway, bridge, osm_way_id,
                    threat_level}]->(:Junction)                                    ❓ 7.1

(:Casualty | :Vehicle | :MedicalPoint)-[:NEAR {distance_m}]->(:Junction)           ✅
(:Threat)-[:AFFECTS]->(:Junction)                                                  ✅

(:Mission)-[:USES]->(:Vehicle)                                                     ✅
(:Mission)-[:PICKS_UP {order, status, eta}]->(:Casualty)                           ✅
(:Mission)-[:DELIVERS_TO]->(:MedicalPoint)                                         ✅
(:Mission)-[:ROUTE_STEP {order}]->(:Junction)                                      ✅

(:Casualty)-[:HELD_AT]->(:MedicalPoint)                                            ✅
(:Report)-[:ABOUT]->(:Casualty)                                                    ❓ 7.5
(:MedicalPoint)-[:REQUESTS_VEHICLE | :REQUESTS_MEDICS]->(:MedicalPoint)            bonus
```

### Field notes

- **`ROAD`:** one edge per permitted direction. A two-way road is two edges with the same `osm_way_id`.
  - `speed_*_kmh` are the road's speed caps per vehicle type, from road class and surface.
  - `delay_factor` is 1.0 normally; raise it for a jam, damage or threat.
  - `status` is `open` or `closed`.
  - `geometry` is the text `"lat,lon;lat,lon;..."`.
- **`Vehicle.speed_kmh`:** the vehicle's own current speed (it drops with low battery, for example). `type` is `ugv`
  or `ambulance`. `status` is `idle` or `tasked`.
- **`Casualty.status`:** `reported` (untriaged) → `awaiting_pickup` → `assigned` → `in_transit` → `delivered`, or back
  to `awaiting_pickup` when dropped at a handover or collection point; `dead` when triaged `DEAD`. Triage labels
  depend on 7.2.
- **`Mission.status`:** `planned` → `active` → `done`. `progress_m` is the distance driven along its `ROUTE_STEP`s.
- **`SimControl.speed`:** scenario minutes per real second (default 1). `reset = true` asks the simulator to put the
  scenario back to its start, as one commit; the history is kept.
- **Types:** lists (`capabilities`) and `datetime(...)` (`time_of_injury`) are native TuringDB types (6.4).

---

## 6. Decisions (closed)

Each one: what we chose and why. Do not reopen without a new fact.

1. **Travel time is computed at routing time, never stored.** Time across a road for one vehicle =
   `length_m / min(vehicle.speed_kmh, road cap for its type) * delay_factor`. The search is a Dijkstra in Python
   (`routing.py`) over the open roads of the commit being read.
   - *Why:* distance and speed are the facts; time depends on the vehicle and on current conditions. It changes
     whenever a vehicle's speed, a road's delay or a road's status changes.
   - *Rejected:* minutes stored per vehicle type (cannot tell two UGVs apart, and every delay means rewriting roads);
     patching TuringDB (a C++ server).
   - *Verified:* TuringDB 3.0 does have a shortest path, with its own syntax:
     `MATCH (a) WHERE a = <id> MATCH (b) WHERE b = <id> shortestPath(a, b, length_m, dist, path) RETURN dist, path`.
     The weight must be one stored property; an expression such as `length_m / speed_ugv_kmh` is a parse error.
     So it can find the shortest or the fastest-per-type route, but not the fastest for one specific vehicle.
2. **The system does logistics, the medic does triage** (requirements 2–3).
   - *Pickup order:* by triage category, then time since injury.
   - *Medical point:* among points with the needed capability, operational and with a free bed, the one with the
     fewest route minutes.
   - *Vehicle:* the one that can carry the casualty (stretcher or seat), is within range and gives the fastest
     whole trip.
3. **The real OSM map is the base,** and the scenario is placed on it (`seed_scenario.py` on graph `evac2`). The toy
   graph (`seed_toy_graph.py`) is kept only as a fast test fixture.
4. **Data types:** keep lists and `datetime`; TuringDB 3.0 stores and returns both correctly.
5. **The vehicle is assumed to reach the casualty.** It really stops at the nearest junction; `NEAR.distance_m` is
   kept for display only.
6. **Closing a road closes every edge with its `osm_way_id`** (both directions). Broken missions are those with
   consecutive `ROUTE_STEP`s across a closed edge.
7. ~~**One-way roads:** try the next 3 nearest junctions.~~ Dropped with the simulator: every scenario entity is
   reachable on the current graph.
8. **The simulator** (Layer 1 plan: `.claude/plans/layer-1-simulator/plan.md`):
   - one tick = one scenario minute = one commit, which stores the scenario time in `Clock` (the history has no
     timestamps of its own);
   - Python owns the clock and the loop; the C2 screen controls it through `SimControl`. One writer per node;
   - the medic triages the whole batch while paused; on play the first tick dispatches it by priority (T1, T2, T3,
     then time of injury). No reassignment of busy vehicles;
   - dispatch rules as the C2 planner's: UGVs to a handover or collection point, ambulances to Role 1 or higher, a
     casualty at a relay point gets ambulances only, range × battery, no road above the vehicle's `max_threat`;
   - movement uses each vehicle's own `speed_kmh` (6.1).
9. **TuringDB facts learned building it:** `CALL db.history()` lists the newest commit first, marked `(HEAD)`; the
   `change` parameter of the HTTP API is hexadecimal; edges created after a change's last `COMMIT` are invisible to
   later reads in that change; a change that creates an edge from a node modified on main meanwhile is rejected;
   **on disk every commit costs ~30 MB whatever it changes** (it filled a laptop disk in an afternoon), in memory
   ~0.04 MB.
10. **TuringDB runs in memory and the graph is rebuilt from the repo on every start** (`run.sh`). This is also how
    the team shares one graph: same commit, same graph. The run history lasts until TuringDB stops.
    *Rejected:* a shared server (venue wifi, one point of failure, only one simulator allowed), TuringDB Cloud
    (offline requirement), copying graph folders (gigabytes).

---

## 7. Open decisions

To settle together. Only 7.8 (event format) blocks the MVP, as part of the simulator decisions (section 8, step 1).

1. **Threat: one source of truth.** Today it is both `Threat-[:AFFECTS]->Junction` and `ROAD.threat_level`, and
   routing ignores both, so **ambulances are sent to the front**.
   - *Proposal:* keep `ROAD.threat_level` as what routing reads; a vehicle skips roads above its `max_threat`. The
     `Threat` node stays as the record of what and when. The C2 map already colours roads by `threat_level`.
2. **Triage labels.** Code uses NATO `T1`/`T2`/`T3`; the triage tool in this document is MITT.
   - *Proposal:* MITT labels `P1`, `P2`, `P3`, `DEAD`.
3. **Medical point types.** The pathway in section 1 says stabilisation → Role 1 → Role 2/2E → field hospital. Code
   uses `ccp`, `handover`, `role1`, `role2_basic`, `role3`.
   - *Proposal:* `stabilisation`, `handover`, `role1`, `role2`, `role2e`, `field_hospital`. `handover` (the UGV to
     ambulance transfer point) is real and the mission logic needs it.
4. **Which capability each triage category needs.** `routing.py` has a placeholder: T1 and T2 need `stabilisation`,
   T3 needs `first_aid`. Clinical call, for Noo.
5. **Asynchronous reports.** `Casualty` has no `reported_at` or `source`.
   - *Proposal:* a `Report` node (MIST content, `reported_at`, `source`) linked with `ABOUT`, so updates never
     overwrite earlier reports and the audit story works.
6. **Medics: nodes or numbers?** Today only counts on medical points.
   - *Proposal:* keep counts; add a `Medic` node only if a medic walking to a casualty is part of the demo.
7. **The "lives saved" metric for replay.** We have no survival model.
   - *Proposal:* % of casualties of each triage category that reach the right medical point within their target
     time (for example category 1 within 60 minutes, following NATO's 10-1-2). "One more UGV" is a branch with an
     extra vehicle, compared with the base on this metric.
8. **Event format** for Layer 1: what a timed event looks like (time, type, payload). It must include speed changes
   and delays, not only new casualties and closures, or the demo never shows travel time changing.
9. **The bridge for the collapse event:** proposal `osm_way_id` 1297140381, the secondary road Robotyne → Orikhiv,
   about 500 m north of HP-1 (47.505 N, 35.813 E); mission routes from the front already cross it.
10. ✅ *Resolved by the simulator (6.8): UGVs drop at a relay point, an ambulance takes over.* **UGV to ambulance relay.** In `routing.py` a mission is one vehicle. The C2 planner already sends UGVs to a
    `handover` point (or a collection point) and ambulances to Role 1+; adopt that rule everywhere. UGVs have 25 km range and no point with
    `stabilisation` is within reach by real road, so on `evac3` the T2 casualties get "no resource" while UGV-2 sits
    idle. Real doctrine: the UGV carries to a `handover` point and an ambulance takes over.
    - *Proposal:* a mission can have two legs (UGV to the nearest `handover`, ambulance onward). This also keeps
      ambulances out of the threat zone, together with 7.1.
11. **Scenario coordinates.** ✅ Resolved: every entity now sits on (or within ~200 m of) a real junction; all 5
    casualties are reachable by a UGV within range × battery. Scenario kept simple for now: casualties to pick up,
    no active threat, no bridge event, no scarcity. Clinical content (MIST, triage labels) is still Noo's.
12. **Two mission planners.** `scripts/routing.py` and the C2 planner (`planner.ts`) differ:

    | | `routing.py` | C2 planner |
    |---|---|---|
    | Route | fastest, per-vehicle speed and `delay_factor` | shortest by length (TuringDB `shortestPath`), minutes from road speeds per type |
    | UGV destination | by capability (never fits T1/T2) | `handover` or collection point |
    | Checks | capacity, range | capacity, range × battery, threat vs `max_threat` |
    | Casualties per trip | one | several |
    | Who confirms | nobody (batch) | operator, best option preselected |
    | Vehicle status set | `assigned` | `tasked` |
    | Mission time fields | `eta_min`, `distance_km` | `created_at`, `eta` (datetime) |

    - ~~*Decided (3 Oct): keep the C2 planner as the product.*~~ *Reversed the same day: the medic only triages,
      so the system dispatches (6.8). The C2 planner stays, hidden behind "Manual", as an override.*
    - *Still to do:* port into it the fastest route with
      per-vehicle speed and `delay_factor`. Keep `routing.py` for `close` and for tests, or retire it. Align status and
      time fields on the C2 planner's (`tasked`, `eta` datetime).
    - *Seen once, not reproduced:* the planner showed UGV-1 selected and created the mission with AMB-1. Probably a
      race between the vehicle list refresh and "Create mission". For Noo.

---

## 8. Plan

Status as of **Saturday 3 Oct, afternoon**: ✅ done · 🟡 partly · ⬜ not started.

**MVP = Layers 0–4** (gate: the full demo runs on screen without touching the terminal).

**Where we are:** the scenario runs. The medic triages from MIST reports, presses play, and the system dispatches;
vehicles drive the real roads, pick casualties up, hand over to ambulances and deliver, one commit per minute.
**Next:** a disruption event and time travel, which show TuringDB's history.

### Critical path to the MVP, in order

1. ✅ **Simulator (Layer 1).** Blocks everything else. Decide first, together: whether vehicles move on the map, clock
   speed, state life cycles, event format (7.8) and a shared scenario clock (today the UI clock is fixed at 05:30).
   Each run starts from an initial commit of the graph instead of building a new graph.
2. ✅ **Second leg:** when a UGV delivers at a handover point, the ambulance leg can be planned. Mostly falls out of 1.
3. **One event end to end:** the bridge (7.9) collapses from a button in the UI, broken missions show, re-plan.
4. **Time travel in the UI:** rewind to before the collapse. TuringDB's headline feature; weighs more in the demo
   than branches.
5. **Polish:** query time in ms on screen, a demo script.

**Out of the MVP** (valuable, not needed to tell the story): "one more UGV" and the lives-saved metric (7.7), the
threat zone (7.1), MIST and MITT clinical content (7.2–7.4), porting the fastest route into the C2 planner (7.12),
the extra scenarios in `docs/SCENARIOS.md`.

### Status by layer

**Layer 0: Foundation** ✅
- ✅ TuringDB and the C2 map start with `run.sh`.
- ✅ OSM roads as `Junction` and `ROAD` (`build_roads.py`); `data/osm/roads.json` shared in the repo (pending merge).
- ✅ Scenario on the real roads (`seed_scenario.py`): every entity on or near a junction, all 5 casualties reachable
  by a UGV.
- ✅ `scripts/build_graph.sh` builds the graph end to end. Graph `evac`, rebuilt in memory by `run.sh` on every start (4,098 junctions, 9,142 roads, `Clock`, `SimControl`).
  Graphs built before the `MAX_GAP_M = 60` fix have Robotyne cut off the network: rebuild under a new name.
- ✅ Route search returning minutes (`routing.py`, 10 tests; and TuringDB `shortestPath` in the C2 planner).
- **Gate:** met on `evac3`: a route from a casualty to a medical point returns minutes, and a mission is written as
  one change, committed and submitted.

**Layer 1: Simulator and events** ✅ (timed events still to do)
- ✅ Scenario clock (`Clock`) shared by the simulator and the screen; play, pause, speed and reset from the screen.
- ✅ Tick loop (`scripts/simulate.py`): dispatch, movement along the road geometry, pickups (the casualty rides with
  the vehicle), drops, handover to an ambulance, beds; one commit per tick. A rejected pass is retried.
- ⬜ Timed events (7.8): casualties arriving over time, speed changes, delays.
- **Gate:** met: the scenario plays, and each tick is a commit carrying its scenario time (`tests/test_simulate.py`).

**Layer 2: Missions** ✅
- ✅ Automatic dispatch in the simulator (`routing.py`): priority, capacity, range × battery, threat, relay rules.
- ✅ Second leg: a casualty dropped at a handover point gets an ambulance on the next tick.
- ✅ Mission life cycle `planned → active → done`.
- 🟡 Manual C2 planner kept behind "Manual"; its ETA does not use `speed_kmh` yet.
- **Gate:** every triaged casualty gets a mission as soon as a suitable vehicle is free.

**Layer 3: Changing events and versioning** ⬜
- 🟡 `routing.py close <osm_way_id>` closes a road both ways and lists the broken missions (terminal only).
- ⬜ Bridge collapse from the UI, re-plan of the broken missions.
- ⬜ Time travel to a past commit in the UI.
- ⬜ Branches and the "one more UGV" replay (out of the MVP).
- **Gate:** close the bridge, see the broken missions, re-plan, and rewind to before the closure.

**Layer 4: Map and operator screen** 🟡
- ✅ C2 page: 2D and 3D map, casualty queue, mission planner, Cypher query bar with preset queries, node inspector,
  mission routes drawn; graph picked with `?graph=<name>`.
- ✅ Triage cards with the MIST report; clock, play/pause, speed, reset; vehicles slide between ticks (2D and 3D).
- ✅ End-to-end test `visualizer/tests/simulator.spec.ts` (live: needs TuringDB and the simulator).
- ⬜ Event buttons, commit picker for time travel, query time in ms.
- **Gate:** the full demo runs on screen without touching the terminal.

**CUT LINE: freeze the core by Saturday 22:00** (the venue closes at 22:30)

**Layer 5: Bonus, only if layers 0–4 work**
- Messages requesting more UGVs or medics.
- Vision or RF from drones and phones.
- 🟡 Plain-language questions, spoken or typed, on the C2 page (`scripts/voice_query.py`, `voice_server.py`):
  Parakeet speech to text, then the nearest of 24 known questions by multilingual MiniLM similarity, answered from
  the graph as a sentence and a table, in English or Ukrainian (the language of the question). Retrieval, not a
  generative LLM: it can only say what a handler computes, and under a similarity of 0.6 it says it did not
  understand. Read-only; it never tasks a vehicle. *Model:* all-MiniLM-L6-v2 was rejected for Ukrainian: it splits
  Cyrillic into letters and scored off-topic Ukrainian as high as real questions. Ukrainian texts
  (`scripts/voice_text.py`) still need a native speaker's review.
- A triage suggestion based on MITT.

**Sunday until 12:00:** no new features. Record the demo video, finish the deck, and upload both well before 12:00.

**How to split once the simulator decisions are taken:**
- simulator: clock, events, tick loop, vehicle movement (Layer 1);
- missions and versioning in the C2 planner: second leg, life cycle, bridge collapse, re-plan (Layers 2–3);
- operator screen: clock controls, event buttons, time travel (Layer 4);
- clinical realism, after the MVP: MIST reports, triage labels, capabilities (7.2–7.4).

**Parallel work once the common core exists** (simulator, states, events). Each item touches its own files and
can be picked up by anyone:
- **Terrain modelling** (`build_roads.py`, `fetch_osm.py`): off-road paths for UGVs (fields, footpaths), minor roads
  and tracks across the whole sector (today only near the front), and better speeds per road class and surface
  (today our own assumptions; OSM rarely has `maxspeed`).

**Cleanup:** ✅ done (`main.py` deleted, `pandas` declared, README "how to run", Cypher helpers in
`scripts/cypher.py`, `CAPS` in `seed_scenario.py`).
