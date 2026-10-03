# Plan: Layer 1 simulator

**Status**: implemented

## Goal

We play the medics. Casualty reports (MIST) arrive without a triage category; on the operator screen we read each
report and set its category and mobility, and that is all we decide. The system does the logistics on its own: it
gives the most urgent waiting casualty the best free vehicle, destination and route, and creates the mission. A scenario
clock runs from the screen: press play and vehicles drive along their routes, pick casualties up (the casualty rides with
the vehicle) and drop them off. A UGV dropping a casualty at a handover point puts the casualty back in line, and the
system then sends an ambulance. Every scenario minute is one TuringDB commit that stores the scenario time, so the
history reads minute by minute. Reset puts the scenario back to its start without losing the history.

## Findings

Measured on 3 Oct 2026 against TuringDB 3.0 (scratch graph `toy2`, scenario graph `evac3`):

1. A tick as its own change on `main` (move 4 vehicles, `COMMIT`, `CHANGE SUBMIT`) takes 20–45 ms.
2. Time travel works: `LOAD COMMIT '<hash>'` (4 ms) then `set_commit(hash)` reads the old value; without the load it
   fails with `COMMIT_NOT_LOADED`.
3. `CALL db.history()` returns only `commit, nodeCount, edgeCount, partCount`: no time, no message. The scenario time
   of a commit must be stored inside the graph.
4. No conflict detection: when two changes write the same node, the one submitted last wins. A long-open simulator
   change would overwrite what the UI submitted meanwhile.
5. `DELETE r` on an edge works, so `NEAR` links can be moved.
6. The C2 UI already passes `commit` to queries (`visualizer/src/api/args/cypherQuery.args.ts:8-9`,
   `visualizer/src/api/api.ts:453`).
7. The C2 UI loads the graph once (`staleTime: Infinity`, `visualizer/src/pages/c2.tsx:136-145`) and refetches only
   after creating a mission (`c2.tsx:162-167`): it would not show the simulator's changes.
8. A full refetch of what the UI reads (all nodes, all edges on `evac3`) costs about 2 ms in the engine, ~700 KB.
9. The UI clock is fixed at 05:30 (`visualizer/src/stores/scenario.store.ts`) and drives queue waiting times and
   mission ETAs.
10. Missions written by the C2 planner carry what movement needs: `ROUTE_STEP {order}` junctions, `PICKS_UP {order}`,
    `DELIVERS_TO`; every `ROAD` has `length_m`, speeds per vehicle type and `geometry`.
11. `scripts/routing.py` already orders casualties by triage then time of injury (`:58`, `plan()` `:165`), finds the
    fastest vehicle → casualty → point trip within range (`best_option()` `:100`) and writes a `Mission` with its
    `ROUTE_STEP`s (`write_mission()` `:144`); 10 tests in `tests/test_routing.py`.

## Decisions

- **Clock: 1 scenario minute per tick, speed adjustable** (default 1 scenario minute per real second, so a 40-minute
  mission plays in 40 s). *Why:* the golden hour is counted in minutes; a UGV covers ~300–400 m per minute, enough
  resolution. *Rejected:* 10-second ticks (6× the commits, no gain in the story).
- **Commits are clear steps of three kinds:** one per tick (state at that minute), one per decision (a triage set by
  the medic, a mission created by the system), one per event (e.g. bridge collapse).
- **Control: one play/pause button on the operator screen** (plus speed).
- **Casualties all present at the start.** Casualties arriving over time (events, detection systems) come later.
- **Restart with a reset commit** that puts the scenario back to its initial state; earlier history stays for time
  travel. *Rejected:* a new graph per run (no `DROP GRAPH`, graphs pile up).
- ~~**States:** casualty `awaiting_pickup → …`~~ *Superseded below (casualties now start untriaged).*
- **Smooth movement:** the back stores a position per tick; the front animates between the last two positions. A
  casualty in transit takes the vehicle's position each tick, so it moves with the vehicle.
- **Architecture: simulator in the back (Python), control in the front through the graph.** Python owns the clock and
  the tick loop; the UI writes play/pause and speed and reads the scenario time. *Rejected:* everything in the front
  (two tabs = two clocks, no Python tests); a Python control server (one more process to fail in the demo).
