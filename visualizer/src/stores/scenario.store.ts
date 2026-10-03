import { create } from 'zustand'

export type ScenarioStore = {
  /** TuringDB graph holding the road network and scenario entities. */
  graph: string
  setGraph: (v: string) => void

  /** Active TuringDB change (what-if branch) id; undefined means main. */
  change: string | undefined
  setChange: (v: string | undefined) => void
}

export const useScenarioStore = create<ScenarioStore>((set) => ({
  graph: 'evac2',
  setGraph: (v: string) => set({ graph: v }),

  change: undefined,
  setChange: (v: string | undefined) => set({ change: v }),
}))

export default useScenarioStore
