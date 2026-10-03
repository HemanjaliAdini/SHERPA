// Tilted 3D view of the C2 graph (deck.gl): same offline basemap and colours as the 2D map, with
// scenario nodes drawn as columns whose height encodes a property. Same props as C2Map.
import {
  type Color,
  FlyToInterpolator,
  LinearInterpolator,
  type MapViewState,
  type PickingInfo,
  WebMercatorViewport,
} from '@deck.gl/core'
import { _TerrainExtension as TerrainExtension } from '@deck.gl/extensions'
import { TerrainLayer } from '@deck.gl/geo-layers'
import { GeoJsonLayer, LineLayer, PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers'
import DeckGL from '@deck.gl/react'
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import './c2.css'
import type { C2MapHandle } from './c2-map'
import {
  BASEMAP_STYLE,
  EDGE_STYLE,
  HIGHLIGHT_COLOR,
  MAP_BG,
  MISSION_ROUTE_STYLE,
  OTHER_EDGE_STYLE,
  ROAD_BASE_COLOR,
  ROAD_CLOSED_COLOR,
  nodeColor,
  roadWeight,
  threatColor,
} from './colors'
import type { GeoGraph, GraphEdge, GraphNode } from './graph-data'
import { inspectNode } from './inspector'
import type { Selection } from './selection'
import {
  type HeightAt,
  TERRAIN_IMAGE,
  type TerrainMeta,
  loadHeightSampler,
  loadTerrainMeta,
} from './terrain-sampler'
import { HOME_BOUNDS, HOME_PADDING } from './view'

type Props = {
  graph: GeoGraph | undefined
  selection: Selection | null
  /** Called with a node id when a node is clicked, or null when empty map is clicked */
  onSelectNode: (nid: number | null) => void
  graphName: string
  change: string | undefined
  /** Incremented to ask the map to fly to the current selection (e.g. after a query) */
  fitRequest: number
  /** Terrain height exaggeration; 0 draws the map flat */
  terrainScale?: number
}

type ViewState = MapViewState & {
  transitionDuration?: number | 'auto'
  transitionInterpolator?: FlyToInterpolator | LinearInterpolator
  onTransitionEnd?: () => void
}

// Sector bounds [[west, south], [east, north]]: Robotyne front to Zaporizhzhia
const PITCH = 55
const BEARING = -15
const VILLAGE_LABEL_MIN_ZOOM = 11
const DIMMED = 0.12
const ORBIT_DEG_PER_SEC = 6
// Double-tap Shift+Up: tilt smoothly to look straight down, keeping position, zoom and bearing;
// double-tap Shift+Down returns to the view from before
const TOP_DOWN_MS = 600
const TOP_DOWN_INTERPOLATOR = new LinearInterpolator(['pitch'])
function rgba(color: string, alpha = 1): [number, number, number, number] {
  const a = Math.round(alpha * 255)
  if (color.startsWith('#')) {
    const v = Number.parseInt(color.slice(1), 16)
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255, a]
  }
  const [r, g, b] = (color.match(/\d+/g) ?? []).map(Number)
  return [r ?? 0, g ?? 0, b ?? 0, a]
}

function edgeColor(e: GraphEdge): string {
  if (e.type === 'ROAD')
    return e.closed ? ROAD_CLOSED_COLOR : e.threat > 0 ? threatColor(e.threat) : ROAD_BASE_COLOR
  return (EDGE_STYLE[e.type] ?? OTHER_EDGE_STYLE).color
}

function edgeWidth(e: GraphEdge): number {
  return e.type === 'ROAD' ? roadWeight(e.highway) : (EDGE_STYLE[e.type] ?? OTHER_EDGE_STYLE).weight
}

type Basemap = Record<
  'forest' | 'builtup' | 'water' | 'rivers' | 'railways' | 'places',
  GeoJSON.FeatureCollection
>
type Place = { position: [number, number]; name: string; major: boolean }

