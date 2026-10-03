import { useQuery } from '@tanstack/react-query'

import { C2Map } from '@/components/c2/c2-map'
import {
  EDGE_STYLE,
  FACILITY_COLOR,
  FACILITY_LABEL,
  JUNCTION_COLOR,
  ROAD_BASE_COLOR,
  ROAD_CLOSED_COLOR,
  THREAT_MARKER_COLOR,
  TRIAGE_COLOR,
  VEHICLE_COLOR,
  threatColor,
} from '@/components/c2/colors'
import { fetchGraph } from '@/components/c2/graph-data'
import { useScenarioStore } from '@/stores'

const NodeKey = ({ color, label, small }: { color: string; label: string; small?: boolean }) => (
  <div className="mb-1 flex items-center gap-2">
    <span className="inline-flex w-6 justify-center">
      <span
        className={`inline-block rounded-full ${small ? 'h-1 w-1' : 'h-3 w-3 border-2 border-[#0b1118]'}`}
        style={{ background: color }}
      />
    </span>
    {label}
  </div>
)

const EdgeKey = ({ color, dashed, label }: { color: string; dashed?: boolean; label: string }) => (
  <div className="mb-1 flex items-center gap-2">
    <span
      className="inline-block h-0 w-6"
      style={{ borderTop: `2px ${dashed ? 'dashed' : 'solid'} ${color}` }}
    />
    {label}
  </div>
)

const SectionTitle = ({ children }: { children: string }) => (
  <div className="text-content-fourth mt-3 mb-2 font-medium tracking-wide uppercase first:mt-0">
    {children}
  </div>
)

const Legend = () => (
  <div className="bg-grey-900/90 text-content-primary border-grey-700 absolute bottom-6 left-3 z-[1000] max-h-[80%] w-56 overflow-y-auto rounded-md border p-3 text-xs">
    <SectionTitle>Nodes</SectionTitle>
    <NodeKey color={JUNCTION_COLOR} label="Junction" small />
    {(['T1', 'T2', 'T3'] as const).map((t) => (
      <NodeKey key={t} color={TRIAGE_COLOR[t]} label={`Casualty ${t}`} />
    ))}
    {Object.entries(FACILITY_LABEL).map(([type, label]) => (
      <NodeKey key={type} color={FACILITY_COLOR[type]} label={label} />
    ))}
    <NodeKey color={VEHICLE_COLOR.ugv} label="Vehicle: UGV" />
    <NodeKey color={VEHICLE_COLOR.ambulance} label="Vehicle: ambulance" />
    <NodeKey color={THREAT_MARKER_COLOR} label="Threat" />
    <SectionTitle>Edges</SectionTitle>
    <EdgeKey color={ROAD_BASE_COLOR} label="ROAD" />
    <EdgeKey color={ROAD_CLOSED_COLOR} dashed label="ROAD (closed)" />
    <div
      className="mt-1 mb-1 h-1.5 w-full rounded"
      style={{
        background: `linear-gradient(to right, ${threatColor(0.01)}, ${threatColor(0.5)}, ${threatColor(1)})`,
      }}
    />
    <div className="text-content-fourth mb-2 flex justify-between">
      <span>ROAD threat low</span>
      <span>high</span>
    </div>
    <EdgeKey color={EDGE_STYLE.NEAR.color} dashed label="NEAR" />
    <EdgeKey color={EDGE_STYLE.AFFECTS.color} dashed label="AFFECTS" />
    <EdgeKey color={EDGE_STYLE.ROUTE_STEP.color} label="Mission route" />
    <div className="text-content-fourth mt-2">Click a node to inspect it.</div>
  </div>
)

export const TC2Page = () => {
  const graphName = useScenarioStore((state) => state.graph)
  const change = useScenarioStore((state) => state.change)

  const graph = useQuery({
    queryKey: ['c2-graph', graphName, change],
    queryFn: () => fetchGraph(graphName, change),
    staleTime: Number.POSITIVE_INFINITY,
  })

  const unplaced = graph.data?.unplaced
    ? ` \u00b7 ${graph.data.unplaced} nodes without a position`
    : ''
  const status = graph.isError
    ? 'could not load the graph'
    : graph.isLoading || !graph.data
      ? 'loading graph...'
      : `${graph.data.nodes.size} nodes \u00b7 ${graph.data.edges.length} edges drawn${unplaced}`

  return (
    <div className="relative h-full w-full">
      <C2Map graph={graph.data} graphName={graphName} change={change} />
      <Legend />
      <div className="bg-grey-900/90 text-content-primary border-grey-700 absolute top-3 left-3 z-[1000] rounded-md border px-3 py-1.5 text-xs">
        {graphName} on {change ? `change ${change}` : 'main'} {'·'} {status}
      </div>
    </div>
  )
}
