"""Route vehicles over the ROAD graph and plan evacuation missions (D1 and D2 in docs/DISCREPANCIES.md).

Travel time is never stored. A road's time for one vehicle is
    length_m / min(vehicle speed_kmh, road cap for its type) * delay_factor
computed during the search, so it follows the vehicle's own speed and the current delays. TuringDB has no
shortestPath, so the search runs here (Dijkstra) on the open roads of the commit being read.

Usage:
  uv run python scripts/routing.py plan [graph]                 one mission per casualty awaiting pickup
  uv run python scripts/routing.py close <osm_way_id> [graph]   close a road both ways, list broken missions
"""
import heapq
import math
import sys
from typing import NamedTuple

from turingdb import TuringDB

from build_roads import haversine_m
from cypher import lit, props


class Road(NamedTuple):
    dst: int
    length_m: float
    cap_ugv_kmh: float
    cap_ambulance_kmh: float
    delay_factor: float


class Vehicle(NamedTuple):
    id: str
    type: str
    junction: int
    speed_kmh: float
    range_km: float
    litter_capacity: int
    ambulatory_capacity: int


class Point(NamedTuple):
    id: str
    junction: int
    capabilities: tuple[str, ...]


class Option(NamedTuple):
    vehicle: Vehicle
    point: Point
    steps: list[int]
    minutes: float
    km: float


Roads = dict[int, list[Road]]

# Order of pickup: triage first, then time since injury
TRIAGE_ORDER = {"T1": 0, "T2": 1, "T3": 2}
# ponytail: clinical placeholder, to confirm with Noo together with D6 (MITT labels) and D7 (point types)
REQUIRED_CAPABILITY = {"T1": "stabilisation", "T2": "stabilisation", "T3": "first_aid"}
FALLBACK_JUNCTIONS = 3  # D2.6: if the NEAR junction has no way out (one-way roads), try the next nearest ones


def edge_minutes(road: Road, vehicle_type: str, speed_kmh: float) -> float:
    cap = {"ugv": road.cap_ugv_kmh, "ambulance": road.cap_ambulance_kmh}[vehicle_type]
    return road.length_m / 1000 / min(speed_kmh, cap) * 60 * road.delay_factor


def route(roads: Roads, src: int, dst: int, vehicle_type: str, speed_kmh: float):
    """Fastest path for one vehicle as (junctions, minutes, km), or None if dst cannot be reached."""
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


def best_option(roads: Roads, casualty_junction: int, mobility: str, required: str,
                vehicles: list[Vehicle], points: list[Point]) -> Option | None:
    """Fastest vehicle -> casualty -> medical point trip that can carry and treat this casualty."""
    best = None
    for v in (v for v in vehicles if can_carry(v, mobility)):
        pickup = route(roads, v.junction, casualty_junction, v.type, v.speed_kmh)
        if pickup is None:
            continue
        for p in (p for p in points if required in p.capabilities):
            delivery = route(roads, casualty_junction, p.junction, v.type, v.speed_kmh)
            if delivery is None:
                continue
            km = pickup[2] + delivery[2]
            minutes = pickup[1] + delivery[1]
            if km <= v.range_km and (best is None or minutes < best.minutes):
                best = Option(v, p, pickup[0] + delivery[0][1:], minutes, km)
    return best


# --- TuringDB side -------------------------------------------------------------------------------------------


def rows(client: TuringDB, query: str) -> list[dict]:
    return client.query(query).to_dict("records")


def load_roads(client: TuringDB) -> tuple[Roads, dict[int, tuple[float, float]]]:
    roads: Roads = {}
    for r in rows(client, (
        "MATCH (a:Junction)-[r:ROAD]->(b:Junction) WHERE r.status <> 'closed' "
        "RETURN id(a) AS a, id(b) AS b, r.length_m AS len, r.speed_ugv_kmh AS ugv, "
        "r.speed_ambulance_kmh AS amb, r.delay_factor AS delay"
    )):
        roads.setdefault(int(r["a"]), []).append(Road(int(r["b"]), r["len"], r["ugv"], r["amb"], r["delay"]))
    coords = {int(r["j"]): (r["lat"], r["lon"])
              for r in rows(client, "MATCH (j:Junction) RETURN id(j) AS j, j.lat AS lat, j.lon AS lon")}
    return roads, coords


def nearest_junctions(coords: dict[int, tuple[float, float]], junction: int, k: int) -> list[int]:
    here = coords[junction]
    return sorted((j for j in coords if j != junction), key=lambda j: haversine_m(here, coords[j]))[:k]


