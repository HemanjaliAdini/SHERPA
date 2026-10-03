# Test scenarios

Scenarios for checking that the system does what the PRD says. All ids and values come from `scripts/seed_toy_graph.py`. Steps are in order; no real travel times yet.

## Scenario 0: Baseline

Starting state: the seed graph as it is. All roads `open`, all medical points `operational`, THR-1 inactive.

| Step | Event | Expected result |
|---|---|---|
| 1 | Seed graph loaded | CAS-1, CAS-2 and CAS-3 are `awaiting_pickup`. All four vehicles are `idle` |
| 2 | Medic opens the list | Order is CAS-1 (T1, injured first), CAS-3 (T1), CAS-2 (T2) |
| 3 | First leg planned | M-1: UGV-1 takes CAS-1 to HP-1. M-2: UGV-2 takes CAS-3 to HP-1. CAS-2 is told to walk to CCP-C |
| 4 | UGVs collect at INC | CAS-1 and CAS-3 are `in_transit`. M-1 and M-2 are `active` |
| 5 | UGVs deliver to HP-1. CAS-2 reaches CCP-C | CAS-1 and CAS-3 are `HELD_AT` HP-1. CAS-2 is `HELD_AT` CCP-C. UGV-1 and UGV-2 are `idle`. M-1 and M-2 are done |
| 6 | Second leg planned | M-3: AMB-1 takes CAS-1 and CAS-3 from HP-1 to R1-A. M-4: AMB-2 takes CAS-2 from CCP-C to R1-A |
| 7 | Ambulances deliver | All three casualties are `HELD_AT` R1-A. R1-A `free_beds` goes from 4 to 1. All vehicles are `idle` and all four missions are done |
| 8 | Final checks | No flags were raised at any step. Every invariant query returns nothing. The history shows one commit per tick |

## Scenario 1: Bridge down (routing)

| Step | Event | Expected result |
|---|---|---|
| 1 | Seed graph loaded | Three casualties `awaiting_pickup`, all four vehicles `idle` |
| 2 | First leg planned | M-1: UGV-1 takes CAS-1 to HP-1.<br>M-2: UGV-2 takes CAS-3 to HP-1.<br>CAS-2 gets no UGV because UGVs have no seats |
| 3 | Second leg planned | M-3: AMB-1 takes CAS-1 from HP-1 to R1-A.<br>M-4: AMB-2 takes CAS-3 from HP-1 to R1-A.<br>Both routes cross BRG |
| 4 | Road BRG–R1A set `closed`. AMB-1 has crossed, AMB-2 is still at HP1 | M-3 is unaffected.<br>M-4 is flagged broken and re-planned from HP1. The road is `closed` in both directions |
| 5 | Check M-4's new plan | Route is HP1 → HP2 → R1B.<br>Delivery point is R1-B, the nearest Role 1 with a free bed, and not R1-A |
| 6 | Road HP2–R1B set `closed` while AMB-2 is at HP2 | No open route from HP2 to any Role 1.<br>M-4 is flagged `no_route`, and AMB-2 holds at HP-2 with CAS-3.<br>CAS-2 is also flagged `no_route` |
| 7 | Road HP2–R1B set `open` | M-4 is re-routed from HP2, not from HP1, and delivers to R1-B.<br>CAS-2 gets a route and an ambulance mission |
| 8 | Time travel to the commit before step 4 | Road BRG–R1A is `open` and M-4 has its original route to R1-A |
| 9 | Fresh seed, THR-1 set active | Ambulance routes between R1A and HP1 avoid BRG and go via R1B and HP2.<br>UGV routes may still use BRG |
| 10 | Fresh seed, first leg planned. Road ROB–INC set `closed` while UGV-1 and UGV-2 are empty and heading to INC | M-1 and M-2 are cancelled.<br>UGV-1 and UGV-2 are `idle`.<br>CAS-1, CAS-2 and CAS-3 are all flagged `no_route` |

**To find out:** if we are using arbitrary paths (not just roads), how can we see any closures/blockages info here?

## Scenario 2: Too many, too few (resources)

Add three casualties to the seed: CAS-4 (T1, litter), CAS-5 (T2, litter), CAS-6 (T3, ambulatory).

| Step | Event | Expected result |
|---|---|---|
| 1 | All six reports arrive in one tick | UGV-1 and UGV-2 each get one mission, for two of the three T1 casualties.<br>The third T1 is flagged `no_resource`. No vehicle has two missions |
| 2 | UGV-1 delivers to HP-1 | UGV-1 is `idle` and is assigned the remaining T1 before CAS-5 (T2) |
| 3 | UGV-2 `battery_pct` set to 5 | UGV-2 is not assigned. CAS-5 is flagged `no_resource` |
| 4 | R1-B `free_beds` set to 1. AMB-1 leaves HP-1 for R1-A with two litter casualties | Mission planned to R1-A as normal |
| 5 | R1-A set `no_power` while AMB-1 is en route | The mission redirects to R1-B.<br>One casualty takes the last bed, and the other goes to R2B-1 or is flagged.<br>`free_beds` never goes below zero |
| 6 | Replay step 1 on a branch with UGV-3 added at HP1 | All three T1 casualties get missions.<br>The main graph is unchanged.<br>Running it again gives the same result |

## Scenario 3: UGV lost with a casualty on board

Assumed status values (not in the code yet): vehicle `disabled` and `destroyed`, casualty `in_transit` and `unknown`, mission `active` and `broken`.

UGV route: INC → ROB → CCPC → HP1.

| Step | Event | Expected result |
|---|---|---|
| 1 | Seed graph loaded, first leg planned | M-1: UGV-1 takes CAS-1 to HP-1.<br>M-2: UGV-2 takes CAS-3 to HP-1 |
| 2 | UGV-1 collects CAS-1 at INC | CAS-1 is `in_transit` and M-1 is `active` |
| 3 | UGV-1 breaks down at ROB with CAS-1 on board | UGV-1 is `disabled`.<br>M-1 is `broken`.<br>CAS-1 is `awaiting_pickup` at ROB, still T1, and flagged for re-triage. `time_of_injury` is unchanged |
| 4 | Planner looks for another vehicle | UGV-2 is on M-2, so CAS-1 is flagged `no_resource`. UGV-1 is never offered again |
| 5 | UGV-2 delivers CAS-3 to HP-1 | UGV-2 is `idle`.<br>M-3 is planned: UGV-2 takes CAS-1 to HP-1, with the pickup at ROB and not INC.<br>The `no_resource` flag clears |
| 6 | UGV-2 delivers CAS-1 to HP-1 | M-3 is done.<br>CAS-1's history shows M-1 `broken` then M-3 done, and CAS-1 was never on two active missions |
| 7 | Replay on a branch with UGV-3 at HP1 | CAS-1 is collected from ROB without waiting for UGV-2. The metric shows the shorter delay |

### Variants, each on a fresh seed

| Step | Event | Expected result |
|---|---|---|
| 8 | UGV-1 breaks down at CCPC, next to collection point CCP-C | CAS-1 is `HELD_AT` CCP-C, where there is a medic, and waits there for the next vehicle |
| 9 | UGV-1 is destroyed by a strike at ROB with CAS-1 on board | UGV-1 is `destroyed`.<br>CAS-1 is `unknown` and flagged for a medic to confirm. The system does not mark CAS-1 dead or alive on its own |
| 10 | Same strike, with UGV-2 due to pass ROB on M-2 | A threat is recorded at ROB.<br>M-2 is flagged for the medic, because ROB is the only way to INC |
