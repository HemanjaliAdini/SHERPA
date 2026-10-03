"""Scenario simulator: one tick = one scenario minute = one TuringDB commit.

Each tick dispatches free vehicles to triaged casualties (routing.dispatch_pass), moves every vehicle with a mission
along its ROUTE_STEPs at min(vehicle speed, road cap) / delay_factor, picks casualties up (they then ride with the
vehicle), drops them at the destination and moves the scenario Clock one minute on. A drop at a handover or
collection point puts the casualty back in line for an ambulance.

The C2 screen controls the run through the SimControl node (running, speed = scenario minutes per real second);
only this process writes the Clock node.

Usage:
  uv run python scripts/simulate.py [graph]           run, following SimControl
  uv run python scripts/simulate.py --reset [graph]   put the scenario back to its start (as one commit)
"""
import bisect
import sys
import time
from datetime import datetime, timedelta
from typing import NamedTuple

from turingdb import TuringDB
from turingdb.exceptions import TuringDBException

from build_roads import haversine_m
from cypher import lit, props
from routing import (RELAY_TYPES, Road, cypher_time, dispatch_pass, edge_minutes, load_roads, read_clock, route,
                     rows)

TICK = timedelta(minutes=1)
RESERVE_TRANSPORT_KMH = 60.0  # a requested reserve UGV is carried forward by road at this speed
PAUSED_POLL_S = 0.5


class Leg(NamedTuple):
    """One road along a mission route, from one ROUTE_STEP junction to the next."""
    length_m: float
    metres_per_min: float
    points: list[tuple[float, float]]  # polyline from the start junction to the end junction


# --- pure movement -------------------------------------------------------------------------------------------


def advance(legs: list[Leg], progress_m: float, minutes: float) -> float:
    """Distance along the route after driving `minutes` from `progress_m`, each road at its own speed."""
    start = 0.0
    for leg in legs:
        end = start + leg.length_m
        if progress_m < end:
            reach = leg.metres_per_min * minutes
            if progress_m + reach < end:
                return progress_m + reach
            minutes -= (end - progress_m) / leg.metres_per_min
            progress_m = end
        start = end
    return progress_m


def position_at(legs: list[Leg], progress_m: float) -> tuple[float, float]:
    """(lat, lon) at `progress_m` along the route, following each road's geometry."""
    start = 0.0
    for leg in legs:
        if progress_m <= start + leg.length_m or leg is legs[-1]:
            return along(leg.points, min(max((progress_m - start) / leg.length_m, 0.0), 1.0))
        start += leg.length_m
    raise ValueError("route has no legs")


def along(points: list[tuple[float, float]], fraction: float) -> tuple[float, float]:
    """Point at `fraction` of a polyline's own length."""
    cumulative = [0.0]
    for p, q in zip(points, points[1:]):
        cumulative.append(cumulative[-1] + haversine_m(p, q))
    target = fraction * cumulative[-1]
    i = min(bisect.bisect_left(cumulative, target), len(points) - 1)
    if i == 0:
        return points[0]
    seg = cumulative[i] - cumulative[i - 1]
    t = (target - cumulative[i - 1]) / seg if seg else 0.0
    (la1, lo1), (la2, lo2) = points[i - 1], points[i]
    return la1 + (la2 - la1) * t, lo1 + (lo2 - lo1) * t


def distance_to_junction(legs: list[Leg], index: int) -> float:
    """Route distance from the start to the `index`-th ROUTE_STEP junction."""
    return sum(leg.length_m for leg in legs[:index])


# --- TuringDB side -------------------------------------------------------------------------------------------


def mission_legs(client: TuringDB, mission_id: str, vehicle_type: str, speed_kmh: float) -> tuple[list[Leg], list[int]]:
    """The roads between consecutive ROUTE_STEPs, and the junction ids in order."""
    steps = rows(client, f"MATCH (m:Mission {{id: {lit(mission_id)}}})-[s:ROUTE_STEP]->(j) "
                         "RETURN s.order AS o, id(j) AS j, j.lat AS lat, j.lon AS lon ORDER BY o")
    junctions = [int(s["j"]) for s in steps]
    coords = [(s["lat"], s["lon"]) for s in steps]
    if not junctions:
        raise RuntimeError(f"mission {mission_id} has no ROUTE_STEPs")
    roads = rows(client, (
        f"MATCH (m:Mission {{id: {lit(mission_id)}}})-[s:ROUTE_STEP]->(a:Junction)-[r:ROAD]->(b:Junction)"
        "<-[t:ROUTE_STEP]-(m) WHERE t.order = s.order + 1 "
        "RETURN s.order AS o, r.length_m AS len, r.speed_ugv_kmh AS ugv, r.speed_ambulance_kmh AS amb, "
        "r.delay_factor AS delay ORDER BY o"
    ))
    by_order = {}
    for r in roads:
        by_order.setdefault(int(r["o"]), r)  # parallel roads between the same junctions: take one
    legs = []
    for order in range(1, len(junctions)):
        r = by_order[order]
        road = Road(0, r["len"], r["ugv"], r["amb"], r["delay"])
        # Straight between the two junctions, as the C2 map draws roads, so vehicles stay on the drawn line
        legs.append(Leg(r["len"], r["len"] / edge_minutes(road, vehicle_type, speed_kmh), [coords[order - 1], coords[order]]))
    return legs, junctions


