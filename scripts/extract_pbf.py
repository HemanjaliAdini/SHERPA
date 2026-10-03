"""Extract the sector road network from a Geofabrik PBF into data/osm/roads.json.

Same output format and road-class / bounding-box rules as fetch_osm.py (Overpass JSON elements),
so build_roads.py reads either. A way is kept if any of its nodes lies inside the box; its
nodes are all kept, as Overpass does with `>`.

Usage: uv run python scripts/extract_pbf.py [path/to/file.osm.pbf]
"""
import json
import sys
import time
from pathlib import Path

import osmium

from fetch_osm import FRONT_BBOX, FULL_BBOX, MAJOR, MINOR, OSM_DIR, OUT

DEFAULT_PBF = OSM_DIR / "ukraine-261002.osm.pbf"
# Disk-backed node-location index: a country-sized PBF would need several GB of RAM in memory
NODE_INDEX = OSM_DIR / "node_index.bin"
MAJOR_SET, MINOR_SET = set(MAJOR.split("|")), set(MINOR.split("|"))
PROGRESS_EVERY = 250_000


def inside(bbox: tuple[float, ...], lat: float, lon: float) -> bool:
    s, w, n, e = bbox
    return s <= lat <= n and w <= lon <= e


def main() -> None:
    pbf = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PBF
    print(f"reading {pbf} ({pbf.stat().st_size / 1e6:.0f} MB)", flush=True)
    start = time.time()

    ways: list[dict] = []
    nodes: dict[int, tuple[float, float]] = {}
    seen = bad_locations = 0

    fp = (
        osmium.FileProcessor(str(pbf), osmium.osm.NODE | osmium.osm.WAY)
        .with_locations(f"sparse_file_array,{NODE_INDEX}")
        .with_filter(osmium.filter.KeyFilter("highway"))
    )
    for obj in fp:
        if not obj.is_way():
            continue
        seen += 1
        if seen % PROGRESS_EVERY == 0:
            print(f"  {seen} highway ways scanned, {len(ways)} kept, {time.time() - start:.0f}s", flush=True)
        hw = obj.tags["highway"]
        if hw not in MAJOR_SET and hw not in MINOR_SET:
            continue
        pts = []
        for n in obj.nodes:
            if n.location.valid():
                pts.append((n.ref, n.lat, n.lon))
            else:
                bad_locations += 1
        if not pts:
            continue
        if not any(inside(FULL_BBOX, la, lo) for _, la, lo in pts):
            continue
        if hw in MINOR_SET and not any(inside(FRONT_BBOX, la, lo) for _, la, lo in pts):
            continue
        if len(pts) != len(obj.nodes):
            continue  # incomplete geometry; skip rather than emit a broken way
        ways.append({"type": "way", "id": obj.id, "nodes": [r for r, _, _ in pts], "tags": dict(obj.tags)})
        for ref, la, lo in pts:
            nodes[ref] = (la, lo)

    print(f"done scanning in {time.time() - start:.0f}s: {len(ways)} ways, {len(nodes)} nodes, "
          f"{bad_locations} node refs without location", flush=True)
    elements = ways + [{"type": "node", "id": i, "lat": la, "lon": lo} for i, (la, lo) in nodes.items()]
    OUT.write_text(json.dumps({"elements": elements}))
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.1f} MB)", flush=True)
    NODE_INDEX.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
