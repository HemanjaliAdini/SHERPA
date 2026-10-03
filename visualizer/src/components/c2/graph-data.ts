import { executeCypherQuery } from '@/api'

export type GraphNode = {
  nid: number
  label: string
  id: string
  lat: number
  lon: number
  /** true when the node has no lat/lon of its own and sits at the mean of its neighbours */
  derived: boolean
  /** facility role, vehicle kind, threat type, or triage category for casualties */
  kind: string
  status: string
  /** label on the map: the id, plus "→ target +N carried" for a vehicle on a mission */
  tag: string
}

/** What is left of an active mission's route, from its vehicle to the destination */
export type ActiveRoute = { vehicle: number; color: string; points: [number, number][] }

// One colour per vehicle for its remaining route
const ROUTE_COLORS = ['#f97316', '#22d3ee', '#a3e635', '#f472b6', '#facc15', '#c084fc']

export type GraphEdge = {
  /** TuringDB edge ids drawn by this line (a two-way road has one id per direction) */
  ids: number[]
  src: number
  dst: number
  type: string
  highway: string
  threat: number
  closed: boolean
  /** length_m for roads, distance_m for NEAR links */
  metres: number | null
  /** road speeds in km/h (null for non-road edges) */
  speedUgv: number | null
  speedAmbulance: number | null
  /** ROAD delay_factor (1 when absent) */
  delay: number
}

export type GeoGraph = {
  nodes: Map<number, GraphNode>
  edges: GraphEdge[]
  /** TuringDB edge id -> index into edges */
  edgeIndex: Map<number, number>
  /** node id -> indices into edges touching it */
  incident: Map<number, number[]>
  /** mission node id -> its route as junction ids in ROUTE_STEP order */
  routes: Map<number, number[]>
  /** remaining route of each mission under way, for drawing */
  activeRoutes: ActiveRoute[]
  unplaced: number
}

const NODES_QUERY =
  'MATCH (n) RETURN id(n), labels(n), n.id, n.lat, n.lon, n.type, n.triage_category, n.status, ' +
  'n.progress_m, n.stranded_by'
// Simulator bookkeeping nodes have no place on the map
const HIDDEN_LABELS = new Set(['Clock', 'SimControl'])
// Missions no longer under way are left off the map; events appear once the simulator applies them
const hiddenNode = (label: string, status: unknown) =>
  HIDDEN_LABELS.has(label) ||
  (label === 'Mission' && (status === 'done' || status === 'cancelled')) ||
  (label === 'Event' && status !== 'applied' && status !== 'resolved')
/** Map label of an applied event, by its type */
export const EVENT_TAG: Record<string, string> = {
  road_closed: 'road closed',
  road_delayed: 'road slowed',
  road_reopened: 'road reopened',
  casualty_reported: 'new casualty',
  battery_depleted: 'battery depleted',
}
const EDGES_QUERY =
  'MATCH (a)-[r]->(b) RETURN id(r), id(a), id(b), type(r), r.highway, r.threat_level, r.status, ' +
  'r.length_m, r.distance_m, r.speed_ugv_kmh, r.speed_ambulance_kmh, r.order, r.delay_factor'
// Nodes without coordinates (Threat, Mission) take the mean of their placed neighbours; a few
// passes let positions flow along short chains such as Mission -> Vehicle -> Junction
const PLACEMENT_PASSES = 3

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v))