- **One writer per node:** `Clock` written only by the simulator, `SimControl` only by the UI (Finding 4).
- **Movement speed comes from the graph: each vehicle's own `speed_kmh`.** Time on a road =
  `length_m / min(vehicle.speed_kmh, road cap for its type) * delay_factor` (PRD decision 6.1). *Rejected:* road speed
  per type only (UGV-1 and UGV-2 would be identical).
- ~~**Dispatch stays casualty by casualty** (operator picks the vehicle).~~ *Superseded (3 Oct): the operator choosing
  vehicles is logistics, which the PRD gives to the system (requirements 2–3, decision 6.2).*
- **Adolfo does the UI part too.**
- ~~**`triage_reason`**, a line saying why a casualty has its category.~~ *Superseded (3 Oct): the medic sets the
  category, so the screen shows the MIST report the medic decides from instead.*
- **We play the medics: the medic decides triage and mobility only, from the MIST report.** Casualties start with no
  category. *Why:* PRD requirements 2–3; the demo shows a human making the clinical call and the system covering it.
- **The system dispatches automatically, in the simulator.** Rules, taken from the C2 planner so behaviour does not
  change: order by triage (T1, T2, T3), then time of injury; untriaged and `DEAD` casualties are never dispatched; UGVs
  go to a handover or collection point, ambulances to Role 1 or higher; a casualty already at a handover or collection
  point gets ambulances only; capacity (stretcher or seat), range × battery, and no road above the vehicle's
  `max_threat`; among the rest, the fastest whole trip. One casualty per trip. *Why:* one owner of logistics and of the
  clock; it reuses `routing.py` (Finding 11). *This reverses PRD 7.12 (keep the C2 planner as the product), which assumed
  the operator chooses the logistics.*
- **No reassignment:** a busy vehicle is never taken off its mission; an urgent casualty waits for the first free
  vehicle. Simple first; preemption later if needed.
- ~~**Dispatch runs on every loop pass, paused or running.**~~ *Superseded (3 Oct): dispatching each casualty as it
  is triaged lets triage order decide priority (a T3 triaged first takes the best vehicle before the T1 is seen).*
- **Triage the whole batch first, then start the clock.** A batch of reports arrives with the clock paused; the medic
  triages all of them; on play, the first tick dispatches the whole triaged batch in priority order. While running,
  every tick dispatches free vehicles to whoever waits (e.g. the ambulance leg after a handover drop). Untriaged
  casualties simply wait; play is not blocked. Later, with timed events, a new batch pauses the clock on arrival.
  *Why:* the system sees every category at once, so priority is real; the medic's reading time costs no scenario
  minutes; simpler (dispatch only inside the tick).
- **The C2 manual planner is kept, hidden by default** (a toggle shows it again as a manual override).
- **States:** casualty `reported → awaiting_pickup → assigned → in_transit → delivered`, or back to
  `awaiting_pickup` when dropped at a handover or collection point; mission `planned → active → done`; vehicle
  `idle → tasked → idle`.

## Context

- `scripts/routing.py`: `Road` `:23`, `edge_minutes()` `:64` (time formula), `route()` `:69`, `best_option()` `:100`
  (to extend with the dispatch rules), `write_mission()` `:144` (align its fields with the UI's: vehicle `tasked`,
  `created_at`/`eta` as datetimes from `Clock.now`), `plan()` `:165` (becomes the dispatch pass).
- `tests/test_routing.py`: the test style to follow (tiny hand-built networks, no TuringDB).
- `scripts/seed_scenario.py`: the initial state that reset restores; `snap()` for `NEAR`; the one-change-with-`CHANGE
  DELETE`-on-failure pattern in `main()` is the pattern for each tick.
- `scripts/cypher.py`: `lit`, `props` (TuringDB has no query parameters).
- `scripts/build_graph.sh`, `run.sh`: the simulator joins `run.sh`.
- `visualizer/src/components/c2/planner.ts:41` `DESTINATION_TYPES`, `:103` `rankVehicles`: the rules being ported.
- `visualizer/src/components/c2/missions.ts:11-64`: the mission shape the UI reads (statuses, `created_at`, `eta`,
  `PICKS_UP {order, status, eta}`).
- `visualizer/src/components/c2/scenario-data.ts:52-58`: queries; add the MIST fields.
- `visualizer/src/components/c2/casualty-queue.tsx:16` `STATUS_LABEL`, `:67` and the "Plan pickup" button `:79`: the
  queue entry becomes the triage card.
