import type { GeoGraph, GraphNode } from './graph-data'
import { type Scenario, formatClock } from './scenario-data'

type Turn = { speaker: string; text: string; tone: 'field' | 'command' | 'unit' | 'site' }

type Props = {
  node: GraphNode | undefined
  scenario: Scenario | undefined
  now: Date
  graph: GeoGraph | undefined
  position: { x: number; y: number; width: number; height: number } | null
  onClose: () => void
}

const firstName = (name: string) =>
  name
    .split(/\s+/)
    .map((word) => word[0])
    .join('')
    .slice(0, 2)

// Communications are generated from the simulator's current graph state.
// NEAR is an anchor, so movement reports use the vehicle's actual coordinates.
function turnsFor(node: GraphNode, scenario: Scenario | undefined, graph: GeoGraph | undefined): Turn[] {
  if (!scenario || !graph) return [{ speaker: 'C2', tone: 'command', text: 'Loading scene status…' }]
  const linked = (mission: number, type: string) => graph.edges
    .filter((edge) => edge.src === mission && edge.type === type)
    .map((edge) => graph.nodes.get(edge.dst))
    .filter((item): item is GraphNode => item !== undefined)
  const missions = [...graph.nodes.values()].filter((item) => item.label === 'Mission')
  const related = missions.filter((mission) => graph.edges.some((edge) =>
    edge.src === mission.nid && edge.dst === node.nid &&
    ['USES', 'PICKS_UP', 'DELIVERS_TO'].includes(edge.type)))
  const exchanges = related.flatMap((mission): Turn[] => {
    const vehicle = linked(mission.nid, 'USES')[0]
    const destination = linked(mission.nid, 'DELIVERS_TO')[0]
    const casualties = linked(mission.nid, 'PICKS_UP')
    if (!vehicle) return []
    const aboard = casualties.filter((item) => item.status === 'in_transit')
    const waiting = casualties.filter((item) => item.status === 'assigned')
    const nearestPickup = waiting.reduce((distance, casualty) => {
      const north = (casualty.lat - vehicle.lat) * 111195
      const east = (casualty.lon - vehicle.lon) * 111195 * Math.cos(vehicle.lat * Math.PI / 180)
      return Math.min(distance, Math.hypot(north, east))
    }, Infinity)
    const point = scenario.facilities.find((item) => item.id === destination?.id)
    const medic = point ? `Medics · ${point.name}` : 'Medic team'
    const position = `${vehicle.lat.toFixed(5)}, ${vehicle.lon.toFixed(5)}`
    return [
      { speaker: 'Medic team', tone: 'field', text: `Send ${vehicle.id} to ${casualties.map((item) => item.id).join(', ')}. Evacuate to ${point?.name ?? destination?.id ?? 'the receiving point'}; mission ${mission.id}.` },
      { speaker: vehicle.id, tone: 'unit', text: aboard.length
        ? `${aboard.map((item) => item.id).join(', ')} aboard. Moving to ${point?.name ?? destination?.id ?? 'destination'}. Position ${position}.`
        : `${nearestPickup <= 500 ? 'Approaching' : 'On the move towards'} ${waiting.map((item) => item.id).join(', ') || 'pickup point'}. Position ${position}.` },
      ...aboard.map((casualty): Turn => ({ speaker: casualty.id, tone: 'field', text: `Picked up by ${vehicle.id}. On our way to the receiving medics.` })),
      { speaker: medic, tone: 'site', text: point
        ? `${point.state === 'operational' && point.medics > 0 ? 'Copy. Receiving medics available.' : `Receiving point ${point.state}; ${point.medics} medics available.`} ${point.freeBeds} free beds.`
        : 'Receiving team availability has not been recorded.' },
    ]
  })
  if (node.label === 'Casualty') {
    const casualty = scenario.casualties.find((item) => item.id === node.id)
    if (!casualty) return []
    const report: Turn[] = [
      { speaker: casualty.id, tone: 'field', text: casualty.status === 'delivered'
        ? 'Arrived at the medical point. Handover complete.'
        : casualty.status === 'in_transit' ? 'Evacuation in progress.'
        : 'Waiting here for the pickup team.' },
      { speaker: 'Medic team', tone: 'field', text: casualty.triage
        ? `${casualty.triage}, ${casualty.mobility || 'mobility not recorded'}. ${casualty.status === 'awaiting_pickup' ? `Send an available vehicle to ${casualty.id}.` : casualty.status === 'assigned' ? `Pickup assigned for ${casualty.id}.` : casualty.status === 'delivered' ? `${casualty.id} received.` : casualty.status === 'in_transit' ? `${casualty.id} is with the transport team.` : 'Review before dispatch.'}`
        : `Triage pending. Injury report: ${casualty.mist.injuries || 'not recorded'}. Record triage before dispatch.` },
    ]
    return [...(related.length ? [...exchanges, ...report] : report), ...(related.length ? [] : [{ speaker: 'C2', tone: 'command' as const, text:
      casualty.status === 'delivered' ? 'Handover complete.'
      : casualty.status === 'awaiting_pickup' ? 'Waiting for an available vehicle to be dispatched.'
      : casualty.status === 'reported' ? 'Awaiting the medic’s triage decision.'
      : `Current status: ${casualty.status}.` }])]
  }
  if (node.label === 'Vehicle') {
    if (exchanges.length) return exchanges
    const vehicle = scenario.vehicles.find((item) => item.id === node.id)
    return [{ speaker: node.id, tone: 'unit', text: `Status ${vehicle?.status ?? node.status}. Position ${node.lat.toFixed(5)}, ${node.lon.toFixed(5)}. ${vehicle?.status === 'idle' ? 'Available for the next dispatch.' : 'No active mission is recorded.'}` }]
  }
  if (node.label === 'MedicalPoint') {
    const point = scenario.facilities.find((item) => item.id === node.id)
    const held = graph.edges.filter((edge) => edge.type === 'HELD_AT' && edge.dst === node.nid)
      .map((edge) => graph.nodes.get(edge.src)).filter((item): item is GraphNode => !!item)
    return [
      { speaker: `Medics · ${point?.name ?? node.id}`, tone: 'site', text: `Status ${point?.state ?? 'unknown'}. ${point?.medics ?? 0} medics available; ${point?.freeBeds ?? 0} free beds.` },
      ...held.map((casualty): Turn => ({ speaker: 'Medic team', tone: 'field', text: `${casualty.id} received. ${casualty.status === 'awaiting_pickup' ? 'Awaiting onward ambulance transfer.' : `Status: ${casualty.status}.`}` })),
      ...exchanges,
    ]
  }
  if (node.label === 'Drone' || node.kind === 'drone') return [{ speaker: node.id, tone: 'unit', text: `Drone status: ${node.status || 'not recorded'}. Position ${node.lat.toFixed(5)}, ${node.lon.toFixed(5)}.` }]
  return [{ speaker: node.id, tone: 'site', text: 'Select a casualty, vehicle, or medical point to follow their communication.' }]
}

