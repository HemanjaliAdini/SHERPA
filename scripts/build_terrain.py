"""Build the offline terrain image for the 3D C2 view from the Copernicus 30 m elevation model.

Crops the DEM tile to the sector, downsamples it, and writes it as a Terrain-RGB PNG
(height = R * 6553.6 + G * 25.6 + B * 0.1 - 10000 metres) plus a JSON sidecar with its bounds,
into visualizer/public/terrain/, which the app serves without internet.

The 40 MB source tile is downloaded into data/elevation/ (git-ignored) if it is not there yet.
Usage: uv run python scripts/build_terrain.py
"""
import json
import urllib.request
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.windows import from_bounds

from fetch_osm import FULL_BBOX

ROOT = Path(__file__).resolve().parent.parent
TILE = "Copernicus_DSM_COG_10_N47_00_E035_00_DEM"
SRC = ROOT / "data" / "elevation" / f"{TILE}.tif"
SOURCE_URL = f"https://copernicus-dem-30m.s3.amazonaws.com/{TILE}/{TILE}.tif"
OUT_DIR = ROOT / "visualizer" / "public" / "terrain"
DOWNSAMPLE = 2  # 1 arc-second (~30 m) -> ~60 m cells: plenty for a flyby, small enough to ship
ATTRIBUTION = (
    "Copernicus DEM GLO-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH "
    "2014-2018, provided under COPERNICUS by the European Union and ESA"
)


def to_terrain_rgb(height_m: np.ndarray) -> np.ndarray:
    value = np.round((height_m + 10000.0) * 10.0).astype(np.uint32)
    rgb = np.stack([(value >> 16) & 255, (value >> 8) & 255, value & 255], axis=-1)
    return rgb.astype(np.uint8)


def download_tile() -> None:
    """Fetch the DEM tile; written to a .part file first so an interrupted download is never used."""
    SRC.parent.mkdir(parents=True, exist_ok=True)
    part = SRC.with_suffix(".tif.part")
    print(f"downloading {SOURCE_URL}", flush=True)
    with urllib.request.urlopen(SOURCE_URL, timeout=120) as resp, open(part, "wb") as f:
        total = int(resp.headers.get("Content-Length", 0))
        done = 0
        while chunk := resp.read(1 << 22):
            f.write(chunk)
            done += len(chunk)
            print(f"  {done / 1e6:.0f} of {total / 1e6:.0f} MB", flush=True)
    part.rename(SRC)


def main() -> None:
    if not SRC.exists():
        download_tile()
    south, west, north, east = FULL_BBOX
    with rasterio.open(SRC) as dem:
        window = from_bounds(west, south, east, north, dem.transform).round_offsets().round_lengths()
        heights = dem.read(1, window=window).astype(np.float64)
        win_bounds = rasterio.windows.bounds(window, dem.transform)  # (west, south, east, north)

    # The DEM is a surface model with radar artefacts over water; nothing here is below sea level
    heights = np.maximum(heights, 0.0)

    rows, cols = heights.shape
    heights = heights[: rows - rows % DOWNSAMPLE, : cols - cols % DOWNSAMPLE]
    heights = heights.reshape(rows // DOWNSAMPLE, DOWNSAMPLE, cols // DOWNSAMPLE, DOWNSAMPLE).mean(axis=(1, 3))

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    png = OUT_DIR / "elevation.png"
    Image.fromarray(to_terrain_rgb(heights), "RGB").save(png, optimize=True)
    meta = {
        "bounds": [round(b, 6) for b in win_bounds],
        "width": int(heights.shape[1]),
        "height": int(heights.shape[0]),
        "min_m": round(float(heights.min()), 1),
        "max_m": round(float(heights.max()), 1),
        "decoder": {"rScaler": 6553.6, "gScaler": 25.6, "bScaler": 0.1, "offset": -10000},
        "source": SOURCE_URL,
        "attribution": ATTRIBUTION,
    }
    (OUT_DIR / "elevation.json").write_text(json.dumps(meta, indent=2))
    print(f"wrote {png} ({png.stat().st_size / 1e6:.2f} MB, {meta['width']}x{meta['height']} cells)")
    print(f"bounds {meta['bounds']}, elevation {meta['min_m']} to {meta['max_m']} m")


if __name__ == "__main__":
    main()
