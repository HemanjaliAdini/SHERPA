import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'

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
import { MissionPlanner } from '@/components/c2/mission-planner'
import { QueryBar } from '@/components/c2/query-bar'
import {
  type Casualty,
  activeQueue,
  fetchScenario,
  formatClock,
} from '@/components/c2/scenario-data'
import { type Selection, neighbourhood, selectionFromIds } from '@/components/c2/selection'
import {
  SPEEDS,
  fetchSim,
  requestReset,
  setRunning,
  setSpeed,
  setTriage,
} from '@/components/c2/sim'
import { VoiceAsk } from '@/components/c2/voice-ask'
import { useScenarioStore } from '@/stores'

// deck.gl is only downloaded when the 3D view is first opened
const C2Map3D = lazy(() =>
  import('@/components/c2/c2-map-3d').then((m) => ({ default: m.C2Map3D }))
)

type ViewMode = '2d' | '3d'

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

const KEY_HELP = [
  'Arrows move',
  'Shift+arrows turn and tilt (3D)',
  '+ / - zoom',
  'R reset',
  'V 2D/3D',
  '1-9 casualty',
  'Esc clear',
  '/ query',
  'M ask by voice',
  'L legend',
].join(' \u00b7 ')
const PAN_PX = 150
const TURN_DEG = 15
const TILT_DEG = 10

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')

