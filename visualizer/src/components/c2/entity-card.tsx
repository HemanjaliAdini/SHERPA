// Info box for the selected vehicle, medical point, medic team or command node: the numbers an
// operator needs at a glance, read from the same scenario and graph queries as the rest of the page.
import type { ReactNode } from 'react'

import { FACILITY_LABEL } from './colors'
import type { GeoGraph, GraphNode } from './graph-data'
import type { Facility, Scenario } from './scenario-data'

export const ENTITY_CARD_LABELS = new Set(['Vehicle', 'MedicalPoint', 'Medic', 'Command'])

type Props = {
  node: GraphNode
  graph: GeoGraph
  scenario: Scenario
  now: Date
  onClose: () => void
}

const words = (s: string) => s.replaceAll('_', ' ')

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex items-baseline justify-between gap-3 py-0.5">
    <dt className="shrink-0 text-slate-400">{label}</dt>
    <dd className="text-right font-medium text-slate-100">{children}</dd>
  </div>
)

const Bar = ({ pct }: { pct: number }) => (
  <span className="ml-2 inline-block h-1.5 w-16 overflow-hidden rounded bg-slate-700 align-middle">
    <span
      className="block h-full"
      style={{
        width: `${Math.max(0, Math.min(100, pct))}%`,
        background: pct < 25 ? '#f87171' : pct < 50 ? '#fbbf24' : '#34d399',
      }}
    />
  </span>
)

/** Nodes at the other end of this node's edges of one type */
function linked(graph: GeoGraph, nid: number, type: string, direction: 'out' | 'in'): GraphNode[] {
  return (graph.incident.get(nid) ?? [])
    .map((i) => graph.edges[i])
    .filter((e) => e.type === type && (direction === 'out' ? e.src === nid : e.dst === nid))
    .map((e) => graph.nodes.get(direction === 'out' ? e.dst : e.src))
    .filter((n): n is GraphNode => n !== undefined)
}

const list = (ids: string[]) => (ids.length ? ids.join(', ') : 'none')
const DAMAGE_CLASS: Record<string, string> = { light: 'text-amber-300', heavy: 'text-red-400' }

// A vehicle parked at a medical point is seeded ~20 m off it and can snap to a different junction,
// so "at this point" is decided by distance, not by sharing a junction
const AT_POINT_METRES = 150
function metresBetween(a: GraphNode, b: GraphNode) {
  const north = (a.lat - b.lat) * 111195
  const east = (a.lon - b.lon) * 111195 * Math.cos((a.lat * Math.PI) / 180)
  return Math.hypot(north, east)
}
const isAt = (graph: GeoGraph, vehicleNid: number, facilityNid: number) => {
  const v = graph.nodes.get(vehicleNid)
  const f = graph.nodes.get(facilityNid)
  return v !== undefined && f !== undefined && metresBetween(v, f) <= AT_POINT_METRES
}

function VehicleRows({ node, graph, scenario }: Pick<Props, 'node' | 'graph' | 'scenario'>) {
  const vehicle = scenario.vehicles.find((v) => v.nid === node.nid)
  if (!vehicle) return null
  const missions = (scenario.assignments ?? []).filter((m) => m.vehicleId === vehicle.id)
  const aboard = missions.filter((m) => m.casualtyStatus === 'in_transit').map((m) => m.casualtyId)
  const toCollect = missions.filter((m) => m.casualtyStatus === 'assigned').map((m) => m.casualtyId)
  const capacity = vehicle.litterCapacity + vehicle.ambulatoryCapacity
  const base = scenario.facilities.find((f) => isAt(graph, vehicle.nid, f.nid))
  return (
    <>
      <Row label="Casualties aboard">
        {aboard.length} of {capacity}
        {aboard.length > 0 && <span className="text-slate-400"> ({aboard.join(', ')})</span>}
      </Row>
      <Row label="Capacity">
        {vehicle.litterCapacity} litter, {vehicle.ambulatoryCapacity} ambulatory
      </Row>
      {toCollect.length > 0 && <Row label="Going to collect">{toCollect.join(', ')}</Row>}
      {missions[0] && <Row label="Delivering to">{missions[0].destinationId}</Row>}
      {missions.length === 0 && base && <Row label="Waiting at">{base.name}</Row>}
      {/* battery_pct is the energy level for both types: fuel for an ambulance, battery for a UGV */}
      <Row label={vehicle.type === 'ambulance' ? 'Fuel' : 'Battery'}>
        {Math.round(vehicle.batteryPct)}%<Bar pct={vehicle.batteryPct} />
      </Row>
      <Row label="Range left">
        {Math.round((vehicle.rangeKm * vehicle.batteryPct) / 100)} of {vehicle.rangeKm} km
      </Row>
      {vehicle.speedKmh !== null && <Row label="Speed">{vehicle.speedKmh} km/h</Row>}
      <Row label="Damage">
        <span className={DAMAGE_CLASS[vehicle.damage] ?? ''}>
          {vehicle.damage || 'not recorded'}
        </span>
      </Row>
      <Row label="Highest threat it will drive through">{vehicle.maxThreat}</Row>
    </>
  )
}

