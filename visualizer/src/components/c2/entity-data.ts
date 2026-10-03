import { executeCypherQuery } from '@/api'

export type EntityKind = 'casualty' | 'facility' | 'vehicle' | 'threat'

export type Entity = {
  kind: EntityKind
  id: string
  lat: number
  lon: number
  /** facility role, vehicle kind, threat type */
  type: string
  status: string
  detail: string
}

const KIND_BY_LABEL: Record<string, EntityKind> = {
  Casualty: 'casualty',
  MedicalPoint: 'facility',
  Vehicle: 'vehicle',
}

const ENTITIES_QUERY =
  'MATCH (n) WHERE n:MedicalPoint OR n:Vehicle OR n:Casualty ' +
  'RETURN labels(n), n.id, n.lat, n.lon, n.type, n.status, n.name, n.triage_category, ' +
  'n.mobility, n.free_beds, n.state'

// Threats have no position of their own: they sit on the junction they affect
const THREATS_QUERY =
  'MATCH (t:Threat)-[:AFFECTS]->(j) RETURN t.id, t.type, t.level, t.active, j.lat, j.lon'

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v))

export async function fetchEntities(graph: string, change?: string): Promise<Entity[]> {
  const [entityData, threatData] = await Promise.all([
    executeCypherQuery({ graph, change, query: ENTITIES_QUERY }),
    executeCypherQuery({ graph, change, query: THREATS_QUERY }),
  ])
  const out: Entity[] = []

  for (const chunk of entityData) {
    const [labels, id, lat, lon, type, status, name, triage, mobility, beds, state] =
      chunk as unknown[][]
    for (let i = 0; i < id.length; i++) {
      const kind = KIND_BY_LABEL[(labels[i] as string[])[0]]
      if (!kind) continue
      const detail =
        kind === 'casualty'
          ? `${str(triage[i])} ${str(mobility[i])}`
          : kind === 'facility'
            ? `${str(name[i])} · ${str(state[i])} · ${str(beds[i])} free beds`
            : str(status[i])
      out.push({
        kind,
        id: str(id[i]),
        lat: Number(lat[i]),
        lon: Number(lon[i]),
        type: kind === 'casualty' ? str(triage[i]) : str(type[i]),
        status: str(status[i]),
        detail,
      })
    }
  }

  for (const chunk of threatData) {
    const [id, type, level, active, lat, lon] = chunk as unknown[][]
    for (let i = 0; i < id.length; i++) {
      out.push({
        kind: 'threat',
        id: str(id[i]),
        lat: Number(lat[i]),
        lon: Number(lon[i]),
        type: str(type[i]),
        status: active[i] ? 'active' : 'inactive',
        detail: `${str(type[i])} level ${str(level[i])} · ${active[i] ? 'active' : 'inactive'}`,
      })
    }
  }
  return out
}
