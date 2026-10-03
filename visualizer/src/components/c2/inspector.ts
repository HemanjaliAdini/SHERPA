// Node inspector content shared by the 2D and 3D maps: properties read from the branch being
// shown, plus the node's relationships. Rendered as HTML styled by `.c2-inspector` in c2.css.
import { executeCypherQuery } from '@/api'
import type { GeoGraph, GraphNode } from './graph-data'

const MAX_LISTED_RELATIONSHIPS = 12

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/**
 * Calls `render` with the content straight away (properties still loading), then again once the
 * node's properties have been fetched or failed to load.
 */
export async function inspectNode(
  g: GeoGraph | undefined,
  n: GraphNode,
  graphName: string,
  change: string | undefined,
  render: (html: string) => void
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

  render(`${header}${relationshipsHtml}<div class="c2-inspector-note">loading properties...</div>`)
  try {
    const data = await executeCypherQuery({
      graph: graphName,
      change,
      query: `CALL db.getNodes([${n.nid}]) YIELD properties RETURN properties`,
    })
    const props = JSON.parse((data[0][0] as string[])[0]) as Record<string, unknown>
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
