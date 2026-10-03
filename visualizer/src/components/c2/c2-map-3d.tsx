// Tilted 3D view of the C2 graph (deck.gl): same offline basemap and colours as the 2D map, with
// scenario nodes drawn as columns whose height encodes a property. Same props as C2Map.
import {
  type Color,
  FlyToInterpolator,
  type MapViewState,
  type PickingInfo,
  WebMercatorViewport,
} from '@deck.gl/core'
import { ColumnLayer, GeoJsonLayer, LineLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers'
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

type Props = {
  graph: GeoGraph | undefined
  selection: Selection | null
  /** Called with a node id when a node is clicked, or null when empty map is clicked */
  onSelectNode: (nid: number | null) => void
  graphName: string
  change: string | undefined
  /** Incremented to ask the map to fly to the current selection (e.g. after a query) */
  fitRequest: number
}

type ViewState = MapViewState & {
  transitionDuration?: number | 'auto'
  transitionInterpolator?: FlyToInterpolator
  onTransitionEnd?: () => void
}

// Sector bounds [[west, south], [east, north]]: Robotyne front to Zaporizhzhia
const SECTOR_BOUNDS: [[number, number], [number, number]] = [
  [35.0, 47.4],
  [35.95, 47.9],
]
const PITCH = 55
const BEARING = -15
const VILLAGE_LABEL_MIN_ZOOM = 11
const DIMMED = 0.12
const ORBIT_DEG_PER_SEC = 6
// Column heights are a 0..1 fraction of this, in metres at REFERENCE_ZOOM. Heights shrink less
// than the map when zooming in, so columns stay readable from the overview to street level.
const MAX_HEIGHT_M = 6500
const REFERENCE_ZOOM = 10
const HEIGHT_ZOOM_FACTOR = 0.9
const TRIAGE_HEIGHT: Record<string, number> = { T1: 1, T2: 0.66, T3: 0.33, T4: 0.15 }
const MIN_HEIGHT = 0.06
const MAX_FREE_BEDS = 20

/** 0..1 height of a node's column: what the height means depends on the node's label. */
function nodeHeight(n: GraphNode): number {
  const m = n.metric ?? 0
  switch (n.label) {
    case 'Junction':
      return 0
    case 'Casualty':
      return TRIAGE_HEIGHT[n.kind] ?? MIN_HEIGHT
    case 'MedicalPoint':
      return Math.max(MIN_HEIGHT, Math.min(1, m / MAX_FREE_BEDS))
    case 'Vehicle':
      return Math.max(MIN_HEIGHT, Math.min(1, m / 100))
    case 'Threat':
      return Math.max(MIN_HEIGHT, Math.min(1, m))
    default:
      return MIN_HEIGHT
  }
}

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
function loadBasemap(): Promise<Basemap> {
  const names = ['forest', 'builtup', 'water', 'rivers', 'railways', 'places'] as const
  basemapPromise ??= Promise.all(
    names.map(async (name) => (await fetch(`/basemap/${name}.geojson`)).json())
  ).then((data) => Object.fromEntries(names.map((n, i) => [n, data[i]])) as Basemap)
  return basemapPromise
}

// Ground layers are drawn in order without depth testing, so coplanar layers never z-fight
const GROUND = { depthCompare: 'always', depthWriteEnabled: false } as const

function fitSector(width: number, height: number) {
  const vp = new WebMercatorViewport({ width, height })
  return vp.fitBounds(SECTOR_BOUNDS, { padding: 40 })
}

export const C2Map3D = forwardRef<C2MapHandle, Props>(function C2Map3D(
  { graph, selection, onSelectNode, graphName, change, fitRequest },
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
  const [orbiting, setOrbiting] = useState(false)
  const [inspector, setInspector] = useState<string | null>(null)
  const inspectToken = useRef(0)
  const flying = useRef(false)

  useEffect(() => {
    let cancelled = false
    loadBasemap().then((b) => !cancelled && setBasemap(b))
    return () => {
      cancelled = true
    }
  }, [])

  // Start framed on the whole sector, tilted
  useLayoutEffect(() => {
    const el = container.current
    if (!el) return
    const { longitude, latitude, zoom } = fitSector(el.clientWidth, el.clientHeight)
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
    const { longitude, latitude, zoom } = fitSector(el.clientWidth, el.clientHeight)
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

  // Same commands as the 2D map, so the page's big buttons and keys work in both views
  useImperativeHandle(ref, () => ({
    zoomIn: () => zoomBy(1),
    zoomOut: () => zoomBy(-1),
    resetView,
    focusNodes: flyToNodes,
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
    for (const n of graph.nodes.values()) (n.label === 'Junction' ? junctions : entities).push(n)
    const roads: number[] = []
    const links: number[] = []
    const anchors = new Set<number>()
    graph.edges.forEach((e, i) => {
      if (!graph.nodes.has(e.src) || !graph.nodes.has(e.dst)) return
      if (e.type === 'ROAD') roads.push(i)
      else {
        links.push(i)
        anchors.add(e.src)
        anchors.add(e.dst)
      }
    })
    return { junctions, entities, roads, links, anchors }
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

  const heightScale = 2 ** ((REFERENCE_ZOOM - viewState.zoom) * HEIGHT_ZOOM_FACTOR)
  // Quantised so the link and label layers are not rebuilt on every animation frame
  const z = Math.round(heightScale * 100) / 100
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
  const top = (n: GraphNode): [number, number, number] => [
    n.lon,
    n.lat,
    nodeHeight(n) * MAX_HEIGHT_M * z,
  ]

  const nodeAlpha = (nid: number) => (!selection || selection.nodes.has(nid) ? 1 : DIMMED)
  const edgeLook = (i: number): { color: Color; width: number } => {
    const e = graph?.edges[i]
    if (!e) return { color: [0, 0, 0, 0], width: 0 }
    const width = edgeWidth(e)
    if (!selection) return { color: rgba(edgeColor(e), 0.95), width }
    if (selection.edges.has(i)) return { color: rgba(HIGHLIGHT_COLOR), width: width + 2 }
    return { color: rgba(edgeColor(e), DIMMED), width }
  }

  const layers = [
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
              id: `basemap-${name}`,
              data: basemap[name],
              filled: true,
              stroked: true,
              getFillColor: rgba(style.fillColor, style.fillOpacity),
              getLineColor: rgba(style.color),
              lineWidthUnits: 'pixels',
              getLineWidth: style.weight,
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
              id: `basemap-${name}`,
              data: basemap[name],
              filled: false,
              getLineColor: rgba(style.color, style.opacity),
              lineWidthUnits: 'pixels',
              getLineWidth: style.weight,
              parameters: GROUND,
            })
        )
      : []),
    new ScatterplotLayer<Place>({
      id: 'places',
      data: places,
      radiusUnits: 'pixels',
      getRadius: (p) => (p.major ? 3 : 2),
      getPosition: (p) => p.position,
      getFillColor: (p) => rgba(p.major ? '#dbe4ee' : '#8b9bb0', 0.8),
      parameters: GROUND,
    }),
    data &&
      graph &&
      new LineLayer<number>({
        id: 'roads',
        data: data.roads,
        widthUnits: 'pixels',
        getSourcePosition: (i) => top(graph.nodes.get(graph.edges[i].src) as GraphNode),
        getTargetPosition: (i) => top(graph.nodes.get(graph.edges[i].dst) as GraphNode),
        getColor: (i) => edgeLook(i).color,
        getWidth: (i) => edgeLook(i).width,
        updateTriggers: { getColor: selection, getWidth: selection },
        parameters: GROUND,
      }),
    data &&
      new ScatterplotLayer<GraphNode>({
        id: 'junctions',
        data: data.junctions,
        pickable: true,
        radiusUnits: 'pixels',
        stroked: true,
        lineWidthUnits: 'pixels',
        getPosition: (n) => [n.lon, n.lat],
        getRadius: (n) =>
          (data.anchors.has(n.nid) ? 3.5 : 1.8) + (selection?.nodes.has(n.nid) ? 1.5 : 0),
        getFillColor: (n) => rgba(nodeColor(n.label, n.kind), nodeAlpha(n.nid)),
        getLineColor: (n) => rgba('#dbe4ee', nodeAlpha(n.nid)),
        getLineWidth: (n) => (data.anchors.has(n.nid) ? 1.5 : 0),
        updateTriggers: {
          getRadius: selection,
          getFillColor: selection,
          getLineColor: selection,
        },
        parameters: GROUND,
      }),
    // NEAR / AFFECTS: from the top of the entity's column down to its junction
    data &&
      graph &&
      new LineLayer<number>({
        id: 'links',
        data: data.links,
        widthUnits: 'pixels',
        getSourcePosition: (i) => top(graph.nodes.get(graph.edges[i].src) as GraphNode),
        getTargetPosition: (i) => top(graph.nodes.get(graph.edges[i].dst) as GraphNode),
        getColor: (i) => edgeLook(i).color,
        getWidth: (i) => edgeLook(i).width,
        updateTriggers: {
          getSourcePosition: z,
          getTargetPosition: z,
          getColor: selection,
          getWidth: selection,
        },
      }),
    data &&
      new ColumnLayer<GraphNode>({
        id: 'entities',
        data: data.entities,
        pickable: true,
        extruded: true,
        diskResolution: 16,
        radiusUnits: 'pixels',
        radius: 7,
        elevationScale: heightScale,
        getPosition: (n) => [n.lon, n.lat],
        getElevation: (n) => nodeHeight(n) * MAX_HEIGHT_M,
        getFillColor: (n) => rgba(nodeColor(n.label, n.kind), nodeAlpha(n.nid)),
        updateTriggers: { getFillColor: selection },
      }),
    // Selected scenario nodes get a highlight ring at their base
    data &&
      selection &&
      new ScatterplotLayer<GraphNode>({
        id: 'selected-rings',
        data: selectedEntities,
        radiusUnits: 'pixels',
        getRadius: 11,
        filled: false,
        stroked: true,
        lineWidthUnits: 'pixels',
        getLineWidth: 2,
        getPosition: (n) => [n.lon, n.lat],
        getLineColor: rgba(HIGHLIGHT_COLOR),
        parameters: GROUND,
      }),
    // Built only once there is text: an empty 'auto' character set makes an empty font atlas
    placeLabels.length > 0 &&
      new TextLayer<Place>({
        id: 'place-labels',
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
        parameters: GROUND,
      }),
    data &&
      new TextLayer<GraphNode>({
        id: 'entity-labels',
        data: data.entities,
        getPosition: top,
        getText: (n) => n.id,
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
        updateTriggers: { getPosition: z, getColor: selection },
        parameters: { depthCompare: 'always' },
      }),
  ]

  const onClick = (info: PickingInfo) => {
    const n = info.object as GraphNode | undefined
    const token = ++inspectToken.current
    if (!n || (info.layer?.id !== 'entities' && info.layer?.id !== 'junctions')) {
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
        Drag to pan, right-drag or Ctrl-drag to rotate and tilt, scroll to zoom {'·'} Map data {'©'}{' '}
        OpenStreetMap contributors (ODbL)
      </div>
    </div>
  )
})