- `visualizer/src/components/c2/mission-planner.tsx`: the manual planner to hide behind a toggle.
- `visualizer/src/pages/c2.tsx:136-145` (refetch while running), `:162-167` (invalidate pattern).
- `visualizer/src/stores/scenario.store.ts`: replace the fixed `now` with the graph clock.
- `visualizer/src/components/c2/c2-map.tsx:216`, `c2-map-3d.tsx:421`: mission routes; hide `done` missions.
- TuringDB time travel: https://docs.turingdb.ai/graph_dev/time_travelling
- **Warnings:** every tick is a short change; never leave one open between ticks (Finding 4). The Prettier hook
  reformats `.ts/.tsx` on Edit: run `npx biome format --write` on touched visualizer files before committing. With no
  threat zone in the simple scenario, ambulances may be the fastest option even at the front, so the UGV → handover flow
  may not show until a threat zone exists (out of scope here).

## Acceptance contract

- [ ] An untriaged (`reported`) or `DEAD` casualty never gets a mission, over 10 loop passes — checked by:
      `tests/test_simulate.py::test_untriaged_and_dead_not_dispatched`
- [ ] Setting a category makes the casualty `awaiting_pickup`; while paused no mission is created; on the first tick
      after play every triaged casualty a vehicle can take gets a mission, in priority order, whatever order they were
      triaged in — checked by: `tests/test_simulate.py::test_batch_dispatched_on_first_tick`
- [ ] With one free vehicle and a T1 and a T3 waiting, the T1 gets it; with two T1s, the one injured first — checked by:
      `tests/test_routing.py::test_dispatch_priority_order`
- [ ] Dispatch rules: a UGV's destination is a handover or collection point; an ambulance's is Role 1 or higher; a
      casualty at a handover point is offered ambulances only; trips over range × battery and roads above
      `max_threat` are rejected — checked by: `tests/test_routing.py::test_dispatch_rules`
- [ ] A vehicle on a mission is never reassigned while another casualty waits — checked by:
      `tests/test_simulate.py::test_no_reassignment`
- [ ] While `SimControl.running = false`, 5 real seconds move no vehicle and leave `Clock.now` unchanged — checked by:
      `tests/test_simulate.py::test_paused_does_not_move`
- [ ] While running, N ticks advance `Clock.now` by N minutes and add at least N commits to `CALL db.history()` —
      checked by: `tests/test_simulate.py::test_tick_advances_clock_and_commits`
- [ ] A vehicle advances along its `ROUTE_STEP`s by `min(speed_kmh, road cap)` for 1 minute per tick; its position
      after k ticks matches the expected point on the route within 1 m — checked by:
      `tests/test_simulate.py::test_advance_along_route`
- [ ] Passing its casualty's junction, the casualty becomes `in_transit` and has the vehicle's `lat`/`lon` at every
      later tick — checked by: `tests/test_simulate.py::test_pickup_rides_with_vehicle`
- [ ] Drop at a handover or collection point: mission `done`, vehicle `idle` and `NEAR` that point's junction,
      casualty `awaiting_pickup`, `NEAR` that junction and `HELD_AT` the point; the next dispatch sends an ambulance
      — checked by: `tests/test_simulate.py::test_drop_at_handover_then_ambulance`
- [ ] Delivery at Role 1 or higher: casualty `delivered`, `HELD_AT` the point, `free_beds` down by 1 — checked by:
      `tests/test_simulate.py::test_delivery_takes_a_bed`
- [ ] Each tick commit stores its time: after `LOAD COMMIT`, reading `Clock.now` at that commit gives that tick's
      minute — checked by: `tests/test_simulate.py::test_commit_carries_scenario_time`
- [ ] Reset: no `Mission` nodes; vehicles and casualties back to seed position, status (`reported`, no category) and
      `NEAR`; beds back to seed; `Clock.now` = 05:30, `running = false`; a pre-reset commit still loads and shows
      the old state — checked by: `tests/test_simulate.py::test_reset_restores_seed_keeps_history`
- [ ] On the operator screen, end to end on a freshly built graph: each casualty card shows its MIST report and
      triage buttons; triaging every card creates no mission until play; after play missions show on the map within
      2 s; play moves the clock (equal to
      `Clock.now`) and the vehicle marker between two screenshots 3 s apart; pause stops both; the manual planner is
      hidden until its toggle is pressed — checked by: `visualizer/tests/simulator.spec.ts`
