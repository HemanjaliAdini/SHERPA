import { useState } from 'react'

import { executeCypherQueryFull } from '@/api'
import { CypherQueryError } from '@/api/responses/cypherQuery.response'
import type { GeoGraph } from './graph-data'
import { type QueryOutcome, selectionFromResult } from './selection'

// Preset queries, all checked against the evac2 graph. Routes use road length until
// per-vehicle cost properties exist.
const EXAMPLES: { group: string; label: string; query: string }[] = [
  {
    group: 'Planner',
    label: 'Pickup queue by triage',
    query:
      "MATCH (c:Casualty) WHERE c.status = 'awaiting_pickup' " +
      'RETURN c, c.id, c.triage_category, c.mobility ORDER BY c.triage_category, c.id',
  },
  {
    group: 'Planner',
    label: 'Nearest UGV to CAS-3 by road',
    query:
      "MATCH (v:Vehicle {type: 'ugv'})-[:NEAR]->(a), (c:Casualty {id: 'CAS-3'})-[:NEAR]->(b) " +
      'shortestPath(a, b, length_m, dist, path) RETURN dist, path',
  },
  {
    group: 'Planner',
    label: 'Nearest medical point with free beds for CAS-1',
    query:
      "MATCH (c:Casualty {id: 'CAS-1'})-[:NEAR]->(a), (m:MedicalPoint)-[:NEAR]->(b) " +
      'WHERE m.free_beds > 0 shortestPath(a, b, length_m, dist, path) RETURN dist, path',
  },
  {
    group: 'Planner',
    label: 'Ambulance leg: handover point HP-1 to Role 1 R1-A',
    query:
      "MATCH (h:MedicalPoint {id: 'HP-1'})-[:NEAR]->(a), (m:MedicalPoint {id: 'R1-A'})-[:NEAR]->(b) " +
      'shortestPath(a, b, length_m, dist, path) RETURN dist, path',
  },
  {
    group: 'Planner',
    label: "Roads above AMB-1's threat limit (empty until a threat is active)",
    query:
      "MATCH (v:Vehicle {id: 'AMB-1'}) MATCH (a)-[r:ROAD]->(b) " +
      'WHERE r.threat_level > v.max_threat RETURN a, r, b',
  },
  {
    group: 'Planner',
    label: 'Bridges (chokepoints for disruption events)',
    query: 'MATCH (a)-[r:ROAD]->(b) WHERE r.bridge RETURN a, r, b',
  },
  {
    group: 'Explore',
    label: 'Casualties, their junction and the roads out of it',
    query: 'MATCH (c:Casualty)-[r:NEAR]->(j:Junction)-[e:ROAD]->(k) RETURN c, r, j, e, k',
  },
  {
    group: 'Explore',
    label: 'Casualties more than 500 m from a road',
    query: 'MATCH (c:Casualty)-[r:NEAR]->(j) WHERE r.distance_m > 500 RETURN c, r, j, r.distance_m',
  },
  {
    group: 'Explore',
    label: 'Roads within 2 hops of threat THR-1',
    query: "MATCH (t:Threat {id: 'THR-1'})-[a:AFFECTS]->(j)-[e:ROAD*1..2]-(k) RETURN t, a, j, e, k",
  },
]
const EXAMPLE_GROUPS = [...new Set(EXAMPLES.map((e) => e.group))]
const MAX_TABLE_ROWS = 50

type Props = {
  graph: GeoGraph | undefined
  graphName: string
  change: string | undefined
  onResult: (outcome: QueryOutcome | null) => void
}

const cell = (v: unknown) =>
  v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)

