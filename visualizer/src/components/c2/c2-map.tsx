import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useEffect, useRef } from 'react'

import { executeCypherQuery } from '@/api'
import './c2.css'
import {
  BASEMAP_STYLE,
  EDGE_STYLE,
  OTHER_EDGE_STYLE,
  ROAD_BASE_COLOR,
  ROAD_CLOSED_COLOR,
  nodeColor,
  roadWeight,
  threatColor,
} from './colors'
import type { GeoGraph, GraphEdge, GraphNode } from './graph-data'

// Sector bounds (south-west, north-east): Robotyne front to Zaporizhzhia
const SECTOR_BOUNDS = L.latLngBounds([47.4, 35.0], [47.9, 35.95])
const VILLAGE_LABEL_MIN_ZOOM = 11

type Props = { graph: GeoGraph | undefined; graphName: string; change: string | undefined }

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

function nodeMarker(n: GraphNode): L.CircleMarker {
  const junction = n.label === 'Junction'
  return L.circleMarker([n.lat, n.lon], {
    radius: junction ? 1.8 : 7,
    color: junction ? nodeColor(n.label, n.kind) : n.derived ? '#ffffff' : '#0b1118',
    weight: junction ? 0 : 2,
    dashArray: n.derived ? '2 2' : undefined,
    fillColor: nodeColor(n.label, n.kind),
    fillOpacity: 1,
  })
}

export const C2Map = ({ graph, graphName, change }: Props) => {
  const container = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const graphLayer = useRef<L.LayerGroup | null>(null)
  // Read by the click handler so an inspector popup queries the branch currently shown
  const source = useRef({ graphName, change })
  source.current = { graphName, change }

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
    L.control.zoom({ position: 'bottomright' }).addTo(m)
    m.attributionControl.setPrefix(false)
    m.attributionControl.addAttribution('Map data © OpenStreetMap contributors (ODbL)')
    m.fitBounds(SECTOR_BOUNDS)
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

    for (const e of graph.edges) {
      const a = graph.nodes.get(e.src)
      const b = graph.nodes.get(e.dst)
      if (!a || !b) continue
      L.polyline(
        [
          [a.lat, a.lon],
          [b.lat, b.lon],
        ],
        { ...edgeStyle(e), interactive: false }
      ).addTo(group)
    }

    // Junctions first, then the scenario nodes on top of them
    const ordered = [...graph.nodes.values()].sort(
      (x, y) => Number(x.label !== 'Junction') - Number(y.label !== 'Junction')
    )
    for (const n of ordered) {
      const marker = nodeMarker(n)
      if (n.label !== 'Junction') {
        marker.bindTooltip(n.id, {
          permanent: true,
          direction: 'right',
          offset: [6, 0],
          className: 'c2-node-label',
        })
      }
      marker.on('click', () => inspect(m, n))
      marker.addTo(group)
    }
    group.addTo(m)
    graphLayer.current = group
  }, [graph])

  // Node inspector: all properties of the clicked node, read from the branch being shown
  async function inspect(m: L.Map, n: GraphNode) {
    const popup = L.popup({ className: 'c2-inspector', maxWidth: 320 })
      .setLatLng([n.lat, n.lon])
      .setContent(`<b>${escapeHtml(n.label)}</b> ${escapeHtml(n.id)}<br/>loading...`)
      .openOn(m)
    try {
      const { graphName: g, change: c } = source.current
      const data = await executeCypherQuery({
        graph: g,
        change: c,
        query: `CALL db.getNodes([${n.nid}]) YIELD properties RETURN properties`,
      })
      const props = JSON.parse((data[0][0] as string[])[0]) as Record<string, unknown>
      const rows = Object.entries(props)
        .map(
          ([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(JSON.stringify(v))}</td></tr>`
        )
        .join('')
      popup.setContent(
        `<b>${escapeHtml(n.label)}</b> ${escapeHtml(n.id)}<span class="c2-inspector-nid"> node ${n.nid}</span>` +
          `${n.derived ? '<div class="c2-inspector-note">position derived from neighbours</div>' : ''}` +
          `<table>${rows}</table>`
      )
    } catch (err) {
      popup.setContent(
        `<b>${escapeHtml(n.id)}</b><br/>could not load properties: ${escapeHtml(String(err))}`
      )
    }
  }

  return <div ref={container} className="c2-map h-full w-full" />
}
