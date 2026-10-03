import { useMemo } from 'react'
import { TuringGraphSelector } from './turing-graph-selector'

import { useAppStore, useScenarioStore } from '@/stores'
import useGraphInfo from '@/hooks/use-graph-info'

export const TuringTopBar = () => {
  const page = useAppStore((state) => state.page)
  const graphName = useAppStore((state) => state.graphName)
  const graph = useGraphInfo(graphName)
  // The C2 page picks its graph from the address (?graph=), not from the viewer's selector
  const c2Graph = useScenarioStore((state) => state.graph)

  const rightTitle = useMemo(
    () => (page === 'c2' ? c2Graph : graph.info ? graph.info.name : 'No graph selected'),
    [page, c2Graph, graph.info]
  )
  const leftTitle = useMemo(() => {
    switch (page) {
      case 'viewer':
        return 'Viewing:'
    }
  }, [page])

  return (
    <div className="border-grey-900 bg-grey-800 flex items-center space-x-4 border-t border-b p-4">
      <div className="text-content-secondary flex flex-1 items-center space-x-7 font-sans text-sm font-medium">
        <span className="text-content-primary text-base font-bold tracking-[0.2em]">
          S.H.E.R.P.A
        </span>
        <span>{leftTitle}</span>
        <span
          className={
            'border-grey-500 text-content-secondary ml-4 rounded-md border p-1 pr-2 pl-2 text-sm'
          }
        >
          {rightTitle}
        </span>
      </div>
      <TuringGraphSelector />
    </div>
  )
}