export const TC2Page = () => {
  const graphName = useScenarioStore((state) => state.graph)
  const change = useScenarioStore((state) => state.change)
  const fixedNow = useScenarioStore((state) => state.now)
  const [manual, setManual] = useState(false)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [fitRequest, setFitRequest] = useState(0)
  const [queryOpen, setQueryOpen] = useState(false)
  const [legendOpen, setLegendOpen] = useState(false)
  const [focusNid, setFocusNid] = useState<number | null>(null)
  const [planningFor, setPlanningFor] = useState<Casualty | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [mode, setMode] = useState<ViewMode>('3d')
  const queryClient = useQueryClient()
  const mapRef = useRef<C2MapHandle>(null)
  // After an action the simulator answers on its next pass (up to ~1 s), so keep refreshing a while
  const busyUntil = useRef(0)

  // The simulator's clock and controls; while it runs, the map and queue refresh every second
  const sim = useQuery({
    queryKey: ['c2-sim', graphName],
    queryFn: () => fetchSim(graphName),
    refetchInterval: 1000,
  })
  const running = sim.data?.running ?? false
  const now = sim.data?.now ?? fixedNow
  const refresh = () => (Date.now() < busyUntil.current ? 1000 : false)

  const graph = useQuery({
    queryKey: ['c2-graph', graphName, change],
    queryFn: () => fetchGraph(graphName, change),
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: refresh,
  })

  const scenario = useQuery({
    queryKey: ['c2-scenario', graphName, change],
    queryFn: () => fetchScenario(graphName, change),
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: refresh,
  })
  const untriaged = scenario.data?.casualties.filter((c) => c.status === 'reported').length ?? 0
  const refreshAll = () => {
    for (const key of ['c2-sim', 'c2-graph', 'c2-scenario'])
      queryClient.invalidateQueries({ queryKey: [key] })
  }
  // Every tick (and a reset) changes the clock: refresh the map and the queue once per change
  const clockTime = sim.data?.now.getTime()
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch on each clock change only
  useEffect(() => {
    for (const key of ['c2-graph', 'c2-scenario'])
      queryClient.invalidateQueries({ queryKey: [key] })
  }, [clockTime])
  const act = (work: Promise<void>) => {
    busyUntil.current = Date.now() + 6000
    work.then(refreshAll).catch((err) => setNotice(String(err)))
  }
  const queue = scenario.data ? activeQueue(scenario.data.casualties) : []

  const selectNode = (nid: number | null) => {
    setFocusNid(nid)
    setSelection(nid === null || !graph.data ? null : neighbourhood(graph.data, nid))
  }
  const locateCasualty = (c: Casualty) => {
    selectNode(c.nid)
    mapRef.current?.focusNodes(c.junction === null ? [c.nid] : [c.nid, c.junction])
  }
  const previewPlan = useCallback((preview: Selection | null) => {
    setSelection(preview)
    if (preview) setFitRequest((n) => n + 1)
  }, [])

  const missionCreated = (missionId: string) => {
    setPlanningFor(null)
    setNotice(`Mission ${missionId} created and committed to the graph`)
    queryClient.invalidateQueries({ queryKey: ['c2-graph'] })
    queryClient.invalidateQueries({ queryKey: ['c2-scenario'] })
  }

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(timer)
  }, [notice])

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
        setPlanningFor(null)
        return
      }
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
      const map = mapRef.current
      const arrow = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[
        e.key
      ]
      if (arrow) {
        e.preventDefault()
        if (e.shiftKey) {
          if (arrow[0]) map?.rotate(arrow[0] * TURN_DEG)
          else map?.tilt(-arrow[1] * TILT_DEG)
        } else map?.pan(arrow[0] * PAN_PX, arrow[1] * PAN_PX)
        return
      }
      if (e.key === 'v' || e.key === 'V') setMode((m) => (m === '2d' ? '3d' : '2d'))
      else if (e.key === '+' || e.key === '=') mapRef.current?.zoomIn()
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

  // Both views take the same props and command handle, so controls work in 2D and 3D
  const mapProps = {
    graph: graph.data,
    selection,
    onSelectNode: selectNode,
    graphName,
    change,
    fitRequest,
  }

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
        {mode === '2d' ? (
          <C2Map ref={mapRef} {...mapProps} />
        ) : (
          <Suspense
            fallback={
              <div className="c2-map text-content-fourth flex h-full w-full items-center justify-center text-xs">
                loading 3D view...
              </div>
            }
          >
            <C2Map3D ref={mapRef} {...mapProps} />
          </Suspense>
        )}

        <div className="absolute top-3 left-3 z-[1000] flex max-w-[calc(100%-24px)] flex-col items-start gap-2">
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
          <VoiceAsk
            graphName={graphName}
            change={change}
            now={now}
            onAnswer={(answer) => {
              const picked =
                answer && graph.data
                  ? selectionFromIds(graph.data, answer.highlight ?? [], answer.paths ?? [])
                  : null
              setSelection(picked && picked.nodes.size > 0 ? picked : null)
              if (picked?.nodes.size) setFitRequest((n) => n + 1)
            }}
          />
        </div>

        <div className="bg-grey-900/90 text-content-fourth border-grey-700 absolute top-3 right-3 z-[1000] rounded-md border px-3 py-1.5 text-xs">
          {graphName} on {change ? `change ${change}` : 'main'} {'\u00b7'} {status}
        </div>
        <div className="bg-grey-900/90 border-grey-700 absolute top-12 right-3 z-[1000] flex overflow-hidden rounded-md border text-xs">
          {(['2d', '3d'] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              className={`px-3 py-1 font-medium ${mode === m ? 'bg-grey-600 text-content-primary' : 'text-content-fourth hover:bg-grey-800'}`}
            >
              {m.toUpperCase()}
            </button>
          ))}
          <span className="text-content-fourth border-grey-700 flex items-center border-l px-2">
            <Kbd>V</Kbd>
          </span>
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
          <span className="font-mono text-sm font-semibold">{formatClock(now)}</span>
          {sim.data?.resetting ? (
            <span className="text-content-fourth">Resetting...</span>
          ) : sim.data ? (
            <span className="flex items-center gap-2">
              {untriaged > 0 && <span className="text-[#fbbf24]">{untriaged} to triage</span>}
              <button
                type="button"
                onClick={() => act(setRunning(graphName, !running))}
                className="bg-grey-600 hover:bg-grey-500 rounded px-3 py-1 font-semibold"
              >
                {running ? 'Pause' : 'Play'}
              </button>
              <button
                type="button"
                onClick={() => act(requestReset(graphName))}
                className="text-content-fourth hover:text-content-primary underline"
                title="Put the scenario back to its start; the history is kept"
              >
                Reset
              </button>
              <select
                value={sim.data.speed}
                onChange={(e) => act(setSpeed(graphName, Number(e.target.value)))}
                className="bg-grey-800 rounded px-1 py-1"
                title="Scenario minutes per second"
              >
                {SPEEDS.map((v) => (
                  <option key={v} value={v}>
                    {v}x
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setManual(!manual)}
                className="text-content-fourth hover:text-content-primary underline"
                title="Manual mission planner"
              >
                {manual ? 'Auto' : 'Manual'}
              </button>
            </span>
          ) : (
            <span className="text-content-fourth">no simulator clock in this graph</span>
          )}
        </div>
        {notice && (
          <div className="border-b border-[#166534] bg-[#14532d] px-4 py-2 text-sm font-medium">
            {notice}
          </div>
        )}
        {scenario.isError ? (
          <div className="p-4 text-sm text-[#fca5a5]">Could not load the scenario.</div>
        ) : planningFor && graph.data && scenario.data ? (
          <MissionPlanner
            key={planningFor.nid}
            graph={graph.data}
            graphName={graphName}
            change={change}
            scenario={scenario.data}
            initial={planningFor}
            now={now}
            onPreview={previewPlan}
            onCreated={missionCreated}
            onClose={() => setPlanningFor(null)}
          />
        ) : (
          <CasualtyQueue
            queue={queue}
            now={now}
            selectedNid={focusNid}
            onLocate={locateCasualty}
            onPlan={
              manual
                ? (c) => {
                    setNotice(null)
                    setPlanningFor(c)
                  }
                : undefined
            }
            onTriage={
              sim.data?.resetting
                ? undefined
                : (c, category, mobility) => act(setTriage(graphName, c.nid, category, mobility))
            }
          />
        )}
      </aside>
    </div>
  )
}
