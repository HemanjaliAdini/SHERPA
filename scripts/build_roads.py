"""Build LOAD PARQUET inputs (nodes.parquet, edges.parquet) for the road network from data/osm/roads.json.

Junctions are OSM nodes shared by 2+ ways or at a way's end; each stretch of road between two
junctions becomes one ROAD edge per permitted direction. Only the largest connected component is kept.

Output goes to <turing-dir>/data/<OUT_DIR_NAME>/ so that `LOAD PARQUET '<OUT_DIR_NAME>' AS evac` can read it.
"""
import json
import math
import re
from collections import Counter
from pathlib import Path

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "osm" / "roads.json"
OUT_DIR_NAME = "evac_roads"
OUT = Path.home() / ".turing" / "data" / OUT_DIR_NAME

# Scenario assumptions (km/h), tunable. Ambulance speed by OSM highway class, UGV capped lower.
AMBULANCE_KMH = {
    "trunk": 80, "primary": 70, "secondary": 60, "tertiary": 50,
    "unclassified": 40, "residential": 30, "service": 20, "track": 25,
}
UNPAVED_AMBULANCE_CAP_KMH = 30
UGV_CAP_KMH = 25
UGV_UNPAVED_CAP_KMH = 18
UNPAVED = {"unpaved", "dirt", "ground", "gravel", "compacted", "sand", "grass", "mud", "earth", "fine_gravel", "dirt/sand"}
EARTH_RADIUS_M = 6_371_000


def haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    la1, lo1, la2, lo2 = map(math.radians, (*a, *b))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(h))


def parse_maxspeed(v: str | None) -> float | None:
    m = re.fullmatch(r"\s*(\d+)\s*(km/h)?\s*", v or "")
    return float(m.group(1)) if m else None


def direction(tags: dict) -> str:
    ow = tags.get("oneway")
    if ow in ("yes", "true", "1") or tags.get("junction") in ("roundabout", "circular"):
        return "fwd"
    if ow == "-1":
        return "rev"
    return "both"


def speeds(tags: dict) -> tuple[str, float, float]:
    hw = tags["highway"]
    surface = tags.get("surface") or ("unpaved" if hw == "track" else "paved")
    unpaved = surface in UNPAVED
    amb = parse_maxspeed(tags.get("maxspeed")) or AMBULANCE_KMH[hw]
    if unpaved:
        amb = min(amb, UNPAVED_AMBULANCE_CAP_KMH)
    ugv = min(amb, UGV_UNPAVED_CAP_KMH if unpaved else UGV_CAP_KMH)
    return surface, float(amb), float(ugv)


def main() -> None:
    print(f"reading {SRC}", flush=True)
    elements = json.load(open(SRC))["elements"]
    coords = {e["id"]: (e["lat"], e["lon"]) for e in elements if e["type"] == "node"}
    ways = [e for e in elements if e["type"] == "way" and e["tags"].get("highway") in AMBULANCE_KMH]
    complete = [w for w in ways if all(n in coords for n in w["nodes"])]
    print(f"{len(coords)} nodes, {len(ways)} ways ({len(ways) - len(complete)} dropped for missing nodes)", flush=True)

    use = Counter(n for w in complete for n in w["nodes"])

    # 1. split ways into junction-to-junction segments
    segments = []  # (src_osm, dst_osm, way_id, tags, [(lat, lon), ...])
    for w in complete:
        nodes = w["nodes"]
        cuts = [i for i, n in enumerate(nodes) if i in (0, len(nodes) - 1) or use[n] >= 2]
        for a, b in zip(cuts, cuts[1:]):
            seg = nodes[a : b + 1]
            if seg[0] == seg[-1]:
                continue
            segments.append((seg[0], seg[-1], w["id"], w["tags"], [coords[n] for n in seg]))
    print(f"{len(segments)} segments", flush=True)

    # 2. keep the largest connected component
    parent: dict[int, int] = {}

    def find(x: int) -> int:
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for s, d, *_ in segments:
        parent[find(s)] = find(d)
    sizes = Counter(find(n) for n in parent)
    keep_root = sizes.most_common(1)[0][0]
    print(f"{len(sizes)} components; keeping largest ({sizes[keep_root]} of {len(parent)} junctions)", flush=True)
    segments = [sg for sg in segments if find(sg[0]) == keep_root]

    # 3. nodes
    osm_ids = sorted({n for sg in segments for n in (sg[0], sg[1])})
    node_id = {osm: i for i, osm in enumerate(osm_ids)}
    nodes_df = pd.DataFrame(
        {
            "__id": pd.Series(range(len(osm_ids)), dtype="int64"),
            "__labels": [["Junction"]] * len(osm_ids),
            "id": [f"J{osm}" for osm in osm_ids],
            "lat": [coords[osm][0] for osm in osm_ids],
            "lon": [coords[osm][1] for osm in osm_ids],
        }
    )

    # 4. edges (one per permitted direction)
    rows = []
    for s, d, way_id, tags, pts in segments:
        length = sum(haversine_m(p, q) for p, q in zip(pts, pts[1:]))
        if length <= 0:
            continue
        surface, amb, ugv = speeds(tags)
        common = {
            "length_m": length,
            "surface": surface,
            "status": "open",
            "threat_level": 0.0,
            "speed_ugv_kmh": ugv,
            "speed_ambulance_kmh": amb,
            "highway": tags["highway"],
            "bridge": tags.get("bridge", "no") not in ("no", ""),
            "osm_way_id": way_id,
        }
        dirs = direction(tags)
        if dirs in ("fwd", "both"):
            rows.append({"src": s, "dst": d, "geometry": pts, **common})
        if dirs in ("rev", "both"):
            rows.append({"src": d, "dst": s, "geometry": pts[::-1], **common})

    edges_df = pd.DataFrame(
        {
            "__source": pd.Series([node_id[r["src"]] for r in rows], dtype="int64"),
            "__target": pd.Series([node_id[r["dst"]] for r in rows], dtype="int64"),
            "__type": "ROAD",
            "id": [f"R{i}" for i in range(len(rows))],
            "geometry": [";".join(f"{la:.6f},{lo:.6f}" for la, lo in r["geometry"]) for r in rows],
            **{
                k: [r[k] for r in rows]
                for k in (
                    "length_m", "surface", "status", "threat_level",
                    "speed_ugv_kmh", "speed_ambulance_kmh", "highway", "bridge",
                )
            },
            "osm_way_id": pd.Series([r["osm_way_id"] for r in rows], dtype="int64"),
        }
    )

    OUT.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.Table.from_pandas(nodes_df, preserve_index=False), OUT / "nodes.parquet")
    pq.write_table(pa.Table.from_pandas(edges_df, preserve_index=False), OUT / "edges.parquet")

    print(f"wrote {len(nodes_df)} junctions, {len(edges_df)} ROAD edges to {OUT}", flush=True)
    print(f"total directed length {edges_df.length_m.sum() / 1000:.0f} km; bridges: {int(edges_df.bridge.sum())} edges", flush=True)
    print(edges_df.highway.value_counts().to_string(), flush=True)


if __name__ == "__main__":
    main()
