// Map framing shared by the 2D and 3D views. [west, south], [east, north] in degrees.

/** Whole road network, Robotyne front to Zaporizhzhia: the limit of panning */
export const SECTOR_BOUNDS: [[number, number], [number, number]] = [
  [35.0, 47.4],
  [35.95, 47.9],
]

/** Where the work is: front line, collection and handover points, Orikhiv, Role 2. Home view. */
export const HOME_BOUNDS: [[number, number], [number, number]] = [
  [35.62, 47.42],
  [35.93, 47.64],
]

/** Screen space kept clear of the floating controls when framing the home view */
export const HOME_PADDING = { top: 70, left: 40, bottom: 40, right: 220 }
