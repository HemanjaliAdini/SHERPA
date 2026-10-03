import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'

import { executeCypherQuery } from '@/api'
import './c2.css'
import {
  BASEMAP_STYLE,
  EDGE_STYLE,
  HIGHLIGHT_COLOR,
  MISSION_ROUTE_STYLE,
  OTHER_EDGE_STYLE,
  ROAD_BASE_COLOR,
  ROAD_CLOSED_COLOR,
  nodeColor,
  roadWeight,
  threatColor,
} from './colors'
import type { GeoGraph, GraphEdge, GraphNode } from './graph-data'
import type { Selection } from './selection'

// Sector bounds (south-west, north-east): Robotyne front to Zaporizhzhia
const SECTOR_BOUNDS = L.latLngBounds([47.4, 35.0], [47.9, 35.95])
const VILLAGE_LABEL_MIN_ZOOM = 11
const DIMMED = 0.12
const MAX_LISTED_RELATIONSHIPS = 12

type Props = {
  graph: GeoGraph | undefined
  selection: Selection | null
  /** Called with a node id when a node is clicked, or null when empty map is clicked */
  onSelectNode: (nid: number | null) => void
  graphName: string
  change: string | undefined
  /** Incremented to ask the map to zoom to the current selection (e.g. after a query) */
  fitRequest: number
}

/** Commands the page can send to the map (buttons and keyboard shortcuts). */
export type C2MapHandle = {
  zoomIn: () => void
  zoomOut: () => void
  resetView: () => void
  /** Bring these nodes into view */
  focusNodes: (nids: number[]) => void
}

