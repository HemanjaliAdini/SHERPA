import { useState } from 'react'
import { TRIAGE_COLOR } from './colors'
import { Kbd } from './map-controls'
import { type Casualty, formatClock, formatWait } from './scenario-data'
import { MOBILITIES, TRIAGE_CATEGORIES } from './sim'

const OFF_ROAD_WARNING_M = 500

type Props = {
  queue: Casualty[]
  now: Date
  /** casualty node currently selected on the map */
  selectedNid: number | null
  onLocate: (c: Casualty) => void
  onPlan?: (c: Casualty) => void
  /** absent while a reset is pending: no triage on top of it */
  onTriage?: (
    c: Casualty,
    category: (typeof TRIAGE_CATEGORIES)[number],
    mobility: (typeof MOBILITIES)[number]
  ) => void
}

const STATUS_LABEL: Record<string, string> = {
  reported: 'Needs triage',
  dead: 'Dead',
  awaiting_pickup: 'Awaiting pickup',
  assigned: 'Mission assigned',
  in_transit: 'In transit',
}

// The medic's only decision: category and mobility, from the MIST report. Open until dispatched.
const TriageButtons = ({
  c,
  onTriage,
}: { c: Casualty; onTriage: NonNullable<Props['onTriage']> }) => {
  const [mobility, setMobility] = useState<(typeof MOBILITIES)[number]>(
    c.mobility === 'ambulatory' ? 'ambulatory' : 'litter'
  )
  return (
    <div className="border-grey-700 flex flex-wrap items-center gap-1 border-t px-3 py-2">
      {MOBILITIES.map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => setMobility(m)}
          className={`rounded px-2 py-1 text-xs capitalize ${mobility === m ? 'bg-grey-600 text-content-primary' : 'text-content-fourth hover:bg-grey-700'}`}
        >
          {m}
        </button>
      ))}
      <span className="ml-auto flex gap-1">
        {TRIAGE_CATEGORIES.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => onTriage(c, t, mobility)}
            className="rounded px-2 py-1 text-xs font-bold text-[#0b1118]"
            style={{ background: TRIAGE_COLOR[t] ?? '#9ca3af' }}
          >
            {t}
          </button>
        ))}
      </span>
    </div>
  )
}

export const CasualtyQueue = ({ queue, now, selectedNid, onLocate, onPlan, onTriage }: Props) => (
  <div className="flex min-h-0 flex-1 flex-col">
    <div className="border-grey-700 flex items-baseline justify-between border-b px-4 py-3">
      <h2 className="text-base font-semibold">Casualties</h2>
      <span className="text-content-fourth text-sm">{queue.length} active</span>
    </div>
    <ol className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
      {queue.length === 0 && (
        <li className="text-content-fourth px-1 py-6 text-center text-sm">No active casualties</li>
      )}
      {queue.map((c, i) => {
        const selected = c.nid === selectedNid
        const colour = TRIAGE_COLOR[c.triage] ?? '#9ca3af'
        const offRoad = c.offRoadMetres !== null && c.offRoadMetres > OFF_ROAD_WARNING_M
        return (
          <li key={c.nid}>
            <div
              className={`bg-grey-800 hover:bg-grey-700 flex overflow-hidden rounded-lg border ${selected ? 'border-[#fde047]' : 'border-grey-700'}`}
            >
              <div className="w-2 shrink-0" style={{ background: colour }} />
              <button
                type="button"
                className="flex-1 px-3 py-2.5 text-left"
                onClick={() => onLocate(c)}
                title="Show on map"
              >
                <div className="flex items-center gap-2">
                  <span
                    className="rounded px-1.5 py-0.5 text-sm font-bold text-[#0b1118]"
                    style={{ background: colour }}
                  >
                    {c.triage || '?'}
                  </span>
                  <span className="text-lg font-semibold">{c.id}</span>
                  {i < 9 && (
                    <span className="ml-auto">
                      <Kbd>{i + 1}</Kbd>
                    </span>
                  )}
                </div>
                <div className="text-content-primary mt-1 text-sm capitalize">
                  {c.mobility || 'mobility unknown'} {'·'} waiting{' '}
                  <span className="font-semibold">{formatWait(c.injuredAt, now)}</span>
                </div>
                <div className="text-content-fourth mt-0.5 text-xs">
                  Injured {formatClock(c.injuredAt)} {'·'} {STATUS_LABEL[c.status] ?? c.status}
                </div>
                {c.stranded && (
                  <div className="mt-1 rounded bg-[#4c0519] px-2 py-1 text-xs font-medium text-[#ffe4e6]">
                    Stranded: its vehicle stopped. Picked up first, by the next free vehicle of that
                    type
                  </div>
                )}
                {c.mist.injuries && (
                  <div className="text-content-primary mt-1 space-y-0.5 text-xs">
                    <div>M: {c.mist.mechanism}</div>
                    <div>I: {c.mist.injuries}</div>
                    <div>S: {c.mist.signs}</div>
                    <div>T: {c.mist.treatment}</div>
                  </div>
                )}
                {offRoad && (
                  <div className="mt-1 text-xs font-medium text-[#fbbf24]">
                    {(Number(c.offRoadMetres) / 1000).toFixed(1)} km from the nearest road
                  </div>
                )}
              </button>
              {onPlan && (
                <button
                  type="button"
                  onClick={() => onPlan(c)}
                  disabled={c.status !== 'awaiting_pickup'}
                  className="border-grey-700 hover:bg-grey-600 w-24 shrink-0 border-l px-2 text-sm font-semibold disabled:opacity-40"
                >
                  Plan pickup
                </button>
              )}
            </div>
            {onTriage && (c.status === 'reported' || c.status === 'awaiting_pickup') && (
              <TriageButtons c={c} onTriage={onTriage} />
            )}
          </li>
        )
      })}
    </ol>
  </div>
)
