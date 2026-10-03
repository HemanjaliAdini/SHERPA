import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useEffect, useState } from 'react'

import { FACILITY_LABEL, TRIAGE_COLOR } from './colors'
import type { GeoGraph } from './graph-data'
import { Kbd } from './map-controls'
import { createMission } from './missions'
import {
  type Candidate,
  type Plan,
  buildPlan,
  formatMinutes,
  planSelection,
  rangeKm,
  rankFacilities,
  rankVehicles,
} from './planner'
import { type Casualty, type Scenario, formatClock } from './scenario-data'
import type { Selection } from './selection'

type Props = {
  graph: GeoGraph
  graphName: string
  change: string | undefined
  scenario: Scenario
  initial: Casualty
  now: Date
  /** Route preview to highlight on the map (null clears it) */
  onPreview: (selection: Selection | null) => void
  onCreated: (missionId: string, plan: Plan) => void
  onClose: () => void
}

const Section = ({
  step,
  title,
  children,
}: { step: number; title: string; children: ReactNode }) => (
  <section className="border-grey-700 border-b px-4 py-3">
    <h3 className="text-content-fourth mb-2 text-xs font-semibold tracking-wide uppercase">
      {step}. {title}
    </h3>
    {children}
  </section>
)

const CheckIcon = ({ ok }: { ok: boolean }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    {ok ? (
      <path d="M5 13l4 4L19 7" stroke="#22c55e" strokeWidth="3" strokeLinecap="round" />
    ) : (
      <path d="M6 6l12 12M18 6L6 18" stroke="#ef4444" strokeWidth="3" strokeLinecap="round" />
    )}
  </svg>
)

