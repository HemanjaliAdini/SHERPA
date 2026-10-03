"""Route vehicles over the ROAD graph and dispatch evacuation missions (PRD decisions 6.1, 6.2).

Travel time is never stored. A road's time for one vehicle is
    length_m / min(vehicle speed_kmh, road cap for its type) * delay_factor
computed during the search, so it follows the vehicle's own speed and the current delays. TuringDB's shortestPath
takes one stored property as weight, so the per-vehicle search runs here (Dijkstra) on the open roads.

Dispatch follows the C2 planner's rules (visualizer/src/components/c2/planner.ts): UGVs carry to a handover or
collection point, ambulances to Role 1 or higher; the medic's triage sets the order. The simulator calls
dispatch_pass() on every tick.

Usage:
  uv run python scripts/routing.py plan [graph]                 one dispatch pass, as its own change
  uv run python scripts/routing.py close <osm_way_id> [graph]   close a road both ways, list broken missions
"""
import heapq
import math
import sys
from datetime import datetime, timedelta
from typing import NamedTuple

from turingdb import TuringDB

from cypher import lit, props


class Road(NamedTuple):
    dst: int
    length_m: float
    cap_ugv_kmh: float
    cap_ambulance_kmh: float
    delay_factor: float
    threat_level: float = 0.0


class Vehicle(NamedTuple):
    id: str
    type: str
    junction: int
    speed_kmh: float
    range_km: float
    litter_capacity: int
    ambulatory_capacity: int
    battery_pct: float = 100.0
    max_threat: float = 1.0


class Point(NamedTuple):
    id: str
    junction: int
    type: str


class Option(NamedTuple):
    vehicle: Vehicle
    point: Point
    steps: list[int]
    minutes: float
    km: float
    pickup_minutes: float


class Waiting(NamedTuple):
    id: str
    triage: str
    injured_at: datetime
    junction: int
    mobility: str
    at_relay: bool  # already dropped at a handover or collection point: ambulances only


Roads = dict[int, list[Road]]

# Order of pickup: triage first, then time since injury. Untriaged and DEAD casualties are never dispatched.
TRIAGE_ORDER = {"T1": 0, "T2": 1, "T3": 2}
# Where each vehicle type takes casualties (same as DESTINATION_TYPES in planner.ts)
DESTINATION_TYPES = {"ugv": ("handover", "ccp"), "ambulance": ("role1", "role2_basic", "role3")}
RELAY_TYPES = ("handover", "ccp")  # points without beds where an ambulance takes over


def edge_minutes(road: Road, vehicle_type: str, speed_kmh: float) -> float:
    cap = {"ugv": road.cap_ugv_kmh, "ambulance": road.cap_ambulance_kmh}[vehicle_type]
    return road.length_m / 1000 / min(speed_kmh, cap) * 60 * road.delay_factor


def route(roads: Roads, src: int, dst: int, vehicle_type: str, speed_kmh: float, max_threat: float = 1.0):
    """Fastest path for one vehicle as (junctions, minutes, km), or None if dst cannot be reached.

    Roads whose threat_level is above the vehicle's max_threat are not used.
    """
    best = {src: 0.0}
    prev: dict[int, tuple[int, float]] = {}
    heap = [(0.0, src)]
    while heap:
        t, node = heapq.heappop(heap)
        if node == dst:
            break
        if t > best[node]:
            continue
        for road in roads.get(node, ()):
            if road.threat_level > max_threat:
                continue
            arrival = t + edge_minutes(road, vehicle_type, speed_kmh)
            if arrival < best.get(road.dst, math.inf):
                best[road.dst] = arrival
                prev[road.dst] = (node, road.length_m)
                heapq.heappush(heap, (arrival, road.dst))
    if dst not in best:
        return None
    path, metres = [dst], 0.0
    while path[-1] != src:
        node, length = prev[path[-1]]
        path.append(node)
        metres += length
    return path[::-1], best[dst], metres / 1000


def can_carry(v: Vehicle, mobility: str) -> bool:
    return v.litter_capacity > 0 or (mobility == "ambulatory" and v.ambulatory_capacity > 0)


