// Colours for the C2 map. Basemap is deliberately muted so threats and routes stand out.
export const MAP_BG = '#0b1118'

export const BASEMAP_STYLE = {
  water: { color: '#1d4468', weight: 0.5, fillColor: '#16324a', fillOpacity: 0.9 },
  forest: { color: '#1b3a2a', weight: 0.5, fillColor: '#12261c', fillOpacity: 0.8 },
  builtup: { color: '#3a4152', weight: 0.5, fillColor: '#262b36', fillOpacity: 0.9 },
  rivers: { color: '#2f6a99', weight: 1.2, opacity: 0.9 },
  railways: { color: '#6b7280', weight: 1, opacity: 0.8, dashArray: '4 4' },
} as const

export const ROAD_BASE_COLOR = '#5b6f86'
// Roads changed by an event (scripts/events.py): bright, so a closure or a blockage is seen as it happens
export const ROAD_CLOSED_COLOR = '#f43f5e'
export const ROAD_DELAYED_COLOR = '#fb923c'
export const EVENT_COLOR = '#f43f5e'

// Threat level 0..1 on a slate -> amber -> red ramp
const THREAT_STOPS: [number, [number, number, number]][] = [
  [0, [91, 111, 134]],
  [0.5, [240, 170, 40]],
  [1, [225, 50, 50]],
]

export function threatColor(level: number): string {
  const t = Math.min(1, Math.max(0, level))
  for (let i = 1; i < THREAT_STOPS.length; i++) {
    const [t1, c1] = THREAT_STOPS[i]
    const [t0, c0] = THREAT_STOPS[i - 1]
    if (t <= t1) {
      const f = (t - t0) / (t1 - t0)
      const [r, g, b] = c0.map((v, k) => Math.round(v + (c1[k] - v) * f))
      return `rgb(${r}, ${g}, ${b})`
    }
  }
  return 'rgb(225, 50, 50)'
}

const ROAD_WEIGHT: Record<string, number> = {
  trunk: 3.5,
  primary: 3,
  secondary: 2.5,
  tertiary: 2,
  unclassified: 1.5,
  residential: 1.2,
  service: 1,
  track: 1,
  connector: 1,
}

export const roadWeight = (highway: string) => ROAD_WEIGHT[highway] ?? 1.2

type RoadLook = { closed: boolean; delay: number; threat: number; highway: string }

/** A road's colour: closed or slowed by an event first, then its threat level */
export function roadColor(e: RoadLook): string {
  if (e.closed) return ROAD_CLOSED_COLOR
  if (e.delay > 1) return ROAD_DELAYED_COLOR
  return e.threat > 0 ? threatColor(e.threat) : ROAD_BASE_COLOR
}

/** Roads changed by an event are drawn wider than their class */
export const roadWidth = (e: RoadLook) =>
  roadWeight(e.highway) + (e.closed ? 2.5 : e.delay > 1 ? 1.5 : 0)

// Entity colours: casualties by triage category, facilities by role, vehicles by kind
export const TRIAGE_COLOR: Record<string, string> = {
  T1: '#ef4444',
  T2: '#f59e0b',
  T3: '#22c55e',
  T4: '#9ca3af',
}
export const FACILITY_COLOR: Record<string, string> = {
  ccp: '#2dd4bf',
  handover: '#c084fc',
  role1: '#38bdf8',
  role2_basic: '#3b82f6',
  role3: '#6366f1',
}
export const FACILITY_LABEL: Record<string, string> = {
  ccp: 'Collection point',
  handover: 'Handover point',
  role1: 'Role 1',
  role2_basic: 'Role 2 Basic',
  role3: 'Role 3',
}
// 'disabled': stopped by an event (a flat battery), left where it stopped
export const VEHICLE_COLOR: Record<string, string> = {
  ugv: '#f59e0b',
  ambulance: '#e5e7eb',
  disabled: '#4b5563',
}
export const THREAT_MARKER_COLOR = '#fb7185'
export const FALLBACK_COLOR = '#9ca3af'

// Graph styling: node colour by label (refined by type/triage), edge style by relationship type
export const JUNCTION_COLOR = '#7f93aa'
export const LABEL_COLOR: Record<string, string> = {
  Junction: JUNCTION_COLOR,
  Casualty: TRIAGE_COLOR.T1,
  MedicalPoint: FACILITY_COLOR.role1,
  Vehicle: VEHICLE_COLOR.ugv,
  Threat: THREAT_MARKER_COLOR,
  Mission: '#c084fc',
  Event: EVENT_COLOR,
}

export function nodeColor(label: string, kind: string): string {
  if (label === 'Casualty') return TRIAGE_COLOR[kind] ?? FALLBACK_COLOR
  if (label === 'MedicalPoint') return FACILITY_COLOR[kind] ?? FALLBACK_COLOR
  if (label === 'Vehicle') return VEHICLE_COLOR[kind] ?? FALLBACK_COLOR
  return LABEL_COLOR[label] ?? FALLBACK_COLOR
}

export type EdgeStyle = { color: string; weight: number; dashArray?: string }
export const EDGE_STYLE: Record<string, EdgeStyle> = {
  NEAR: { color: '#e2e8f0', weight: 2.5, dashArray: '4 4' },
  AFFECTS: { color: THREAT_MARKER_COLOR, weight: 3, dashArray: '6 4' },
}
const MISSION_COLOR = '#c084fc'
for (const t of ['USES', 'PICKS_UP', 'DELIVERS_TO', 'CREATED']) {
  EDGE_STYLE[t] = { color: MISSION_COLOR, weight: 2, dashArray: '6 4' }
}
// A mission's planned route, drawn through its ROUTE_STEP junctions in order
export const MISSION_ROUTE_STYLE = { color: MISSION_COLOR, weight: 6, opacity: 0.8 }
// Selected / query-result edges
export const HIGHLIGHT_COLOR = '#fde047'
// Any other relationship (e.g. mission edges added later) is still drawn, just in this colour
export const OTHER_EDGE_STYLE: EdgeStyle = { color: '#c084fc', weight: 2 }