def move_near(client: TuringDB, label: str, entity_id: str, junction: int, lat: float, lon: float) -> None:
    """Re-link an entity to a junction and put it at (lat, lon)."""
    j = rows(client, f"MATCH (j) WHERE j = {junction} RETURN j.lat AS lat, j.lon AS lon")[0]
    match = f"MATCH (n:{label} {{id: {lit(entity_id)}}})"
    client.query(f"{match}-[r:NEAR]->() DELETE r")
    client.query(
        f"{match} MATCH (j) WHERE j = {junction} "
        f"CREATE (n)-[:NEAR {props(distance_m=haversine_m((lat, lon), (j['lat'], j['lon'])))}]->(j) "
        f"SET n.lat = {lat}, n.lon = {lon}"
    )


def finish(client: TuringDB, mission_id: str, vehicle_id: str) -> None:
    """Arrival: drop the casualty at the destination, free the vehicle, close the mission."""
    p = rows(client, (
        f"MATCH (m:Mission {{id: {lit(mission_id)}}})-[:DELIVERS_TO]->(p:MedicalPoint)-[:NEAR]->(j) "
        "RETURN p.id AS id, p.type AS type, p.lat AS lat, p.lon AS lon, id(j) AS j"
    ))[0]
    relay = p["type"] in RELAY_TYPES
    for c in rows(client, f"MATCH (m:Mission {{id: {lit(mission_id)}}})-[:PICKS_UP]->(c:Casualty) RETURN c.id AS id"):
        cas = f"MATCH (c:Casualty {{id: {lit(c['id'])}}})"
        client.query(f"{cas}-[h:HELD_AT]->() DELETE h")
        client.query(f"{cas} MATCH (p:MedicalPoint {{id: {lit(p['id'])}}}) CREATE (c)-[:HELD_AT]->(p) "
                     f"SET c.status = {lit('awaiting_pickup' if relay else 'delivered')}")
        move_near(client, "Casualty", c["id"], int(p["j"]), p["lat"], p["lon"])
        if not relay:
            client.query(f"MATCH (p:MedicalPoint {{id: {lit(p['id'])}}}) SET p.free_beds = p.free_beds - 1")
    client.query(f"MATCH (m:Mission {{id: {lit(mission_id)}}})-[r:PICKS_UP]->() SET r.status = 'done', m.status = 'done'")
    client.query(f"MATCH (v:Vehicle {{id: {lit(vehicle_id)}}}) SET v.status = 'idle'")
    move_near(client, "Vehicle", vehicle_id, int(p["j"]), p["lat"], p["lon"])


def move_missions(client: TuringDB) -> None:
    for m in rows(client, (
        "MATCH (m:Mission)-[:USES]->(v:Vehicle) WHERE m.status = 'planned' OR m.status = 'active' "
        "RETURN m.id AS id, m.progress_m AS progress, v.id AS vid, v.type AS type, v.speed_kmh AS speed"
    )):
        legs, junctions = mission_legs(client, m["id"], m["type"], m["speed"])
        if not legs:  # vehicle, casualty and destination on one junction: arrives at once
            finish(client, m["id"], m["vid"])
            continue
        progress = advance(legs, m["progress"] or 0.0, TICK.total_seconds() / 60)
        lat, lon = position_at(legs, progress)
        client.query(f"MATCH (m:Mission {{id: {lit(m['id'])}}})-[:USES]->(v:Vehicle) "
                     f"SET m.progress_m = {progress}, m.status = 'active', v.lat = {lat}, v.lon = {lon}")
        for c in rows(client, (
            f"MATCH (m:Mission {{id: {lit(m['id'])}}})-[:PICKS_UP]->(c:Casualty)-[:NEAR]->(j) "
            "RETURN c.id AS id, c.status AS status, id(j) AS j"
        )):
            pickup_at = distance_to_junction(legs, junctions.index(int(c["j"]))) if int(c["j"]) in junctions else 0.0
            if c["status"] == "assigned" and progress >= pickup_at:
                c["status"] = "in_transit"
                client.query(f"MATCH (m:Mission {{id: {lit(m['id'])}}})-[r:PICKS_UP]->(c:Casualty {{id: {lit(c['id'])}}}) "
                             "SET r.status = 'picked_up', c.status = 'in_transit'")
            if c["status"] == "in_transit":
                client.query(f"MATCH (c:Casualty {{id: {lit(c['id'])}}}) SET c.lat = {lat}, c.lon = {lon}")
        if progress >= distance_to_junction(legs, len(legs)):
            finish(client, m["id"], m["vid"])