def best_option(roads: Roads, casualty_junction: int, mobility: str, vehicles: list[Vehicle],
                points: list[Point], at_relay: bool = False) -> Option | None:
    """Fastest vehicle -> casualty -> medical point trip that can carry this casualty within range x battery."""
    best = None
    for v in vehicles:
        if not can_carry(v, mobility) or (at_relay and v.type == "ugv"):
            continue
        pickup = route(roads, v.junction, casualty_junction, v.type, v.speed_kmh, v.max_threat)
        if pickup is None:
            continue
        for p in (p for p in points if p.type in DESTINATION_TYPES[v.type]):
            delivery = route(roads, casualty_junction, p.junction, v.type, v.speed_kmh, v.max_threat)
            if delivery is None:
                continue
            km = pickup[2] + delivery[2]
            minutes = pickup[1] + delivery[1]
            if km <= v.range_km * v.battery_pct / 100 and (best is None or minutes < best.minutes):
                best = Option(v, p, pickup[0] + delivery[0][1:], minutes, km, pickup[1])
    return best


def dispatch(roads: Roads, waiting: list[Waiting], vehicles: list[Vehicle], points: list[Point],
             beds: dict[str, int]) -> list[tuple[Waiting, Option]]:
    """Give free vehicles to waiting casualties, most urgent first. A vehicle or a bed is used at most once."""
    free = list(vehicles)
    left = dict(beds)
    plan = []
    for cas in sorted((w for w in waiting if w.triage in TRIAGE_ORDER),
                      key=lambda w: (TRIAGE_ORDER[w.triage], w.injured_at)):
        open_points = [p for p in points if p.type in RELAY_TYPES or left.get(p.id, 0) > 0]
        option = best_option(roads, cas.junction, cas.mobility, free, open_points, cas.at_relay)
        if option is None:
            continue
        free.remove(option.vehicle)
        if option.point.type not in RELAY_TYPES:
            left[option.point.id] -= 1
        plan.append((cas, option))
    return plan


# --- TuringDB side -------------------------------------------------------------------------------------------


def rows(client: TuringDB, query: str) -> list[dict]:
    return client.query(query).to_dict("records")


def cypher_time(t: datetime) -> str:
    return f"datetime('{t.strftime('%Y-%m-%dT%H:%M:%SZ')}')"


def load_roads(client: TuringDB) -> Roads:
    roads: Roads = {}
    for r in rows(client, (
        "MATCH (a:Junction)-[r:ROAD]->(b:Junction) WHERE r.status <> 'closed' "
        "RETURN id(a) AS a, id(b) AS b, r.length_m AS len, r.speed_ugv_kmh AS ugv, "
        "r.speed_ambulance_kmh AS amb, r.delay_factor AS delay, r.threat_level AS threat"
    )):
        roads.setdefault(int(r["a"]), []).append(
            Road(int(r["b"]), r["len"], r["ugv"], r["amb"], r["delay"], r["threat"] or 0.0))
    return roads


def write_mission(client: TuringDB, mission_id: str, casualty_id: str, option: Option, now: datetime) -> None:
    """Same shape as the C2 planner's missions.ts, so the UI reads system missions unchanged."""
    v, p = option.vehicle, option.point
    mission = props(id=lit(mission_id), status=lit("planned"), created_at=cypher_time(now),
                    eta=cypher_time(now + timedelta(minutes=option.minutes)), progress_m=0.0)
    pickup = props(order=1, status=lit("pending"), eta=cypher_time(now + timedelta(minutes=option.pickup_minutes)))
    client.query(
        f"MATCH (v:Vehicle {{id: {lit(v.id)}}}), (c:Casualty {{id: {lit(casualty_id)}}}), "
        f"(p:MedicalPoint {{id: {lit(p.id)}}}) "
        f"CREATE (m:Mission {mission}), (m)-[:USES]->(v), (m)-[:PICKS_UP {pickup}]->(c), (m)-[:DELIVERS_TO]->(p) "
        f"SET v.status = 'tasked', c.status = 'assigned'"
    )
    client.query("COMMIT")  # the new Mission is invisible to the ROUTE_STEP queries until committed
    for order, junction in enumerate(option.steps, 1):
        client.query(
            f"MATCH (m:Mission {{id: {lit(mission_id)}}}) MATCH (j) WHERE j = {junction} "
            f"CREATE (m)-[:ROUTE_STEP {props(order=order)}]->(j)"
        )
    client.query("COMMIT")  # so the same tick can read the route back and move the vehicle


