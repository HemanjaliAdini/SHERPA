import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { TRIAGE_COLOR } from './colors'
import { Kbd } from './map-controls'
import { type Casualty, formatClock, formatWait } from './scenario-data'
import { type MOBILITIES, TRIAGE_CATEGORIES } from './sim'

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

const words = (s: string) => s.replace(/_/g, ' ').replace(/ -> /g, ' → ')

// The drone's frame of a casualty, full screen: the whole frame with the person boxed (`-full.jpg`, made with the
// crop) beside the crop. Click anywhere or Esc closes it.
const PhotoThumb = ({ c, small = false }: { c: Casualty; small?: boolean }) => {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const close = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [open])
  const full = c.photo.replace(/\.jpg$/, '-full.jpg')
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="shrink-0 rounded focus-visible:ring-2 focus-visible:ring-white"
        title="Show the drone's photo"
      >
        <img
          src={c.photo}
          alt={`${c.id} seen from the drone`}
          className={`${small ? 'h-9 w-9' : 'h-16 w-16'} rounded object-cover`}
        />
        {!small && (
          <span className="text-content-fourth mt-0.5 block text-center text-[10px]">
            drone · enlarge
          </span>
        )}
      </button>
      {open &&
        // On document.body: an animated card (transform) would otherwise trap a fixed overlay inside it
        createPortal(
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="c2-fade-in fixed inset-0 z-[3000] flex cursor-zoom-out flex-wrap items-center justify-center gap-4 bg-black/85 p-6"
            aria-label="Close the drone photo"
          >
            <img
              src={full}
              alt={`${c.id}: the drone's whole frame, person boxed in red`}
              className="max-h-[80vh] max-w-[min(90vw,720px)] rounded object-contain"
              onError={(e) => {
                e.currentTarget.style.display = 'none'
              }}
            />
            <span className="text-content-primary flex flex-col items-center gap-2 text-sm">
              <img src={c.photo} alt={`${c.id} close up`} className="h-[min(60vh,320px)] rounded" />
              {c.id}, seen from the drone · click or Esc to close
            </span>
          </button>,
          document.body
        )}
    </>
  )
}

// Sensor fusion's suggestion with its reasons and sources (PRD section 5): it informs, the medic decides
const RecommendationBox = ({ c }: { c: Casualty }) => {
  const r = c.recommendation
  if (!r) return null
  if (c.triage) {
    // Decided: one line on what the system had suggested and whether the medic took it
    const verdict = !r.triage
      ? 'none'
      : r.triage === c.triage
        ? 'accepted'
        : `changed to ${c.triage}`
    return (
      <div className="c2-fade-in text-content-fourth mt-1 flex items-center gap-2 text-xs">
        {c.photo && <PhotoThumb c={c} small />}
        <span>
          Recommended {r.triage || 'nothing'}
          {r.confidence !== null && ` ${r.confidence.toFixed(2)}`} · {verdict}
          {r.disagree.length > 0 && (
            <span className="text-[#fde68a]">
              {' '}
              · sources disagree on {r.disagree.map(words).join(', ')}
            </span>
          )}
        </span>
      </div>
    )
  }
  const disagreeing = r.evidence.filter((e) => r.disagree.some((f) => e.startsWith(`${f}:`)))
  return (
    <div className="c2-fade-in border-grey-700 mt-2 flex gap-2 rounded border bg-[#0b1118] p-2 text-xs">
      {c.photo && <PhotoThumb c={c} />}
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-1.5">
          <span className="text-content-fourth">Recommended</span>
          {r.triage ? (
            <span
              className="rounded px-1.5 py-0.5 font-bold text-[#0b1118]"
              style={{ background: TRIAGE_COLOR[r.triage] ?? '#9ca3af' }}
            >
              {r.triage}
            </span>
          ) : (
            <span className="font-semibold">none: the medic decides</span>
          )}
          {r.confidence !== null && (
            <span
              className="text-content-primary font-mono"
              title="Confidence of the sources behind it"
            >
              {r.confidence.toFixed(2)}
            </span>
          )}
        </div>
        <div className="text-content-primary">{words(r.reason)}</div>
        {r.evidence.map((e) => (
          <div key={e} className="text-content-fourth">
            {words(e)}
          </div>
        ))}
        {disagreeing.length > 0 && (
          <div className="rounded bg-[#451a03] px-1.5 py-1 font-medium text-[#fde68a]">
            Sources disagree: {disagreeing.map(words).join('; ')}
          </div>
        )}
      </div>
    </div>
  )
}

