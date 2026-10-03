// Reads ground height at any point from the offline Terrain-RGB image, so clickable layers can be
// placed on the terrain themselves (deck.gl cannot pick layers lifted by the terrain extension).

export type TerrainMeta = {
  /** [west, south, east, north] in degrees */
  bounds: [number, number, number, number]
  decoder: { rScaler: number; gScaler: number; bScaler: number; offset: number }
  attribution: string
}

/** Height in metres at a point; 0 outside the terrain image. */
export type HeightAt = (lon: number, lat: number) => number

export const TERRAIN_IMAGE = '/terrain/elevation.png'

export const loadTerrainMeta = (): Promise<TerrainMeta> =>
  fetch('/terrain/elevation.json').then((r) => r.json())

export async function loadHeightSampler(meta: TerrainMeta): Promise<HeightAt> {
  // fetch + createImageBitmap, not <img>.decode(): decode() can wait for a paint, which an idle
  // page may not do, leaving the 3D view without terrain until the camera first moves
  const blob = await (await fetch(TERRAIN_IMAGE)).blob()
  const image = await createImageBitmap(blob)
  const { width, height } = image
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return () => 0
  ctx.drawImage(image, 0, 0)
  const px = ctx.getImageData(0, 0, width, height).data
  const [west, south, east, north] = meta.bounds
  const { rScaler, gScaler, bScaler, offset } = meta.decoder

  return (lon, lat) => {
    const col = Math.floor(((lon - west) / (east - west)) * width)
    const row = Math.floor(((north - lat) / (north - south)) * height)
    if (col < 0 || row < 0 || col >= width || row >= height) return 0
    const i = (row * width + col) * 4
    return px[i] * rScaler + px[i + 1] * gScaler + px[i + 2] * bScaler + offset
  }
}
