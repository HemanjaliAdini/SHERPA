import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useEffect, useRef } from 'react'

import './c2.css'
import {
  BASEMAP_STYLE,
  ROAD_BASE_COLOR,
  ROAD_CLOSED_COLOR,
  roadWeight,
  threatColor,
} from './colors'
import type { Entity } from './entity-data'
import { entityMarker } from './entity-icons'
import type { RoadLine } from './road-data'

// Sector bounds (south-west, north-east): Robotyne front to Zaporizhzhia
const SECTOR_BOUNDS = L.latLngBounds([47.4, 35.0], [47.9, 35.95])
const VILLAGE_LABEL_MIN_ZOOM = 11

type Props = { roads: RoadLine[]; entities: Entity[] }

async function loadGeoJson(name: string): Promise<GeoJSON.FeatureCollection> {
  const res = await fetch(`/basemap/${name}.geojson`)
  return res.json()
}

export const C2Map = ({ roads, entities }: Props) => {
  const container = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const roadLayer = useRef<L.LayerGroup | null>(null)
  const entityLayer = useRef<L.LayerGroup | null>(null)

  // Create the map and the offline basemap once
  useEffect(() => {
    if (!container.current) return
    const m = L.map(container.current, {
      preferCanvas: true,
      zoomControl: false,
      minZoom: 8,
      maxZoom: 15,
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

    // Added in drawing order: background first, roads (added by the other effect) on top
    ;(async () => {
      const [forest, builtup, water, rivers, railways, placeData] = await Promise.all(
        ['forest', 'builtup', 'water', 'rivers', 'railways', 'places'].map(loadGeoJson)
      )
      if (cancelled) return
      L.geoJSON(forest, { style: BASEMAP_STYLE.forest, interactive: false }).addTo(m)
      L.geoJSON(builtup, { style: BASEMAP_STYLE.builtup, interactive: false }).addTo(m)
      L.geoJSON(water, { style: BASEMAP_STYLE.water, interactive: false }).addTo(m)
      L.geoJSON(rivers, { style: BASEMAP_STYLE.rivers, interactive: false }).addTo(m)
      L.geoJSON(railways, { style: BASEMAP_STYLE.railways, interactive: false }).addTo(m)
      // Roads may have been drawn already; keep them above the basemap
      roadLayer.current?.eachLayer((l) => (l as L.Polyline).bringToFront())

      for (const f of placeData.features) {
        if (f.geometry.type !== 'Point') continue
        const [lon, lat] = f.geometry.coordinates
        const { name, name_en: nameEn, place } = f.properties as Record<string, string>
        const major = place === 'city' || place === 'town'
        const marker = L.circleMarker([lat, lon], {
          radius: major ? 4 : 2.5,
          color: '#0b1118',
          weight: 1,
          fillColor: major ? '#dbe4ee' : '#8b9bb0',
          fillOpacity: 1,
          interactive: false,
        }).bindTooltip(nameEn || name, {
          permanent: true,
          direction: 'right',
          className: major ? 'c2-place-label c2-place-label-major' : 'c2-place-label',
        })
        marker.addTo(major ? places : villages)
      }
      syncVillages()
    })()

    return () => {
      cancelled = true
      m.remove()
      map.current = null
      roadLayer.current = null
      entityLayer.current = null
    }
  }, [])

  // (Re)draw roads whenever the road data changes, e.g. after switching what-if branch
  useEffect(() => {
    const m = map.current
    if (!m) return
    roadLayer.current?.remove()
    const group = L.layerGroup()
    for (const road of roads) {
      L.polyline(road.points, {
        color: road.closed
          ? ROAD_CLOSED_COLOR
          : road.threat > 0
            ? threatColor(road.threat)
            : ROAD_BASE_COLOR,
        weight: roadWeight(road.highway),
        opacity: road.closed ? 0.9 : 0.95,
        dashArray: road.closed ? '2 6' : undefined,
        interactive: false,
      }).addTo(group)
    }
    group.addTo(m)
    roadLayer.current = group
  }, [roads])

  // (Re)draw scenario entities (casualties, facilities, vehicles, threats)
  useEffect(() => {
    const m = map.current
    if (!m) return
    entityLayer.current?.remove()
    const group = L.layerGroup()
    for (const e of entities) entityMarker(e).addTo(group)
    group.addTo(m)
    entityLayer.current = group
  }, [entities])

  return <div ref={container} className="c2-map h-full w-full" />
}