// The medic's only decision: category and mobility, from the MIST report. Open until dispatched.
const mobilityOf = (c: Casualty): (typeof MOBILITIES)[number] =>
  (c.mobility || c.recommendation?.mobility) === 'ambulatory' ? 'ambulatory' : 'litter'

const MOBILITY_LABEL: Record<string, string> = { litter: 'Stretcher', ambulatory: 'Walks' }

const TriageButtons = ({
  c,
  onTriage,
}: { c: Casualty; onTriage: NonNullable<Props['onTriage']> }) => {
  // Mobility is not the medic's call: the drone's posture or the app give it; unknown means a stretcher, which fits
  // every vehicle that carries casualties lying down (the safe default)
  const mobility = mobilityOf(c)
  const suggested = c.triage ? '' : (c.recommendation?.triage ?? '')
  return (
    <div className="c2-fade-in border-grey-700 flex flex-wrap items-center gap-1 border-t px-3 py-2">
      <span className="ml-auto flex gap-1">
        {TRIAGE_CATEGORIES.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => onTriage(c, t, mobility)}
            className={`rounded px-2 py-1 text-xs font-bold text-[#0b1118] transition duration-150 hover:brightness-110 active:scale-95 ${t === suggested ? 'ring-2 ring-white' : ''}`}
            style={{ background: TRIAGE_COLOR[t] ?? '#9ca3af' }}
            title={t === suggested ? 'Recommended: one click accepts it' : undefined}
          >
            {t}
          </button>
        ))}
      </span>
    </div>
  )
}

// Triaged and waiting: the buttons stay out of the way until the medic chooses to change the decision
const ChangeTriage = ({
  c,
  onTriage,
}: { c: Casualty; onTriage: NonNullable<Props['onTriage']> }) => {
  const [open, setOpen] = useState(false)
  if (open)
    return (
      <TriageButtons
        c={c}
        onTriage={(...args) => {
          setOpen(false)
          onTriage(...args)
        }}
      />
    )
  return (
    <div className="flex justify-end px-3 py-1">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-content-fourth hover:text-content-primary text-xs underline"
      >
        Change triage
      </button>
    </div>
  )
}

const GroupHeader = ({
  label,
  count,
  urgent,
  rowRef,
}: {
  label: string
  count: number
  urgent?: boolean
  rowRef: (el: HTMLElement | null) => void
}) => (
  <li
    ref={rowRef}
    className={`px-1 pt-2 pb-0.5 text-xs font-semibold tracking-wide uppercase ${urgent ? 'text-[#fbbf24]' : 'text-content-fourth'}`}
  >
    {label} ({count})
  </li>
)

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
const SLIDE = { duration: 380, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }

/** FLIP: rows that change place slide from where they were; new rows fade in. Keyed elements, measured each render. */
function useSlidingRows() {
  const rows = useRef(new Map<string, HTMLElement>())
  const last = useRef(new Map<string, number>())
  useLayoutEffect(() => {
    const now = new Map<string, number>()
    for (const [key, el] of rows.current) now.set(key, el.offsetTop) // stable when the list scrolls
    if (!reducedMotion()) {
      for (const [key, top] of now) {
        const el = rows.current.get(key)
        const before = last.current.get(key)
        if (!el) continue
        if (before === undefined) {
          if (last.current.size > 0)
            el.animate(
              [
                { opacity: 0, transform: 'translateY(8px)' },
                { opacity: 1, transform: 'none' },
              ],
              SLIDE
            )
        } else if (Math.abs(before - top) > 1) {
          el.animate([{ transform: `translateY(${before - top}px)` }, { transform: 'none' }], SLIDE)
        }
      }
    }
    last.current = now
  })
  return (key: string) => (el: HTMLElement | null) => {
    if (el) rows.current.set(key, el)
    else rows.current.delete(key)
  }
}

