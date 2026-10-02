"""Seed a small synthetic casualty-evacuation graph (no OSM) following the final schema.

Usage: uv run python scripts/seed_toy_graph.py [graph_name]   (default: toy)
There is no DROP GRAPH in TuringDB, so pick a new name to reseed.
"""
import sys

from turingdb import TuringDB

from build_roads import AMBULANCE_KMH, UGV_CAP_KMH, haversine_m

GRAPH = sys.argv[1] if len(sys.argv) > 1 else "toy"

# name -> (lat, lon). Junctions sit at the scenario's synthetic positions.
JUNCTIONS = {
    "INC": (47.445, 35.833),   # south edge of Robotyne, METHANE location
    "ROB": (47.450, 35.830),   # Robotyne centre
    "CCPW": (47.456, 35.795),
    "CCPC": (47.455, 35.825),
    "CCPE": (47.458, 35.865),
    "HP1": (47.500, 35.812),
    "HP2": (47.505, 35.860),
    "BRG": (47.530, 35.800),   # bridge on the main road, chokepoint
    "R1A": (47.560, 35.790),
    "R1B": (47.575, 35.760),
    "R2B": (47.624, 35.648),
    "MID": (47.720, 35.400),
    "R3": (47.820, 35.180),
}
# (a, b, highway, surface, bridge); each becomes a ROAD edge in both directions
ROADS = [
    ("INC", "ROB", "track", "unpaved", False),
    ("ROB", "CCPC", "track", "unpaved", False),
    ("CCPC", "CCPW", "track", "unpaved", False),
    ("CCPC", "CCPE", "track", "unpaved", False),
    ("CCPC", "HP1", "tertiary", "asphalt", False),
    ("CCPE", "HP2", "tertiary", "asphalt", False),
    ("HP1", "HP2", "unclassified", "asphalt", False),
    ("HP1", "BRG", "secondary", "asphalt", False),
    ("BRG", "R1A", "secondary", "asphalt", True),
    ("HP2", "R1B", "unclassified", "asphalt", False),
    ("R1B", "R1A", "unclassified", "asphalt", False),
    ("R1A", "R2B", "primary", "asphalt", False),
    ("R2B", "MID", "trunk", "asphalt", False),
    ("MID", "R3", "trunk", "asphalt", False),
]
CAPS = {
    "ccp": ["first_aid"],
    "handover": ["ugv_dock", "first_aid"],
    "role1": ["first_aid", "stabilisation"],
    "role2_basic": ["first_aid", "stabilisation", "surgery"],
    "role3": ["first_aid", "stabilisation", "surgery", "icu"],
}
# id, name, type, junction, medics_available, free_beds
MEDICAL_POINTS = [
    ("CCP-W", "Collection point West", "ccp", "CCPW", 1, 0),
    ("CCP-C", "Collection point Centre", "ccp", "CCPC", 1, 0),
    ("CCP-E", "Collection point East", "ccp", "CCPE", 1, 0),
    ("HP-1", "Handover point 1", "handover", "HP1", 1, 0),
    ("HP-2", "Handover point 2", "handover", "HP2", 1, 0),
    ("R1-A", "Role 1 Orikhiv", "role1", "R1A", 3, 4),
    ("R1-B", "Role 1 alternate", "role1", "R1B", 2, 6),
    ("R2B-1", "Role 2 Basic", "role2_basic", "R2B", 5, 8),
    ("R3-1", "Role 3 Zaporizhzhia", "role3", "R3", 12, 20),
]
# id, type, junction, litter, ambulatory, range_km, battery_pct, max_threat
VEHICLES = [
    ("UGV-1", "ugv", "HP1", 1, 0, 25.0, 90.0, 0.8),
    ("UGV-2", "ugv", "HP1", 1, 0, 25.0, 75.0, 0.8),
    ("AMB-1", "ambulance", "R1A", 4, 2, 300.0, 100.0, 0.4),
    ("AMB-2", "ambulance", "R1A", 4, 2, 300.0, 100.0, 0.4),
]
# id, lat, lon, time_of_injury, triage, mobility
CASUALTIES = [
    ("CAS-1", 47.4430, 35.8335, "2023-09-12T04:10:00Z", "T1", "litter"),
    ("CAS-2", 47.4400, 35.8100, "2023-09-12T04:25:00Z", "T2", "ambulatory"),
    ("CAS-3", 47.4380, 35.8600, "2023-09-12T04:40:00Z", "T1", "litter"),
]


def lit(v) -> str:
    """Cypher literal; TuringDB has no query parameters."""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, str):
        return "'" + v.replace("\\", "\\\\").replace("'", "\\'") + "'"
    if isinstance(v, list):
        return "[" + ", ".join(lit(x) for x in v) + "]"
    return repr(v)


def props(**kw) -> str:
    return "{" + ", ".join(f"{k}: {v}" for k, v in kw.items()) + "}"


def nearest_junction(lat: float, lon: float) -> tuple[str, float]:
    name = min(JUNCTIONS, key=lambda j: haversine_m((lat, lon), JUNCTIONS[j]))
    return name, haversine_m((lat, lon), JUNCTIONS[name])


