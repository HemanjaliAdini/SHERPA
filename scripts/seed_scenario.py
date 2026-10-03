"""Place the synthetic scenario entities on the real road graph.

Medical points, vehicles, casualties and one (inactive) threat are created at the scenario's
synthetic coordinates and linked to their nearest junction by NEAR / AFFECTS edges. The nearest
junction is found inside TuringDB. Runs as one change that is only submitted if everything succeeds.

Usage: uv run python scripts/seed_scenario.py [graph_name]   (default: evac2)
Needs a running TuringDB server (./run.sh). Refuses to run twice: there are no uniqueness constraints.
"""
import sys

from turingdb import TuringDB

from build_roads import haversine_m
from seed_toy_graph import CAPS, lit, props

GRAPH = sys.argv[1] if len(sys.argv) > 1 else "evac2"
COS2_LAT = 0.456  # cos^2(47.5 deg): equirectangular squared-distance weight for longitude

# id, name, type, lat, lon, medics_available, free_beds
MEDICAL_POINTS = [
    ("CCP-W", "Collection point West", "ccp", 47.456, 35.795, 1, 0),
    ("CCP-C", "Collection point Centre", "ccp", 47.455, 35.825, 1, 0),
    ("CCP-E", "Collection point East", "ccp", 47.458, 35.865, 1, 0),
    ("HP-1", "Handover point 1", "handover", 47.500, 35.812, 1, 0),
    ("HP-2", "Handover point 2", "handover", 47.505, 35.860, 1, 0),
    ("R1-A", "Role 1 Orikhiv", "role1", 47.560, 35.790, 3, 4),
    ("R1-B", "Role 1 alternate", "role1", 47.575, 35.760, 2, 6),
    ("R2B-1", "Role 2 Basic", "role2_basic", 47.624, 35.648, 5, 8),
    ("R3-1", "Role 3 Zaporizhzhia", "role3", 47.820, 35.180, 12, 20),
]
# id, type, lat, lon, litter_capacity, ambulatory_capacity, range_km, battery_pct, max_threat
# UGVs wait at HP-1 and ambulances at R1-A, offset ~20 m so the markers do not overlap
VEHICLES = [
    ("UGV-1", "ugv", 47.5002, 35.812, 1, 0, 25.0, 90.0, 0.8),
    ("UGV-2", "ugv", 47.4998, 35.812, 1, 0, 25.0, 75.0, 0.8),
    ("AMB-1", "ambulance", 47.5602, 35.790, 4, 2, 300.0, 100.0, 0.4),
    ("AMB-2", "ambulance", 47.5598, 35.790, 4, 2, 300.0, 100.0, 0.4),
]
# id, lat, lon, time_of_injury, triage_category, mobility. All on the near side of the front line (47.436)
CASUALTIES = [
    ("CAS-1", 47.4430, 35.8335, "2023-09-12T04:10:00Z", "T1", "litter"),
    ("CAS-2", 47.4400, 35.8100, "2023-09-12T04:25:00Z", "T2", "ambulatory"),
    ("CAS-3", 47.4385, 35.8600, "2023-09-12T04:40:00Z", "T1", "litter"),
    ("CAS-4", 47.4415, 35.8250, "2023-09-12T04:52:00Z", "T3", "ambulatory"),
    ("CAS-5", 47.4395, 35.8450, "2023-09-12T05:05:00Z", "T2", "litter"),
]
# id, type, level, active, lat, lon: on the main road between HP-1 and R1-A; starts inactive
THREAT = ("THR-1", "fpv_drone", 0.7, False, 47.530, 35.800)


def var(entity_id: str) -> str:
    return "e_" + entity_id.replace("-", "_")


