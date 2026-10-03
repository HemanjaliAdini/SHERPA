import { useQuery } from '@tanstack/react-query'

import { C2Map } from '@/components/c2/c2-map'
import {
  FACILITY_COLOR,
  FACILITY_LABEL,
  ROAD_BASE_COLOR,
  ROAD_CLOSED_COLOR,
  THREAT_MARKER_COLOR,
  TRIAGE_COLOR,
  VEHICLE_COLOR,
  threatColor,
} from '@/components/c2/colors'
import { fetchEntities } from '@/components/c2/entity-data'
import { type Shape, shapeSvg } from '@/components/c2/entity-icons'
import { fetchRoads } from '@/components/c2/road-data'
import { useScenarioStore } from '@/stores'

const Swatch = ({ color, dashed }: { color: string; dashed?: boolean }) => (
  <span
    className="inline-block h-0 w-6 align-middle"
    style={{ borderTop: `3px ${dashed ? 'dotted' : 'solid'} ${color}` }}
  />
)

const Key = ({
  shape,
  color,
  stroke,
  label,
}: { shape: Shape; color: string; stroke?: string; label: string }) => (
  <div className="mb-1 flex items-center gap-2">
    <span
      className="inline-flex w-6 justify-center"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: static SVG built from our own constants
      dangerouslySetInnerHTML={{ __html: shapeSvg(shape, color, stroke ?? '#0b1118', 16) }}
    />
    {label}
  </div>
)

const SectionTitle = ({ children }: { children: string }) => (
  <div className="text-content-fourth mt-3 mb-2 font-medium tracking-wide uppercase">
    {children}
  </div>
)

const Legend = () => (
  <div className="bg-grey-900/90 text-content-primary border-grey-700 absolute bottom-6 left-3 z-[1000] w-56 rounded-md border p-3 text-xs">
    <div className="text-content-fourth mb-2 font-medium tracking-wide uppercase">Roads</div>
    <div className="mb-1 flex items-center gap-2">
      <Swatch color={ROAD_BASE_COLOR} /> No known threat
    </div>
    <div className="mb-1 flex items-center gap-2">
      <Swatch color={ROAD_CLOSED_COLOR} dashed /> Closed
    </div>
    <div className="text-content-fourth mt-2 mb-1">Threat level</div>
    <div
      className="h-2 w-full rounded"
      style={{
        background: `linear-gradient(to right, ${threatColor(0.01)}, ${threatColor(0.5)}, ${threatColor(1)})`,
      }}
    />
    <div className="text-content-fourth mt-1 flex justify-between">
      <span>low</span>
      <span>high</span>
    </div>
    <SectionTitle>Casualties (triage)</SectionTitle>
    {(['T1', 'T2', 'T3'] as const).map((t) => (
      <Key key={t} shape="circle" color={TRIAGE_COLOR[t]} stroke="#ffffff" label={t} />
    ))}
    <SectionTitle>Medical points</SectionTitle>
    {Object.entries(FACILITY_LABEL).map(([type, label]) => (
      <Key key={type} shape="square" color={FACILITY_COLOR[type]} label={label} />
    ))}
    <SectionTitle>Vehicles</SectionTitle>
    <Key shape="triangle" color={VEHICLE_COLOR.ugv} label="UGV" />
    <Key shape="triangle" color={VEHICLE_COLOR.ambulance} label="Ambulance" />
    <SectionTitle>Threats</SectionTitle>
    <Key shape="diamond" color={THREAT_MARKER_COLOR} stroke="#ffffff" label="Threat" />
  </div>
)

export const TC2Page = () => {
  const graph = useScenarioStore((state) => state.graph)
  const change = useScenarioStore((state) => state.change)

  const roads = useQuery({
    queryKey: ['c2-roads', graph, change],
    queryFn: () => fetchRoads(graph, change),
    staleTime: Number.POSITIVE_INFINITY,
  })

  const entities = useQuery({
    queryKey: ['c2-entities', graph, change],
    queryFn: () => fetchEntities(graph, change),
    staleTime: Number.POSITIVE_INFINITY,
  })

  return (
    <div className="relative h-full w-full">
      <C2Map roads={roads.data ?? []} entities={entities.data ?? []} />
      <Legend />
      <div className="bg-grey-900/90 text-content-primary border-grey-700 absolute top-3 left-3 z-[1000] rounded-md border px-3 py-1.5 text-xs">
        {graph} on {change ? `change ${change}` : 'main'}
        {' · '}
        {roads.isError
          ? 'could not load roads'
          : roads.isLoading
            ? 'loading roads...'
            : `${roads.data?.length ?? 0} road segments`}
      </div>
    </div>
  )
}