def reinforce(client: TuringDB, now: datetime) -> None:
    """Far reserve UGVs. A requested one becomes idle at its handover point once its arrival time has come.
    A new one is requested when a casualty is still waiting at the front after dispatch and no UGV is idle or
    already on its way: nearer UGVs are dispatched like any vehicle, only the far reserve has to be asked for."""
    for v in rows(client, "MATCH (v:Vehicle) WHERE v.status = 'requested' "
                          "RETURN v.id AS id, v.arrives_at AS at, v.arrive_point AS point"):
        if v["at"].to_pydatetime() > now:
            continue
        p = rows(client, f"MATCH (p:MedicalPoint {{id: {lit(v['point'])}}})-[:NEAR]->(j) "
                         "RETURN p.lat AS lat, p.lon AS lon, id(j) AS j")[0]
        client.query(f"MATCH (v:Vehicle {{id: {lit(v['id'])}}}) SET v.status = 'idle'")
        move_near(client, "Vehicle", v["id"], int(p["j"]), p["lat"] + 0.0002, p["lon"])
        print(f"{v['id']} arrived at {v['point']} from reserve", flush=True)
    relayed = {r["id"] for r in rows(client, "MATCH (c:Casualty)-[:HELD_AT]->(:MedicalPoint) RETURN c.id AS id")}
    waiting = [c for c in rows(client, "MATCH (c:Casualty) WHERE c.status = 'awaiting_pickup' "
                                       "RETURN c.id AS id, c.lat AS lat, c.lon AS lon") if c["id"] not in relayed]
    if not waiting:
        return
    ugvs = rows(client, "MATCH (v:Vehicle)-[:NEAR]->(j) WHERE v.type = 'ugv' "
                        "RETURN v.id AS id, v.status AS status, id(j) AS j ORDER BY id")
    if any(v["status"] in ("idle", "requested") for v in ugvs):
        return
    reserve = next((v for v in ugvs if v["status"] == "reserve"), None)
    handovers = rows(client, "MATCH (p:MedicalPoint)-[:NEAR]->(j) WHERE p.type = 'handover' "
                             "RETURN p.id AS id, p.lat AS lat, p.lon AS lon, id(j) AS j")
    if reserve is None or not handovers:
        return
    c = waiting[0]
    point = min(handovers, key=lambda p: haversine_m((c["lat"], c["lon"]), (p["lat"], p["lon"])))
    trip = route(load_roads(client), int(reserve["j"]), int(point["j"]), "ambulance", RESERVE_TRANSPORT_KMH)
    if trip is None:
        return
    arrives = now + timedelta(minutes=round(trip[1]))
    client.query(f"MATCH (v:Vehicle {{id: {lit(reserve['id'])}}}) SET v.status = 'requested', "
                 f"v.arrives_at = {cypher_time(arrives)}, v.arrive_point = {lit(point['id'])}")
    print(f"{c['id']} waiting, no UGV free: {reserve['id']} requested from reserve, at {point['id']} in "
          f"{trip[1]:.0f} min ({trip[2]:.1f} km)", flush=True)


def tick_writes(client: TuringDB) -> datetime:
    """One scenario minute, written inside the caller's change. Returns the new scenario time."""
    now = read_clock(client)
    dispatch_pass(client, now)
    reinforce(client, now)
    move_missions(client)
    client.query(f"MATCH (k:Clock) SET k.now = {cypher_time(now + TICK)}")
    return now + TICK


