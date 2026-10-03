// Alerts on the map: each applied event is drawn as a callout where it happened (the closed road, the stopped
// vehicle, the new casualty), in place of a plain node marker. Same HTML in 2D (Leaflet) and 3D (deck.gl overlay).
import { SOLVING_TYPES, type SimEvent, describeEvent, eventTitle } from './events'
import type { GeoGraph } from './graph-data'
import { formatClock } from './scenario-data'

export type MapAlert = {
  nid: number
  lat: number
  lon: number
  title: string
  text: string
  /** just happened (or just resolved): drawn open, pulsing and on top; otherwise a compact tag that opens on hover */
  fresh: boolean
  /** its effect is over: drawn green, with how it ended */
  resolved: boolean
}

/** Alerts for the events in effect that have a place on the map, oldest first. A resolved event is drawn (green)
 * only while it is in `justResolved`, i.e. for a few seconds after it was resolved. `fresh` holds `id:status`. */
export function mapAlerts(
  graph: GeoGraph | undefined,
  events: SimEvent[],
  fresh: Set<string>,
  justResolved: Set<string>
): MapAlert[] {
  if (!graph) return []
  return events.flatMap((e) => {
    const resolved = e.status === 'resolved'
    const shown =
      (e.status === 'applied' || (resolved && justResolved.has(e.id))) && !SOLVING_TYPES.has(e.type)
    const n = shown ? graph.nodes.get(e.nid) : undefined
    if (!n) return []
    const title = eventTitle(e)
    const text = resolved
      ? `Resolved ${formatClock(e.resolvedAt)}: ${e.resolution}`
      : describeEvent(e)
    return [
      {
        nid: e.nid,
        lat: n.lat,
        lon: n.lon,
        title: `${formatClock(e.at)} ${title}`,
        // "New casualty CAS-8: ..." under the title "New casualty" says it twice
        text: text.startsWith(`${title} `) ? text.slice(title.length + 1) : text,
        fresh: fresh.has(`${e.id}:${e.status}`),
        resolved,
      },
    ]
  })
}

export type PlacedAlert = { alert: MapAlert; x: number; y: number; stem: number }

// Approximate callout sizes in pixels (open, and compact), for stacking only
const OPEN_BOX: [number, number] = [262, 58]
const COMPACT_BOX: [number, number] = [170, 26]
const STEM_PX = 14
const STEM_STEP_PX = 6
const MAX_STEM_PX = 320

/** Screen layout: alerts whose callouts would overlap are stacked upwards on longer stems. Open (fresh) alerts
 * are placed first, nearest their point, and come last so they are drawn on top. */
export function layoutAlerts(points: { alert: MapAlert; x: number; y: number }[]): PlacedAlert[] {
  const ordered = [...points.filter((p) => p.alert.fresh), ...points.filter((p) => !p.alert.fresh)]
  const taken: [number, number, number, number][] = []
  const placed = ordered.map((p) => {
    const [w, h] = p.alert.fresh ? OPEN_BOX : COMPACT_BOX
    const box = (stem: number): [number, number, number, number] => [
      p.x - w / 2,
      p.y - stem - h,
      p.x + w / 2,
      p.y - stem,
    ]
    const clash = (b: [number, number, number, number]) =>
      taken.some((t) => b[0] < t[2] && t[0] < b[2] && b[1] < t[3] && t[1] < b[3])
    let stem = STEM_PX
    while (clash(box(stem)) && stem < MAX_STEM_PX) stem += STEM_STEP_PX
    taken.push(box(stem))
    return { ...p, stem }
  })
  return placed.reverse()
}

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch
  )

/** The callout, with its tip at the event's point (the container is placed on the point) */
export function alertHtml(a: MapAlert, selected: boolean, stem = STEM_PX): string {
  const cls = `c2-alert${a.fresh ? ' c2-alert-fresh' : ''}${a.resolved ? ' c2-alert-resolved' : ''}${selected ? ' c2-alert-selected' : ''}`
  return [
    `<div class="${cls}" title="${escapeHtml(`${a.title}: ${a.text}`)}">`,
    `<div class="c2-alert-box"><span class="c2-alert-icon">${a.resolved ? '&#10003;' : '!'}</span>`,
    '<span class="c2-alert-body">',
    `<span class="c2-alert-title">${escapeHtml(a.title)}</span>`,
    `<span class="c2-alert-text">${escapeHtml(a.text)}</span></span></div>`,
    `<div class="c2-alert-stem" style="height:${stem}px"></div><div class="c2-alert-dot"></div></div>`,
  ].join('')
}
