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
from cypher import lit, props

GRAPH = sys.argv[1] if len(sys.argv) > 1 else "evac2"
COS2_LAT = 0.456  # cos^2(47.5 deg): equirectangular squared-distance weight for longitude

CAPS = {
    "ccp": ["first_aid"],
    "handover": ["ugv_dock", "first_aid"],
    "role1": ["first_aid", "stabilisation"],
    "role2_basic": ["first_aid", "stabilisation", "surgery"],
    "role3": ["first_aid", "stabilisation", "surgery", "icu"],
}

# Positions sit on (or within ~200 m of) a junction of the real OSM road network, so every entity is reachable.
# id, name, type, lat, lon, medics_available, free_beds
MEDICAL_POINTS = [
    ("CCP-W", "Collection point West", "ccp", 47.4448, 35.7912, 1, 0),
    ("CCP-C", "Collection point Centre", "ccp", 47.455, 35.825, 1, 0),
    ("CCP-E", "Collection point East", "ccp", 47.4558, 35.8484, 1, 0),
    ("HP-1", "Handover point 1", "handover", 47.5050, 35.8132, 1, 0),
    ("HP-2", "Handover point 2", "handover", 47.5025, 35.8551, 1, 0),
    ("R1-A", "Role 1 Orikhiv", "role1", 47.560, 35.790, 3, 4),
    ("R1-B", "Role 1 alternate", "role1", 47.575, 35.760, 2, 6),
    ("R2B-1", "Role 2 Basic", "role2_basic", 47.6376, 35.6614, 5, 8),
    ("R3-1", "Role 3 Zaporizhzhia", "role3", 47.820, 35.180, 12, 20),
]
# id, type, lat, lon, litter_capacity, ambulatory_capacity, range_km, battery_pct, max_threat, speed_kmh
# UGVs wait at HP-1 and ambulances at R1-A, offset ~20 m so the markers do not overlap.
# speed_kmh is the vehicle's own current speed; a road's cap for the vehicle type can lower it (routing.py)
VEHICLES = [
    ("UGV-1", "ugv", 47.5052, 35.8132, 1, 0, 25.0, 90.0, 0.8, 20.0),
    ("UGV-2", "ugv", 47.5048, 35.8132, 1, 0, 25.0, 75.0, 0.8, 15.0),
    ("AMB-1", "ambulance", 47.5602, 35.790, 4, 2, 300.0, 100.0, 0.4, 80.0),
    ("AMB-2", "ambulance", 47.5598, 35.790, 4, 2, 300.0, 100.0, 0.4, 80.0),
]
# id, lat, lon, time_of_injury, then the MIST report the medic triages from: mechanism, injuries, signs, treatment.
# Casualties arrive untriaged (status reported); the medic sets triage_category and mobility on the C2 screen.
# ponytail: placeholder clinical texts, to be replaced by Noo / the triage parser. All behind the front line (47.436)
CASUALTIES = [
    ("CAS-1", 47.4430, 35.8335, "2023-09-12T04:10:00Z", "Artillery fragment",
     "Catastrophic bleed, left thigh", "HR 130, RR 28, responds to pain only", "Tourniquet 04:12"),
    ("CAS-2", 47.4381, 35.7986, "2023-09-12T04:25:00Z", "FPV drone blast",
     "Fragment wounds, right forearm", "HR 100, RR 18, alert, walking", "Pressure dressing"),
    ("CAS-3", 47.4440, 35.8485, "2023-09-12T04:40:00Z", "Anti-personnel mine",
     "Traumatic amputation, right foot; burns to legs", "HR 140, RR 30, confused", "Tourniquet, morphine 10 mg"),
    ("CAS-4", 47.4415, 35.8250, "2023-09-12T04:52:00Z", "Small arms fire",
     "Graze, left shoulder", "HR 90, RR 16, alert, walking", "Field dressing"),
    ("CAS-5", 47.4395, 35.8450, "2023-09-12T05:05:00Z", "Vehicle rollover",
     "Suspected pelvic fracture, cannot walk", "HR 115, RR 22, alert", "Pelvic binder"),
]
SCENARIO_START = "2023-09-12T05:30:00Z"  # Clock.now at seed and after a reset
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
    for eid, typ, lat, lon, litter, amb, rng, batt, max_threat, speed in VEHICLES:
        parts.append(
            f"({var(eid)}:Vehicle "
            + props(id=lit(eid), type=lit(typ), lat=lat, lon=lon, litter_capacity=litter, ambulatory_capacity=amb,
                    range_km=rng, battery_pct=batt, max_threat=max_threat, speed_kmh=speed, status=lit("idle"))
            + ")"
        )
    for eid, lat, lon, toi, mechanism, injuries, signs, treatment in CASUALTIES:
        parts.append(
            f"({var(eid)}:Casualty "
            + props(id=lit(eid), lat=lat, lon=lon, time_of_injury=f"datetime({lit(toi)})", status=lit("reported"),
                    mist_mechanism=lit(mechanism), mist_injuries=lit(injuries), mist_signs=lit(signs),
                    mist_treatment=lit(treatment))
            + ")"
        )
    # Simulator clock (written only by simulate.py) and controls (written only by the C2 screen)
    parts.append("(:Clock " + props(id=lit("CLOCK"), now=f"datetime({lit(SCENARIO_START)})") + ")")
    parts.append("(:SimControl " + props(id=lit("SIM"), running=lit(False), speed=1.0, reset=lit(False)) + ")")
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
