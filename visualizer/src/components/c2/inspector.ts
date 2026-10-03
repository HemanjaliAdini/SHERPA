// Node inspector content shared by the 2D and 3D maps: properties read from the branch being
// shown, plus the node's relationships. Rendered as HTML styled by `.c2-inspector` in c2.css.
import { executeCypherQuery } from '@/api'
import { typeTitle } from './events'
import type { GeoGraph, GraphNode } from './graph-data'
import { formatClock } from './scenario-data'

const MAX_LISTED_RELATIONSHIPS = 12

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

const time = (v: unknown) => (v ? formatClock(new Date(String(v))) : '')

/** An event as a person reads it: what, when, what it did and how it ended (PRD section 5, Events) */
function eventCard(id: string, p: Record<string, unknown>): string {
  const status = String(p.status ?? '')
  let payload: Record<string, unknown> = {}
  try {
    payload = JSON.parse(String(p.payload ?? '{}'))
  } catch {}
  const details = Object.entries(payload)
    .map(
      ([k, v]) =>
        `<tr><td>${escapeHtml(k.replace(/_/g, ' '))}</td><td>${escapeHtml(String(v))}</td></tr>`
    )
    .join('')
  const section = (title: string, body: string, cls = '') =>
    `<div class="c2-inspector-section">${title}</div><div class="c2-event-line ${cls}">${body}</div>`
  const ending =
    status === 'resolved'
      ? section(
          'How it ended',
          `&#10003; ${time(p.resolved_at)} ${escapeHtml(String(p.resolution ?? ''))}`,
          'c2-event-ended'
        )
      : status === 'applied'
        ? section('Now', 'Still in effect')
        : status === 'failed'
          ? section('Failed', escapeHtml(String(p.error ?? '')))
          : section('Now', 'Not happened yet')
  return [
    `<div class="c2-event-card c2-event-${escapeHtml(status)}">`,
    `<div class="c2-event-head"><b>${escapeHtml(id)}</b> ${escapeHtml(typeTitle(String(p.type ?? '')))}`,
    `<span class="c2-event-status">${escapeHtml(status)}</span></div>`,
    `<div class="c2-inspector-note">${time(p.at)} \u00b7 from ${escapeHtml(String(p.source ?? 'unknown'))}</div>`,
    p.summary ? section('What happened', escapeHtml(String(p.summary))) : '',
    ending,
    details ? `<div class="c2-inspector-section">Details</div><table>${details}</table>` : '',
    '</div>',
  ].join('')
}

/**
 * Calls `render` with the content straight away (properties still loading), then again once the
 * node's properties have been fetched or failed to load. `quiet` skips the first call: a refresh of
 * an open inspector keeps showing the old content until the new one is ready.
 */
export async function inspectNode(
  g: GeoGraph | undefined,
  n: GraphNode,
  graphName: string,
  change: string | undefined,
  render: (html: string) => void,
  quiet = false
) {
  const relationships = (g?.incident.get(n.nid) ?? [])
    .slice(0, MAX_LISTED_RELATIONSHIPS)
    .map((i) => {
      const e = g?.edges[i]
      if (!e || !g) return ''
      const outgoing = e.src === n.nid
      const other = g.nodes.get(outgoing ? e.dst : e.src)
      const name = other ? `${other.label} ${other.id}` : `node ${outgoing ? e.dst : e.src}`
      const metres = e.metres === null ? '' : ` (${Math.round(e.metres)} m)`
      return `<li>${outgoing ? '→' : '←'} <b>${escapeHtml(e.type)}</b> ${escapeHtml(name)}${metres}</li>`
    })
    .join('')
  const total = g?.incident.get(n.nid)?.length ?? 0
  const more =
    total > MAX_LISTED_RELATIONSHIPS ? `<li>and ${total - MAX_LISTED_RELATIONSHIPS} more</li>` : ''
  const header =
    `<b>${escapeHtml(n.label)}</b> ${escapeHtml(n.id)}<span class="c2-inspector-nid"> node ${n.nid}</span>` +
    `${n.derived ? '<div class="c2-inspector-note">position derived from neighbours</div>' : ''}`
  const relationshipsHtml = `<div class="c2-inspector-section">Relationships</div><ul>${relationships || '<li>none</li>'}${more}</ul>`

  if (!quiet)
    render(
      `${header}${relationshipsHtml}<div class="c2-inspector-note">loading properties...</div>`
    )
  try {
    const data = await executeCypherQuery({
      graph: graphName,
      change,
      query: `CALL db.getNodes([${n.nid}]) YIELD properties RETURN properties`,
    })
    const props = JSON.parse((data[0][0] as string[])[0]) as Record<string, unknown>
    if (n.label === 'Event') {
      render(eventCard(n.id, props))
      return
    }
    const rows = Object.entries(props)
      .map(
        ([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(JSON.stringify(v))}</td></tr>`
      )
      .join('')
    render(
      `${header}<div class="c2-inspector-section">Properties</div><table>${rows}</table>${relationshipsHtml}`
    )
  } catch (err) {
    render(
      `${header}${relationshipsHtml}<div class="c2-inspector-note">could not load properties: ${escapeHtml(String(err))}</div>`
    )
  }
}
