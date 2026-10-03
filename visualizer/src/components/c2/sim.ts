// Link to the simulator (scripts/simulate.py): it owns the Clock node; this screen writes only
// SimControl (play/pause, speed) and the medic's triage. Each write is its own short change on main.
import { executeCypherQuery } from '@/api'
import { rowsOf } from './selection'

export type SimState = { now: Date; running: boolean; speed: number; resetting: boolean }

export const SPEEDS = [0.5, 1, 2, 5] // scenario minutes per real second
export const TRIAGE_CATEGORIES = ['T1', 'T2', 'T3', 'DEAD'] as const
export const MOBILITIES = ['litter', 'ambulatory'] as const

export async function fetchSim(graph: string): Promise<SimState | null> {
  const data = await executeCypherQuery({
    graph,
    query: 'MATCH (k:Clock), (s:SimControl) RETURN k.now, s.running, s.speed, s.reset',
  })
  const r = rowsOf(data)[0]
  return r
    ? {
        now: new Date(String(r[0])),
        running: r[1] === true,
        speed: Number(r[2] ?? 1),
        resetting: r[3] === true,
      }
    : null
}

async function writeChange(graph: string, query: string): Promise<void> {
  const q = (text: string, change?: string) => executeCypherQuery({ graph, change, query: text })
  const opened = await q('CHANGE NEW')
  // the change id is sent back in hex, as the Python SDK does; decimal would name another change
  const change = Number((opened[0][0] as number[])[0]).toString(16)
  try {
    await q(query, change)
    await q('COMMIT', change)
    await q('CHANGE SUBMIT', change)
  } catch (err) {
    await q('CHANGE DELETE', change).catch(() => undefined)
    throw err
  }
}

export const setRunning = (graph: string, running: boolean) =>
  writeChange(graph, `MATCH (s:SimControl) SET s.running = ${running}`)

/** Ask the simulator to put the scenario back to its start (it does so on its next pass, paused or not). */
export const requestReset = (graph: string) =>
  writeChange(graph, 'MATCH (s:SimControl) SET s.reset = true')

export const setSpeed = (graph: string, speed: number) =>
  writeChange(graph, `MATCH (s:SimControl) SET s.speed = ${speed}`)

/** The medic's decision. A triaged casualty waits for the system to dispatch it on the next tick. */
export const setTriage = (
  graph: string,
  nid: number,
  category: (typeof TRIAGE_CATEGORIES)[number],
  mobility: (typeof MOBILITIES)[number]
) =>
  writeChange(
    graph,
    `MATCH (c:Casualty) WHERE c = ${nid} SET c.triage_category = '${category}', ` +
      `c.mobility = '${mobility}', c.status = '${category === 'DEAD' ? 'dead' : 'awaiting_pickup'}'`
  )

/** A vehicle destroyed or broken down: the dispatcher no longer uses it. Only offered for an idle vehicle. */
export const markVehicleLost = (graph: string, nid: number) =>
  writeChange(graph, `MATCH (v:Vehicle) WHERE v = ${nid} SET v.status = 'lost', v.damage = 'heavy'`)