- [ ] Nothing that worked before breaks — checked by: the gate commands

**Named scenarios.** *Triage and dispatch:* the medic reads all five reports and sets each category and mobility; nothing
moves; on play the system sends the free vehicles to the T1s first. *Priority:* with one vehicle free, T1 before T3. *Pickup and drop:* the vehicle drives, CAS-3 rides with it,
both stop at the destination. *Second leg:* a casualty dropped at HP-1 gets an ambulance to Role 1, which then has one
bed fewer. *Pause:* nothing moves and nothing is dispatched while paused. *Reset:* back to the start, the run's
commits still load.

**Gate commands** (TuringDB running):

```
uv run pytest
cd visualizer && npx tsc --noEmit -p . && npx biome check src/components/c2 src/pages/c2.tsx src/stores && npx playwright test tests/simulator.spec.ts
```

## Out of scope

- Reassigning busy vehicles (preemption); several casualties per trip.
- Timed events: casualties arriving over time, detection systems, the event format (PRD 7.8).
- Bridge collapse, closed roads under a moving vehicle, re-planning; the time-travel view (Layer 3).
- Threat zones (so the UGV-first flow may not appear yet); clinical realism of the MIST texts (Noo, Vashti's triage
  parser).

## Interfaces

Shared by the simulator (Python) and the C2 UI:

```
(:Clock {id: 'CLOCK', now: datetime})                      written only by the simulator
(:SimControl {id: 'SIM', running: bool, speed: float})     written only by the UI; speed = scenario minutes per
                                                           real second (default 1.0)
(:Casualty {..., status: 'reported' | 'awaiting_pickup' | 'assigned' | 'in_transit' | 'delivered',
             triage_category: null | 'T1' | 'T2' | 'T3' | 'DEAD', mobility: null | 'litter' | 'ambulatory',
             mist_mechanism, mist_injuries, mist_signs, mist_treatment: string})
             triage_category and mobility written only by the UI (the medic)
(:Mission {..., status: 'planned' | 'active' | 'done', created_at, eta: datetime, progress_m: float})
(:Vehicle {..., status: 'idle' | 'tasked', speed_kmh: float})
(:Casualty)-[:HELD_AT]->(:MedicalPoint)
```

## Tasks

1. **UPDATE `scripts/seed_scenario.py`**: `Clock` (05:30), `SimControl` (paused, 1.0); casualties `reported`, no
   category or mobility, with placeholder MIST texts. VALIDATE: `scripts/build_graph.sh evac6`, then
   `MATCH (c:Casualty) RETURN c.status, c.triage_category, c.mist_injuries` shows `reported`, null, text.
2. **UPDATE `scripts/routing.py` + `tests/test_routing.py`, dispatch rules**: destination types per vehicle type,
   range × battery, `max_threat`, ambulances only at a handover point, skip untriaged and `DEAD`; `write_mission()`
   with the UI's fields. VALIDATE: `uv run pytest tests/test_routing.py`.
3. **CREATE `scripts/simulate.py` + `tests/test_simulate.py`, pure movement**: advance along a route by 1 minute,
   position on the geometry, pickups passed. Reuses `routing.Road`, `edge_minutes`. VALIDATE:
   `uv run pytest tests/test_simulate.py -k "advance"`.
4. **ADD `tick(client)`**: start missions, move, pick up, drop, deliver, move `Clock.now`, one short change.
   VALIDATE: integration tests on the toy graph inside a change deleted afterwards:
   `uv run pytest tests/test_simulate.py -k "tick or pickup or drop or delivery or commit_carries"`.
5. **ADD dispatch to the tick, the loop and CLI** (`uv run python scripts/simulate.py [graph]`, `--reset`): each
   tick dispatches free vehicles (before moving); every 0.5 s read `SimControl` and tick at `speed` when running;
   start it from `run.sh`. VALIDATE:
   `uv run pytest tests/test_simulate.py -k "paused or batch or untriaged or reassign"`.
6. **ADD `reset(client)`** from the seed lists. VALIDATE: `uv run pytest tests/test_simulate.py -k reset`.
7. **UPDATE the C2 UI, clock and controls**: `now` from `Clock.now`; refetch every second; play/pause and speed
   writing `SimControl`; hide `done` missions; new state labels. VALIDATE: `npx tsc --noEmit -p .`, press play on
   `?graph=evac6`, the clock moves.
