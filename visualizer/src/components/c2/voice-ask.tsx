// Ask the scenario a question by voice (or typed): scripts/voice_server.py transcribes it with Parakeet,
// matches it to a known question with MiniLM and answers from the graph as one sentence and a table.
import { useEffect, useRef, useState } from 'react'

import { Kbd } from './map-controls'

export type VoiceAnswer = {
  understood: boolean
  question: string
  /** language of the question and of the answer: 'en' or 'uk' */
  lang?: string
  say: string
  title?: string
  score?: number
  columns?: string[]
  rows?: string[][]
  /** node ids to light up, and routes as junction ids */
  highlight?: number[]
  paths?: number[][]
  suggestions?: string[]
  ms?: Record<string, number>
}

type Props = {
  graphName: string
  change: string | undefined
  now: Date
  onAnswer: (answer: VoiceAnswer | null) => void
}

const SAMPLE_RATE = 16000 // what Parakeet expects
type Phase = 'idle' | 'listening' | 'thinking'

/** Recorded audio in whatever format the browser produced, as 16 kHz mono 16-bit WAV. */
async function toWav(blob: Blob): Promise<Blob> {
  const decoded = await new AudioContext().decodeAudioData(await blob.arrayBuffer())
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * SAMPLE_RATE), SAMPLE_RATE)
  const source = offline.createBufferSource()
  source.buffer = decoded
  source.connect(offline.destination)
  source.start()
  const pcm = (await offline.startRendering()).getChannelData(0)

  const view = new DataView(new ArrayBuffer(44 + pcm.length * 2))
  const text = (at: number, s: string) =>
    [...s].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)))
  text(0, 'RIFF')
  view.setUint32(4, 36 + pcm.length * 2, true)
  text(8, 'WAVEfmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, SAMPLE_RATE * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  text(36, 'data')
  view.setUint32(40, pcm.length * 2, true)
  pcm.forEach((s, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true))
  return new Blob([view], { type: 'audio/wav' })
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')

export const VoiceAsk = ({ graphName, change, now, onAnswer }: Props) => {
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [typed, setTyped] = useState('')
  const [answer, setAnswer] = useState<VoiceAnswer | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [speak, setSpeak] = useState(true)
  const recorder = useRef<MediaRecorder | null>(null)

  const send = async (body: Blob | string) => {
    setPhase('thinking')
    setError(null)
    const params = new URLSearchParams({ graph: graphName, now: now.toISOString() })
    if (change) params.set('change', change)
    try {
      const res = await fetch(`/voice/ask?${params}`, {
        method: 'POST',
        headers: { 'Content-Type': typeof body === 'string' ? 'application/json' : 'audio/wav' },
        body: typeof body === 'string' ? JSON.stringify({ text: body }) : body,
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? res.statusText)
      setAnswer(json)
      onAnswer(json.understood ? json : null)
      if (speak && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel()
        const utterance = new SpeechSynthesisUtterance(json.say)
        utterance.lang = json.lang === 'uk' ? 'uk-UA' : 'en-GB' // picks a Ukrainian voice (Lesya on macOS)
        window.speechSynthesis.speak(utterance)
      }
    } catch (err) {
      setError(
        err instanceof TypeError
          ? 'Voice server not reachable. Start it with: uv run --extra voice python scripts/voice_server.py'
          : String(err instanceof Error ? err.message : err)
      )
    } finally {
      setPhase('idle')
    }
  }

  const startListening = async () => {
    setOpen(true)
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const chunks: Blob[] = []
      const rec = new MediaRecorder(stream)
      rec.ondataavailable = (e) => chunks.push(e.data)
      rec.onstop = async () => {
        for (const track of stream.getTracks()) track.stop()
        try {
          await send(await toWav(new Blob(chunks, { type: rec.mimeType })))
        } catch (err) {
          setError(`Could not read the recording: ${err}`)
          setPhase('idle')
        }
      }
      recorder.current = rec
      rec.start()
      window.speechSynthesis?.cancel()
      setPhase('listening')
    } catch (err) {
      setError(`Microphone not available: ${err}`)
    }
  }

  const stopListening = () => {
    recorder.current?.stop()
    recorder.current = null
    setPhase('thinking')
  }

  const toggle = () => {
    if (phase === 'listening') stopListening()
    else if (phase === 'idle') startListening()
  }

  // M starts and stops listening, from anywhere on the page except a text field
  const toggleRef = useRef(toggle)
  toggleRef.current = toggle
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'm' || e.key === 'M') && !isTyping(e.target) && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        toggleRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const close = () => {
    if (phase === 'listening') stopListening()
    setOpen(false)
    setAnswer(null)
    onAnswer(null)
  }

  const micButton = (
    <button
      type="button"
      onClick={toggle}
      disabled={phase === 'thinking'}
      className={`flex h-11 items-center gap-3 rounded-lg border px-3 text-sm font-medium shadow-lg disabled:opacity-60 ${
        phase === 'listening'
          ? 'animate-pulse border-[#ef4444] bg-[#7f1d1d] text-white'
          : 'bg-grey-900/95 border-grey-600 text-content-primary hover:bg-grey-700'
      }`}
    >
      {phase === 'listening'
        ? 'Listening... tap to stop'
        : phase === 'thinking'
          ? 'Thinking...'
          : 'Ask by voice'}
      <Kbd>M</Kbd>
    </button>
  )

  if (!open) return micButton

  return (
    <div className="bg-grey-900/95 text-content-primary border-grey-700 flex w-[560px] max-w-full flex-col gap-2 rounded-md border p-2 text-xs shadow-lg">
      <div className="flex items-center gap-2">
        {micButton}
        <form
          className="flex min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault()
            if (typed.trim() && phase === 'idle') send(typed)
          }}
        >
          <input
            className="bg-grey-800 border-grey-600 text-content-primary h-11 w-full min-w-0 rounded border px-2 text-sm outline-none focus:border-[#7f93aa]"
            placeholder="or type: who is the most critical? / хто найкритичніший?"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </form>
        <div className="flex flex-col gap-1">
          <button
            type="button"
            className="bg-grey-800 hover:bg-grey-700 text-content-fourth rounded px-2 py-0.5"
            onClick={() => setSpeak(!speak)}
            title="Read answers aloud"
          >
            {speak ? 'Voice on' : 'Voice off'}
          </button>
          <button
            type="button"
            className="bg-grey-800 hover:bg-grey-700 text-content-fourth rounded px-2 py-0.5"
            onClick={close}
          >
            Close
          </button>
        </div>
      </div>

      {error && <div className="px-1 text-[#fca5a5]">{error}</div>}

      {answer && (
        <div className="flex flex-col gap-2">
          <div className="text-content-fourth px-1">
            {answer.ms?.speech !== undefined ? 'Heard' : 'Asked'}:{' '}
            <span className="text-content-primary italic">"{answer.question}"</span>
            {answer.title && (
              <>
                {' · '}
                {answer.understood ? answer.title : `closest: ${answer.title}`} (
                {Math.round((answer.score ?? 0) * 100)}%)
              </>
            )}
            {answer.ms && (
              <>
                {' · '}
                {Object.entries(answer.ms)
                  .map(([k, v]) => `${k} ${v} ms`)
                  .join(', ')}
              </>
            )}
          </div>
          <div
            className={`rounded px-2 py-1.5 text-sm font-semibold ${answer.understood ? 'bg-grey-800' : 'bg-[#422006] text-[#fde68a]'}`}
          >
            {answer.say}
          </div>
          {answer.suggestions && answer.suggestions.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 px-1">
              <span className="text-content-fourth">Try:</span>
              {answer.suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="bg-grey-800 hover:bg-grey-700 rounded px-2 py-0.5"
                  onClick={() => {
                    setTyped(s)
                    send(s)
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
          {answer.columns && answer.columns.length > 0 && answer.rows && answer.rows.length > 0 && (
            <div className="border-grey-700 max-h-64 overflow-auto rounded border">
              <table className="w-full text-[12px]">
                <thead className="bg-grey-800 sticky top-0">
                  <tr>
                    {answer.columns.map((c) => (
                      <th key={c} className="px-2 py-1 text-left font-medium">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {answer.rows.map((row, r) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: answer rows have no identity
                    <tr key={r} className="border-grey-700 border-t">
                      {row.map((v, c) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
                        <td key={c} className="px-2 py-1">
                          {v}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {!answer && !error && phase === 'idle' && (
        <div className="text-content-fourth px-1">
          Press M or tap the button, ask your question, then press again. For example "which
          casualty is the most critical?"
        </div>
      )}
    </div>
  )
}
