import L from 'leaflet'

import {
  FACILITY_COLOR,
  FALLBACK_COLOR,
  THREAT_MARKER_COLOR,
  TRIAGE_COLOR,
  VEHICLE_COLOR,
} from './colors'
import type { Entity } from './entity-data'

export type Shape = 'circle' | 'square' | 'triangle' | 'diamond'

const SIZE = 18

const SHAPES: Record<Shape, (fill: string, stroke: string) => string> = {
  circle: (f, s) => `<circle cx="9" cy="9" r="6" fill="${f}" stroke="${s}" stroke-width="2"/>`,
  square: (f, s) =>
    `<rect x="3" y="3" width="12" height="12" fill="${f}" stroke="${s}" stroke-width="2"/>`,
  triangle: (f, s) =>
    `<polygon points="9,2 16,15 2,15" fill="${f}" stroke="${s}" stroke-width="2" stroke-linejoin="round"/>`,
  diamond: (f, s) =>
    `<polygon points="9,1 17,9 9,17 1,9" fill="${f}" stroke="${s}" stroke-width="2" stroke-linejoin="round"/>`,
}

export const shapeSvg = (shape: Shape, fill: string, stroke = '#0b1118', size = SIZE) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">${SHAPES[shape](fill, stroke)}</svg>`

export function entityStyle(e: Entity): { shape: Shape; color: string; stroke: string } {
  switch (e.kind) {
    case 'casualty':
      return { shape: 'circle', color: TRIAGE_COLOR[e.type] ?? FALLBACK_COLOR, stroke: '#ffffff' }
    case 'facility':
      return { shape: 'square', color: FACILITY_COLOR[e.type] ?? FALLBACK_COLOR, stroke: '#0b1118' }
    case 'vehicle':
      return {
        shape: 'triangle',
        color: VEHICLE_COLOR[e.type] ?? FALLBACK_COLOR,
        stroke: '#0b1118',
      }
    case 'threat':
      return { shape: 'diamond', color: THREAT_MARKER_COLOR, stroke: '#ffffff' }
  }
}

export function entityMarker(e: Entity): L.Marker {
  const { shape, color, stroke } = entityStyle(e)
  const icon = L.divIcon({
    html: shapeSvg(shape, color, stroke),
    className: 'c2-entity-icon',
    iconSize: [SIZE, SIZE],
    iconAnchor: [SIZE / 2, SIZE / 2],
  })
  return L.marker([e.lat, e.lon], { icon, keyboard: false }).bindTooltip(
    `<b>${e.id}</b><br/>${e.detail}`,
    { direction: 'top', offset: [0, -8], className: 'c2-entity-tooltip' }
  )
}
