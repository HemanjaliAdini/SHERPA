import { executeCypherQuery } from '@/api'
import { rowsOf } from './selection'

export type Casualty = {
  nid: number
  id: string
  triage: string
  mobility: string
  status: string
  injuredAt: Date | null
  /** junction the casualty is NEAR, and how far off the road network it is */
  junction: number | null
  offRoadMetres: number | null
}

export type Vehicle = {
  nid: number
  id: string
  type: string
  status: string
  litterCapacity: number
  ambulatoryCapacity: number
  rangeKm: number
  batteryPct: number
  maxThreat: number
  junction: number | null
}

export type Facility = {
  nid: number
  id: string
  name: string
  type: string
  state: string
  freeBeds: number
  medics: number
  capabilities: string[]
  junction: number | null
}

export type Scenario = { casualties: Casualty[]; vehicles: Vehicle[]; facilities: Facility[] }

// An OPTIONAL MATCH that finds nothing returns UINT64_MAX for a bare node, not null
const nodeId = (v: unknown) => {
  const n = Number(v)
  return v === null || v === undefined || n > Number.MAX_SAFE_INTEGER ? null : n
}
const num = (v: unknown, fallback = 0) => (v === null || v === undefined ? fallback : Number(v))
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v))

const CASUALTIES =
  'MATCH (c:Casualty) OPTIONAL MATCH (c)-[n:NEAR]->(j) RETURN c, c.id, c.triage_category, ' +
  'c.mobility, c.status, c.time_of_injury, n.distance_m, j'
const VEHICLES =
  'MATCH (v:Vehicle) OPTIONAL MATCH (v)-[:NEAR]->(j) RETURN v, v.id, v.type, v.status, ' +
  'v.litter_capacity, v.ambulatory_capacity, v.range_km, v.battery_pct, v.max_threat, j'
const FACILITIES =
  'MATCH (m:MedicalPoint) OPTIONAL MATCH (m)-[:NEAR]->(j) RETURN m, m.id, m.name, m.type, ' +
  'm.state, m.free_beds, m.medics_available, m.capabilities, j'

export async function fetchScenario(graph: string, change?: string): Promise<Scenario> {
  const [c, v, f] = await Promise.all(
    [CASUALTIES, VEHICLES, FACILITIES].map((query) => executeCypherQuery({ graph, change, query }))
  )
  return {
    casualties: rowsOf(c).map((r) => ({
      nid: Number(r[0]),
      id: str(r[1]),
      triage: str(r[2]),
      mobility: str(r[3]),
      status: str(r[4]),
      injuredAt: r[5] ? new Date(String(r[5])) : null,
      offRoadMetres: r[6] === null || r[6] === undefined ? null : Number(r[6]),
      junction: nodeId(r[7]),
    })),
    vehicles: rowsOf(v).map((r) => ({
      nid: Number(r[0]),
      id: str(r[1]),
      type: str(r[2]),
      status: str(r[3]),
      litterCapacity: num(r[4]),
      ambulatoryCapacity: num(r[5]),
      rangeKm: num(r[6]),
      batteryPct: num(r[7], 100),
      maxThreat: num(r[8], 1),
      junction: nodeId(r[9]),
    })),
    facilities: rowsOf(f).map((r) => ({
      nid: Number(r[0]),
      id: str(r[1]),
      name: str(r[2]),
      type: str(r[3]),
      state: str(r[4]),
      freeBeds: num(r[5]),
      medics: num(r[6]),
      capabilities: Array.isArray(r[7]) ? (r[7] as string[]) : [],
      junction: nodeId(r[8]),
    })),
  }
}

const TRIAGE_ORDER: Record<string, number> = { T1: 0, T2: 1, T3: 2, T4: 3 }

/** Casualties still needing evacuation: most urgent first, then longest waiting first. */
export function activeQueue(casualties: Casualty[]): Casualty[] {
  return casualties
    .filter((c) => c.status !== 'delivered')
    .sort(
      (a, b) =>
        (TRIAGE_ORDER[a.triage] ?? 9) - (TRIAGE_ORDER[b.triage] ?? 9) ||
        (a.injuredAt?.getTime() ?? 0) - (b.injuredAt?.getTime() ?? 0)
    )
}

export function formatWait(from: Date | null, now: Date): string {
  if (!from) return 'unknown'
  const minutes = Math.max(0, Math.round((now.getTime() - from.getTime()) / 60000))
  const h = Math.floor(minutes / 60)
  return h > 0 ? `${h}h ${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`
}

export const formatClock = (d: Date | null) =>
  d
    ? `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`
    : '--:--'