def build_create() -> str:
    parts = []
    for j, (lat, lon) in JUNCTIONS.items():
        parts.append(f"({j}:Junction {props(id=lit('J-' + j), lat=lat, lon=lon)})")

    for k, (a, b, hw, surface, bridge) in enumerate(ROADS):
        length = haversine_m(JUNCTIONS[a], JUNCTIONS[b])
        amb = float(AMBULANCE_KMH[hw]) if surface == "asphalt" else 25.0
        ugv = float(min(amb, UGV_CAP_KMH)) if surface == "asphalt" else 18.0
        for d, (s, t) in enumerate([(a, b), (b, a)]):
            geom = f"{JUNCTIONS[s][0]:.6f},{JUNCTIONS[s][1]:.6f};{JUNCTIONS[t][0]:.6f},{JUNCTIONS[t][1]:.6f}"
            p = props(
                id=lit(f"R-{k}-{d}"), geometry=lit(geom), length_m=length, surface=lit(surface),
                status=lit("open"), threat_level=0.0, speed_ugv_kmh=ugv, speed_ambulance_kmh=amb,
                highway=lit(hw), bridge=lit(bridge),
            )
            parts.append(f"({s})-[:ROAD {p}]->({t})")

    def near(var: str, lat: float, lon: float) -> None:
        j, dist = nearest_junction(lat, lon)
        parts.append(f"({var})-[:NEAR {props(distance_m=dist)}]->({j})")

    for pid, name, typ, j, medics, beds in MEDICAL_POINTS:
        v = "mp_" + pid.replace("-", "_")
        lat, lon = JUNCTIONS[j]
        parts.append(
            f"({v}:MedicalPoint "
            + props(id=lit(pid), name=lit(name), lat=lat, lon=lon, type=lit(typ), capabilities=lit(CAPS[typ]),
                    medics_available=medics, state=lit("operational"), free_beds=beds)
            + ")"
        )
        near(v, lat, lon)

    for vid, typ, j, litter, amb, rng, batt, max_threat in VEHICLES:
        v = "v_" + vid.replace("-", "_")
        lat, lon = JUNCTIONS[j]
        parts.append(
            f"({v}:Vehicle "
            + props(id=lit(vid), type=lit(typ), lat=lat, lon=lon, litter_capacity=litter, ambulatory_capacity=amb,
                    range_km=rng, battery_pct=batt, max_threat=max_threat, status=lit("idle"))
            + ")"
        )
        near(v, lat, lon)

    for cid, lat, lon, toi, triage, mobility in CASUALTIES:
        v = "c_" + cid.replace("-", "_")
        parts.append(
            f"({v}:Casualty "
            + props(id=lit(cid), lat=lat, lon=lon, time_of_injury=f"datetime({lit(toi)})",
                    status=lit("awaiting_pickup"), triage_category=lit(triage), mobility=lit(mobility))
            + ")"
        )
        near(v, lat, lon)

    parts.append(f"(thr1:Threat {props(id=lit('THR-1'), type=lit('fpv_drone'), level=0.7, active=False)})")
    parts.append("(thr1)-[:AFFECTS]->(BRG)")

    # One planned mission: UGV-1 collects CAS-1 and delivers to HP-1 (also exercises `order` as a property name)
    parts.append(
        "(m1:Mission "
        + props(id=lit("M-1"), status=lit("planned"),
                created_at=f"datetime({lit('2023-09-12T04:15:00Z')})", eta=f"datetime({lit('2023-09-12T04:30:00Z')})")
        + ")"
    )
    return "CREATE " + ",\n       ".join(parts)


def main() -> None:
    client = TuringDB(host="http://localhost:6666")
    if GRAPH in client.list_available_graphs():
        sys.exit(f"graph '{GRAPH}' already exists and cannot be dropped; pass a different name")
    client.create_graph(GRAPH)
    client.set_graph(GRAPH)
    client.new_change()
    client.query(build_create())
    client.query("COMMIT")  # make the new nodes visible to the mission edges below
    client.query("MATCH (m:Mission {id: 'M-1'}), (hp:MedicalPoint {id: 'HP-1'}) CREATE (hp)-[:CREATED]->(m)")
    client.query("MATCH (m:Mission {id: 'M-1'}), (v:Vehicle {id: 'UGV-1'}) CREATE (m)-[:USES]->(v)")
    client.query(
        "MATCH (m:Mission {id: 'M-1'}), (c:Casualty {id: 'CAS-1'}) "
        "CREATE (m)-[:PICKS_UP {order: 1, status: 'pending', eta: datetime('2023-09-12T04:20:00Z')}]->(c)"
    )
    client.query("MATCH (m:Mission {id: 'M-1'}), (hp:MedicalPoint {id: 'HP-1'}) CREATE (m)-[:DELIVERS_TO]->(hp)")
    client.query("CHANGE SUBMIT")
    client.checkout()
    print(f"seeded graph '{GRAPH}'")


if __name__ == "__main__":
    main()