function Choice<T extends { id: string }>({
  candidate,
  selected,
  onSelect,
  title,
  detail,
}: {
  candidate: Candidate<T>
  selected: boolean
  onSelect: () => void
  title: string
  detail: string
}) {
  const blocked = candidate.blockers.length > 0
  return (
    <button
      type="button"
      disabled={blocked}
      onClick={onSelect}
      className={`mb-1.5 w-full rounded-lg border px-3 py-2 text-left disabled:opacity-45 ${selected ? 'border-[#fde047] bg-grey-700' : 'border-grey-700 bg-grey-800 hover:bg-grey-700'}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-semibold">{title}</span>
        <span className="text-sm">
          {candidate.leg
            ? `${(candidate.leg.metres / 1000).toFixed(1)} km · ${formatMinutes(candidate.leg.minutes)}`
            : 'no route'}
        </span>
      </div>
      <div className="text-content-fourth text-xs">
        {blocked ? candidate.blockers.join(', ') : detail}
      </div>
    </button>
  )
}

export const MissionPlanner = ({
  graph,
  graphName,
  change,
  scenario,
  initial,
  now,
  onPreview,
  onCreated,
  onClose,
}: Props) => {
  const [casualties, setCasualties] = useState<Casualty[]>([initial])
  const [vehicleId, setVehicleId] = useState<string | null>(null)
  const [facilityId, setFacilityId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const casualtyKey = casualties.map((c) => c.id).join(',')

  const vehicles = useQuery({
    queryKey: ['plan-vehicles', graphName, change, casualtyKey],
    queryFn: () => rankVehicles(graph, graphName, change, scenario.vehicles, casualties),
  })
  const usable = (list: Candidate<{ id: string }>[] | undefined) =>
    list?.find((c) => c.blockers.length === 0)
  const vehicle =
    scenario.vehicles.find((v) => v.id === vehicleId) ??
    (usable(vehicles.data)?.item as (typeof scenario.vehicles)[number] | undefined)

  const facilities = useQuery({
    queryKey: ['plan-facilities', graphName, change, casualtyKey, vehicle?.id],
    queryFn: () =>
      rankFacilities(graph, graphName, change, vehicle!, scenario.facilities, casualties),
    enabled: vehicle !== undefined,
  })
  const facility =
    scenario.facilities.find(
      (f) => f.id === facilityId && facilities.data?.some((c) => c.item.id === f.id)
    ) ?? (usable(facilities.data)?.item as (typeof scenario.facilities)[number] | undefined)

  const plan = useQuery({
    queryKey: ['plan', graphName, change, casualtyKey, vehicle?.id, facility?.id],
    queryFn: () => buildPlan(graph, graphName, change, vehicle!, casualties, facility!),
    enabled: vehicle !== undefined && facility !== undefined,
  })

  // Show the planned route on the map while planning; clear it when the planner closes
  useEffect(() => {
    onPreview(plan.data ? planSelection(plan.data) : null)
  }, [plan.data, onPreview])
  useEffect(() => () => onPreview(null), [onPreview])

  const create = async () => {
    if (!plan.data?.ok || creating) return
    setCreating(true)
    setError(null)
    try {
      const confirmedPlan = plan.data
      onCreated(await createMission(graphName, confirmedPlan, now), confirmedPlan)
    } catch (err) {
      setError(String(err))
    } finally {
      setCreating(false)
    }
  }

  // Enter confirms the mission (when not typing in a field)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing =
        e.target instanceof HTMLElement &&
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)
      if (e.key === 'Enter' && !typing) create()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const others = scenario.casualties.filter(
    (c) => c.status === 'awaiting_pickup' && !casualties.some((x) => x.nid === c.nid)
  )
  const p = plan.data

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-grey-700 flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-base font-semibold">Plan pickup</h2>
        <button
          type="button"
          onClick={onClose}
          className="bg-grey-800 hover:bg-grey-700 border-grey-600 flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm"
        >
          Back to queue <Kbd>Esc</Kbd>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Section step={1} title="Casualties">
          {casualties.map((c, k) => (
            <div
              key={c.nid}
              className="bg-grey-800 mb-1.5 flex items-center gap-2 rounded-lg px-3 py-2"
            >
              <span
                className="rounded px-1.5 py-0.5 text-sm font-bold text-[#0b1118]"
                style={{ background: TRIAGE_COLOR[c.triage] ?? '#9ca3af' }}
              >
                {c.triage}
              </span>
              <span className="font-semibold">{c.id}</span>
              <span className="text-content-fourth text-sm capitalize">{c.mobility}</span>
              {k > 0 && (
                <button
                  type="button"
                  className="text-content-fourth hover:text-content-primary ml-auto text-sm underline"
                  onClick={() => setCasualties(casualties.filter((x) => x.nid !== c.nid))}
                >
                  remove
                </button>
              )}
            </div>
          ))}
          {others.length > 0 && (
            <select
              className="bg-grey-800 border-grey-600 mt-1 w-full rounded-lg border px-2 py-2 text-sm"
              value=""
              onChange={(e) => {
                const c = others.find((x) => x.id === e.target.value)
                if (c) setCasualties([...casualties, c])
              }}
            >
              <option value="" disabled>
                Add another casualty to this pickup...
              </option>
              {others.map((c) => (
                <option key={c.nid} value={c.id}>
                  {c.triage} {c.id} ({c.mobility})
                </option>
              ))}
            </select>
          )}
        </Section>

        <Section step={2} title="Vehicle (nearest by road)">
          {vehicles.isLoading && (
            <div className="text-content-fourth text-sm">Finding routes...</div>
          )}
          {vehicles.data?.map((c) => (
            <Choice
              key={c.item.id}
              candidate={c}
              selected={c.item.id === vehicle?.id}
              onSelect={() => {
                setVehicleId(c.item.id)
                setFacilityId(null)
              }}
              title={`${c.item.id} · ${c.item.type === 'ugv' ? 'UGV' : 'Ambulance'}`}
              detail={`${c.item.litterCapacity} litter, ${c.item.ambulatoryCapacity} seated · range ${rangeKm(c.item).toFixed(0)} km`}
            />
          ))}
        </Section>

        <Section step={3} title={vehicle?.type === 'ugv' ? 'Hand over at' : 'Deliver to'}>
          {!vehicle && <div className="text-content-fourth text-sm">Choose a vehicle first.</div>}
          {facilities.isLoading && (
            <div className="text-content-fourth text-sm">Finding routes...</div>
          )}
          {facilities.data?.map((c) => (
            <Choice
              key={c.item.id}
              candidate={c}
              selected={c.item.id === facility?.id}
              onSelect={() => setFacilityId(c.item.id)}
              title={`${c.item.id} · ${FACILITY_LABEL[c.item.type] ?? c.item.type}`}
              detail={`${c.item.name} · ${c.item.freeBeds} free beds · ${c.item.medics} medics`}
            />
          ))}
        </Section>

        <Section step={4} title="Route and checks">
          {plan.isLoading && <div className="text-content-fourth text-sm">Planning route...</div>}
          {vehicle && facility && plan.data === null && (
            <div className="text-sm text-[#fca5a5]">No road route connects these stops.</div>
          )}
          {p && (
            <>
              <div className="mb-2 flex items-baseline justify-between">
                <span className="text-2xl font-semibold">{(p.metres / 1000).toFixed(1)} km</span>
                <span className="text-sm">
                  {formatMinutes(p.minutes)} {'·'} arrives{' '}
                  <span className="font-semibold">
                    {formatClock(new Date(now.getTime() + p.minutes * 60000))}
                  </span>
                </span>
              </div>
              <ol className="text-content-fourth mb-2 space-y-0.5 text-xs">
                {p.legs.map((l) => (
                  <li key={`${l.from}-${l.to}`}>
                    {l.from} {'→'} {l.to}: {(l.metres / 1000).toFixed(1)} km,{' '}
                    {formatMinutes(l.minutes)}
                  </li>
                ))}
              </ol>
              <ul className="space-y-1 text-sm">
                {p.checks.map((c) => (
                  <li key={c.label} className="flex items-center gap-2">
                    <CheckIcon ok={c.ok} /> {c.label}
                  </li>
                ))}
              </ul>
              <div className="text-content-fourth mt-2 text-xs">
                Shortest road route; travel time from road speeds for this vehicle type.
              </div>
            </>
          )}
        </Section>
      </div>

      <div className="border-grey-700 border-t p-3">
        {error && <div className="mb-2 text-sm text-[#fca5a5]">{error}</div>}
        <button
          type="button"
          disabled={!p?.ok || creating}
          onClick={create}
          className="flex h-14 w-full items-center justify-center gap-3 rounded-lg bg-[#2563eb] text-base font-semibold text-white hover:bg-[#1d4ed8] disabled:opacity-40"
        >
          {creating ? 'Creating mission...' : 'Create mission'} <Kbd>Enter</Kbd>
        </button>
      </div>
    </div>
  )
}
