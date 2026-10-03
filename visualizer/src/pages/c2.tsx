import { useQuery } from '@tanstack/react-query'

import { executeCypherQuery } from '@/api'
import { useScenarioStore } from '@/stores'

export const TC2Page = () => {
  const graph = useScenarioStore((state) => state.graph)
  const change = useScenarioStore((state) => state.change)

  // Placeholder proving the page reaches TuringDB on the active branch; the map replaces this.
  const junctions = useQuery({
    queryKey: ['c2-junction-count', graph, change],
    queryFn: async () => {
      const data = await executeCypherQuery({
        graph,
        change,
        query: 'MATCH (n:Junction) RETURN count(n)',
      })
      return (data[0][0] as number[])[0]
    },
  })

  return (
    <div className="text-content-primary flex h-full w-full flex-col gap-2 p-6">
      <h1 className="text-lg font-medium">C2 map</h1>
      <p className="text-content-fourth text-sm">
        Graph {graph} on {change ? `change ${change}` : 'main'}:{' '}
        {junctions.isError ? 'query failed' : (junctions.data ?? '...')} junctions
      </p>
    </div>
  )
}
