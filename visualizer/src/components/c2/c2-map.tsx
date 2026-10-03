import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'

import './c2.css'
import {
  BASEMAP_STYLE,
  EDGE_STYLE,
  HIGHLIGHT_COLOR,
  MISSION_ROUTE_STYLE,
  OTHER_EDGE_STYLE,
  nodeColor,
  roadColor,
  roadWidth,
} from './colors'
import type { GeoGraph, GraphEdge, GraphNode } from './graph-data'
import { inspectNode } from './inspector'
import { type MapAlert, alertHtml, layoutAlerts } from './map-alerts'
import type { Selection } from './selection'
import { HOME_BOUNDS, HOME_PADDING, SECTOR_BOUNDS } from './view'

const latLngBounds = ([[w, south], [e, n]]: [[number, number], [number, number]]) =>
  L.latLngBounds([south, w], [n, e])
const SECTOR = latLngBounds(SECTOR_BOUNDS)
const HOME = latLngBounds(HOME_BOUNDS)
const HOME_FIT = {
  paddingTopLeft: [HOME_PADDING.left, HOME_PADDING.top] as L.PointTuple,
  paddingBottomRight: [HOME_PADDING.right, HOME_PADDING.bottom] as L.PointTuple,
}
const VILLAGE_LABEL_MIN_ZOOM = 11
const DIMMED = 0.12

type Props = {
  graph: GeoGraph | undefined
  selection: Selection | null
  /** Called with a node id when a node is clicked, or null when empty map is clicked */
  onSelectNode: (nid: number | null) => void
  graphName: string
  change: string | undefined
  /** Incremented to ask the map to zoom to the current selection (e.g. after a query) */
  fitRequest: number
  /** Applied events, drawn as callouts where they happened */
  alerts: MapAlert[]
}

/** Commands the page can send to the map (buttons and keyboard shortcuts). */
export type C2MapHandle = {
  zoomIn: () => void
  zoomOut: () => void
  resetView: () => void
  /** Bring these nodes into view */
  focusNodes: (nids: number[]) => void
  /** Move the view by screen pixels (arrow keys) */
  pan: (dx: number, dy: number) => void
  /** Turn and tilt the camera, in degrees; only the 3D view can */
  rotate: (degrees: number) => void
  tilt: (degrees: number) => void
  /** Swing the camera to look straight down; only the 3D view tilts, so 2D ignores it */
  topDown: () => void
  /** Return to the view from just before the last topDown (3D only) */
  restoreView: () => void
}

async function loadGeoJson(name: string): Promise<GeoJSON.FeatureCollection> {
  const res = await fetch(`/basemap/${name}.geojson`)
  return res.json()
}

