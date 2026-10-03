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
export const ROAD_CLOSED_COLOR = '#3b2230'

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
export const VEHICLE_COLOR: Record<string, string> = { ugv: '#f59e0b', ambulance: '#e5e7eb' }
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
}

export function nodeColor(label: string, kind: string): string {
  if (label === 'Casualty') return TRIAGE_COLOR[kind] ?? FALLBACK_COLOR
  if (label === 'MedicalPoint') return FACILITY_COLOR[kind] ?? FALLBACK_COLOR
  if (label === 'Vehicle') return VEHICLE_COLOR[kind] ?? FALLBACK_COLOR
  return LABEL_COLOR[label] ?? FALLBACK_COLOR
}

export type EdgeStyle = { color: string; weight: number; dashArray?: string }
export const EDGE_STYLE: Record<string, EdgeStyle> = {
  NEAR: { color: '#9fb0c3', weight: 1.2, dashArray: '3 4' },
  AFFECTS: { color: THREAT_MARKER_COLOR, weight: 1.5, dashArray: '5 3' },
  // Not drawn edge by edge: a mission's ROUTE_STEPs are joined in order into one line
  ROUTE_STEP: { color: '#c084fc', weight: 4 },
}
// Any other relationship (e.g. mission edges added later) is still drawn, just in this colour
export const OTHER_EDGE_STYLE: EdgeStyle = { color: '#c084fc', weight: 2 }
