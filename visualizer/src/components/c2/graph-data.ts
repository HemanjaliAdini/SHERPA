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
  /** free_beds for a MedicalPoint, battery_pct for a Vehicle, level for a Threat; else null */
  metric: number | null
}

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
  unplaced: number
}

const NODES_QUERY =
  'MATCH (n) RETURN id(n), labels(n), n.id, n.lat, n.lon, n.type, n.triage_category, ' +
  'n.free_beds, n.battery_pct, n.level'
// Which numeric property a label's metric is read from (column offset after triage_category)
const METRIC_COLUMN: Record<string, number> = { MedicalPoint: 0, Vehicle: 1, Threat: 2 }
const EDGES_QUERY =
  'MATCH (a)-[r]->(b) RETURN id(r), id(a), id(b), type(r), r.highway, r.threat_level, r.status, ' +
  'r.length_m, r.distance_m, r.speed_ugv_kmh, r.speed_ambulance_kmh, r.order'
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
  for (const chunk of nodeData) {
    const [nid, labels, id, lat, lon, type, triage, ...metrics] = chunk as unknown[][]
    for (let i = 0; i < nid.length; i++) {
      const label = (labels[i] as string[])[0] ?? ''
      const metric = metrics[METRIC_COLUMN[label]]?.[i]
      const base = {
        nid: Number(nid[i]),
        label,
        id: str(id[i]),
        kind: label === 'Casualty' ? str(triage[i]) : str(type[i]),
        metric: metric === null || metric === undefined ? null : Number(metric),
      }
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
    const [eid, src, dst, type, highway, threat, status, length, distance, ugv, ambulance, order] =
      chunk as unknown[][]
    for (let i = 0; i < src.length; i++) {
      const id = Number(eid[i])
      const s = Number(src[i])
      const d = Number(dst[i])
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
      })
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

  return { nodes, edges, edgeIndex, incident, routes, unplaced: pending.size }
}