let basemapPromise: Promise<Basemap> | null = null
const TERRAIN_EXTENSIONS = [new TerrainExtension()]
// Terrain mesh tolerance in real metres (scaled by the exaggeration where it is used)
const TERRAIN_MESH_ERROR_M = 4

function loadBasemap(): Promise<Basemap> {
  const names = ['forest', 'builtup', 'water', 'rivers', 'railways', 'places'] as const
  basemapPromise ??= Promise.all(
    names.map(async (name) => (await fetch(`/basemap/${name}.geojson`)).json())
  ).then((data) => Object.fromEntries(names.map((n, i) => [n, data[i]])) as Basemap)
  return basemapPromise
}

// Ground layers are drawn in order without depth testing, so coplanar layers never z-fight
const GROUND = { depthCompare: 'always', depthWriteEnabled: false } as const

function fitHome(width: number, height: number) {
  const vp = new WebMercatorViewport({ width, height })
  return vp.fitBounds(HOME_BOUNDS, { padding: HOME_PADDING })
}

export const C2Map3D = forwardRef<C2MapHandle, Props>(function C2Map3D(
  { graph, selection, onSelectNode, graphName, change, fitRequest, terrainScale = 0 },
  ref
) {
  const container = useRef<HTMLDivElement>(null)
  const [viewState, setViewState] = useState<ViewState>({
    longitude: 35.475,
    latitude: 47.65,
    zoom: 9.5,
    pitch: PITCH,
    bearing: BEARING,
    minZoom: 8,
    maxZoom: 16,
    maxPitch: 75,
  })
  const [basemap, setBasemap] = useState<Basemap | null>(null)
  const [terrain, setTerrain] = useState<TerrainMeta | null>(null)
  const [heightAt, setHeightAt] = useState<HeightAt | null>(null)
  const [orbiting, setOrbiting] = useState(false)
  const [inspector, setInspector] = useState<string | null>(null)
  const inspectToken = useRef(0)
  const flying = useRef(false)
  const beforeTopDown = useRef<ViewState | null>(null)

  useEffect(() => {
    let cancelled = false
    loadBasemap().then((b) => !cancelled && setBasemap(b))
    loadTerrainMeta()
      .then(async (t) => {
        if (cancelled) return
        setTerrain(t)
        const sampler = await loadHeightSampler(t)
        if (!cancelled) setHeightAt(() => sampler)
      })
      .catch(() => undefined) // no terrain built: the map stays flat
    return () => {
      cancelled = true
    }
  }, [])

  // Start framed on the operational area (home view), tilted
  useLayoutEffect(() => {
    const el = container.current
    if (!el) return
    const { longitude, latitude, zoom } = fitHome(el.clientWidth, el.clientHeight)
    setViewState((v) => ({ ...v, longitude, latitude, zoom }))
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new graph closes the inspector
  useEffect(() => setInspector(null), [graph])

  // Slow orbit around the centre of the view; paused while a fly-to is running
  useEffect(() => {
    if (!orbiting) return
    let frame = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      if (!flying.current) {
        setViewState(({ transitionDuration, transitionInterpolator, onTransitionEnd, ...v }) => ({
          ...v,
          bearing: ((v.bearing ?? 0) + dt * ORBIT_DEG_PER_SEC) % 360,
        }))
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [orbiting])

  function flyToSelection() {
    if (selection) flyToNodes([...selection.nodes])
  }

  function flyToNodes(nids: number[]) {
    const el = container.current
    if (!el || !graph) return
    const points = nids.map((nid) => graph.nodes.get(nid)).filter((n) => n !== undefined)
    if (points.length === 0) return
    const lons = points.map((n) => n.lon)
    const lats = points.map((n) => n.lat)
    const vp = new WebMercatorViewport({ width: el.clientWidth, height: el.clientHeight })
    const target = vp.fitBounds(
      [
        [Math.min(...lons), Math.min(...lats)],
        [Math.max(...lons), Math.max(...lats)],
      ],
      { padding: 120, maxZoom: 14, minExtent: 0.02 }
    )
    flying.current = true
    setViewState((v) => ({
      ...v,
      longitude: target.longitude,
      latitude: target.latitude,
      // A tilted camera sees further than the flat fit assumes; back off slightly
      zoom: target.zoom - 0.3,
      pitch: PITCH,
      bearing: (v.bearing ?? 0) - 25,
      transitionDuration: 'auto',
      transitionInterpolator: new FlyToInterpolator({ speed: 1.4 }),
      onTransitionEnd: () => {
        flying.current = false
      },
    }))
  }

  function resetView() {
    const el = container.current
    if (!el) return
    const { longitude, latitude, zoom } = fitHome(el.clientWidth, el.clientHeight)
    flying.current = true
    setViewState((v) => ({
      ...v,
      longitude,
      latitude,
      zoom,
      pitch: PITCH,
      bearing: BEARING,
      transitionDuration: 'auto',
      transitionInterpolator: new FlyToInterpolator({ speed: 1.4 }),
      onTransitionEnd: () => {
        flying.current = false
      },
    }))
  }

  const zoomBy = (delta: number) =>
    setViewState(({ transitionDuration, transitionInterpolator, onTransitionEnd, ...v }) => ({
      ...v,
      zoom: Math.min(v.maxZoom ?? 16, Math.max(v.minZoom ?? 8, v.zoom + delta)),
    }))

  // Arrow keys: move the camera across the ground in screen directions, so "up" is always
  // away from the viewer whatever the camera bearing
  const pan = (dx: number, dy: number) =>
    setViewState(({ transitionDuration, transitionInterpolator, onTransitionEnd, ...v }) => {
      const el = container.current
      if (!el) return v
      const vp = new WebMercatorViewport({ ...v, width: el.clientWidth, height: el.clientHeight })
      const [longitude, latitude] = vp.unproject([
        el.clientWidth / 2 + dx,
        el.clientHeight / 2 + dy,
      ])
      return { ...v, longitude, latitude }
    })
  const turn = (bearing: number, pitch: number) =>
    setViewState(({ transitionDuration, transitionInterpolator, onTransitionEnd, ...v }) => ({
      ...v,
      bearing: ((v.bearing ?? 0) + bearing) % 360,
      pitch: Math.min(v.maxPitch ?? 75, Math.max(0, (v.pitch ?? 0) + pitch)),
    }))

  // Same commands as the 2D map, so the page's big buttons and keys work in both views
  useImperativeHandle(ref, () => ({
    zoomIn: () => zoomBy(1),
    zoomOut: () => zoomBy(-1),
    resetView,
    focusNodes: flyToNodes,
    pan,
    rotate: (degrees) => turn(degrees, 0),
    tilt: (degrees) => turn(0, degrees),
    topDown: () =>
      setViewState(({ transitionDuration, transitionInterpolator, onTransitionEnd, ...v }) => {
        // Remember where we were looking, so double-tap Shift+Down can come back to it
        if ((v.pitch ?? 0) > 0) beforeTopDown.current = v
        return {
          ...v,
          pitch: 0,
          transitionDuration: TOP_DOWN_MS,
          transitionInterpolator: TOP_DOWN_INTERPOLATOR,
        }
      }),
    restoreView: () => {
      const saved = beforeTopDown.current
      beforeTopDown.current = null
      setViewState(({ transitionDuration, transitionInterpolator, onTransitionEnd, ...v }) => ({
        ...v,
        // Without a saved view, just tilt back to the standard angle where we are
        ...(saved
          ? {
              longitude: saved.longitude,
              latitude: saved.latitude,
              zoom: saved.zoom,
              bearing: saved.bearing,
              pitch: saved.pitch,
            }
          : { pitch: PITCH }),
        transitionDuration: TOP_DOWN_MS,
        transitionInterpolator: saved
          ? new FlyToInterpolator({ speed: 1.4 })
          : TOP_DOWN_INTERPOLATOR,
      }))
    },
  }))

  // Fly to the selection on request, so a query result is brought into view
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new request should move the view
  useEffect(() => {
    if (!graph || !selection || fitRequest === 0) return
    flyToSelection()
  }, [fitRequest])

  const data = useMemo(() => {
    if (!graph) return null
    const junctions: GraphNode[] = []
    const entities: GraphNode[] = []
    for (const n of graph.nodes.values()) {
      // Missions have no place of their own; a casualty in transit rides inside its vehicle ("+1")
      if (n.label === 'Mission' || n.status === 'in_transit') continue
      ;(n.label === 'Junction' ? junctions : entities).push(n)
    }
    const roads: number[] = []
    const links: number[] = []
    const anchors = new Set<number>()
    graph.edges.forEach((e, i) => {
      if (!graph.nodes.has(e.src) || !graph.nodes.has(e.dst)) return
      // Only roads are drawn; NEAR, AFFECTS and mission links stay in the data (inspector, queries)
      if (e.type === 'ROAD') roads.push(i)
      else {
        anchors.add(e.src)
        anchors.add(e.dst)
      }
    })
    const routes = graph.activeRoutes
      .filter((r) => r.points.length > 1)
      .map((r) => ({
        color: r.color,
        path: r.points.map(([lat, lon]) => [lon, lat] as [number, number]),
      }))
    return { junctions, entities, roads, links, anchors, routes }
  }, [graph])

  const places = useMemo<Place[]>(
    () =>
      (basemap?.places.features ?? []).flatMap((f) => {
        if (f.geometry.type !== 'Point') return []
        const { name, name_en: nameEn, place } = f.properties as Record<string, string>
        const [lon, lat] = f.geometry.coordinates
        return [
          {
            position: [lon, lat],
            name: nameEn || name,
            major: place === 'city' || place === 'town',
          },
        ]
      }),
    [basemap]
  )

  const showVillages = viewState.zoom >= VILLAGE_LABEL_MIN_ZOOM
  // Layer data must keep its identity across camera frames, or deck.gl re-processes it each frame
  const placeLabels = useMemo(
    () => (showVillages ? places : places.filter((p) => p.major)),
    [places, showVillages]
  )
  const selectedEntities = useMemo(
    () => (data && selection ? data.entities.filter((n) => selection.nodes.has(n.nid)) : []),
    [data, selection]
  )

  const nodeAlpha = (nid: number) => (!selection || selection.nodes.has(nid) ? 1 : DIMMED)
  const edgeLook = (i: number): { color: Color; width: number } => {
    const e = graph?.edges[i]
    if (!e) return { color: [0, 0, 0, 0], width: 0 }
    const width = edgeWidth(e)
    if (!selection) return { color: rgba(edgeColor(e), 0.95), width }
    if (selection.edges.has(i)) return { color: rgba(HIGHLIGHT_COLOR), width: width + 2 }
    return { color: rgba(edgeColor(e), DIMMED), width }
  }

  // Terrain and the draped basemap show as soon as the small metadata file loads; clickable
  // layers move up onto it once the height sampler is ready (they draw on top either way)
  const terrainOn = terrain !== null && terrainScale > 0

  const drape = terrainOn ? { extensions: TERRAIN_EXTENSIONS } : {}
  // deck.gl does not rebuild a layer when its extensions change, so draped and flat layers get
  // different ids and toggling terrain swaps them cleanly
  const layerId = (name: string) => (terrainOn ? `${name}@terrain` : name)
  // Ground position of a point, on the exaggerated terrain when it is shown
  const lift = (lon: number, lat: number): [number, number, number] => [
    lon,
    lat,
    terrainOn && heightAt ? heightAt(lon, lat) * terrainScale : 0,
  ]
  const ground = (n: GraphNode) => lift(n.lon, n.lat)
  const placed = [terrainOn, terrainScale, heightAt]
  const layers = [
    terrainOn &&
      new TerrainLayer({
        id: 'terrain',
        elevationData: TERRAIN_IMAGE,
        bounds: terrain.bounds,
        // Exaggerate by scaling the decoded height: k * (r*R + g*G + b*B + offset)
        elevationDecoder: {
          rScaler: terrain.decoder.rScaler * terrainScale,
          gScaler: terrain.decoder.gScaler * terrainScale,
          bScaler: terrain.decoder.bScaler * terrainScale,
          offset: terrain.decoder.offset * terrainScale,
        },
        texture: null,
        color: [24, 33, 44],
        // Error is in exaggerated metres: keep ~4 real metres at any exaggeration, or the mesh
        // gets far more triangles than the 60 m cells can show and takes seconds to build
        meshMaxError: TERRAIN_MESH_ERROR_M * terrainScale,
        operation: 'terrain+draw',
      }),
    ...(basemap
      ? (
          [
            ['forest', BASEMAP_STYLE.forest],
            ['builtup', BASEMAP_STYLE.builtup],
            ['water', BASEMAP_STYLE.water],
          ] as const
        ).map(
          ([name, style]) =>
            new GeoJsonLayer({
              id: layerId(`basemap-${name}`),
              data: basemap[name],
              filled: true,
              stroked: true,
              getFillColor: rgba(style.fillColor, style.fillOpacity),
              getLineColor: rgba(style.color),
              lineWidthUnits: 'pixels',
              getLineWidth: style.weight,
              ...drape,
              parameters: GROUND,
            })
        )
      : []),
    ...(basemap
      ? (
          [
            ['rivers', BASEMAP_STYLE.rivers],
            ['railways', BASEMAP_STYLE.railways],
          ] as const
        ).map(
          ([name, style]) =>
            new GeoJsonLayer({
              id: layerId(`basemap-${name}`),
              data: basemap[name],
              filled: false,
              getLineColor: rgba(style.color, style.opacity),
              lineWidthUnits: 'pixels',
              getLineWidth: style.weight,
              ...drape,
              parameters: GROUND,
            })
        )
      : []),
    new ScatterplotLayer<Place>({
      id: layerId('places'),
      data: places,
      radiusUnits: 'pixels',
      getRadius: (p) => (p.major ? 3 : 2),
      getPosition: (p) => p.position,
      getFillColor: (p) => rgba(p.major ? '#dbe4ee' : '#8b9bb0', 0.8),
      ...drape,
      parameters: GROUND,
    }),
    data &&
      graph &&
      new LineLayer<number>({
        id: layerId('roads'),
        data: data.roads,
        widthUnits: 'pixels',
        getSourcePosition: (i) => ground(graph.nodes.get(graph.edges[i].src) as GraphNode),
        getTargetPosition: (i) => ground(graph.nodes.get(graph.edges[i].dst) as GraphNode),
        getColor: (i) => edgeLook(i).color,
        getWidth: (i) => edgeLook(i).width,
        updateTriggers: {
          getPosition: placed,
          getSourcePosition: placed,
          getTargetPosition: placed,
          getPath: placed,
          getColor: selection,
          getWidth: selection,
        },
        parameters: GROUND,
      }),
    data &&
      new ScatterplotLayer<GraphNode>({
        id: layerId('junctions'),
        data: data.junctions,
        pickable: true,
        radiusUnits: 'pixels',
        stroked: true,
        lineWidthUnits: 'pixels',
        getPosition: ground,
        getRadius: (n) =>
          (data.anchors.has(n.nid) ? 3.5 : 1.8) + (selection?.nodes.has(n.nid) ? 1.5 : 0),
        getFillColor: (n) => rgba(nodeColor(n.label, n.kind), nodeAlpha(n.nid)),
        getLineColor: (n) => rgba('#dbe4ee', nodeAlpha(n.nid)),
        getLineWidth: (n) => (data.anchors.has(n.nid) ? 1.5 : 0),
        updateTriggers: {
          getPosition: placed,
          getSourcePosition: placed,
          getTargetPosition: placed,
          getPath: placed,
          getRadius: selection,
          getFillColor: selection,
          getLineColor: selection,
        },
        parameters: GROUND,
      }),
    // Mission routes, through their ROUTE_STEP junctions in order
    data &&
      new PathLayer<{ color: string; path: [number, number][] }>({
        id: layerId('mission-routes'),
        data: data.routes,
        widthUnits: 'pixels',
        getPath: (r) => r.path.map(([lon, lat]) => lift(lon, lat)),
        getWidth: MISSION_ROUTE_STYLE.weight,
        getColor: (r) => rgba(r.color, MISSION_ROUTE_STYLE.opacity),
        updateTriggers: { getPath: placed },
        parameters: GROUND,
      }),
    // NEAR / AFFECTS and mission links between nodes
    data &&
      graph &&
      new LineLayer<number>({
        id: layerId('links'),
        data: data.links,
        widthUnits: 'pixels',
        getSourcePosition: (i) => ground(graph.nodes.get(graph.edges[i].src) as GraphNode),
        getTargetPosition: (i) => ground(graph.nodes.get(graph.edges[i].dst) as GraphNode),
        getColor: (i) => edgeLook(i).color,
        getWidth: (i) => edgeLook(i).width,
        updateTriggers: {
          getPosition: placed,
          getSourcePosition: placed,
          getTargetPosition: placed,
          getPath: placed,
          getColor: selection,
          getWidth: selection,
        },
        parameters: GROUND,
      }),
    data &&
      new ScatterplotLayer<GraphNode>({
        id: layerId('entities'),
        // vehicles and casualties in transit slide to their new position between ticks
        transitions: { getPosition: 900 },
        data: data.entities,
        pickable: true,
        radiusUnits: 'pixels',
        getRadius: (n) => (selection?.nodes.has(n.nid) ? 8.5 : 7),
        stroked: true,
        lineWidthUnits: 'pixels',
        getLineWidth: 2,
        getPosition: ground,
        getFillColor: (n) => rgba(nodeColor(n.label, n.kind), nodeAlpha(n.nid)),
        // Same as 2D: white outline when the position is derived from neighbours
        getLineColor: (n) => rgba(n.derived ? '#ffffff' : MAP_BG, nodeAlpha(n.nid)),
        updateTriggers: {
          getPosition: placed,
          getSourcePosition: placed,
          getTargetPosition: placed,
          getPath: placed,
          getRadius: selection,
          getFillColor: selection,
          getLineColor: selection,
        },
        parameters: GROUND,
      }),
    // Selected scenario nodes get a highlight ring at their base
    data &&
      selection &&
      new ScatterplotLayer<GraphNode>({
        id: layerId('selected-rings'),
        data: selectedEntities,
        radiusUnits: 'pixels',
        getRadius: 11,
        filled: false,
        stroked: true,
        lineWidthUnits: 'pixels',
        getLineWidth: 2,
        getPosition: ground,
        getLineColor: rgba(HIGHLIGHT_COLOR),
        updateTriggers: { getPosition: placed, getPath: placed },
        parameters: GROUND,
      }),
    // Built only once there is text: an empty 'auto' character set makes an empty font atlas
    placeLabels.length > 0 &&
      new TextLayer<Place>({
        id: layerId('place-labels'),
        data: placeLabels,
        characterSet: 'auto',
        getPosition: (p) => p.position,
        getText: (p) => p.name,
        getSize: (p) => (p.major ? 13 : 11),
        getColor: (p) => rgba(p.major ? '#dbe4ee' : '#aab6c5'),
        getTextAnchor: 'end',
        getPixelOffset: [-6, 0],
        fontWeight: 600,
        fontFamily: 'system-ui, sans-serif',
        fontSettings: { sdf: true },
        outlineWidth: 3,
        outlineColor: rgba(MAP_BG),
        ...drape,
        parameters: GROUND,
      }),
    data &&
      new TextLayer<GraphNode>({
        id: layerId('entity-labels'),
        // vehicles and casualties in transit slide to their new position between ticks
        transitions: { getPosition: 900 },
        data: data.entities,
        getPosition: ground,
        getText: (n) => n.tag,
        getSize: 11,
        getColor: (n) => rgba('#e5edf5', !selection || selection.nodes.has(n.nid) ? 1 : 0.25),
        getTextAnchor: 'start',
        getAlignmentBaseline: 'bottom',
        getPixelOffset: [8, -2],
        fontWeight: 600,
        fontFamily: 'system-ui, sans-serif',
        fontSettings: { sdf: true },
        outlineWidth: 3,
        outlineColor: rgba(MAP_BG),
        updateTriggers: {
          getPosition: placed,
          getSourcePosition: placed,
          getTargetPosition: placed,
          getPath: placed,
          getColor: selection,
        },
        parameters: { depthCompare: 'always' },
      }),
  ]

  const onClick = (info: PickingInfo) => {
    const n = info.object as GraphNode | undefined
    const token = ++inspectToken.current
    const picked = info.layer?.id.replace('@terrain', '')
    if (!n || (picked !== 'entities' && picked !== 'junctions')) {
      onSelectNode(null)
      setInspector(null)
      return
    }
    onSelectNode(n.nid)
    inspectNode(graph, n, graphName, change, (html) => {
      if (token === inspectToken.current) setInspector(html)
    })
  }

  const button =
    'border-grey-700 rounded border px-2.5 py-1 font-medium disabled:cursor-default disabled:opacity-40'

  return (
    <div ref={container} className="c2-map relative h-full w-full">
      <DeckGL
        viewState={viewState}
        onViewStateChange={({ viewState: v }) => setViewState(v as ViewState)}
        controller={{ dragRotate: true, touchRotate: true }}
        layers={layers}
        onClick={onClick}
        getCursor={({ isHovering, isDragging }) =>
          isDragging ? 'grabbing' : isHovering ? 'pointer' : 'grab'
        }
        getTooltip={({ object, layer }) =>
          object && (layer?.id === 'entities' || layer?.id === 'junctions')
            ? {
                text: `${(object as GraphNode).label} ${(object as GraphNode).id}`,
                style: {
                  background: '#111a24',
                  border: '1px solid #2a3a4d',
                  color: '#dbe4ee',
                  fontSize: '12px',
                  padding: '4px 8px',
                },
              }
            : null
        }
      />
      <div className="absolute top-[88px] right-3 z-[1000] flex gap-1.5 text-xs">
        <button
          type="button"
          className={`${button} bg-grey-900/90 text-content-primary hover:bg-grey-800`}
          disabled={!selection}
          onClick={flyToSelection}
          title="Fly the camera to the current selection or query result"
        >
          Fly to selection
        </button>
        <button
          type="button"
          className={`${button} ${orbiting ? 'bg-[#fde047] text-[#0b1118]' : 'bg-grey-900/90 text-content-primary hover:bg-grey-800'}`}
          onClick={() => setOrbiting((o) => !o)}
          aria-pressed={orbiting}
          title="Slowly orbit the camera around the centre of the view"
        >
          Orbit
        </button>
      </div>
      {inspector && (
        <div className="c2-inspector bg-grey-900/95 border-grey-700 text-content-primary absolute top-[124px] right-3 z-[1000] max-h-[60%] w-80 overflow-y-auto rounded-md border px-3 py-2.5 text-xs">
          <button
            type="button"
            className="text-content-fourth hover:text-content-primary float-right ml-2"
            onClick={() => setInspector(null)}
            aria-label="Close inspector"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: inspectNode escapes all values */}
          <div dangerouslySetInnerHTML={{ __html: inspector }} />
        </div>
      )}
      <div className="text-content-fourth pointer-events-none absolute right-3 bottom-2 z-[1000] text-[10px]">
        Map data {'©'} OpenStreetMap contributors (ODbL)
        {terrainOn && ` \u00b7 Elevation: ${terrain.attribution}`}
      </div>
    </div>
  )
})
