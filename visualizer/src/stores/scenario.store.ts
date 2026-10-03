import { create } from 'zustand'

export type ScenarioStore = {
  /** TuringDB graph holding the road network and scenario entities. */
  graph: string
  setGraph: (v: string) => void

  /** Scenario clock (the scenario is set in September 2023), used for waiting times and ETAs */
  now: Date
  setNow: (v: Date) => void

  /** Active TuringDB change (what-if branch) id; undefined means main. */
  change: string | undefined
  setChange: (v: string | undefined) => void
}

export const useScenarioStore = create<ScenarioStore>((set) => ({
  graph: new URLSearchParams(window.location.search).get('graph') ?? 'evac',
  setGraph: (v: string) => set({ graph: v }),

  now: new Date('2023-09-12T05:30:00Z'),
  setNow: (v: Date) => set({ now: v }),

  change: undefined,
  setChange: (v: string | undefined) => set({ change: v }),
}))

export default useScenarioStore
