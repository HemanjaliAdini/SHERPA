"""Download the Orikhiv-Robotyne-Zaporizhzhia road network from Overpass to data/osm/roads.json.

The area is too large for a single Overpass request, so it is fetched as a grid of tiles
and merged (ways that cross a tile edge are returned whole by Overpass and de-duplicated here).
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
ATTEMPTS_PER_TILE = 4
OUT = Path(__file__).resolve().parent.parent / "data" / "osm" / "roads.json"


def tiles():
    s, w, n, e = FULL_BBOX
    dlat, dlon = (n - s) / LAT_STEPS, (e - w) / LON_STEPS
    for i in range(LAT_STEPS):
        for j in range(LON_STEPS):
            yield (
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


def fetch_tile(t: tuple[float, ...]) -> list[dict]:
    query = query_for(t)
    for attempt in range(ATTEMPTS_PER_TILE):
        url = OVERPASS_URLS[attempt % len(OVERPASS_URLS)]
        try:
            return post(url, query)["elements"]
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            wait = 5 * (attempt + 1)
            print(f"    attempt {attempt + 1} failed ({e}); retrying in {wait}s", flush=True)
            time.sleep(wait)
    raise RuntimeError(f"tile {t} failed after {ATTEMPTS_PER_TILE} attempts")


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    all_tiles = list(tiles())
    elements: dict[tuple[str, int], dict] = {}
    start = time.time()
    for k, t in enumerate(all_tiles, 1):
        print(f"[{k}/{len(all_tiles)}] tile {t} {'(+minor roads)' if in_front(t) else ''}", flush=True)
        for el in fetch_tile(t):
            elements[(el["type"], el["id"])] = el
        ways = sum(1 for key in elements if key[0] == "way")
        elapsed = time.time() - start
        eta = elapsed / k * (len(all_tiles) - k)
        print(f"    total {ways} ways, {len(elements) - ways} nodes; {elapsed:.0f}s elapsed, ~{eta:.0f}s left", flush=True)
    with open(OUT, "w") as f:
        json.dump({"elements": list(elements.values())}, f)
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.1f} MB)", flush=True)


if __name__ == "__main__":
    sys.exit(main())