export const CasualtyQueue = ({ queue, now, selectedNid, onLocate, onPlan, onTriage }: Props) => {
  const row = useSlidingRows()
  const list = useRef<HTMLOListElement>(null)
  // After a triage, bring the next casualty to triage into view (once the list has re-sorted)
  const advance = useRef(false)
  const untriagedKeys = queue
    .filter((c) => !c.triage)
    .map((c) => c.nid)
    .join(',')
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the set of untriaged casualties changes
  useEffect(() => {
    if (!advance.current) return
    advance.current = false
    const next = list.current?.querySelector<HTMLElement>('[data-untriaged="true"]')
    next?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'nearest' })
  }, [untriagedKeys])
  const triage: Props['onTriage'] = onTriage
    ? (...args) => {
        advance.current = true
        onTriage(...args)
      }
    : undefined
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-grey-700 flex items-baseline justify-between border-b px-4 py-3">
        <h2 className="text-base font-semibold">Casualties</h2>
        <span className="text-content-fourth text-sm">{queue.length} active</span>
      </div>
      <ol ref={list} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {queue.length === 0 && (
          <li className="text-content-fourth px-1 py-6 text-center text-sm">
            No active casualties
          </li>
        )}
        {queue.map((c, i) => {
          const triaged = Boolean(c.triage)
          const firstOfGroup = i === 0 || Boolean(queue[i - 1].triage) !== triaged
          const groupSize = queue.filter((q) => Boolean(q.triage) === triaged).length
          const selected = c.nid === selectedNid
          const colour = TRIAGE_COLOR[c.triage] ?? '#9ca3af'
          const offRoad = c.offRoadMetres !== null && c.offRoadMetres > OFF_ROAD_WARNING_M
          return (
            <Fragment key={c.nid}>
              {firstOfGroup && (
                <GroupHeader
                  label={triaged ? 'Triaged' : 'To triage'}
                  count={groupSize}
                  urgent={!triaged}
                  rowRef={row(triaged ? 'header-triaged' : 'header-to-triage')}
                />
              )}
              <li
                ref={row(String(c.nid))}
                data-untriaged={!triaged}
                className={`bg-grey-800 flex overflow-hidden rounded-lg border transition-colors duration-300 ${selected ? 'border-[#fde047]' : triaged ? 'border-grey-700' : 'border-[#f59e0b]'}`}
              >
                {/* One card: the colour strip runs down the whole card; header, recommendation and buttons inside */}
                <div className="w-2 shrink-0" style={{ background: colour }} />
                <div className="min-w-0 flex-1">
                  <div className="flex">
                    <button
                      type="button"
                      className="hover:bg-grey-700 flex-1 px-3 py-2.5 text-left transition-colors"
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
                        {!triaged && (
                          <span className="rounded bg-[#f59e0b] px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-[#0b1118]">
                            NEEDS TRIAGE
                          </span>
                        )}
                        {i < 9 && (
                          <span className="ml-auto">
                            <Kbd>{i + 1}</Kbd>
                          </span>
                        )}
                      </div>
                      <div className="text-content-primary mt-1 text-sm capitalize">
                        {c.mobility || c.recommendation?.mobility
                          ? MOBILITY_LABEL[mobilityOf(c)]
                          : 'Stretcher (mobility unknown)'}{' '}
                        {'·'} waiting{' '}
                        <span className="font-semibold">{formatWait(c.injuredAt, now)}</span>
                      </div>
                      <div className="text-content-fourth mt-0.5 text-xs">
                        Injured {formatClock(c.injuredAt)} {'·'}{' '}
                        {STATUS_LABEL[c.status] ?? c.status}
                      </div>
                      {c.stranded && (
                        <div className="mt-1 rounded bg-[#4c0519] px-2 py-1 text-xs font-medium text-[#ffe4e6]">
                          Stranded: its vehicle stopped. Picked up first, by the next free vehicle
                          of that type
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
                  {c.recommendation && (
                    <div className="px-3 pb-2">
                      <RecommendationBox c={c} />
                    </div>
                  )}
                  {triage && c.status === 'reported' && <TriageButtons c={c} onTriage={triage} />}
                  {triage && triaged && c.status === 'awaiting_pickup' && (
                    <ChangeTriage c={c} onTriage={triage} />
                  )}
                </div>
              </li>
            </Fragment>
          )
        })}
      </ol>
    </div>
  )
}