8. **UPDATE the queue into triage cards**: MIST report, T1/T2/T3/DEAD and mobility buttons writing the casualty;
   a count of untriaged casualties next to play; manual planner hidden behind a toggle. VALIDATE: triage all cards,
   press play, missions appear within 2 s.
9. **ADD smooth movement** in the 2D and 3D maps between the last two positions. VALIDATE: visual and the
   marker-moves check.
10. **CREATE `visualizer/tests/simulator.spec.ts`**. VALIDATE: the gate commands.
11. **UPDATE `docs/PRD.md`**: requirement 3 and decision 6.2 as built, 7.12 reversed, data model (`Clock`,
    `SimControl`, MIST fields, states, `progress_m`, `HELD_AT` ✅), Layer 1 and 2 status. VALIDATE: read.

## Notes

- **3 Oct, step zero:** `npx biome check src` was already red (21 issues outside C2, from the original TuringDB
  visualizer). Gate narrowed to the files this plan touches (`src/components/c2`, `src/pages/c2.tsx`, `src/stores`),
  which were green. The old issues are left alone.
- **3 Oct, process:** Adolfo asked to implement fast and simple: no blind test-writer, no frozen acceptance tests.
  Tests are written alongside the code; the named tests keep their names but live in `tests/test_simulate.py` and
  `tests/test_routing.py` as the plan says.
- **3 Oct, finding during implementation:** `CALL db.history()` lists the **newest commit first**, and the first row's
  hash carries a `(HEAD)` suffix that must be stripped before `LOAD COMMIT`. (The explore probe read a middle row and
  missed this.) Time travel in Layer 3 must use this order.
- **3 Oct, bug caught by the tests:** `ROUTE_STEP` edges created after the last `COMMIT` of a change are invisible to
  later reads in the same change, so a mission dispatched in a tick looked routeless and was closed at once, freeing
  its vehicle. `write_mission` now commits after the route; a mission with no `ROUTE_STEP`s is an error.
- **3 Oct, D2.6 fallback dropped:** dispatch uses each casualty's `NEAR` junction only (no next-nearest retry); all
  scenario entities are reachable on the current graph.
- **3 Oct, bug found in the C2 UI (Noo's `missions.ts` too):** TuringDB expects the `change` query parameter in hex (the
  Python SDK sends `f"{id:x}"`); the UI sent it in decimal, so from change 10 on it hit `CHANGE_NOT_FOUND` or, worse,
  another existing change. Fixed in `missions.ts` and `sim.ts`.
- **3 Oct, DEAD:** triaging a casualty `DEAD` sets status `dead` (not in the Interfaces list); dispatch never sees it.
- **3 Oct, cut to save credits (Adolfo):** not done — task 7's planner ETA with `speed_kmh` (manual planner is hidden
  anyway), task 9 smooth animation (positions jump once per tick), task 10 Playwright test, task 11 PRD update. Checked
  by hand instead: on `evac6`, T1 on CAS-1's card and Play from the screen → clock moved, M-1 (UGV-1) active, 2.3 km
  done in 7 ticks. Reset has no button (CLI `--reset`).
- **3 Oct, correction to Finding 4:** TuringDB does reject some concurrent changes: submitting a change that creates
  an edge from a node another change modified on main meanwhile fails (`EXEC_ERROR ... has been modified on main`).
  A reset racing the medic's triage crashed the simulator loop; `run_pass()` now logs and retries a rejected pass.
- **3 Oct, e2e test uses the 2D map:** headless Chrome renders the 3D view in software, too slowly for 1 s ticks (in a
  browser with a GPU the 3D view keeps up: timer lag 0–5 ms while running).
- **3 Oct, cut items done after all (Adolfo, in this order):** smooth movement (3D `transitions`, 2D marker slide);
  reset button (`SimControl.reset`, done by the simulator on its next pass; the screen shows "Resetting..." and locks
  triage meanwhile; reset re-links only entities that moved, which removed the clash with triage); live Playwright test
  `visualizer/tests/simulator.spec.ts` (passes twice in a row, ~15 s); PRD updated; manual planner ETA uses
  `min(speed_kmh, road cap) * delay_factor` (UGV-1 24 min vs UGV-2 32 min for the same 7.9 km). The screen refreshes
  map and queue on each clock change instead of a fixed timer.

