"""Download the Orikhiv-Robotyne-Zaporizhzhia road network from Overpass to data/osm/roads.json.

The area is too large for a single Overpass request, so it is fetched as a grid of tiles.
Each tile is cached in data/osm/tiles/, so a re-run only fetches the missing ones, then all
cached tiles are merged (ways that cross a tile edge are returned whole and de-duplicated here).
"""
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# (south, west, north, east)
FULL_BBOX = (47.40, 35.00, 47.90, 35.95)
# Minor roads and tracks only near the front and Orikhiv; elsewhere they overload Overpass
FRONT_BBOX = (47.40, 35.60, 47.62, 35.95)
LAT_STEPS, LON_STEPS = 5, 5
MAJOR = "trunk|primary|secondary|tertiary|unclassified"
MINOR = "residential|track|service"
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
ATTEMPTS_PER_TILE = 6
PAUSE_BETWEEN_TILES_S = 3
OSM_DIR = Path(__file__).resolve().parent.parent / "data" / "osm"
TILE_DIR = OSM_DIR / "tiles"
OUT = OSM_DIR / "roads.json"


def tiles():
    s, w, n, e = FULL_BBOX
    dlat, dlon = (n - s) / LAT_STEPS, (e - w) / LON_STEPS
    for i in range(LAT_STEPS):
        for j in range(LON_STEPS):
            yield (i, j), (
                round(s + i * dlat, 4),
                round(w + j * dlon, 4),
                round(s + (i + 1) * dlat, 4),
                round(w + (j + 1) * dlon, 4),
            )


def in_front(t: tuple[float, ...]) -> bool:
    return t[0] >= FRONT_BBOX[0] and t[1] >= FRONT_BBOX[1] and t[2] <= FRONT_BBOX[2] and t[3] <= FRONT_BBOX[3]


def query_for(t: tuple[float, ...]) -> str:
    classes = f"{MAJOR}|{MINOR}" if in_front(t) else MAJOR
    return (
        f'[out:json][timeout:120];way["highway"~"^({classes})$"]({",".join(map(str, t))});'
        "out body;>;out skel qt;"
    )


def post(url: str, query: str) -> dict:
    req = urllib.request.Request(
        url,
        data=("data=" + urllib.parse.quote(query)).encode(),
        method="POST",
        headers={
            "User-Agent": "edth-casevac-hackathon/0.1",
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    with urllib.request.urlopen(req, timeout=150) as resp:
        return json.load(resp)


def fetch_tile(t: tuple[float, ...]) -> list[dict] | None:
    query = query_for(t)
    for attempt in range(ATTEMPTS_PER_TILE):
        url = OVERPASS_URLS[attempt % len(OVERPASS_URLS)]
        try:
            return post(url, query)["elements"]
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            wait = 15 * (attempt + 1)
            print(f"    attempt {attempt + 1}/{ATTEMPTS_PER_TILE} failed ({e}); retrying in {wait}s", flush=True)
            time.sleep(wait)
    return None


def main() -> None:
    TILE_DIR.mkdir(parents=True, exist_ok=True)
    all_tiles = list(tiles())
    start = time.time()
    missing = []
    for k, ((i, j), t) in enumerate(all_tiles, 1):
        cache = TILE_DIR / f"tile_{i}_{j}.json"
        if cache.exists():
            print(f"[{k}/{len(all_tiles)}] tile {i},{j} cached", flush=True)
            continue
        print(f"[{k}/{len(all_tiles)}] tile {i},{j} {t} {'(+minor roads)' if in_front(t) else ''}", flush=True)
        elements = fetch_tile(t)
        if elements is None:
            print(f"    giving up on tile {i},{j} for now", flush=True)
            missing.append((i, j))
            continue
        cache.write_text(json.dumps(elements))
        print(f"    saved {len(elements)} elements; {time.time() - start:.0f}s elapsed", flush=True)
        time.sleep(PAUSE_BETWEEN_TILES_S)

    merged: dict[tuple[str, int], dict] = {}
    for f in sorted(TILE_DIR.glob("tile_*.json")):
        for el in json.loads(f.read_text()):
            merged[(el["type"], el["id"])] = el
    ways = sum(1 for key in merged if key[0] == "way")
    OUT.write_text(json.dumps({"elements": list(merged.values())}))
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.1f} MB): {ways} ways, {len(merged) - ways} nodes", flush=True)
    if missing:
        sys.exit(f"MISSING tiles {missing}: re-run this script to fetch them")


if __name__ == "__main__":
    main()
