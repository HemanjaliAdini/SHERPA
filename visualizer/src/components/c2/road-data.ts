import { executeCypherQuery } from '@/api'

export type RoadLine = {
  points: [number, number][]
  highway: string
  threat: number
  closed: boolean
}

// Edges are stored once per direction; the shared geometry is drawn once (reverse edges are skipped).
const ROADS_QUERY =
  'MATCH ()-[r:ROAD]->() RETURN r.geometry, r.highway, r.threat_level, r.status, r.id'

const parseGeometry = (g: string): [number, number][] =>
  g.split(';').map((p) => {
    const [lat, lon] = p.split(',')
    return [Number(lat), Number(lon)]
  })

export async function fetchRoads(graph: string, change?: string): Promise<RoadLine[]> {
  const data = await executeCypherQuery({ graph, change, query: ROADS_QUERY })
  const roads: RoadLine[] = []
  const seen = new Set<string>()
  for (const chunk of data) {
    const [geometry, highway, threat, status] = chunk as [string[], string[], number[], string[]]
    for (let i = 0; i < geometry.length; i++) {
      const points = parseGeometry(geometry[i])
      // Reverse edges share the same points in the opposite order: key on the unordered end points
      const a = points[0].join(',')
      const b = points[points.length - 1].join(',')
      const key = a < b ? `${a}|${b}|${points.length}` : `${b}|${a}|${points.length}`
      if (seen.has(key)) continue
      seen.add(key)
      roads.push({
        points,
        highway: highway[i],
        threat: Number(threat[i]),
        closed: status[i] === 'closed',
      })
    }
  }
  return roads
}