export const QueryBar = ({ graph, graphName, change, onResult }: Props) => {
  const [query, setQuery] = useState(
    'MATCH (c:Casualty)-[r:NEAR]->(j:Junction)-[e:ROAD]->(k) RETURN c, r, j, e, k'
  )
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<QueryOutcome | null>(null)
  const [showRows, setShowRows] = useState(false)

  const run = async (q = query) => {
    if (!graph || !q.trim()) return
    setRunning(true)
    setError(null)
    try {
      const result = await executeCypherQueryFull({ graph: graphName, change, query: q })
      const next = selectionFromResult(graph, q, result)
      setOutcome(next)
      onResult(next)
    } catch (err) {
      const message =
        err instanceof CypherQueryError ? `${err.errorType}: ${err.errorDetails}` : String(err)
      setError(message)
      setOutcome(null)
      onResult(null)
    } finally {
      setRunning(false)
    }
  }

  const clear = () => {
    setOutcome(null)
    setError(null)
    onResult(null)
  }

  return (
    <div className="bg-grey-900/95 text-content-primary border-grey-700 absolute top-3 left-3 z-[1000] flex w-[640px] max-w-[calc(100%-24px)] flex-col gap-2 rounded-md border p-2 text-xs">
      <div className="flex gap-2">
        <textarea
          className="bg-grey-800 border-grey-600 text-content-primary min-h-[34px] flex-1 resize-y rounded border px-2 py-1.5 font-mono text-xs outline-none focus:border-[#7f93aa]"
          rows={2}
          spellCheck={false}
          value={query}
          placeholder="MATCH (c:Casualty)-[r:NEAR]->(j) RETURN c, r, j"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
              e.preventDefault()
              run()
            }
          }}
        />
        <div className="flex flex-col gap-1">
          <button
            type="button"
            className="bg-grey-600 hover:bg-grey-500 rounded px-3 py-1.5 font-medium disabled:opacity-50"
            disabled={running || !graph}
            onClick={() => run()}
          >
            {running ? 'Running' : 'Run'}
          </button>
          <button
            type="button"
            className="bg-grey-800 hover:bg-grey-700 text-content-fourth rounded px-3 py-1"
            onClick={clear}
          >
            Clear
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <select
          className="bg-grey-800 border-grey-600 text-content-primary max-w-[260px] rounded border px-1.5 py-1"
          value=""
          onChange={(e) => {
            const example = EXAMPLES[Number(e.target.value)]
            if (!example) return
            setQuery(example.query)
            run(example.query)
          }}
        >
          <option value="" disabled>
            Examples...
          </option>
          {EXAMPLE_GROUPS.map((group) => (
            <optgroup key={group} label={group}>
              {EXAMPLES.map((ex, i) =>
                ex.group === group ? (
                  <option key={ex.label} value={i}>
                    {ex.label}
                  </option>
                ) : null
              )}
            </optgroup>
          ))}
        </select>
        <span className="text-content-fourth flex-1 truncate">
          {error ? (
            <span className="text-[#fca5a5]">{error}</span>
          ) : outcome ? (
            `${outcome.rows.length} rows \u00b7 ${outcome.selection.nodes.size} nodes, ${outcome.selection.edges.size} edges highlighted${outcome.missing ? ` \u00b7 ${outcome.missing} ids not on the map` : ''}`
          ) : (
            'Enter runs the query; results light up on the map'
          )}
        </span>
        {outcome && outcome.rows.length > 0 && (
          <button
            type="button"
            className="text-content-fourth hover:text-content-primary underline"
            onClick={() => setShowRows(!showRows)}
          >
            {showRows ? 'hide rows' : 'show rows'}
          </button>
        )}
      </div>

      {outcome && showRows && (
        <div className="border-grey-700 max-h-56 overflow-auto rounded border">
          <table className="w-full font-mono text-[11px]">
            <thead className="bg-grey-800 sticky top-0">
              <tr>
                {outcome.columns.map((c) => (
                  <th key={c} className="px-2 py-1 text-left font-medium">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {outcome.rows.slice(0, MAX_TABLE_ROWS).map((row, r) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: result rows have no identity
                <tr key={r} className="border-grey-700 border-t">
                  {row.map((v, c) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
                    <td key={c} className="max-w-[240px] truncate px-2 py-0.5">
                      {cell(v)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {outcome.rows.length > MAX_TABLE_ROWS && (
            <div className="text-content-fourth px-2 py-1">
              showing {MAX_TABLE_ROWS} of {outcome.rows.length} rows
            </div>
          )}
        </div>
      )}
    </div>
  )
}
