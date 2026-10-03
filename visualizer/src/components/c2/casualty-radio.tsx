import { useEffect, useRef, useState } from 'react'
import type { RadioMessage } from './communications'
import { type Casualty, type RadioAssignment, formatClock } from './scenario-data'

export function CasualtyRadio({ casualty, messages, assignment, onClose }: { casualty: Casualty; messages: RadioMessage[]; assignment?: RadioAssignment; onClose: () => void }) {
  const [open, setOpen] = useState(true)
  const contentId = `casualty-radio-${casualty.id}`
  const scroll = useRef<HTMLDivElement>(null)
  useEffect(() => { if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight }, [casualty.id, messages.length, open])
  return <section aria-label={`${casualty.id} Radio`} className="pointer-events-auto flex min-h-0 flex-col overflow-hidden rounded-lg border border-[#334155] bg-[#0e1b26]/95 shadow-xl backdrop-blur">
    <header className="flex items-center justify-between gap-2 border-b border-[#334155] px-3 py-2">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-controls={contentId} aria-label={`${open ? 'Collapse' : 'Expand'} ${casualty.id} radio`} className="min-w-0 flex-1 text-left"><h2 className="text-sm font-semibold text-sky-200">{casualty.id} Radio <span className="ml-2 text-slate-400" aria-hidden="true">{open ? '▾' : '▸'}</span></h2>
        <p className="mt-1 text-[11px] text-slate-400">{casualty.triage || 'Awaiting triage'} · {casualty.status.replaceAll('_', ' ')} · Simulated text radio</p></button>
      <button type="button" onClick={onClose} aria-label="Close casualty radio" className="rounded px-2 py-1 text-slate-300 hover:bg-slate-700">✕</button>
    </header>
    {open && assignment && <p className="border-b border-[#334155] px-3 py-2 text-xs font-semibold text-emerald-200">{casualty.status === 'in_transit' ? 'Transport' : 'Assigned'}: {assignment.vehicleId} → {assignment.destinationId}</p>}
    {open && !assignment && casualty.status === 'assigned' && <p className="px-3 py-2 text-xs text-slate-400">Updating dispatch details…</p>}
    {open && <div id={contentId} ref={scroll} className="min-h-0 overflow-y-auto px-3 py-2" aria-live="polite">
      {!messages.length && <p className="py-3 text-xs text-slate-400">Waiting for the casualty report…</p>}
      <ol className="space-y-3">
        {messages.map((message) => <li key={message.key}>
          <article aria-label={`Radio message from ${message.speaker}`} className="border-l-2 border-sky-700 pl-3">
            <div className="flex items-start justify-between gap-2 text-[10px]"><span className="font-semibold text-sky-200">{message.speaker} → {message.recipient}</span><time className="shrink-0 font-mono text-slate-400">{formatClock(new Date(message.time))}</time></div>
            <p className="mt-1 text-xs leading-5 text-slate-200">{message.text}</p>
          </article>
        </li>)}
      </ol>
    </div>}
  </section>
}
