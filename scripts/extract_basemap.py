"""Extract an offline vector basemap (GeoJSON) for the sector from a Geofabrik PBF.

Writes one file per layer into visualizer/public/basemap/ so the C2 map needs no internet:
water, rivers, forest, builtup, railways, places.

Usage: uv run python scripts/extract_basemap.py [path/to/file.osm.pbf]
"""
import json
import sys
import time
from pathlib import Path

import osmium

from fetch_osm import FULL_BBOX, OSM_DIR

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PBF = OSM_DIR / "ukraine-261002.osm.pbf"
OUT_DIR = ROOT / "visualizer" / "public" / "basemap"
NODE_INDEX = OSM_DIR / "basemap_node_index.bin"
PROGRESS_EVERY = 500_000
MIN_AREA_SPAN_DEG = 0.0004  # drop polygons smaller than ~40 m across
COORD_DECIMALS = 5  # ~1 m
PLACES = {"city", "town", "village", "hamlet"}
WATERWAYS = {"river", "canal"}


def in_bbox(lat: float, lon: float) -> bool:
    s, w, n, e = FULL_BBOX
    return s <= lat <= n and w <= lon <= e


def round_coords(c):
    if isinstance(c[0], (int, float)):
        return [round(c[0], COORD_DECIMALS), round(c[1], COORD_DECIMALS)]
    return [round_coords(x) for x in c]


def span(coords) -> float:
    pts = []

    def walk(c):
        if isinstance(c[0], (int, float)):
            pts.append(c)
        else:
            for x in c:
                walk(x)

    walk(coords)
    lons, lats = [p[0] for p in pts], [p[1] for p in pts]
    return max(max(lons) - min(lons), max(lats) - min(lats))


def area_layer(tags) -> str | None:
    if tags.get("natural") == "water" or tags.get("waterway") == "riverbank" or tags.get("landuse") == "reservoir":
        return "water"
    if tags.get("landuse") == "forest" or tags.get("natural") == "wood":
        return "forest"
    if tags.get("landuse") in ("residential", "industrial", "commercial"):
        return "builtup"
    return None


def main() -> None:
    pbf = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PBF
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"reading {pbf} ({pbf.stat().st_size / 1e6:.0f} MB)", flush=True)
    start = time.time()

    layers: dict[str, list[dict]] = {k: [] for k in ("water", "rivers", "forest", "builtup", "railways", "places")}
    geom = osmium.geom.GeoJSONFactory()
    seen = 0

    keys = ("natural", "landuse", "waterway", "railway", "place")
    fp = (
        osmium.FileProcessor(str(pbf), osmium.osm.NODE | osmium.osm.WAY | osmium.osm.AREA)
        .with_locations(f"sparse_file_array,{NODE_INDEX}")
        .with_areas(osmium.filter.KeyFilter("natural", "landuse", "waterway"))
        .with_filter(osmium.filter.KeyFilter(*keys))
    )
    for obj in fp:
        seen += 1
        if seen % PROGRESS_EVERY == 0:
            counts = {k: len(v) for k, v in layers.items()}
            print(f"  {seen} objects, kept {counts}, {time.time() - start:.0f}s", flush=True)
        tags = obj.tags

        if obj.is_node():
            if tags.get("place") in PLACES and "name" in tags and obj.location.valid() and in_bbox(obj.lat, obj.lon):
                layers["places"].append({
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [round(obj.lon, 5), round(obj.lat, 5)]},
                    "properties": {"name": tags["name"], "name_en": tags.get("name:en", ""), "place": tags["place"]},
                })
        elif obj.is_area():
            layer = area_layer(tags)
            if layer is None:
                continue
            try:
                if not any(in_bbox(n.lat, n.lon) for ring in obj.outer_rings() for n in ring if n.location.valid()):
                    continue
                g = json.loads(geom.create_multipolygon(obj))
            except (RuntimeError, osmium.InvalidLocationError):
                continue
            if span(g["coordinates"]) < MIN_AREA_SPAN_DEG:
                continue
            g["coordinates"] = round_coords(g["coordinates"])
            layers[layer].append({"type": "Feature", "geometry": g, "properties": {"name": tags.get("name", "")}})
        elif obj.is_way():
            if tags.get("waterway") in WATERWAYS:
                layer = "rivers"
            elif tags.get("railway") == "rail":
                layer = "railways"
            else:
                continue
            try:
                if not any(in_bbox(n.lat, n.lon) for n in obj.nodes if n.location.valid()):
                    continue
                g = json.loads(geom.create_linestring(obj))
            except (RuntimeError, osmium.InvalidLocationError):
                continue
            g["coordinates"] = round_coords(g["coordinates"])
            layers[layer].append({"type": "Feature", "geometry": g, "properties": {"name": tags.get("name", "")}})

    print(f"done scanning in {time.time() - start:.0f}s", flush=True)
    for name, feats in layers.items():
        f = OUT_DIR / f"{name}.geojson"
        f.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":")))
        print(f"wrote {f} ({f.stat().st_size / 1e6:.2f} MB, {len(feats)} features)", flush=True)
    NODE_INDEX.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