function edgeStyle(e: GraphEdge): L.PolylineOptions {
  if (e.type === 'ROAD') {
    return {
      color: roadColor(e),
      weight: roadWidth(e),
      dashArray: e.closed ? '4 5' : undefined,
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

const SLIDE_MS = 900 // a little under one tick at 1x

function slide(marker: L.CircleMarker, from: L.LatLng, to: L.LatLng) {
  const start = performance.now()
  const step = (t: number) => {
    const k = Math.min((t - start) / SLIDE_MS, 1)
    marker.setLatLng([from.lat + (to.lat - from.lat) * k, from.lng + (to.lng - from.lng) * k])
    if (k < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

export const C2Map = forwardRef<C2MapHandle, Props>(function C2Map(
  { graph, selection, onSelectNode, graphName, change, fitRequest, alerts },
  ref
) {
  const container = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const graphLayer = useRef<L.LayerGroup | null>(null)
  const alertLayer = useRef<L.LayerGroup | null>(null)
  // The open inspector popup and its node, refreshed in place on each new graph (every tick while running)
  const inspected = useRef<{ popup: L.Popup; nid: number } | null>(null)
  // Alert stacking depends on the zoom (their screen distance), so they are laid out again after each zoom
  const [zoom, setZoom] = useState(0)
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
      maxBounds: SECTOR.pad(0.3),
    })
    m.attributionControl.setPrefix(false)
    m.attributionControl.addAttribution('Map data © OpenStreetMap contributors (ODbL)')
    m.fitBounds(HOME, HOME_FIT)
    m.on('click', () => latest.current.onSelectNode(null))
    m.on('zoomend', () => setZoom(m.getZoom()))
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
      // Only roads are drawn; NEAR, AFFECTS and mission links stay in the data (inspector, queries)
      const line = L.polyline(
        a && b && e.type === 'ROAD'
          ? [
              [a.lat, a.lon],
              [b.lat, b.lon],
            ]
          : [],
        { ...edgeStyle(e), interactive: false }
      )
      return line.addTo(group)
    })

    // What is left of each mission's route, in its vehicle's colour, under the nodes
    for (const route of graph.activeRoutes) {
      if (route.points.length > 1) {
        L.polyline(route.points, {
          ...MISSION_ROUTE_STYLE,
          color: route.color,
          interactive: false,
        }).addTo(group)
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
    // Where each node was drawn before this refresh, so moving vehicles slide instead of jumping
    const previous = new Map(
      [...nodeMarkers.current].map(([nid, { marker }]) => [nid, marker.getLatLng()])
    )
    nodeMarkers.current = new Map()
    for (const n of ordered) {
      // Missions have no place of their own; a casualty in transit rides inside its vehicle ("+1");
      // events are drawn as alerts (below)
      if (n.label === 'Mission' || n.label === 'Event' || n.status === 'in_transit') continue
      const look = nodeLook(n, anchors)
      const from = n.label === 'Junction' ? undefined : previous.get(n.nid)
      const marker = L.circleMarker(from ?? [n.lat, n.lon], { ...look.style, radius: look.radius })
      if (from && (from.lat !== n.lat || from.lng !== n.lon))
        slide(marker, from, L.latLng(n.lat, n.lon))
      if (n.label !== 'Junction' && n.tag) {
        marker.bindTooltip(n.tag, {
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

    const open = inspected.current
    if (open && m.hasLayer(open.popup)) {
      const n = graph.nodes.get(open.nid)
      if (!n) m.closePopup(open.popup)
      else {
        open.popup.setLatLng([n.lat, n.lon]) // a moving vehicle takes its popup along
        inspectNode(graph, n, graphName, change, (html) => open.popup.setContent(html), true)
      }
    }
  }, [graph])

  // Event alerts, above every marker; redrawn when they change, the selection does or the zoom does
  // biome-ignore lint/correctness/useExhaustiveDependencies: zoom only triggers a new layout
  useEffect(() => {
    const m = map.current
    if (!m) return
    alertLayer.current?.remove()
    const group = L.layerGroup()
    const points = alerts.map((alert) => {
      const { x, y } = m.latLngToContainerPoint([alert.lat, alert.lon])
      return { alert, x, y }
    })
    layoutAlerts(points).forEach(({ alert: a, stem }, order) => {
      const icon = L.divIcon({
        className: 'c2-alert-anchor',
        html: alertHtml(a, selection?.nodes.has(a.nid) ?? false, stem),
        iconSize: [0, 0],
      })
      // Drawn in layout order (open alerts last, on top); hovering lifts a compact one to read it
      const marker = L.marker([a.lat, a.lon], {
        icon,
        zIndexOffset: 10000 + order * 10,
        riseOnHover: true,
        riseOffset: 100000,
        keyboard: false,
      })
      marker.on('click', (ev) => {
        L.DomEvent.stopPropagation(ev)
        latest.current.onSelectNode(a.nid)
        const n = latest.current.graph?.nodes.get(a.nid)
        if (n) inspect(m, n)
      })
      marker.addTo(group)
    })
    group.addTo(m)
    alertLayer.current = group
  }, [alerts, selection, zoom])

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
    resetView: () => map.current?.flyToBounds(HOME, { ...HOME_FIT, duration: 0.6 }),
    focusNodes,
    pan: (dx, dy) => map.current?.panBy([dx, dy], { animate: false }),
    rotate: () => undefined,
    tilt: () => undefined,
    topDown: () => undefined,
    restoreView: () => undefined,
  }))

  // Zoom to the selection on request, so a query result is brought into view
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new request should move the view
  useEffect(() => {
    if (selection && fitRequest > 0) focusNodes([...selection.nodes])
  }, [fitRequest])

  // Node inspector: properties read from the branch being shown, plus the node's relationships
  function inspect(m: L.Map, n: GraphNode) {
    const popup = L.popup({ className: 'c2-inspector', maxWidth: 360 }).setLatLng([n.lat, n.lon])
    const { graph: g, graphName: name, change: ch } = latest.current
    inspected.current = { popup, nid: n.nid }
    let opened = false
    inspectNode(g, n, name, ch, (html) => {
      popup.setContent(html)
      if (!opened) popup.openOn(m)
      opened = true
    })
  }

  return <div ref={container} className="c2-map h-full w-full" />
})
