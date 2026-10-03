import { useEffect, useRef, useState } from 'react'

import { EVENT_COLOR } from './colors'
import { type SimEvent, describeEvent, happened } from './events'
import { formatClock } from './scenario-data'

type Props = {
  events: SimEvent[]
  /** Show an applied event on the map */
  onLocate: (e: SimEvent) => void
  /** Called once per event that happens, and again when it is resolved, while the screen is open */
  onApplied: (e: SimEvent) => void
}

const STATUS_STYLE: Record<string, string> = {
  pending: 'bg-grey-700 text-content-fourth',
  applied: 'text-white',
  resolved: 'bg-[#14532d] text-[#bbf7d0]',
  failed: 'bg-[#78350f] text-[#fde68a]',
}

/** The run's events in time order: pending ones are the script still to come, applied ones are on the map */
export const EventsPanel = ({ events, onLocate, onApplied }: Props) => {
  const [open, setOpen] = useState(true)
  const seen = useRef<Set<string> | null>(null)

  useEffect(() => {
    // Keyed by id and status, so a resolution is news too. The first load only records what has happened,
    // so opening the page mid-run is quiet
    const news = events.filter(happened).map((e) => [`${e.id}:${e.status}`, e] as const)
    if (seen.current) for (const [key, e] of news) if (!seen.current.has(key)) onApplied(e)
    seen.current = new Set(news.map(([key]) => key))
  }, [events, onApplied])

  if (events.length === 0) return null
  return (
    <div className="bg-grey-900/95 text-content-primary border-grey-700 pointer-events-auto w-72 rounded-md border text-xs shadow-lg">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="hover:bg-grey-800 flex w-full items-center justify-between rounded-t-md px-3 py-2"
      >
        <span className="font-medium tracking-wide uppercase">Events</span>
        <span className="text-content-fourth">
          {events.filter(happened).length}/{events.length} happened {open ? '▾' : '▸'}
        </span>
      </button>
      {open && (
        <ol className="border-grey-700 max-h-48 overflow-y-auto border-t">
          {events.map((e) => (
            <li key={e.id}>
              <button
                type="button"
                disabled={!happened(e)}
                onClick={() => onLocate(e)}
                title={e.error || (happened(e) ? 'Show on the map' : 'Not happened yet')}
                className="hover:bg-grey-800 flex w-full items-center gap-2 px-3 py-1.5 text-left disabled:hover:bg-transparent"
              >
                <span className="text-content-fourth font-mono">{formatClock(e.at)}</span>
                <span className={`flex-1 ${e.status === 'pending' ? 'text-content-fourth' : ''}`}>
                  {describeEvent(e)}
                  {e.status === 'resolved' && (
                    <span className="mt-0.5 block text-[#86efac]">
                      {'\u2713'} {formatClock(e.resolvedAt)} {e.resolution}
                    </span>
                  )}
                </span>
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_STYLE[e.status] ?? ''}`}
                  style={e.status === 'applied' ? { background: EVENT_COLOR } : undefined}
                >
                  {e.status}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
