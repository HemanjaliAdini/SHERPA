// Mission planning against the graph: candidate vehicles and destinations ranked by road time,
// route legs via TuringDB's shortestPath, and capacity / range / threat checks.
// Routes are the shortest by road length; per-vehicle threat-weighted costs come later.
import { executeCypherQuery } from '@/api'
import type { GeoGraph } from './graph-data'
import type { Casualty, Facility, Vehicle } from './scenario-data'
import type { Selection } from './selection'

export type Leg = {
  from: string
  to: string
  /** junction ids along the leg, start to end */
  junctions: number[]
  /** drawn edge indices (into GeoGraph.edges) along the leg */
  edges: number[]
  metres: number
  minutes: number
  maxThreat: number
}

export type Check = { ok: boolean; label: string }

export type Plan = {
  vehicle: Vehicle
  casualties: Casualty[]
  facility: Facility
  legs: Leg[]
  metres: number
  minutes: number
  maxThreat: number
  checks: Check[]
  ok: boolean
}

export type Candidate<T> = { item: T; leg: Leg | null; blockers: string[] }

// Used when a road has no speed for this vehicle type
const FALLBACK_KMH = { ugv: 15, ambulance: 30 }
// Where each vehicle type is meant to take casualties, in order of preference: UGVs run to the
// handover point where a crewed ambulance takes over (a collection point is the fallback)
const DESTINATION_TYPES: Record<string, string[]> = {
  ugv: ['handover', 'ccp'],
  ambulance: ['role1', 'role2_basic', 'role3'],
}
const minutesOf = (c: Candidate<unknown>) => c.leg?.minutes ?? Number.POSITIVE_INFINITY

async function roadLeg(
  graph: GeoGraph,
  graphName: string,
  change: string | undefined,
  vehicle: { type: string; speedKmh: number | null },
  from: { label: string; junction: number },
  to: { label: string; junction: number }
): Promise<Leg | null> {
  const empty = { from: from.label, to: to.label, edges: [], metres: 0, minutes: 0, maxThreat: 0 }
  if (from.junction === to.junction) return { ...empty, junctions: [from.junction] }
  const data = await executeCypherQuery({
    graph: graphName,
    change,
    query: `MATCH (a) WHERE a = ${from.junction} MATCH (b) WHERE b = ${to.junction} shortestPath(a, b, length_m, dist, path) RETURN dist, path`,
  })
  const path = (data[0]?.[1] as unknown[][] | undefined)?.[0] as number[] | undefined
  if (!path) return null // no road connection (e.g. every route is closed)

  const leg: Leg = { ...empty, junctions: [], edges: [] }
  path.forEach((id, k) => {
    if (k % 2 === 0) {
      leg.junctions.push(Number(id))
      return
    }
    const i = graph.edgeIndex.get(Number(id))
    if (i === undefined) return
    const e = graph.edges[i]
    const metres = e.metres ?? 0
    // Same time as the simulator: the vehicle's own speed, capped by the road for its type, times the delay
    const cap =
      (vehicle.type === 'ugv' ? e.speedUgv : e.speedAmbulance) ??
      FALLBACK_KMH[vehicle.type as keyof typeof FALLBACK_KMH] ??
      20
    const kmh = Math.min(cap, vehicle.speedKmh ?? cap)
    leg.edges.push(i)
    leg.metres += metres
    leg.minutes += (metres / 1000 / (kmh / 60)) * e.delay
    leg.maxThreat = Math.max(leg.maxThreat, e.threat)
  })
  return leg
}

function capacityBlockers(v: Vehicle, casualties: Casualty[]): string[] {
  const litter = casualties.filter((c) => c.mobility === 'litter').length
  const seated = casualties.length - litter
  const spareLitter = v.litterCapacity - litter
  if (litter > v.litterCapacity) return [`needs ${litter} litter, has ${v.litterCapacity}`]
  // Seated casualties can use any free litter space
  if (seated > v.ambulatoryCapacity + spareLitter) {
    return [`needs ${casualties.length} places, has ${v.litterCapacity + v.ambulatoryCapacity}`]
  }
  return []
}

/** Effective range: UGVs are limited by battery charge. */
export const rangeKm = (v: Vehicle) =>
  v.type === 'ugv' ? (v.rangeKm * v.batteryPct) / 100 : v.rangeKm

export async function rankVehicles(
  graph: GeoGraph,
  graphName: string,
  change: string | undefined,
  vehicles: Vehicle[],
  casualties: Casualty[]
): Promise<Candidate<Vehicle>[]> {
  const first = casualties[0]
  const out = await Promise.all(
    vehicles.map(async (v) => {
      const blockers = [...capacityBlockers(v, casualties)]
      if (v.status !== 'idle') blockers.push(`status ${v.status}`)
      if (v.junction === null || first?.junction === null || !first) {
        return { item: v, leg: null, blockers: [...blockers, 'not on the road network'] }
      }
      const leg = await roadLeg(
        graph,
        graphName,
        change,
        v,
        { label: v.id, junction: v.junction },
        {
          label: first.id,
          junction: first.junction,
        }
      )
      if (!leg) blockers.push('no road route')
      return { item: v, leg, blockers }
    })
  )
  // Feasible first, then soonest there; equal times go to the vehicle with more range left
  return out.sort(
    (a, b) =>
      a.blockers.length - b.blockers.length ||
      Math.round(minutesOf(a)) - Math.round(minutesOf(b)) ||
      rangeKm(b.item) - rangeKm(a.item)
  )
}

