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
}

export type GraphEdge = {
  src: number
  dst: number
  type: string
  highway: string
  threat: number
  closed: boolean
}

/** A mission's route: its ROUTE_STEP junctions in order */
export type GraphRoute = { mission: number; junctions: number[] }

export type GeoGraph = {
  nodes: Map<number, GraphNode>
  edges: GraphEdge[]
  routes: GraphRoute[]
  unplaced: number
}

const NODES_QUERY =
  'MATCH (n) RETURN id(n), labels(n), n.id, n.lat, n.lon, n.type, n.triage_category'
const EDGES_QUERY =
  'MATCH (a)-[r]->(b) RETURN id(a), id(b), type(r), r.highway, r.threat_level, r.status, r.order'
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
    const [nid, labels, id, lat, lon, type, triage] = chunk as unknown[][]
    for (let i = 0; i < nid.length; i++) {
      const label = (labels[i] as string[])[0] ?? ''
      const base = {
        nid: Number(nid[i]),
        label,
        id: str(id[i]),
        kind: label === 'Casualty' ? str(triage[i]) : str(type[i]),
      }
      if (lat[i] === null || lon[i] === null) pending.set(base.nid, base)
      else
        nodes.set(base.nid, { ...base, lat: Number(lat[i]), lon: Number(lon[i]), derived: false })
    }
  }

  const edges: GraphEdge[] = []
  const neighbours = new Map<number, number[]>()
  const link = (a: number, b: number) => {
    if (!neighbours.has(a)) neighbours.set(a, [])
    neighbours.get(a)?.push(b)
  }
  const seenRoads = new Set<string>()
  const steps = new Map<number, [number, number][]>() // mission -> [order, junction]
  for (const chunk of edgeData) {
    const [src, dst, type, highway, threat, status, order] = chunk as unknown[][]
    for (let i = 0; i < src.length; i++) {
      const s = Number(src[i])
      const d = Number(dst[i])
      // Route steps become one line per mission, and do not pull the mission's position along the route
      if (type[i] === 'ROUTE_STEP') {
        if (!steps.has(s)) steps.set(s, [])
        steps.get(s)?.push([Number(order[i]), d])
        continue
      }
      link(s, d)
      link(d, s)
      // ROAD edges exist once per direction; draw each road once
      if (type[i] === 'ROAD') {
        const key = s < d ? `${s}-${d}` : `${d}-${s}`
        if (seenRoads.has(key)) continue
        seenRoads.add(key)
      }
      edges.push({
        src: s,
        dst: d,
        type: str(type[i]),
        highway: str(highway[i]),
        threat: Number(threat[i] ?? 0),
        closed: status[i] === 'closed',
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

  const routes = [...steps].map(([mission, s]) => ({
    mission,
    junctions: [...s].sort((x, y) => x[0] - y[0]).map(([, j]) => j),
  }))

  return { nodes, edges, routes, unplaced: pending.size }
}