async function loadGeoJson(name: string): Promise<GeoJSON.FeatureCollection> {
  const res = await fetch(`/basemap/${name}.geojson`)
  return res.json()
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

function edgeStyle(e: GraphEdge): L.PolylineOptions {
  if (e.type === 'ROAD') {
    return {
      color: e.closed ? ROAD_CLOSED_COLOR : e.threat > 0 ? threatColor(e.threat) : ROAD_BASE_COLOR,
      weight: roadWeight(e.highway),
      dashArray: e.closed ? '2 6' : undefined,
      opacity: 0.95,
    }
  }
  return { ...(EDGE_STYLE[e.type] ?? OTHER_EDGE_STYLE), opacity: 0.95 }
}

type NodeLook = { radius: number; style: L.CircleMarkerOptions }

function nodeLook(n: GraphNode, anchors: Set<number>): NodeLook {
  const color = nodeColor(n.label, n.kind)
  if (n.label === 'Junction') {
    // Junctions that a scenario node hangs off are drawn larger so the link is visible
    const anchor = anchors.has(n.nid)
    return {
      radius: anchor ? 3.5 : 1.8,
      style: {
        color: '#dbe4ee',
        weight: anchor ? 1.5 : 0,
        fillColor: color,
        fillOpacity: 1,
        opacity: 1,
      },
    }
  }
  return {
    radius: 7,
    style: {
      color: n.derived ? '#ffffff' : '#0b1118',
      weight: 2,
      dashArray: n.derived ? '2 2' : undefined,
      fillColor: color,
      fillOpacity: 1,
      opacity: 1,
    },
  }
}

export const C2Map = forwardRef<C2MapHandle, Props>(function C2Map(
  { graph, selection, onSelectNode, graphName, change, fitRequest },
  ref
) {
  const container = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const graphLayer = useRef<L.LayerGroup | null>(null)
  const edgeLines = useRef<L.Polyline[]>([])
  const nodeMarkers = useRef(new Map<number, { marker: L.CircleMarker; look: NodeLook }>())
  // Read by event handlers, so they always see the latest props without re-binding
  const latest = useRef({ graph, graphName, change, onSelectNode })
  latest.current = { graph, graphName, change, onSelectNode }

  // Create the map and the offline basemap once
  useEffect(() => {
    if (!container.current) return
    const m = L.map(container.current, {
      preferCanvas: true,
      zoomControl: false,
      minZoom: 8,
      maxZoom: 16,
      zoomSnap: 0.5,
      maxBounds: SECTOR_BOUNDS.pad(0.3),
    })
    m.attributionControl.setPrefix(false)
    m.attributionControl.addAttribution('Map data © OpenStreetMap contributors (ODbL)')
    m.fitBounds(SECTOR_BOUNDS)
    m.on('click', () => latest.current.onSelectNode(null))
    map.current = m

    let cancelled = false
    const places = L.layerGroup().addTo(m)
    const villages = L.layerGroup()
    const syncVillages = () => {
      const show = m.getZoom() >= VILLAGE_LABEL_MIN_ZOOM
      if (show && !m.hasLayer(villages)) villages.addTo(m)
      if (!show && m.hasLayer(villages)) m.removeLayer(villages)
    }
    m.on('zoomend', syncVillages)

    // Basemap goes in its own pane below the graph, so load order does not matter
    m.createPane('basemap').style.zIndex = '350'
    ;(async () => {
      const [forest, builtup, water, rivers, railways, placeData] = await Promise.all(
        ['forest', 'builtup', 'water', 'rivers', 'railways', 'places'].map(loadGeoJson)
      )
      if (cancelled) return
      const basemap = (data: GeoJSON.FeatureCollection, style: L.PathOptions) =>
        L.geoJSON(data, { style, interactive: false, pane: 'basemap' }).addTo(m)
      basemap(forest, BASEMAP_STYLE.forest)
      basemap(builtup, BASEMAP_STYLE.builtup)
      basemap(water, BASEMAP_STYLE.water)
      basemap(rivers, BASEMAP_STYLE.rivers)
      basemap(railways, BASEMAP_STYLE.railways)

      for (const f of placeData.features) {
        if (f.geometry.type !== 'Point') continue
        const [lon, lat] = f.geometry.coordinates
        const { name, name_en: nameEn, place } = f.properties as Record<string, string>
        const major = place === 'city' || place === 'town'
        L.circleMarker([lat, lon], {
          pane: 'basemap',
          radius: major ? 3 : 2,
          color: '#0b1118',
          weight: 1,
          fillColor: major ? '#dbe4ee' : '#8b9bb0',
          fillOpacity: 0.8,
          interactive: false,
        })
          .bindTooltip(nameEn || name, {
            permanent: true,
            direction: 'left',
            className: major ? 'c2-place-label c2-place-label-major' : 'c2-place-label',
          })
          .addTo(major ? places : villages)
      }
      syncVillages()
    })()

    return () => {
      cancelled = true
      m.remove()
      map.current = null
      graphLayer.current = null
    }
  }, [])

  // (Re)draw the graph: every edge between its endpoints, every node at its lat/lon
  useEffect(() => {
    const m = map.current
    if (!m || !graph) return
    graphLayer.current?.remove()
    const group = L.layerGroup()

    edgeLines.current = graph.edges.map((e) => {
      const a = graph.nodes.get(e.src)
      const b = graph.nodes.get(e.dst)
      const line = L.polyline(
        a && b
          ? [
              [a.lat, a.lon],
              [b.lat, b.lon],
            ]
          : [],
        { ...edgeStyle(e), interactive: false }
      )
      return line.addTo(group)
    })

    // Mission routes under the nodes, so they read as the planned path
    for (const route of graph.routes.values()) {
      const points = route
        .map((nid) => graph.nodes.get(nid))
        .filter((n) => n !== undefined)
        .map((n) => [n.lat, n.lon] as [number, number])
      if (points.length > 1) {
        L.polyline(points, { ...MISSION_ROUTE_STYLE, interactive: false }).addTo(group)
      }
    }

    const anchors = new Set<number>()
    for (const e of graph.edges) {
      if (e.type !== 'ROAD') {
        anchors.add(e.src)
        anchors.add(e.dst)
      }
    }

    // Junctions first, then the scenario nodes on top of them
    const ordered = [...graph.nodes.values()].sort(
      (x, y) => Number(x.label !== 'Junction') - Number(y.label !== 'Junction')
    )
    nodeMarkers.current = new Map()
    for (const n of ordered) {
      const look = nodeLook(n, anchors)
      const marker = L.circleMarker([n.lat, n.lon], { ...look.style, radius: look.radius })
      if (n.label !== 'Junction') {
        marker.bindTooltip(n.id, {
          permanent: true,
          direction: 'right',
          offset: [6, 0],
          className: 'c2-node-label',
        })
      }
      marker.on('click', (ev) => {
        L.DomEvent.stopPropagation(ev)
        latest.current.onSelectNode(n.nid)
        inspect(m, n)
      })
      marker.addTo(group)
      nodeMarkers.current.set(n.nid, { marker, look })
    }
    group.addTo(m)
    graphLayer.current = group
  }, [graph])

  // Highlight the selection and dim everything else; no selection restores the normal look
  useEffect(() => {
    if (!graph) return
    graph.edges.forEach((e, i) => {
      const line = edgeLines.current[i]
      if (!line) return
      const base = edgeStyle(e)
      if (!selection) line.setStyle(base)
      else if (selection.edges.has(i))
        line.setStyle({
          ...base,
          color: HIGHLIGHT_COLOR,
          weight: (base.weight ?? 1) + 2,
          opacity: 1,
        })
      else line.setStyle({ ...base, opacity: DIMMED })
    })
    for (const [nid, { marker, look }] of nodeMarkers.current) {
      if (!selection) {
        marker.setStyle(look.style).setRadius(look.radius)
      } else if (selection.nodes.has(nid)) {
        marker.setStyle({ ...look.style, opacity: 1, fillOpacity: 1 }).setRadius(look.radius + 1.5)
        marker.bringToFront()
      } else {
        marker
          .setStyle({ ...look.style, opacity: DIMMED, fillOpacity: DIMMED })
          .setRadius(look.radius)
      }
      const label = marker.getTooltip()?.getElement()
      if (label) label.style.opacity = !selection || selection.nodes.has(nid) ? '1' : '0.25'
    }
  }, [graph, selection])

  function focusNodes(nids: number[]) {
    const m = map.current
    if (!m || !graph) return
    const points = nids
      .map((nid) => graph.nodes.get(nid))
      .filter((n) => n !== undefined)
      .map((n) => L.latLng(n.lat, n.lon))
    if (points.length === 1) m.flyTo(points[0], Math.max(m.getZoom(), 14), { duration: 0.6 })
    else if (points.length > 1)
      m.flyToBounds(L.latLngBounds(points).pad(0.3), { maxZoom: 15, duration: 0.6 })
  }

  useImperativeHandle(ref, () => ({
    zoomIn: () => map.current?.zoomIn(),
    zoomOut: () => map.current?.zoomOut(),
    resetView: () => map.current?.flyToBounds(SECTOR_BOUNDS, { duration: 0.6 }),
    focusNodes,
  }))

  // Zoom to the selection on request, so a query result is brought into view
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new request should move the view
  useEffect(() => {
    if (selection && fitRequest > 0) focusNodes([...selection.nodes])
  }, [fitRequest])

  // Node inspector: properties read from the branch being shown, plus the node's relationships
  async function inspect(m: L.Map, n: GraphNode) {
    const g = latest.current.graph
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
      total > MAX_LISTED_RELATIONSHIPS
        ? `<li>and ${total - MAX_LISTED_RELATIONSHIPS} more</li>`
        : ''
    const header =
      `<b>${escapeHtml(n.label)}</b> ${escapeHtml(n.id)}<span class="c2-inspector-nid"> node ${n.nid}</span>` +
      `${n.derived ? '<div class="c2-inspector-note">position derived from neighbours</div>' : ''}`
    const relationshipsHtml = `<div class="c2-inspector-section">Relationships</div><ul>${relationships || '<li>none</li>'}${more}</ul>`

    const popup = L.popup({ className: 'c2-inspector', maxWidth: 360 })
      .setLatLng([n.lat, n.lon])
      .setContent(
        `${header}${relationshipsHtml}<div class="c2-inspector-note">loading properties...</div>`
      )
      .openOn(m)
    try {
      const data = await executeCypherQuery({
        graph: latest.current.graphName,
        change: latest.current.change,
        query: `CALL db.getNodes([${n.nid}]) YIELD properties RETURN properties`,
      })
      const props = JSON.parse((data[0][0] as string[])[0]) as Record<string, unknown>
      const rows = Object.entries(props)
        .map(
          ([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(JSON.stringify(v))}</td></tr>`
        )
        .join('')
      popup.setContent(
        `${header}<div class="c2-inspector-section">Properties</div><table>${rows}</table>${relationshipsHtml}`
      )
    } catch (err) {
      popup.setContent(
        `${header}${relationshipsHtml}<div class="c2-inspector-note">could not load properties: ${escapeHtml(String(err))}</div>`
      )
    }
  }

  return <div ref={container} className="c2-map h-full w-full" />
})
