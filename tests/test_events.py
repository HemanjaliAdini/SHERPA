"""Events (PRD 6.11, section 5 "Events"): applied by the simulator at their minute, re-routing, reset.
Needs TuringDB on localhost:6666, like the simulator ticks in test_simulate.py (same scratch graph)."""
import json

import pytest

from demo_script import EVENTS
from routing import load_roads, read_clock, route, rows
from seed_scenario import VEHICLES
from simulate import in_change, mission_legs, reset_writes, tick_writes
from test_simulate import db, fresh, missions, one, scratch, tick, tick_until, triage  # noqa: F401 - fixtures

BRIDGE = 1297140381  # the only road link between the front and the rear (7.9)


def add_event(client, eid, minutes_from_now, type_, payload, source="script"):
    at = (read_clock(client).timestamp() + minutes_from_now * 60)
    from datetime import datetime, timezone
    when = datetime.fromtimestamp(at, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    client.query(f"CREATE (:Event {{id: '{eid}', at: datetime('{when}'), type: '{type_}', "
                 f"payload: '{json.dumps(payload)}', status: 'pending', source: '{source}'}})")
    client.query("COMMIT")


def opening_applied():
    """After a reset the script's events are pending, except the 05:30 reports, fused before Play (apply_opening)."""
    from seed_scenario import SCENARIO_START
    return {e["id"]: "applied" if e["at"] <= SCENARIO_START else "pending" for e in EVENTS}


def no_script(client):
    """Only the events a test adds."""
    client.query("MATCH (e:Event) DETACH DELETE e")
    client.query("COMMIT")


def event(client, eid):
    return one(client, f"MATCH (e:Event {{id: '{eid}'}}) RETURN e.status AS status, e.error AS error, "
                       "e.applied_at AS applied_at")


def way_status(client, way):
    return rows(client, f"MATCH (:Junction)-[r:ROAD]->(:Junction) WHERE r.osm_way_id = {way} "
                        "RETURN r.status AS status, r.closed_by AS by")


def remaining(client, mission_id):
    """(vehicle type, speed, threat limit, junctions still ahead of the vehicle) for a mission."""
    from events import last_passed
    m = one(client, f"MATCH (m:Mission {{id: '{mission_id}'}})-[:USES]->(v) RETURN m.progress_m AS p, "
                    "v.type AS type, v.speed_kmh AS speed, v.max_threat AS thr")
    legs, junctions = mission_legs(client, mission_id, m["type"], m["speed"])
    return m["type"], m["speed"], m["thr"], junctions[last_passed(legs, m["p"] or 0.0):]


def ways_on(client, junctions):
    pairs = set(zip(junctions, junctions[1:]))
    return [int(r["w"]) for r in rows(client, "MATCH (a:Junction)-[r:ROAD]->(b:Junction) "
                                              "RETURN id(a) AS a, id(b) AS b, r.osm_way_id AS w")
            if (int(r["a"]), int(r["b"])) in pairs]


def way_with_detour(client, mission_id):
    """A road ahead of the vehicle whose closure still leaves a route to the same end."""
    vtype, speed, thr, ahead = remaining(client, mission_id)
    roads = load_roads(client)
    way_of = {(int(r["a"]), int(r["b"])): int(r["w"]) for r in rows(
        client, "MATCH (a:Junction)-[r:ROAD]->(b:Junction) RETURN id(a) AS a, id(b) AS b, r.osm_way_id AS w")}
    for way in dict.fromkeys(ways_on(client, ahead)):
        cut = {k: [x for x in v if way_of.get((k, x.dst)) != way] for k, v in roads.items()}
        if route(cut, ahead[0], ahead[-1], vtype, speed, thr) is not None:
            return way
    pytest.skip("no road ahead with a detour")


def test_seed_and_reset_put_the_demo_script_events_pending(fresh):
    in_change(fresh, reset_writes)
    found = {r["id"]: r for r in rows(fresh, "MATCH (e:Event) RETURN e.id AS id, e.type AS type, e.status AS s, "
                                             "e.source AS src")}
    assert set(found) == {e["id"] for e in EVENTS}
    assert {i: e["s"] for i, e in found.items()} == opening_applied()
    assert all(e["src"] == "script" for e in found.values())


def test_reset_of_a_plain_graph_brings_no_scripted_events(fresh):
    """Only a demo graph (seed_scenario.py --demo, SimControl.script) plays the script; evac is the plain scenario."""
    in_change(fresh, lambda c: c.query("MATCH (s:SimControl) SET s.script = false"))
    try:
        in_change(fresh, reset_writes)
        assert one(fresh, "MATCH (e:Event) RETURN count(e) AS n")["n"] == 0
    finally:
        in_change(fresh, lambda c: c.query("MATCH (s:SimControl) SET s.script = true"))


def test_event_waits_for_its_minute_then_closes_both_directions(scratch):
    no_script(scratch)
    add_event(scratch, "EV-T", 2, "road_closed", {"osm_way_id": BRIDGE})
    tick(scratch)
    assert event(scratch, "EV-T")["status"] == "pending"
    assert {r["status"] for r in way_status(scratch, BRIDGE)} == {"open"}
    tick(scratch)
    tick(scratch)
    assert event(scratch, "EV-T")["status"] == "applied"
    closed = way_status(scratch, BRIDGE)
    assert len(closed) == 2 and all(r["status"] == "closed" and r["by"] == "EV-T" for r in closed)  # both ways
    linked = one(scratch, "MATCH (e:Event {id: 'EV-T'})-[:AFFECTS]->(j:Junction) RETURN count(j) AS n")["n"]
    assert linked >= 2  # placed on the map at the road


def test_loaded_mission_gets_a_new_route_and_still_delivers(scratch):
    no_script(scratch)
    triage(scratch, "CAS-1", "T1")
    status = lambda: one(scratch, "MATCH (c:Casualty {id: 'CAS-1'}) RETURN c.status AS s")["s"]  # noqa: E731
    tick_until(scratch, lambda: status() == "in_transit")
    mission = missions(scratch)["CAS-1"]
    way = way_with_detour(scratch, mission["mid"])
    add_event(scratch, "EV-T", 0, "road_closed", {"osm_way_id": way})
    tick(scratch)
    assert event(scratch, "EV-T")["status"] == "applied"
    assert one(scratch, f"MATCH (m:Mission {{id: '{mission['mid']}'}}) RETURN m.status AS s")["s"] == "active"
    assert way not in ways_on(scratch, remaining(scratch, mission["mid"])[3])  # the new route avoids it
    tick_until(scratch, lambda: one(scratch, f"MATCH (m:Mission {{id: '{mission['mid']}'}}) RETURN m.status AS s")["s"]
               == "done")
    assert status() in ("awaiting_pickup", "delivered")  # dropped at its destination (relay or bed)


def test_empty_mission_is_cancelled_and_dispatched_again(scratch):
    no_script(scratch)
    triage(scratch, "CAS-1", "T1")
    tick(scratch)
    first = missions(scratch)["CAS-1"]
    way = way_with_detour(scratch, first["mid"])
    add_event(scratch, "EV-T", 0, "road_closed", {"osm_way_id": way})
    tick(scratch)
    assert one(scratch, f"MATCH (m:Mission {{id: '{first['mid']}'}}) RETURN m.status AS s")["s"] == "cancelled"
    again = rows(scratch, "MATCH (m:Mission)-[:PICKS_UP]->(c:Casualty {id: 'CAS-1'}) "
                          "WHERE m.status = 'planned' OR m.status = 'active' RETURN m.id AS mid")
    assert len(again) == 1 and again[0]["mid"] != first["mid"]  # planned again in the same tick
    assert way not in ways_on(scratch, remaining(scratch, again[0]["mid"])[3])


def test_a_road_closed_before_dispatch_is_never_planned_over(scratch):
    """Applied before the same tick's dispatch, a closure counts at once: no new route crosses it (the bridge of 7.9
    leaves only UGV-2, parked at its south end, able to reach the front)."""
    no_script(scratch)
    for cid in ("CAS-1", "CAS-3"):
        triage(scratch, cid, "T1")
    add_event(scratch, "EV-T", 0, "road_closed", {"osm_way_id": BRIDGE})
    tick(scratch)
    assert event(scratch, "EV-T")["status"] == "applied"
    live = rows(scratch, "MATCH (m:Mission) WHERE m.status = 'planned' OR m.status = 'active' RETURN m.id AS id")
    assert live and all(BRIDGE not in ways_on(scratch, remaining(scratch, m["id"])[3]) for m in live)
    vehicles = {r["v"] for r in rows(scratch, "MATCH (m:Mission)-[:USES]->(v) RETURN v.id AS v")}
    assert "UGV-1" not in vehicles  # parked north of the bridge: cut off from the front


def test_loaded_with_no_route_anywhere_is_blocked(scratch):
    """An ambulance carrying a casualty north over the bridge when it falls: no Role 1 or higher is reachable from
    the front, so the mission is blocked and the vehicle waits at the last junction it passed, casualty on board."""
    no_script(scratch)
    triage(scratch, "CAS-1", "T1")

    def ambulance_loaded_before_bridge():
        for m in rows(scratch, "MATCH (m:Mission)-[:USES]->(v:Vehicle {type: 'ambulance'}), "
                               "(m)-[:PICKS_UP]->(c:Casualty {id: 'CAS-1', status: 'in_transit'}) "
                               "WHERE m.status = 'active' RETURN m.id AS id"):
            return m["id"] if BRIDGE in ways_on(scratch, remaining(scratch, m["id"])[3]) else "past"
        return None

    tick_until(scratch, lambda: ambulance_loaded_before_bridge() is not None)
    mission = ambulance_loaded_before_bridge()
    if mission == "past":
        pytest.skip("the ambulance crossed the bridge within its pickup minute")
    add_event(scratch, "EV-T", 0, "road_closed", {"osm_way_id": BRIDGE})
    tick(scratch)
    assert one(scratch, f"MATCH (m:Mission {{id: '{mission}'}}) RETURN m.status AS s")["s"] == "blocked"
    where = one(scratch, f"MATCH (m:Mission {{id: '{mission}'}})-[:USES]->(v) RETURN v.lat AS lat, v.lon AS lon")
    tick(scratch)
    assert one(scratch, f"MATCH (m:Mission {{id: '{mission}'}})-[:USES]->(v) RETURN v.lat AS lat, v.lon AS lon") == where
    assert one(scratch, "MATCH (c:Casualty {id: 'CAS-1'}) RETURN c.status AS s")["s"] == "in_transit"
    add_event(scratch, "EV-R", 0, "road_reopened", {"osm_way_id": BRIDGE})  # the bridge is back: it drives on
    tick(scratch)
    assert one(scratch, f"MATCH (m:Mission {{id: '{mission}'}}) RETURN m.status AS s")["s"] == "active"
    tick_until(scratch, lambda: one(scratch, "MATCH (c:Casualty {id: 'CAS-1'}) RETURN c.status AS s")["s"]
               == "delivered")


def test_blockage_slows_the_road_and_reset_restores_it(fresh):
    def setup(c):
        no_script(c)
        add_event(c, "EV-T", 0, "road_delayed", {"osm_way_id": BRIDGE, "delay_factor": 3})
        tick(c)
    in_change(fresh, setup)
    assert event(fresh, "EV-T")["status"] == "applied"
    roads = rows(fresh, f"MATCH ()-[r:ROAD]->() WHERE r.osm_way_id = {BRIDGE} "
                        "RETURN r.delay_factor AS d, r.delayed_by AS by, r.status AS s")
    assert all(r["d"] == 3 and r["by"] == "EV-T" and r["s"] == "open" for r in roads)
    in_change(fresh, reset_writes)
    roads = rows(fresh, f"MATCH ()-[r:ROAD]->() WHERE r.osm_way_id = {BRIDGE} RETURN r.delay_factor AS d, "
                        "r.delayed_by AS by")
    assert all(r["d"] == 1.0 and r["by"] is None for r in roads)


def test_reset_reopens_the_road_and_puts_the_script_back(fresh):
    def setup(c):
        add_event(c, "EV-live-1", 0, "road_closed", {"osm_way_id": BRIDGE}, source="button")
        tick(c)
    in_change(fresh, setup)
    assert {r["status"] for r in way_status(fresh, BRIDGE)} == {"closed"}
    in_change(fresh, reset_writes)
    assert all(r["status"] == "open" and r["by"] is None for r in way_status(fresh, BRIDGE))
    events = {r["id"]: r["s"] for r in rows(fresh, "MATCH (e:Event) RETURN e.id AS id, e.status AS s")}
    assert events == opening_applied()  # live one gone, scripted ones pending (the 05:30 reports applied)
    assert one(fresh, "MATCH (:Event)-[r:AFFECTS]->() RETURN count(r) AS n")["n"] == 0


NEW_CASUALTY = {"id": "CAS-T", "lat": 47.4534, "lon": 35.8212, "mist_mechanism": "Drone-dropped grenade"}


def test_a_reported_casualty_appears_untriaged_at_its_minute_and_reset_removes_it(fresh):
    def setup(c):
        no_script(c)
        add_event(c, "EV-T", 1, "casualty_reported", NEW_CASUALTY)
        tick(c)
        assert one(c, "MATCH (x:Casualty {id: 'CAS-T'}) RETURN count(x) AS n")["n"] == 0
        tick(c)
    in_change(fresh, setup)
    cas = one(fresh, "MATCH (x:Casualty {id: 'CAS-T'})-[n:NEAR]->(:Junction) RETURN x.status AS s, x.event_id AS ev, "
                     "x.mist_mechanism AS mech, x.time_of_injury AS injured, n.distance_m AS d")
    applied = one(fresh, "MATCH (e:Event {id: 'EV-T'}) RETURN e.applied_at AS at, e.summary AS summary, e.lat AS lat")
    assert (cas["s"], cas["ev"], cas["mech"]) == ("reported", "EV-T", "Drone-dropped grenade")  # the medic triages
    assert cas["d"] < 200 and cas["injured"] == applied["at"]  # no time of injury given: the event's minute
    assert applied["summary"] == "New casualty CAS-T" and applied["lat"] == NEW_CASUALTY["lat"]
    in_change(fresh, reset_writes)
    assert one(fresh, "MATCH (x:Casualty {id: 'CAS-T'}) RETURN count(x) AS n")["n"] == 0


def test_a_reported_casualty_is_dispatched_once_triaged(scratch):
    no_script(scratch)
    add_event(scratch, "EV-T", 0, "casualty_reported", NEW_CASUALTY)
    tick(scratch)
    assert "CAS-T" not in missions(scratch)
    triage(scratch, "CAS-T", "T1")
    tick(scratch)
    assert missions(scratch)["CAS-T"]["status"] == "active"


def carry_cas1_in_a_ugv(client):
    """CAS-1 on board a UGV, as T3 so that a T1 waiting later would normally come first. Returns its mission."""
    no_script(client)
    triage(client, "CAS-1", "T3")
    tick_until(client, lambda: one(client, "MATCH (c:Casualty {id: 'CAS-1'}) RETURN c.status AS s")["s"]
               == "in_transit")
    mission = missions(client)["CAS-1"]
    assert mission["vtype"] == "ugv"
    return mission


def test_a_flat_battery_strands_the_casualty_and_another_ugv_fetches_it_first(scratch):
    first = carry_cas1_in_a_ugv(scratch)
    triage(scratch, "CAS-3", "T1")  # waiting at the same minute, and a T1
    add_event(scratch, "EV-T", 0, "battery_depleted", {"vehicle_type": "ugv", "reason": "Battery depleted"})
    tick(scratch)
    dead = one(scratch, f"MATCH (v:Vehicle {{id: '{first['vid']}'}}) RETURN v.status AS s, v.battery_pct AS b, "
                        "v.lat AS lat, v.lon AS lon, v.disabled_by AS by")
    assert (dead["s"], dead["b"], dead["by"]) == ("disabled", 0, "EV-T")
    assert one(scratch, f"MATCH (m:Mission {{id: '{first['mid']}'}}) RETURN m.status AS s")["s"] == "cancelled"
    cas = one(scratch, "MATCH (c:Casualty {id: 'CAS-1'}) RETURN c.status AS s, c.stranded_by AS by, "
                       "c.lat AS lat, c.lon AS lon")
    assert cas["by"] == "EV-T" and (cas["lat"], cas["lon"]) == (dead["lat"], dead["lon"])  # left where it stopped
    applied = one(scratch, "MATCH (e:Event {id: 'EV-T'}) RETURN e.status AS s, e.summary AS summary")
    assert applied == {"s": "applied",
                       "summary": f"{first['vid']} stopped: Battery depleted; CAS-1 stranded, picked up first"}
    rescue = missions(scratch)["CAS-1"]
    assert rescue["mid"] != first["mid"] and rescue["vtype"] == "ugv" and rescue["vid"] != first["vid"]
    other = missions(scratch).get("CAS-3")
    assert other is None or int(other["mid"][2:]) > int(rescue["mid"][2:])  # the stranded one was planned first
    tick(scratch)
    assert one(scratch, f"MATCH (v:Vehicle {{id: '{first['vid']}'}}) RETURN v.lat AS lat, v.lon AS lon") == \
        {"lat": dead["lat"], "lon": dead["lon"]}  # it does not move again
    tick_until(scratch, lambda: one(scratch, "MATCH (c:Casualty {id: 'CAS-1'}) RETURN c.status AS s")["s"]
               == "in_transit")
    assert one(scratch, "MATCH (c:Casualty {id: 'CAS-1'}) RETURN c.stranded_by AS by")["by"] is None  # rescued
    resolved = one(scratch, "MATCH (e:Event {id: 'EV-T'}) RETURN e.status AS s, e.resolution AS r")
    assert resolved == {"s": "resolved", "r": f"CAS-1 picked up by {rescue['vid']}"}


def test_reset_restarts_a_stopped_vehicle_and_clears_the_stranded(fresh):
    def setup(c):
        carry_cas1_in_a_ugv(c)
        add_event(c, "EV-T", 0, "battery_depleted", {"vehicle_type": "ugv"})
        tick(c)
    in_change(fresh, setup)
    assert one(fresh, "MATCH (v:Vehicle) WHERE v.status = 'disabled' RETURN count(v) AS n")["n"] == 1
    in_change(fresh, reset_writes)
    seeded = {vid: battery for vid, *_, battery, _, _ in VEHICLES}
    now = {r["id"]: r for r in rows(fresh, "MATCH (v:Vehicle) RETURN v.id AS id, v.status AS s, v.battery_pct AS b, "
                                           "v.disabled_by AS by")}
    # the vehicles of the test graph (the seed list also holds vehicles the test graph does not have)
    assert all(now[v]["s"] == "idle" and now[v]["b"] == seeded[v] and now[v]["by"] is None for v in now)
    assert one(fresh, "MATCH (c:Casualty) WHERE c.stranded_by IS NOT NULL RETURN count(c) AS n")["n"] == 0


def test_a_reopened_road_resolves_its_closure(scratch):
    no_script(scratch)
    add_event(scratch, "EV-T", 0, "road_closed", {"osm_way_id": BRIDGE, "reason": "Bridge hit"})
    add_event(scratch, "EV-R", 2, "road_reopened", {"osm_way_id": BRIDGE, "reason": "Bridge repaired"})
    tick(scratch)
    tick(scratch)
    assert event(scratch, "EV-T")["status"] == "applied"
    tick(scratch)
    assert all(r["status"] == "open" and r["by"] is None for r in way_status(scratch, BRIDGE))
    closure = one(scratch, "MATCH (e:Event {id: 'EV-T'}) RETURN e.status AS s, e.resolution AS r")
    assert closure == {"s": "resolved", "r": "Bridge repaired (EV-R)"}
    assert event(scratch, "EV-R")["status"] == "applied"


def test_a_reported_casualty_is_resolved_once_delivered(scratch):
    no_script(scratch)
    add_event(scratch, "EV-T", 0, "casualty_reported", NEW_CASUALTY)
    tick(scratch)
    triage(scratch, "CAS-T", "T1")
    tick_until(scratch, lambda: event(scratch, "EV-T")["status"] == "resolved")
    found = one(scratch, "MATCH (c:Casualty {id: 'CAS-T'})-[:HELD_AT]->(p) MATCH (e:Event {id: 'EV-T'}) "
                         "RETURN c.status AS s, p.id AS p, e.resolution AS r")
    assert found["s"] == "delivered" and found["r"] == f"CAS-T delivered to {found['p']}"


@pytest.mark.parametrize("type_, payload, error", [
    ("meteor", {}, "unknown event type"),
    ("road_closed", {"osm_way_id": 1}, "no road with osm_way_id 1"),
    ("road_closed", {"osm_way_id": 0}, "connectors"),
    ("road_closed", {}, "KeyError"),
    ("road_delayed", {"osm_way_id": BRIDGE, "delay_factor": 0.5}, "delay_factor must be 1 or more"),
    ("casualty_reported", {"id": "CAS-1", "lat": 47.45, "lon": 35.82}, "CAS-1 already exists"),
    ("casualty_reported", {"id": "CAS-T"}, "KeyError"),
    ("battery_depleted", {"vehicle_type": "ugv"}, "no ugv on a mission"),
    ("battery_depleted", {"vehicle_id": "UGV-9"}, "no working vehicle UGV-9"),
    ("road_reopened", {"osm_way_id": BRIDGE}, "neither closed nor slowed"),
])
def test_a_bad_event_fails_and_the_tick_goes_on(scratch, type_, payload, error):
    no_script(scratch)
    add_event(scratch, "EV-T", 0, type_, payload)
    clock = read_clock(scratch)
    tick(scratch)
    failed = event(scratch, "EV-T")
    assert failed["status"] == "failed" and error in failed["error"]
    assert read_clock(scratch) > clock
