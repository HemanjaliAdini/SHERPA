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
 OSM roads ──build_roads.py──▶ parquet ──LOAD PARQUET──▶ TuringDB graph (evac2) ◀── seed_scenario.py
                                                            │   ▲                    (points, vehicles,
                                                            │   │                     casualties, threat)
                                         reads open roads   ▼   │ writes missions + route, as commits
                                                        routing.py (plan / close)
                                                            │
                                                            ▼
                                                 C2 map (visualizer/, reads the graph)
```

- **TuringDB** holds the state of the world and its history. Every change (a new casualty, a delay, a closed bridge,
  a planned mission) is a commit, so time travel, branches and replay come for free.
- **Routing runs in Python** (`scripts/routing.py`), because TuringDB has no shortest-path search (see 6.1).
- **Everything hangs off the road network.** Casualties, vehicles and medical points link to their nearest junction
  with `NEAR`. A route is a path of `ROAD` edges between those junctions.
- **A mission** is vehicle → casualty → medical point: two route searches with that vehicle.

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

(:Casualty {id, lat, lon, time_of_injury, status, triage_category, mobility})      ✅

(:Threat {id, type, level, active})                                                ✅

(:Mission {id, status, eta_min, distance_km})                                      ✅
```

### Relationships

```
(:Junction)-[:ROAD {id, geometry, length_m, surface, status, delay_factor,         ✅
                    speed_ugv_kmh, speed_ambulance_kmh, highway, bridge, osm_way_id,
                    threat_level}]->(:Junction)                                    ❓ 7.1

(:Casualty | :Vehicle | :MedicalPoint)-[:NEAR {distance_m}]->(:Junction)           ✅
(:Threat)-[:AFFECTS]->(:Junction)                                                  ✅

(:Mission)-[:USES]->(:Vehicle)                                                     ✅
(:Mission)-[:PICKS_UP {order, status}]->(:Casualty)                                ✅
(:Mission)-[:DELIVERS_TO]->(:MedicalPoint)                                         ✅
(:Mission)-[:ROUTE_STEP {order}]->(:Junction)                                      ✅

(:Casualty)-[:HELD_AT]->(:MedicalPoint)                                            🔜
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
  or `ambulance`. `status` is `idle` or `assigned`.
- **`Casualty.status`:** `awaiting_pickup`, `assigned` or `no_resource`. More values come with Layer 1 (in transit,
  delivered). Triage and type values depend on 7.2 and 7.3.
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
   - *Verified:* TuringDB 3.0 has no `shortestPath` (it is a parse error), so this is the only option that works.
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
7. **One-way roads:** if a casualty's nearest junction has no route out, try the next 3 nearest junctions.

---

## 7. Open decisions

To settle together (see the plan: "Together, first").

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
9. **The bridge for the collapse event:** one real OSM bridge (`bridge = true`) on the main road north from Robotyne.
10. **UGV to ambulance relay.** A mission is one vehicle today. UGVs have 25 km range and no point with
    `stabilisation` is within reach by real road, so on `evac3` the T2 casualties get "no resource" while UGV-2 sits
    idle. Real doctrine: the UGV carries to a `handover` point and an ambulance takes over.
    - *Proposal:* a mission can have two legs (UGV to the nearest `handover`, ambulance onward). This also keeps
      ambulances out of the threat zone, together with 7.1.
11. **Scenario coordinates.** They come from the toy graph and were not chosen on real roads: several entities sit
    0.5–1.8 km from the nearest junction (for example CCP-W, CCP-E, R2B-1, CAS-3). Noo to move them onto real roads
    and villages.

---

## 8. Plan

Status: ✅ done · 🟡 partly · ⬜ not started.

**Together, first (about 30 min):** close the open decisions 7.1–7.4 and 7.8. They define fields and values that
every layer reads or writes. After that, the layers can be built in parallel.

**Layer 0: Foundation** 🟡
- ✅ TuringDB running (`run.sh`).
- ✅ OSM roads as `Junction` and `ROAD` (`fetch_osm.py` or `extract_pbf.py`, then `build_roads.py`).
- ✅ Scenario placed on the real roads (`seed_scenario.py`).
- ✅ Route search with computed travel time (`routing.py`, `tests/test_routing.py`).
- ✅ One script that builds the graph end to end (`scripts/build_graph.sh`). Built and checked as `evac3`
  (4,098 junctions, 9,142 roads): `MAX_GAP_M` raised from 50 to 60 m, because at 50 a 50.4 m OSM gap on the road
  north of Robotyne cut the whole scenario area off the network.
- **Gate:** on `evac2`, a route from a casualty's junction to a medical point returns minutes, and one change is
  created, committed and submitted.

**Layer 1: Scenario and events** ⬜
- Synthetic casualties with their MIST information, consistent with the triage labels (7.2).
- A list of timed events (7.8): new reports, report updates, speed changes, delays, a bridge collapse, a point
  overwhelmed or without power.
- A loop applies the events that are due, re-runs `plan`, and commits once per tick.
- **Gate:** the scenario plays from start to end, and `CALL db.history()` shows one commit per tick.

**Layer 2: Missions** 🟡
- ✅ `routing.py plan`: vehicle, pickup order, medical point and route for each casualty awaiting pickup, written as a
  `Mission` with `ROUTE_STEP`s; "no resource" flag otherwise.
- ✅ Checks on stretcher or seat capacity and on range.
- ⬜ Threat check (7.1). Battery check beyond range.
- **Gate:** every category 1 casualty gets either a mission or a clear "no resource available" flag.

**Layer 3: Changing events and versioning** 🟡
- ✅ `routing.py close <osm_way_id>`: closes the road both ways and lists the broken missions.
- ⬜ Re-plan the broken missions on a branch, compare with the current plan, submit.
- ⬜ Time travel to a past commit, to audit what was known when each decision was made.
- ⬜ Replay with one extra UGV on a branch, compared on the metric (7.7).
- **Gate:** close the bridge on a branch, see the broken missions, re-plan, submit, and rewind to before the closure.

**Layer 4: Map and operator screen** 🟡
- ✅ C2 map page (`visualizer/`, `/c2`): offline basemap, roads coloured by threat, casualties, points, vehicles,
  threats.
- ✅ Missions drawn as their route line. The graph to show can be picked with `?graph=<name>` in the URL.
- ⬜ Buttons for the main actions, and query time in milliseconds on screen.
- **Gate:** the full demo runs on screen without touching the terminal.

**CUT LINE: freeze the core by Saturday 22:00** (the venue closes at 22:30)

**Layer 5: Bonus, only if layers 0–4 work**
- Messages requesting more UGVs or medics.
- Vision or RF from drones and phones.
- Plain-language questions to a local LLM.
- A triage suggestion based on MITT.

**Sunday until 12:00:** no new features. Record the demo video, finish the deck, and upload both well before 12:00.

**How to split after "Together, first":**
- one person on the scenario and events (Layer 1);
- one on missions and versioning (Layers 2–3), on top of `routing.py`;
- one on the map (Layer 4);
- Noo on clinical realism: MIST reports, triage, medical point capabilities (7.2–7.4).

**Cleanup:** ✅ done (`main.py` deleted, `pandas` declared, README "how to run", Cypher helpers in
`scripts/cypher.py`, `CAPS` in `seed_scenario.py`).
