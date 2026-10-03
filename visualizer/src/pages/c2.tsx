import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { C2Map, type C2MapHandle } from '@/components/c2/c2-map'
import { CasualtyQueue } from '@/components/c2/casualty-queue'
import {
  EDGE_STYLE,
  FACILITY_COLOR,
  FACILITY_LABEL,
  HIGHLIGHT_COLOR,
  JUNCTION_COLOR,
  ROAD_BASE_COLOR,
  ROAD_CLOSED_COLOR,
  THREAT_MARKER_COLOR,
  TRIAGE_COLOR,
  VEHICLE_COLOR,
  threatColor,
} from '@/components/c2/colors'
import { fetchGraph } from '@/components/c2/graph-data'
import { Kbd, MapControls } from '@/components/c2/map-controls'
import { QueryBar } from '@/components/c2/query-bar'
import {
  type Casualty,
  activeQueue,
  fetchScenario,
  formatClock,
} from '@/components/c2/scenario-data'
import { type Selection, neighbourhood } from '@/components/c2/selection'
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
  <div className="bg-grey-900/95 text-content-primary border-grey-700 max-h-[60vh] w-56 overflow-y-auto rounded-md border p-3 text-xs shadow-lg">
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
    <EdgeKey color={HIGHLIGHT_COLOR} label="Selected / query result" />
    <div className="text-content-fourth mt-2">
      Click a node to see its relationships; click empty map to clear.
    </div>
  </div>
)

const KEY_HELP =
  '1-9 casualty \u00b7 + / - zoom \u00b7 R reset \u00b7 Esc clear \u00b7 / query \u00b7 L legend'

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')

export const TC2Page = () => {
  const graphName = useScenarioStore((state) => state.graph)
  const change = useScenarioStore((state) => state.change)
  const now = useScenarioStore((state) => state.now)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [fitRequest, setFitRequest] = useState(0)
  const [queryOpen, setQueryOpen] = useState(false)
  const [legendOpen, setLegendOpen] = useState(false)
  const [focusNid, setFocusNid] = useState<number | null>(null)
  const mapRef = useRef<C2MapHandle>(null)

  const graph = useQuery({
    queryKey: ['c2-graph', graphName, change],
    queryFn: () => fetchGraph(graphName, change),
    staleTime: Number.POSITIVE_INFINITY,
  })

  const scenario = useQuery({
    queryKey: ['c2-scenario', graphName, change],
    queryFn: () => fetchScenario(graphName, change),
    staleTime: Number.POSITIVE_INFINITY,
  })
  const queue = scenario.data ? activeQueue(scenario.data.casualties) : []

  const selectNode = (nid: number | null) => {
    setFocusNid(nid)
    setSelection(nid === null || !graph.data ? null : neighbourhood(graph.data, nid))
  }
  const locateCasualty = (c: Casualty) => {
    selectNode(c.nid)
    mapRef.current?.focusNodes(c.junction === null ? [c.nid] : [c.nid, c.junction])
  }
  // Keyboard handler reads the latest queue through a ref
  const queueRef = useRef<{ queue: Casualty[]; locate: (c: Casualty) => void }>({
    queue,
    locate: locateCasualty,
  })
  queueRef.current = { queue, locate: locateCasualty }

  // A selection refers to one branch's graph; drop it when the branch changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on branch switch only
  useEffect(() => setSelection(null), [graphName, change])

  // Keyboard shortcuts, printed on the buttons. Ignored while typing, except Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isTyping(e.target)) (e.target as HTMLElement).blur()
        setSelection(null)
        setFocusNid(null)
        return
      }
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === '+' || e.key === '=') mapRef.current?.zoomIn()
      else if (e.key === '-' || e.key === '_') mapRef.current?.zoomOut()
      else if (e.key === 'r' || e.key === 'R') mapRef.current?.resetView()
      else if (e.key === 'l' || e.key === 'L') setLegendOpen((open) => !open)
      else if (/^[1-9]$/.test(e.key)) {
        const c = queueRef.current.queue[Number(e.key) - 1]
        if (c) queueRef.current.locate(c)
      } else if (e.key === '/') {
        e.preventDefault()
        setQueryOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const unplaced = graph.data?.unplaced
    ? ` \u00b7 ${graph.data.unplaced} nodes without a position`
    : ''
  const status = graph.isError
    ? 'could not load the graph'
    : graph.isLoading || !graph.data
      ? 'loading graph...'
      : `${graph.data.nodes.size} nodes \u00b7 ${graph.data.edges.length} edges drawn${unplaced}`

  return (
    <div className="flex h-full w-full">
      <div className="relative h-full flex-1">
        <C2Map
          ref={mapRef}
          graph={graph.data}
          selection={selection}
          onSelectNode={selectNode}
          graphName={graphName}
          change={change}
          fitRequest={fitRequest}
        />

        <div className="absolute top-3 left-3 z-[1000] max-w-[calc(100%-24px)]">
          <QueryBar
            graph={graph.data}
            graphName={graphName}
            change={change}
            open={queryOpen}
            onOpenChange={setQueryOpen}
            onResult={(outcome) => {
              setSelection(outcome && outcome.selection.nodes.size > 0 ? outcome.selection : null)
              if (outcome?.selection.nodes.size) setFitRequest((n) => n + 1)
            }}
          />
        </div>

        <div className="bg-grey-900/90 text-content-fourth border-grey-700 absolute top-3 right-3 z-[1000] rounded-md border px-3 py-1.5 text-xs">
          {graphName} on {change ? `change ${change}` : 'main'} {'\u00b7'} {status}
        </div>

        <div className="absolute bottom-6 left-3 z-[1000] flex flex-col items-start gap-2">
          {legendOpen && <Legend />}
          <button
            type="button"
            onClick={() => setLegendOpen(!legendOpen)}
            className="bg-grey-900/95 border-grey-600 text-content-primary hover:bg-grey-700 flex h-11 items-center gap-3 rounded-lg border px-3 text-sm font-medium shadow-lg"
          >
            {legendOpen ? 'Hide legend' : 'Legend'} <Kbd>L</Kbd>
          </button>
        </div>

        <div className="absolute right-3 bottom-6 z-[1000] flex flex-col items-end gap-2">
          <MapControls
            onZoomIn={() => mapRef.current?.zoomIn()}
            onZoomOut={() => mapRef.current?.zoomOut()}
            onReset={() => mapRef.current?.resetView()}
            onClear={() => selectNode(null)}
            hasSelection={selection !== null}
          />
          <div className="bg-grey-900/90 text-content-fourth rounded px-2 py-1 text-[11px]">
            {KEY_HELP}
          </div>
        </div>
      </div>

      <aside className="border-grey-700 bg-grey-900 text-content-primary flex h-full w-[400px] shrink-0 flex-col border-l">
        <div className="border-grey-700 flex items-center justify-between border-b px-4 py-2 text-xs">
          <span className="text-content-fourth">Scenario time</span>
          <span className="font-mono text-sm font-semibold">{formatClock(now)}</span>
        </div>
        {scenario.isError ? (
          <div className="p-4 text-sm text-[#fca5a5]">Could not load the scenario.</div>
        ) : (
          <CasualtyQueue queue={queue} now={now} selectedNid={focusNid} onLocate={locateCasualty} />
        )}
      </aside>
    </div>
  )
}
