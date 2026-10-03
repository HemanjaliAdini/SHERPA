// Events: what happens during a run (PRD 6.11). Producers write them pending; the simulator applies them on the
// tick (scripts/events.py). This screen only reads them.
import { executeCypherQuery } from '@/api'
import { rowsOf } from './selection'

export type SimEvent = {
  nid: number
  id: string
  at: Date | null
  type: string
  payload: Record<string, unknown>
  status: 'pending' | 'applied' | 'failed' | string
  source: string
  error: string
  /** what happened, written by the simulator when it applied the event */
  summary: string
  /** how it ended, once its effect is over (status 'resolved') */
  resolution: string
  resolvedAt: Date | null
}

const EVENTS =
  'MATCH (e:Event) RETURN e, e.id, e.at, e.type, e.payload, e.status, e.source, e.error, e.summary, ' +
  'e.resolution, e.resolved_at'

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v))

function parse(payload: unknown): Record<string, unknown> {
  try {
    return JSON.parse(str(payload) || '{}')
  } catch {
    return {}
  }
}

export async function fetchEvents(graph: string, change?: string): Promise<SimEvent[]> {
  const data = await executeCypherQuery({ graph, change, query: EVENTS })
  return rowsOf(data)
    .map((r) => ({
      nid: Number(r[0]),
      id: str(r[1]),
      at: r[2] ? new Date(String(r[2])) : null,
      type: str(r[3]),
      payload: parse(r[4]),
      status: str(r[5]),
      source: str(r[6]),
      error: str(r[7]),
      summary: str(r[8]),
      resolution: str(r[9]),
      resolvedAt: r[10] ? new Date(String(r[10])) : null,
    }))
    .sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0) || a.id.localeCompare(b.id))
}

const TITLE: Record<string, string> = {
  road_closed: 'Road closed',
  road_delayed: 'Road slowed',
  road_reopened: 'Road reopened',
  casualty_reported: 'New casualty',
  battery_depleted: 'Battery depleted',
}

/** Has happened: applied, or applied and since resolved */
export const happened = (e: SimEvent) => e.status === 'applied' || e.status === 'resolved'

/** Events that end another one (a reopened road resolves its closure): no alert of their own on the map */
export const SOLVING_TYPES = new Set(['road_reopened'])

/** A few words for a kind of event */
export const typeTitle = (type: string) => TITLE[type] ?? type.replace(/_/g, ' ')
export const eventTitle = (e: SimEvent) => typeTitle(e.type)

/** One line for a person: what happened once applied, else what the event will do */
export function describeEvent(e: SimEvent): string {
  if (e.summary) return e.summary
  const p = e.payload
  const reason = p.reason ? `: ${p.reason}` : ''
  const way = `road ${str(p.osm_way_id)}`
  if (e.type === 'road_closed') return `Road closed${reason || ` (${way})`}`
  if (e.type === 'road_reopened') return `Road reopened${reason || ` (${way})`}`
  if (e.type === 'road_delayed')
    return `Road slowed x${str(p.delay_factor)}${reason || ` (${way})`}`
  if (e.type === 'casualty_reported')
    return `New casualty ${str(p.id)}${p.mist_mechanism ? `: ${p.mist_mechanism}` : ''}`
  if (e.type === 'battery_depleted') {
    const who =
      str(p.vehicle_id) || `a ${str(p.vehicle_type).toUpperCase() || 'vehicle'} on a mission`
    return `Battery runs out: ${who}`
  }
  return eventTitle(e)
}