function FacilityRows({
  facility,
  graph,
  scenario,
}: { facility: Facility; graph: GeoGraph; scenario: Scenario }) {
  const patients = linked(graph, facility.nid, 'HELD_AT', 'in')
  const onward = patients.filter((c) => c.status === 'awaiting_pickup').length
  const inbound = (scenario.assignments ?? []).filter((m) => m.destinationId === facility.id)
  const vehicles = scenario.vehicles.filter(
    (v) => v.status === 'idle' && isAt(graph, v.nid, facility.nid)
  )
  return (
    <>
      <Row label="State">{words(facility.state) || 'unknown'}</Row>
      <Row label="Patients here">
        {patients.length}
        {patients.length > 0 && (
          <span className="text-slate-400"> ({patients.map((c) => c.id).join(', ')})</span>
        )}
      </Row>
      {onward > 0 && <Row label="Waiting for onward transfer">{onward}</Row>}
      <Row label="On the way here">{list(inbound.map((m) => m.casualtyId))}</Row>
      <Row label="Free beds">{facility.freeBeds}</Row>
      <Row label="Medics available">{facility.medics}</Row>
      <Row label="Capabilities">{list(facility.capabilities.map(words))}</Row>
      <Row label="Equipment">{list(facility.equipment.map(words))}</Row>
      <Row label="Vehicles waiting here">{list(vehicles.map((v) => v.id))}</Row>
    </>
  )
}

function MedicRows({ node, graph, scenario }: Omit<Props, 'onClose' | 'now'>) {
  const pointNode = linked(graph, node.nid, 'BASED_AT', 'out')[0]
  const facility = scenario.facilities.find((f) => f.nid === pointNode?.nid)
  return (
    <>
      <Row label="Team status">{words(node.status) || 'unknown'}</Row>
      {facility && (
        <>
          <Row label="Based at">{facility.name}</Row>
          <FacilityRows facility={facility} graph={graph} scenario={scenario} />
        </>
      )}
    </>
  )
}

function CommandRows({ node, scenario }: Pick<Props, 'node' | 'scenario'>) {
  const count = (status: string) => scenario.casualties.filter((c) => c.status === status).length
  const idle = scenario.vehicles.filter((v) => v.status === 'idle').length
  return (
    <>
      <Row label="Status">{words(node.status) || 'unknown'}</Row>
      <Row label="Casualties to triage">{count('reported')}</Row>
      <Row label="Waiting for pickup">{count('awaiting_pickup')}</Row>
      <Row label="Assigned / in transit">
        {count('assigned')} / {count('in_transit')}
      </Row>
      <Row label="Delivered">{count('delivered')}</Row>
      <Row label="Vehicles idle">
        {idle} of {scenario.vehicles.length}
      </Row>
      <Row label="Free beds, all points">
        {scenario.facilities.reduce((sum, f) => sum + f.freeBeds, 0)}
      </Row>
    </>
  )
}

export function EntityCard({ node, graph, scenario, onClose }: Props) {
  const facility =
    node.label === 'MedicalPoint' ? scenario.facilities.find((f) => f.nid === node.nid) : undefined
  const subtitle =
    node.label === 'MedicalPoint'
      ? `${facility?.name ?? ''} · ${FACILITY_LABEL[node.kind] ?? node.kind}`
      : node.label === 'Vehicle'
        ? `${node.kind === 'ugv' ? 'UGV' : words(node.kind)} · ${words(node.status)}`
        : node.label === 'Medic'
          ? `${node.kind} medic team`
          : 'Command post'
  return (
    <section
      aria-label={`${node.id} details`}
      className="pointer-events-auto flex min-h-0 flex-col overflow-hidden rounded-lg border border-[#334155] bg-[#0e1b26]/95 shadow-xl backdrop-blur"
    >
      <header className="flex items-center justify-between gap-2 border-b border-[#334155] px-3 py-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-sky-200">{node.id}</h2>
          <p className="mt-1 text-[11px] text-slate-400">{subtitle}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close details"
          className="rounded px-2 py-1 text-slate-300 hover:bg-slate-700"
        >
          ✕
        </button>
      </header>
      <dl className="min-h-0 overflow-y-auto px-3 py-2 text-xs">
        {node.label === 'Vehicle' && <VehicleRows node={node} graph={graph} scenario={scenario} />}
        {facility && <FacilityRows facility={facility} graph={graph} scenario={scenario} />}
        {node.label === 'Medic' && <MedicRows node={node} graph={graph} scenario={scenario} />}
        {node.label === 'Command' && <CommandRows node={node} scenario={scenario} />}
      </dl>
    </section>
  )
}
