// Writes a confirmed plan into the graph as a Mission, inside a TuringDB change that is only
// submitted when every write succeeded (so the mission lands on main as one commit).
import { executeCypherQuery } from '@/api'
import { type Plan, routeJunctions } from './planner'

const ROUTE_STEPS_PER_QUERY = 10

const datetime = (d: Date) => `datetime('${d.toISOString().replace(/\.\d{3}Z$/, 'Z')}')`
const addMinutes = (d: Date, m: number) => new Date(d.getTime() + m * 60000)

export async function createMission(graphName: string, plan: Plan, now: Date): Promise<string> {
  const q = (query: string, change?: string) =>
    executeCypherQuery({ graph: graphName, change, query })

  const count = await q('MATCH (m:Mission) RETURN count(m)')
  const missionId = `M-${Number((count[0]?.[0] as number[] | undefined)?.[0] ?? 0) + 1}`

  const opened = await q('CHANGE NEW')
  const change = String((opened[0][0] as number[])[0])
  try {
    // Pickup ETAs accumulate along the legs: leg 0 reaches the first casualty, and so on
    let elapsed = 0
    const pickups = plan.casualties.map((c, k) => {
      elapsed += plan.legs[k]?.minutes ?? 0
      return { c, k, eta: addMinutes(now, elapsed) }
    })
    const matches = [
      `MATCH (v) WHERE v = ${plan.vehicle.nid}`,
      `MATCH (f) WHERE f = ${plan.facility.nid}`,
      ...pickups.map(({ c, k }) => `MATCH (c${k}) WHERE c${k} = ${c.nid}`),
    ].join(' ')
    const creates = [
      `(m:Mission {id: '${missionId}', status: 'planned', created_at: ${datetime(now)}, ` +
        `eta: ${datetime(addMinutes(now, plan.minutes))}})`,
      '(m)-[:USES]->(v)',
      '(m)-[:DELIVERS_TO]->(f)',
      ...pickups.map(
        ({ k, eta }) =>
          `(m)-[:PICKS_UP {order: ${k + 1}, status: 'pending', eta: ${datetime(eta)}}]->(c${k})`
      ),
    ].join(', ')
    const statuses = [
      "v.status = 'tasked'",
      ...pickups.map(({ k }) => `c${k}.status = 'assigned'`),
    ].join(', ')
    await q(`${matches} CREATE ${creates} SET ${statuses}`, change)
    await q('COMMIT', change) // the new mission must be visible before route steps attach to it

    const found = await q(`MATCH (m:Mission {id: '${missionId}'}) RETURN id(m)`, change)
    const missionNid = Number((found[0][0] as number[])[0])
    const route = routeJunctions(plan)
    for (let start = 0; start < route.length; start += ROUTE_STEPS_PER_QUERY) {
      const batch = route.slice(start, start + ROUTE_STEPS_PER_QUERY)
      const stepMatches = batch.map((j, k) => `MATCH (j${k}) WHERE j${k} = ${j}`).join(' ')
      const stepCreates = batch
        .map((_, k) => `(m)-[:ROUTE_STEP {order: ${start + k + 1}}]->(j${k})`)
        .join(', ')
      await q(`MATCH (m) WHERE m = ${missionNid} ${stepMatches} CREATE ${stepCreates}`, change)
    }
    await q('CHANGE SUBMIT', change)
    return missionId
  } catch (err) {
    await q('CHANGE DELETE', change).catch(() => undefined)
    throw err
  }
}