def dispatch_pass(client: TuringDB, now: datetime, roads: Roads | None = None) -> list[str]:
    """One dispatch over the current graph, written inside the caller's change. Returns the new mission ids."""
    relayed = {r["id"] for r in rows(client, (
        "MATCH (c:Casualty)-[:HELD_AT]->(p:MedicalPoint) WHERE p.type = 'handover' OR p.type = 'ccp' "
        "RETURN c.id AS id"
    ))}
    waiting = [Waiting(r["id"], r["triage"], r["toi"], int(r["j"]), r["mobility"], r["id"] in relayed)
               for r in rows(client, (
                   "MATCH (c:Casualty)-[:NEAR]->(j:Junction) WHERE c.status = 'awaiting_pickup' "
                   "RETURN c.id AS id, c.triage_category AS triage, c.mobility AS mobility, "
                   "c.time_of_injury AS toi, id(j) AS j"
               ))]
    vehicles = [Vehicle(r["id"], r["type"], int(r["j"]), r["speed"], r["range"], r["litter"], r["amb"],
                        r["battery"], r["max_threat"])
                for r in rows(client, (
                    "MATCH (v:Vehicle)-[:NEAR]->(j:Junction) WHERE v.status = 'idle' "
                    "RETURN v.id AS id, v.type AS type, v.speed_kmh AS speed, v.range_km AS range, "
                    "v.litter_capacity AS litter, v.ambulatory_capacity AS amb, v.battery_pct AS battery, "
                    "v.max_threat AS max_threat, id(j) AS j"
                ))]
    if not waiting or not vehicles:
        return []
    roads = load_roads(client) if roads is None else roads
    # Beds already promised to missions still on their way count as taken
    inflight = {r["id"]: int(r["n"]) for r in rows(client, (
        "MATCH (m:Mission)-[:DELIVERS_TO]->(p:MedicalPoint) WHERE m.status <> 'done' RETURN p.id AS id, count(m) AS n"
    ))}
    points, beds = [], {}
    for r in rows(client, (
        "MATCH (p:MedicalPoint)-[:NEAR]->(j:Junction) WHERE p.state = 'operational' "
        "RETURN p.id AS id, p.type AS type, p.free_beds AS beds, id(j) AS j"
    )):
        points.append(Point(r["id"], int(r["j"]), r["type"]))
        beds[r["id"]] = int(r["beds"]) - inflight.get(r["id"], 0)
    count = int(rows(client, "MATCH (m:Mission) RETURN count(m) AS n")[0]["n"])
    created = []
    for cas, option in dispatch(roads, waiting, vehicles, points, beds):
        count += 1
        write_mission(client, f"M-{count}", cas.id, option, now)
        created.append(f"M-{count}")
        print(f"{cas.id} ({cas.triage}): M-{count} {option.vehicle.id} -> {option.point.id}, "
              f"{option.minutes:.0f} min, {option.km:.1f} km", flush=True)
    return created


def read_clock(client: TuringDB) -> datetime:
    return rows(client, "MATCH (k:Clock) RETURN k.now AS now")[0]["now"].to_pydatetime()


def plan(client: TuringDB) -> None:
    """One dispatch pass as its own change, at the scenario clock's time."""
    client.new_change()
    try:
        dispatch_pass(client, read_clock(client))
        client.query("COMMIT")
        client.query("CHANGE SUBMIT")
    except Exception:
        client.query("CHANGE DELETE")
        raise
    finally:
        client.checkout()


def close_road(client: TuringDB, osm_way_id: int) -> None:
    """Close every ROAD edge of one OSM way (both directions, D2.7) and list the missions that crossed it."""
    client.new_change()
    try:
        client.query(f"MATCH (:Junction)-[r:ROAD]->(:Junction) WHERE r.osm_way_id = {osm_way_id} "
                     "SET r.status = 'closed'")
        client.query("COMMIT")
        broken = rows(client, (
            "MATCH (m:Mission)-[s:ROUTE_STEP]->(a:Junction)-[r:ROAD]->(b:Junction)<-[t:ROUTE_STEP]-(m) "
            f"WHERE r.osm_way_id = {osm_way_id} AND t.order = s.order + 1 RETURN DISTINCT m.id AS id"
        ))
        client.query("CHANGE SUBMIT")
    except Exception:
        client.query("CHANGE DELETE")
        raise
    finally:
        client.checkout()
    print(f"closed way {osm_way_id}; broken missions: {[b['id'] for b in broken] or 'none'}")


def main() -> None:
    args = sys.argv[1:]
    client = TuringDB(host="http://localhost:6666")
    if args[:1] == ["plan"]:
        client.set_graph(args[1] if len(args) > 1 else "evac2")
        plan(client)
    elif args[:1] == ["close"] and len(args) > 1:
        client.set_graph(args[2] if len(args) > 2 else "evac2")
        close_road(client, int(args[1]))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
