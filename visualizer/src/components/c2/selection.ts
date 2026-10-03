// What is highlighted on the map, independent of how it is drawn (Leaflet now, maybe deck.gl later)
import type { CypherQueryFullResponse } from '@/api'
import type { GeoGraph } from './graph-data'

export type Selection = {
  /** node ids */
  nodes: Set<number>
  /** indices into GeoGraph.edges */
  edges: Set<number>
}

export type QueryOutcome = {
  selection: Selection
  columns: string[]
  rows: unknown[][]
  /** result ids that are not in the drawn graph (e.g. created on another branch) */
  missing: number
}

/** A node, every edge touching it, and the nodes at the other ends. */
export function neighbourhood(graph: GeoGraph, nid: number): Selection {
  const nodes = new Set([nid])
  const edges = new Set<number>()
  for (const i of graph.incident.get(nid) ?? []) {
    edges.add(i)
    nodes.add(graph.edges[i].src)
    nodes.add(graph.edges[i].dst)
  }
  return { nodes, edges }
}

/** Nodes by id, plus routes given as junction ids: each consecutive pair lights the road between them. */
export function selectionFromIds(graph: GeoGraph, nids: number[], paths: number[][]): Selection {
  const nodes = new Set(nids.filter((n) => graph.nodes.has(n)))
  const edges = new Set<number>()
  for (const path of paths) {
    path.forEach((a, k) => {
      const b = path[k + 1]
      if (graph.nodes.has(a)) nodes.add(a)
      if (b === undefined) return
      const i = (graph.incident.get(a) ?? []).find((e) => {
        const edge = graph.edges[e]
        return (edge.src === a && edge.dst === b) || (edge.src === b && edge.dst === a)
      })
      if (i !== undefined) edges.add(i)
    })
  }
  return { nodes, edges }
}

// Node and edge ids both come back as UInt64, so whether a column holds nodes or edges is read
// from the query itself: `(x ...)` binds a node variable, `[x ...]` an edge variable.
const NODE_VAR = /\(\s*([A-Za-z_]\w*)/g
const EDGE_VAR = /\[\s*([A-Za-z_]\w*)/g
const ALIAS = /\b([A-Za-z_]\w*)\s+AS\s+([A-Za-z_]\w*)/gi
const SHORTEST_PATH =
  /shortestPath\s*\(\s*\w+\s*,\s*\w+\s*,\s*\w+\s*,\s*\w+\s*,\s*([A-Za-z_]\w*)\s*\)/gi

function variableKinds(query: string): Map<string, 'node' | 'edge' | 'route'> {
  const kinds = new Map<string, 'node' | 'edge' | 'route'>()
  for (const m of query.matchAll(NODE_VAR)) kinds.set(m[1], 'node')
  for (const m of query.matchAll(EDGE_VAR)) kinds.set(m[1], 'edge')
  for (const m of query.matchAll(SHORTEST_PATH)) kinds.set(m[1], 'route')
  for (const m of query.matchAll(ALIAS)) {
    const kind = kinds.get(m[1])
    if (kind) kinds.set(m[2], kind)
  }
  return kinds
}

export function rowsOf(data: unknown[][]): unknown[][] {
  const rows: unknown[][] = []
  for (const chunk of data) {
    const cols = chunk as unknown[][]
    const n = cols[0]?.length ?? 0
    for (let i = 0; i < n; i++) rows.push(cols.map((c) => c[i]))
  }
  return rows
}

export function selectionFromResult(
  graph: GeoGraph,
  query: string,
  result: CypherQueryFullResponse
): QueryOutcome {
  const kinds = variableKinds(query)
  const nodes = new Set<number>()
  const edges = new Set<number>()
  let missing = 0

  const addNode = (id: unknown) => {
    const nid = Number(id)
    if (graph.nodes.has(nid)) nodes.add(nid)
    else missing++
  }
  const addEdge = (id: unknown) => {
    const i = graph.edgeIndex.get(Number(id))
    if (i === undefined) {
      missing++
      return
    }
    edges.add(i)
    nodes.add(graph.edges[i].src)
    nodes.add(graph.edges[i].dst)
  }
  const visit = (value: unknown, kind: string | undefined, type: string) => {
    if (value === null || value === undefined) return
    if (type === 'Path' || kind === 'route') {
      // shortestPath: [node, edge, node, edge, ..., node]
      ;(value as unknown[]).forEach((id, k) => (k % 2 === 0 ? addNode(id) : addEdge(id)))
    } else if (type === 'EntityList') {
      for (const e of value as { type: string; id: number }[]) {
        if (e.type === 'node') addNode(e.id)
        else addEdge(e.id)
      }
    } else if (Array.isArray(value)) {
      for (const v of value) visit(v, kind, 'UInt64')
    } else if (type === 'UInt64' && kind === 'node') {
      addNode(value)
    } else if (type === 'UInt64' && kind === 'edge') {
      addEdge(value)
    }
  }

  const rows = rowsOf(result.data)
  for (const row of rows) {
    row.forEach((value, c) => visit(value, kinds.get(result.columns[c]), result.types[c]))
  }
  return { selection: { nodes, edges }, columns: result.columns, rows, missing }
}