def snap(client: TuringDB, lat: float, lon: float) -> tuple[int, float]:
    """Native id of the junction nearest to (lat, lon) and its distance in metres."""
    df = client.query(
        f"MATCH (j:Junction) RETURN id(j) AS nid, j.lat AS lat, j.lon AS lon, "
        f"(j.lat - {lat}) * (j.lat - {lat}) + (j.lon - {lon}) * (j.lon - {lon}) * {COS2_LAT} AS d "
        f"ORDER BY d LIMIT 1"
    )
    r = df.iloc[0]
    return int(r["nid"]), haversine_m((lat, lon), (float(r["lat"]), float(r["lon"])))


def create_statement() -> str:
    parts = []
    for eid, name, typ, lat, lon, medics, beds in MEDICAL_POINTS:
        parts.append(
            f"({var(eid)}:MedicalPoint "
            + props(id=lit(eid), name=lit(name), lat=lat, lon=lon, type=lit(typ), capabilities=lit(CAPS[typ]),
                    medics_available=medics, state=lit("operational"), free_beds=beds)
            + ")"
        )
    for eid, typ, lat, lon, litter, amb, rng, batt, max_threat in VEHICLES:
        parts.append(
            f"({var(eid)}:Vehicle "
            + props(id=lit(eid), type=lit(typ), lat=lat, lon=lon, litter_capacity=litter, ambulatory_capacity=amb,
                    range_km=rng, battery_pct=batt, max_threat=max_threat, status=lit("idle"))
            + ")"
        )
    for eid, lat, lon, toi, triage, mobility in CASUALTIES:
        parts.append(
            f"({var(eid)}:Casualty "
            + props(id=lit(eid), lat=lat, lon=lon, time_of_injury=f"datetime({lit(toi)})",
                    status=lit("awaiting_pickup"), triage_category=lit(triage), mobility=lit(mobility))
            + ")"
        )
    tid, ttype, level, active, _, _ = THREAT
    parts.append(f"({var(tid)}:Threat " + props(id=lit(tid), type=lit(ttype), level=level, active=active) + ")")
    return "CREATE " + ",\n       ".join(parts)


def main() -> None:
    client = TuringDB(host="http://localhost:6666")
    client.set_graph(GRAPH)
    if int(client.query("MATCH (c:Casualty) RETURN count(c)").iloc[0, 0]) > 0:
        sys.exit(f"graph '{GRAPH}' already has scenario entities; refusing to create duplicates")

    # (entity id, lat, lon, edge type) for everything that attaches to a junction
    attach = (
        [(e[0], e[3], e[4], "NEAR") for e in MEDICAL_POINTS]
        + [(e[0], e[2], e[3], "NEAR") for e in VEHICLES]
        + [(e[0], e[1], e[2], "NEAR") for e in CASUALTIES]
        + [(THREAT[0], THREAT[4], THREAT[5], "AFFECTS")]
    )
    snapped = {eid: snap(client, lat, lon) for eid, lat, lon, _ in attach}

    client.new_change()
    try:
        client.query(create_statement())
        client.query("COMMIT")  # new nodes are invisible to the next queries until committed
        ids = client.query(
            "MATCH (n) WHERE n:MedicalPoint OR n:Vehicle OR n:Casualty OR n:Threat RETURN id(n) AS nid, n.id AS eid"
        )
        native = dict(zip(ids["eid"], (int(n) for n in ids["nid"])))
        for eid, _, _, rel in attach:
            junction, dist = snapped[eid]
            edge_props = f" {props(distance_m=dist)}" if rel == "NEAR" else ""
            client.query(
                f"MATCH (a) WHERE a = {native[eid]} MATCH (b) WHERE b = {junction} "
                f"CREATE (a)-[:{rel}{edge_props}]->(b)"
            )
        client.query("CHANGE SUBMIT")
    except Exception:
        client.query("CHANGE DELETE")
        raise
    finally:
        client.checkout()

    print(client.query("MATCH (n) WHERE NOT n:Junction RETURN labels(n) AS label, count(*) AS n ORDER BY n DESC"))
    far = [(eid, round(d)) for eid, (_, d) in snapped.items() if d > 300]
    print("entities more than 300 m from the nearest junction:", far or "none")


if __name__ == "__main__":
    main()
