import type { RadioBubble } from './communications'
import type { GeoGraph, GraphNode } from './graph-data'

export function SpeechBubbles({ graph, bubbles, project, width, height }: {
  graph: GeoGraph | undefined
  bubbles: RadioBubble[]
  project: (node: GraphNode) => [number, number]
  width: number
  height: number
}) {
  const boxes: { left: number; top: number }[] = []
  return <div className="pointer-events-none absolute inset-0 z-[1002] overflow-hidden" aria-label="Simulated radio communication" aria-live="polite">
    {bubbles.map((bubble) => {
      const node = [...(graph?.nodes.values() ?? [])].find((item) => item.id === bubble.speaker)
      if (!node || width < 280 || height < 200) return null
      const [rawX, rawY] = project(node)
      if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) return null
      const remote = rawX < 0 || rawY < 0 || rawX > width || rawY > height
      const x = Math.max(12, Math.min(rawX, width - 12))
      const y = Math.max(100, Math.min(rawY, height - 12))
      const boxWidth = Math.min(250, width - 24)
      const left = Math.max(12, Math.min(x + 18, width - boxWidth - 12))
      let top = Math.max(100, Math.min(y - 105, height - 130))
      for (const box of boxes) {
        if (Math.abs(left - box.left) < boxWidth && Math.abs(top - box.top) < 112) {
          top = box.top + 120 <= height - 120 ? box.top + 120 : Math.max(100, box.top - 120)
        }
      }
      boxes.push({ left, top })
      return <div key={bubble.key}>
        <svg className="absolute inset-0 h-full w-full" aria-hidden="true">
          <line x1={x} y1={y} x2={left + 16} y2={top + 80} stroke={node.label === 'Vehicle' ? '#fbbf24' : '#67e8f9'} strokeWidth="2" />
          <circle cx={x} cy={y} r="4" fill="#fbbf24" />
        </svg>
        <article aria-label={`Radio message from ${bubble.speaker}`} style={{ left, top, width: boxWidth }}
          className="radio-speech-bubble absolute rounded-2xl border-2 border-sky-300 bg-[#eefaff] px-3 py-2.5 text-[#122436] shadow-2xl">
          <p className="flex items-center justify-between gap-2 text-[11px] font-bold"><span>{bubble.speaker}</span><span className="text-[8px] font-normal uppercase text-slate-500">{remote ? 'Remote · simulated' : 'Simulated radio'}</span></p>
          <p className="mt-1 text-xs leading-5">{bubble.text}</p>
        </article>
      </div>
    })}
  </div>
}