def in_change(client: TuringDB, work) -> None:
    """Run `work(client)` as one short change on main: commit and submit, or discard it on any error."""
    client.new_change()
    try:
        work(client)
        client.query("COMMIT")
        client.query("CHANGE SUBMIT")
    except Exception:
        try:
            client.query("CHANGE DELETE")
        except TuringDBException:
            pass  # a failed submit can consume the change; keep the original error, not this one
        raise
    finally:
        client.checkout()


def reset_writes(client: TuringDB) -> None:
    """Back to the seed: no missions, everyone at their start, beds and clock as seeded, paused."""
    from seed_scenario import (CASUALTIES, MEDICAL_POINTS, SCENARIO_START, VEHICLE_DAMAGE, VEHICLE_RESERVE, VEHICLES,
                               snap)

    client.query("MATCH (m:Mission) DETACH DELETE m")
    client.query("MATCH (c:Casualty)-[h:HELD_AT]->() DELETE h")
    client.query("COMMIT")
    # Re-link only what moved: recreating every NEAR edge clashes with the medic's writes to the same nodes
    where = {r["id"]: (r["lat"], r["lon"]) for r in rows(
        client, "MATCH (n) WHERE n:Vehicle OR n:Casualty RETURN n.id AS id, n.lat AS lat, n.lon AS lon")}
    for vid, _, lat, lon, *_, battery, _, speed in VEHICLES:
        client.query(f"MATCH (v:Vehicle {{id: {lit(vid)}}}) "
                     f"SET v.status = {lit('reserve' if vid in VEHICLE_RESERVE else 'idle')}, "
                     f"v.battery_pct = {battery}, v.speed_kmh = {speed}, "
                     f"v.damage = {lit(VEHICLE_DAMAGE.get(vid, 'none'))} REMOVE v.arrives_at, v.arrive_point")
        if where.get(vid) != (lat, lon):
            move_near(client, "Vehicle", vid, snap(client, lat, lon)[0], lat, lon)
    for cid, lat, lon, *_ in CASUALTIES:
        client.query(f"MATCH (c:Casualty {{id: {lit(cid)}}}) SET c.status = 'reported' "
                     "REMOVE c.triage_category, c.mobility")
        if where.get(cid) != (lat, lon):
            move_near(client, "Casualty", cid, snap(client, lat, lon)[0], lat, lon)
    for pid, *_, beds in MEDICAL_POINTS:
        client.query(f"MATCH (p:MedicalPoint {{id: {lit(pid)}}}) SET p.free_beds = {beds}")
    # Each reset starts a new run. Besides labelling runs in the history, this keeps every reset commit distinct:
    # TuringDB refuses a commit identical to an existing one ("Commit already exists"), e.g. two resets in a row
    run = rows(client, "MATCH (k:Clock) RETURN k.run AS run")[0]["run"]
    client.query(f"MATCH (k:Clock) SET k.now = datetime({lit(SCENARIO_START)}), "
                 f"k.run = {int(run if run == run and run is not None else 0) + 1}")
    client.query("MATCH (s:SimControl) SET s.running = false, s.reset = false")


def loop_once(client: TuringDB) -> float:
    """Follow SimControl once: reset if asked, tick if running. Returns how long to wait before the next pass."""
    control = rows(client, "MATCH (s:SimControl) RETURN s.running AS running, s.speed AS speed, s.reset AS reset")[0]
    if control["reset"] is True:
        in_change(client, reset_writes)
        return PAUSED_POLL_S
    if not control["running"]:
        return PAUSED_POLL_S
    started = time.monotonic()
    in_change(client, tick_writes)
    return max(0.0, 1 / max(control["speed"], 0.01) - (time.monotonic() - started))


def run_pass(client: TuringDB) -> float:
    """One loop pass that never kills the simulator: a pass TuringDB rejects (e.g. a change that touches a node
    the screen modified meanwhile) is already discarded, so it is logged and tried again on the next pass."""
    try:
        return loop_once(client)
    except TuringDBException as e:
        print(f"pass rejected, retrying: {e}", flush=True)
        return PAUSED_POLL_S


def main() -> None:
    args = [a for a in sys.argv[1:] if a != "--reset"]
    client = TuringDB(host="http://localhost:6666")
    client.load_graph(args[0] if args else "evac2", raise_if_loaded=False)
    client.set_graph(args[0] if args else "evac2")
    if "--reset" in sys.argv:
        in_change(client, reset_writes)
        print("scenario reset to its start")
        return
    print(f"simulator following SimControl on graph '{client.get_graph()}'", flush=True)
    while True:
        time.sleep(run_pass(client))


if __name__ == "__main__":
    main()