const toneStyle = {
  field: 'border-sky-500/70 bg-sky-950/60 text-sky-100',
  command: 'border-emerald-500/70 bg-emerald-950/60 text-emerald-100',
  unit: 'border-amber-500/70 bg-amber-950/50 text-amber-100',
  site: 'border-slate-500/70 bg-slate-900/80 text-slate-100',
}

export function SceneDialogue({ node, scenario, now, graph, position, onClose }: Props) {
  if (!node) return null
  const turns = turnsFor(node, scenario, graph)
  const width = Math.min(350, Math.max(180, (position?.width ?? 390) - 24))
  const left = position ? Math.max(12, Math.min(position.x + 20, position.width - width - 12)) : 20
  const top = position ? Math.max(80, Math.min(position.y - 30, position.height - 280)) : 100
  return (
    <>
      {position && <svg className="pointer-events-none absolute inset-0 z-[1001] h-full w-full" aria-hidden="true">
        <line x1={position.x} y1={position.y} x2={left + 8} y2={top + 26} stroke="#fbbf24" strokeWidth="2" />
        <circle cx={position.x} cy={position.y} r="5" fill="#fbbf24" stroke="#0b1118" strokeWidth="2" />
      </svg>}
    <section
      style={{ left, top, width, maxHeight: position ? Math.max(120, position.height - top - 12) : undefined }}
      className="absolute z-[1001] flex flex-col overflow-hidden rounded-lg border border-[#64748b] bg-[#0b1118]/95 shadow-2xl backdrop-blur"
      aria-label={`Scene dialogue for ${node.id}`}
    >
      <header className="flex items-center justify-between border-b border-[#334155] bg-[#17212d] px-3 py-2">
        <div>
          <p className="text-[9px] font-bold tracking-[0.2em] text-amber-300">SCENE COMMS · {formatClock(now)}</p>
          <p className="text-xs font-semibold text-white">
            {node.label} · {node.id}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close scene dialogue"
          className="rounded px-2 py-1 text-xs text-slate-300 hover:bg-slate-700"
        >
          ✕
        </button>
      </header>
      <p className="px-3 pt-2 text-[10px] text-slate-400">Simulated conversation</p>
      <div className="min-h-0 max-h-56 space-y-2 overflow-y-auto p-3" aria-live="polite">
        {turns.map((turn, index) => (
          <article
            key={`${turn.speaker}-${index}`}
            className={`flex gap-2 rounded border p-2 ${toneStyle[turn.tone]}`}
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-current/40 bg-black/20 text-[10px] font-black">
              {firstName(turn.speaker)}
            </span>
            <div className="min-w-0">
              <p className="text-[10px] font-bold tracking-wide">{turn.speaker}</p>
              <p className="mt-0.5 text-xs leading-5">{turn.text}</p>
            </div>
          </article>
        ))}
      </div>
    </section>
    </>
  )
}