export async function fetchGraph(graph: string, change?: string): Promise<GeoGraph> {
  const [nodeData, edgeData] = await Promise.all([
    executeCypherQuery({ graph, change, query: NODES_QUERY }),
    executeCypherQuery({ graph, change, query: EDGES_QUERY }),
  ])

  const nodes = new Map<number, GraphNode>()
  const pending = new Map<number, Omit<GraphNode, 'lat' | 'lon' | 'derived'>>()
  // Finished missions and simulator nodes are left out, together with their edges
  const hidden = new Set<number>()
  const missionProgress = new Map<number, number>()
  for (const chunk of nodeData) {
    const [nid, labels, id, lat, lon, type, triage, status, progress, stranded] =
      chunk as unknown[][]
    for (let i = 0; i < nid.length; i++) {
      const label = (labels[i] as string[])[0] ?? ''
      if (hiddenNode(label, status[i])) {
        hidden.add(Number(nid[i]))
        continue
      }
      const base = {
        nid: Number(nid[i]),
        label,
        id: str(id[i]),
        // A vehicle stopped by an event keeps its place but takes the 'disabled' colour
        kind:
          label === 'Casualty'
            ? str(triage[i])
            : label === 'Vehicle' && status[i] === 'disabled'
              ? 'disabled'
              : str(type[i]),
        status: str(status[i]),
        tag:
          label === 'Event'
            ? `${str(id[i])} ${EVENT_TAG[str(type[i])] ?? str(type[i])}`
            : label === 'Vehicle' && status[i] === 'disabled'
              ? `${str(id[i])} stopped`
              : label === 'Casualty' && stranded[i]
                ? `${str(id[i])} stranded`
                : str(id[i]),
      }
      if (label === 'Mission') missionProgress.set(Number(nid[i]), Number(progress[i] ?? 0))
      if (lat[i] === null || lon[i] === null) pending.set(base.nid, base)
      else
        nodes.set(base.nid, { ...base, lat: Number(lat[i]), lon: Number(lon[i]), derived: false })
    }
  }

  const edges: GraphEdge[] = []
  const edgeIndex = new Map<number, number>()
  const incident = new Map<number, number[]>()
  const neighbours = new Map<number, number[]>()
  const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
    const list = m.get(k)
    if (list) list.push(v)
    else m.set(k, [v])
  }
  const roadByPair = new Map<string, number>()
  const routeSteps = new Map<number, [number, number][]>()
  const nullableNumber = (v: unknown) => (v === null || v === undefined ? null : Number(v))
  for (const chunk of edgeData) {
    const [
      eid,
      src,
      dst,
      type,
      highway,
      threat,
      status,
      length,
      distance,
      ugv,
      ambulance,
      order,
      delay,
    ] = chunk as unknown[][]
    for (let i = 0; i < src.length; i++) {
      const id = Number(eid[i])
      const s = Number(src[i])
      const d = Number(dst[i])
      if (hidden.has(s) || hidden.has(d)) continue
      // A mission's ROUTE_STEP edges become one ordered route line, not one spoke per junction,
      // and do not pull the mission node's derived position along the route
      if (type[i] === 'ROUTE_STEP') {
        push(routeSteps, s, [Number(order[i] ?? 0), d] as [number, number])
        continue
      }
      push(neighbours, s, d)
      push(neighbours, d, s)
      // ROAD edges exist once per direction; draw each road once and map both ids to it
      if (type[i] === 'ROAD') {
        const key = s < d ? `${s}-${d}` : `${d}-${s}`
        const existing = roadByPair.get(key)
        if (existing !== undefined) {
          edges[existing].ids.push(id)
          edgeIndex.set(id, existing)
          continue
        }
        roadByPair.set(key, edges.length)
      }
      const metres = length[i] ?? distance[i]
      edgeIndex.set(id, edges.length)
      push(incident, s, edges.length)
      push(incident, d, edges.length)
      edges.push({
        ids: [id],
        src: s,
        dst: d,
        type: str(type[i]),
        highway: str(highway[i]),
        threat: Number(threat[i] ?? 0),
        closed: status[i] === 'closed',
        metres: nullableNumber(metres),
        speedUgv: nullableNumber(ugv[i]),
        speedAmbulance: nullableNumber(ambulance[i]),
        delay: nullableNumber(delay[i]) ?? 1,
      })
    }
  }

  // A casualty stranded in a stopped vehicle sits on it: one label for both, so they do not overprint
  for (const v of nodes.values()) {
    if (v.label !== 'Vehicle' || v.kind !== 'disabled') continue
    for (const c of nodes.values()) {
      if (
        c.label === 'Casualty' &&
        c.lat === v.lat &&
        c.lon === v.lon &&
        c.tag.endsWith(' stranded')
      ) {
        v.tag = `${v.tag}, ${c.tag}`
        c.tag = ''
      }
    }
  }

  for (let pass = 0; pass < PLACEMENT_PASSES && pending.size > 0; pass++) {
    for (const [nid, base] of pending) {
      const placed = (neighbours.get(nid) ?? [])
        .map((n) => nodes.get(n))
        .filter((n) => n !== undefined)
      if (placed.length === 0) continue
      const lat = placed.reduce((sum, n) => sum + n.lat, 0) / placed.length
      const lon = placed.reduce((sum, n) => sum + n.lon, 0) / placed.length
      nodes.set(nid, { ...base, lat, lon, derived: true })
      pending.delete(nid)
    }
  }

  const routes = new Map<number, number[]>()
  for (const [mission, steps] of routeSteps) {
    routes.set(
      mission,
      steps.sort((a, b) => a[0] - b[0]).map(([, junction]) => junction)
    )
  }

  // Missions under way: the vehicle's label says where it is going and how many it carries, and its route
  // is drawn only from the vehicle onwards (the route walked by road length up to the mission's progress)
  const activeRoutes: ActiveRoute[] = []
  const vehicleOrder = [...nodes.values()]
    .filter((n) => n.label === 'Vehicle')
    .map((n) => n.id)
    .sort()
  const linked = (mission: number, type: string) =>
    edges.filter((e) => e.src === mission && e.type === type).map((e) => nodes.get(e.dst))
  for (const [mission, junctions] of routes) {
    const vehicle = linked(mission, 'USES')[0]
    if (!vehicle) continue
    const casualties = linked(mission, 'PICKS_UP').filter((n) => n !== undefined)
    const carried = casualties.filter((c) => c.status === 'in_transit').length
    const next =
      casualties.find((c) => c.status === 'assigned') ?? linked(mission, 'DELIVERS_TO')[0]
    vehicle.tag = `${vehicle.id}${next ? ` \u2192 ${next.id}` : ''}${carried ? ` +${carried}` : ''}`
    let walked = 0
    let k = 0
    const progress = missionProgress.get(mission) ?? 0
    while (k < junctions.length - 1) {
      const a = junctions[k]
      const b = junctions[k + 1]
      const road = roadByPair.get(a < b ? `${a}-${b}` : `${b}-${a}`)
      const length = road === undefined ? 0 : (edges[road].metres ?? 0)
      if (walked + length > progress) break
      walked += length
      k++
    }
    const ahead = junctions
      .slice(k + 1)
      .map((j) => nodes.get(j))
      .filter((n) => n !== undefined)
    activeRoutes.push({
      vehicle: vehicle.nid,
      color: ROUTE_COLORS[vehicleOrder.indexOf(vehicle.id) % ROUTE_COLORS.length],
      points: [[vehicle.lat, vehicle.lon], ...ahead.map((n) => [n.lat, n.lon] as [number, number])],
    })
  }

  return { nodes, edges, edgeIndex, incident, routes, activeRoutes, unplaced: pending.size }
}