def write_mission(client: TuringDB, mission_id: str, casualty_id: str, option: Option, free_beds: int) -> None:
    v, p = option.vehicle, option.point
    mission = props(id=lit(mission_id), status=lit("planned"), eta_min=round(option.minutes, 1),
                    distance_km=round(option.km, 2))
    pickup = props(order=1, status=lit("pending"))
    client.query(
        f"MATCH (v:Vehicle {{id: {lit(v.id)}}}), (c:Casualty {{id: {lit(casualty_id)}}}), "
        f"(p:MedicalPoint {{id: {lit(p.id)}}}) "
        f"CREATE (m:Mission {mission}), (m)-[:USES]->(v), (m)-[:PICKS_UP {pickup}]->(c), (m)-[:DELIVERS_TO]->(p)"
    )
    client.query(f"MATCH (v:Vehicle {{id: {lit(v.id)}}}) SET v.status = 'assigned'")
    client.query(f"MATCH (c:Casualty {{id: {lit(casualty_id)}}}) SET c.status = 'assigned'")
    client.query(f"MATCH (p:MedicalPoint {{id: {lit(p.id)}}}) SET p.free_beds = {free_beds}")
    client.query("COMMIT")  # the new Mission is invisible to the ROUTE_STEP queries until committed
    for order, junction in enumerate(option.steps, 1):
        client.query(
            f"MATCH (m:Mission {{id: {lit(mission_id)}}}) MATCH (j) WHERE j = {junction} "
            f"CREATE (m)-[:ROUTE_STEP {props(order=order)}]->(j)"
        )


def plan(client: TuringDB) -> None:
    """One mission per casualty awaiting pickup, most urgent first. The system decides all logistics (D2.4)."""
    roads, coords = load_roads(client)
    casualties = sorted(rows(client, (
        "MATCH (c:Casualty)-[:NEAR]->(j:Junction) WHERE c.status = 'awaiting_pickup' "
        "RETURN c.id AS id, c.triage_category AS triage, c.mobility AS mobility, c.time_of_injury AS toi, "
        "id(j) AS j"
    )), key=lambda c: (TRIAGE_ORDER[c["triage"]], c["toi"]))
    vehicles = [Vehicle(r["id"], r["type"], int(r["j"]), r["speed"], r["range"], r["litter"], r["amb"])
                for r in rows(client, (
                    "MATCH (v:Vehicle)-[:NEAR]->(j:Junction) WHERE v.status = 'idle' "
                    "RETURN v.id AS id, v.type AS type, v.speed_kmh AS speed, v.range_km AS range, "
                    "v.litter_capacity AS litter, v.ambulatory_capacity AS amb, id(j) AS j"
                ))]
    if any(v.speed_kmh is None for v in vehicles):
        sys.exit("some Vehicle has no speed_kmh; reseed the scenario with the current seed_scenario.py")
    beds, points = {}, []
    for r in rows(client, (
        "MATCH (p:MedicalPoint)-[:NEAR]->(j:Junction) WHERE p.state = 'operational' "
        "RETURN p.id AS id, p.capabilities AS caps, p.free_beds AS beds, id(j) AS j"
    )):
        beds[r["id"]] = int(r["beds"])
        points.append(Point(r["id"], int(r["j"]), tuple(r["caps"])))
    taken = int(rows(client, "MATCH (m:Mission) RETURN count(m) AS n")[0]["n"])  # next mission id

    client.new_change()
    try:
        for cas in casualties:
            open_points = [p for p in points if beds[p.id] > 0]
            option = None
            for j in [int(cas["j"]), *nearest_junctions(coords, int(cas["j"]), FALLBACK_JUNCTIONS)]:
                option = best_option(roads, j, cas["mobility"], REQUIRED_CAPABILITY[cas["triage"]],
                                     vehicles, open_points)
                if option:
                    break
            if option is None:
                client.query(f"MATCH (c:Casualty {{id: {lit(cas['id'])}}}) SET c.status = 'no_resource'")
                print(f"{cas['id']} ({cas['triage']}): no resource available")
                continue
            taken += 1
            beds[option.point.id] -= 1
            vehicles.remove(option.vehicle)
            write_mission(client, f"M-{taken}", cas["id"], option, beds[option.point.id])
            print(f"{cas['id']} ({cas['triage']}): M-{taken} {option.vehicle.id} -> {option.point.id}, "
                  f"{option.minutes:.0f} min, {option.km:.1f} km, {len(option.steps)} junctions")
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