export async function rankFacilities(
  graph: GeoGraph,
  graphName: string,
  change: string | undefined,
  vehicle: Vehicle,
  facilities: Facility[],
  casualties: Casualty[]
): Promise<Candidate<Facility>[]> {
  const last = casualties[casualties.length - 1]
  const allowed = DESTINATION_TYPES[vehicle.type] ?? []
  const candidates = facilities.filter((f) => allowed.includes(f.type))
  const out = await Promise.all(
    candidates.map(async (f) => {
      const blockers: string[] = []
      if (f.state !== 'operational') blockers.push(`state ${f.state}`)
      // Transfer points (handover, collection) pass casualties on; they do not need beds
      const needsBeds = !['handover', 'ccp'].includes(f.type)
      if (needsBeds && f.freeBeds < casualties.length) blockers.push(`${f.freeBeds} free beds`)
      if (f.junction === null || !last || last.junction === null) {
        return { item: f, leg: null, blockers: [...blockers, 'not on the road network'] }
      }
      const leg = await roadLeg(
        graph,
        graphName,
        change,
        vehicle,
        { label: last.id, junction: last.junction },
        {
          label: f.id,
          junction: f.junction,
        }
      )
      if (!leg) blockers.push('no road route')
      return { item: f, leg, blockers }
    })
  )
  // Feasible first, then the preferred kind of destination for this vehicle, then soonest there
  return out.sort(
    (a, b) =>
      a.blockers.length - b.blockers.length ||
      allowed.indexOf(a.item.type) - allowed.indexOf(b.item.type) ||
      minutesOf(a) - minutesOf(b)
  )
}

export async function buildPlan(
  graph: GeoGraph,
  graphName: string,
  change: string | undefined,
  vehicle: Vehicle,
  casualties: Casualty[],
  facility: Facility
): Promise<Plan | null> {
  const stops = [
    { label: vehicle.id, junction: vehicle.junction },
    ...casualties.map((c) => ({ label: c.id, junction: c.junction })),
    { label: facility.id, junction: facility.junction },
  ]
  if (stops.some((s) => s.junction === null)) return null
  const legs: Leg[] = []
  for (let k = 0; k < stops.length - 1; k++) {
    const leg = await roadLeg(
      graph,
      graphName,
      change,
      vehicle,
      stops[k] as { label: string; junction: number },
      stops[k + 1] as { label: string; junction: number }
    )
    if (!leg) return null
    legs.push(leg)
  }
  const metres = legs.reduce((sum, l) => sum + l.metres, 0)
  const minutes = legs.reduce((sum, l) => sum + l.minutes, 0)
  const maxThreat = Math.max(0, ...legs.map((l) => l.maxThreat))
  const range = rangeKm(vehicle)
  const capacity = capacityBlockers(vehicle, casualties)
  const checks: Check[] = [
    {
      ok: capacity.length === 0,
      label:
        capacity[0] ??
        `Capacity ok (${casualties.length} of ${vehicle.litterCapacity + vehicle.ambulatoryCapacity})`,
    },
    {
      ok: metres / 1000 <= range,
      label: `Range: route ${(metres / 1000).toFixed(1)} km of ${range.toFixed(0)} km available`,
    },
    {
      ok: maxThreat <= vehicle.maxThreat,
      label:
        maxThreat > 0
          ? `Threat on route ${maxThreat.toFixed(2)}, vehicle limit ${vehicle.maxThreat.toFixed(2)}`
          : 'No known threat on route',
    },
  ]
  return {
    vehicle,
    casualties,
    facility,
    legs,
    metres,
    minutes,
    maxThreat,
    checks,
    ok: checks.every((c) => c.ok),
  }
}

/** The plan's route and stops, for highlighting on the map. */
export function planSelection(plan: Plan): Selection {
  const nodes = new Set<number>([
    plan.vehicle.nid,
    plan.facility.nid,
    ...plan.casualties.map((c) => c.nid),
  ])
  const edges = new Set<number>()
  for (const leg of plan.legs) {
    for (const j of leg.junctions) nodes.add(j)
    for (const e of leg.edges) edges.add(e)
  }
  return { nodes, edges }
}

/** Junctions of the whole route in travel order, without the repeat where legs join. */
export function routeJunctions(plan: Plan): number[] {
  const out: number[] = []
  for (const leg of plan.legs) {
    for (const j of leg.junctions) if (out[out.length - 1] !== j) out.push(j)
  }
  return out
}

export const formatMinutes = (m: number) =>
  m >= 60
    ? `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, '0')}m`
    : `${Math.round(m)} min`
