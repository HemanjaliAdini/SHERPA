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
  /** MIST report the medic triages from */
  mist: { mechanism: string; injuries: string; signs: string; treatment: string }
  /** left on the road in a vehicle that stopped (events.battery_depleted): dispatched first */
  stranded: boolean
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
  speedKmh: number | null
  /** none, light or heavy; empty when the graph does not record it */
  damage: string
  /** id of the medical point the vehicle belongs to; empty when the graph does not record it */
  base: string
  /** set while a reserve vehicle is on its way: when and at which medical point it arrives */
  arrivesAt: Date | null
  arrivePoint: string
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
  equipment: string[]
  junction: number | null
}

export type RadioAssignment = {
  id: string; status: string; casualtyId: string; casualtyStatus: string
  casualtyLat: number; casualtyLon: number; vehicleId: string; vehicleLat: number; vehicleLon: number; destinationId: string
}
export type Scenario = { casualties: Casualty[]; vehicles: Vehicle[]; facilities: Facility[]; assignments?: RadioAssignment[] }

// An OPTIONAL MATCH that finds nothing returns UINT64_MAX for a bare node, not null
const nodeId = (v: unknown) => {
  const n = Number(v)
  return v === null || v === undefined || n > Number.MAX_SAFE_INTEGER ? null : n
}
const num = (v: unknown, fallback = 0) => (v === null || v === undefined ? fallback : Number(v))
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v))

const CASUALTIES =
  'MATCH (c:Casualty) OPTIONAL MATCH (c)-[n:NEAR]->(j) RETURN c, c.id, c.triage_category, ' +
  'c.mobility, c.status, c.time_of_injury, n.distance_m, j, c.mist_mechanism, c.mist_injuries, ' +
  'c.mist_signs, c.mist_treatment, c.stranded_by'
const VEHICLES =
  'MATCH (v:Vehicle) OPTIONAL MATCH (v)-[:NEAR]->(j) RETURN v, v.id, v.type, v.status, ' +
  'v.litter_capacity, v.ambulatory_capacity, v.range_km, v.battery_pct, v.max_threat, j, v.speed_kmh, v.damage, v.base, v.arrives_at, v.arrive_point'
const FACILITIES =
  'MATCH (m:MedicalPoint) OPTIONAL MATCH (m)-[:NEAR]->(j) RETURN m, m.id, m.name, m.type, ' +
  'm.state, m.free_beds, m.medics_available, m.capabilities, j, m.equipment'

// Read each radio assignment in one query; map node/edge fetches can straddle a simulator commit.
const ASSIGNMENTS =
  "MATCH (m:Mission)-[:PICKS_UP]->(c:Casualty) MATCH (m)-[:USES]->(v:Vehicle) " +
  "MATCH (m)-[:DELIVERS_TO]->(p:MedicalPoint) WHERE m.status = 'planned' OR m.status = 'active' " +
  "RETURN m.id, m.status, c.id, c.status, c.lat, c.lon, v.id, v.lat, v.lon, p.id"

export async function fetchScenario(graph: string, change?: string): Promise<Scenario> {
  const [c, v, f] = await Promise.all(
    [CASUALTIES, VEHICLES, FACILITIES].map((query) => executeCypherQuery({ graph, change, query }))
  )
  const assignmentData = await executeCypherQuery({ graph, change, query: ASSIGNMENTS })
  const assignments: RadioAssignment[] = rowsOf(assignmentData).map((r) => ({
    id: str(r[0]), status: str(r[1]), casualtyId: str(r[2]), casualtyStatus: str(r[3]),
    casualtyLat: num(r[4]), casualtyLon: num(r[5]), vehicleId: str(r[6]), vehicleLat: num(r[7]), vehicleLon: num(r[8]), destinationId: str(r[9]),
  }))
  return {
    assignments,
    casualties: rowsOf(c).map((r) => ({
      nid: Number(r[0]),
      id: str(r[1]),
      triage: str(r[2]),
      mobility: str(r[3]),
      status: assignments.find((mission) => mission.casualtyId === str(r[1]))?.casualtyStatus ?? str(r[4]),
      injuredAt: r[5] ? new Date(String(r[5])) : null,
      offRoadMetres: r[6] === null || r[6] === undefined ? null : Number(r[6]),
      junction: nodeId(r[7]),
      mist: { mechanism: str(r[8]), injuries: str(r[9]), signs: str(r[10]), treatment: str(r[11]) },
      stranded: Boolean(r[12]),
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
      speedKmh: r[10] === null || r[10] === undefined ? null : Number(r[10]),
      damage: str(r[11]),
      base: str(r[12]),
      arrivesAt: r[13] ? new Date(String(r[13])) : null,
      arrivePoint: str(r[14]),
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
      equipment: Array.isArray(r[9]) ? (r[9] as string[]) : [],
    })),
  }
}

// Untriaged reports first (the medic's work), then the stranded (dispatch takes them first, as in
// scripts/routing.py), then by category; the dead last
const TRIAGE_ORDER: Record<string, number> = { '': -2, T1: 0, T2: 1, T3: 2, T4: 3, DEAD: 4 }
const rank = (c: Casualty) => (c.triage && c.stranded ? -1 : (TRIAGE_ORDER[c.triage] ?? 9))

/** Casualties still needing evacuation: most urgent first, then longest waiting first. */
export function activeQueue(casualties: Casualty[]): Casualty[] {
  return casualties
    .filter((c) => c.status !== 'delivered')
    .sort(
      (a, b) => rank(a) - rank(b) || (a.injuredAt?.getTime() ?? 0) - (b.injuredAt?.getTime() ?? 0)
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
