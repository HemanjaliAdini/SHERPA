import { useEffect, useMemo, useRef, useState } from 'react'

import { type Casualty, type Vehicle, formatClock } from './scenario-data'

type FeedMessage = {
  id: string
  direction: 'incoming' | 'outgoing'
  sender: string
  recipient: string
  casualtyIds: string[]
  time: Date
  text: string
  embedding?: number[]
  source?: 'scenario' | 'mission' | 'audio'
}

export type DispatchMessage = Omit<FeedMessage, 'direction' | 'source'> & {
  routeJunctions: number[]
  journeyMinutes: number
  facilityName: string
}

type Props = {
  now: Date
  casualties: Casualty[]
  vehicles: Vehicle[]
  outgoing: DispatchMessage[]
}

const SERVICE = 'http://127.0.0.1:8765'

async function toWav(audio: Blob): Promise<Blob> {
  const context = new AudioContext()
  try {
    const decoded = await context.decodeAudioData(await audio.arrayBuffer())
    if (decoded.duration > 120) throw new Error('Audio clips must be two minutes or shorter.')
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000)
    const source = offline.createBufferSource()
    source.buffer = decoded
    source.connect(offline.destination)
    source.start()
    const pcm = (await offline.startRendering()).getChannelData(0)
    const buffer = new ArrayBuffer(44 + pcm.length * 2)
    const view = new DataView(buffer)
    const write = (offset: number, value: string) => {
      for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
    }
    write(0, 'RIFF')
    view.setUint32(4, 36 + pcm.length * 2, true)
    write(8, 'WAVE')
    write(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, 16000, true)
    view.setUint32(28, 32000, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, 16, true)
    write(36, 'data')
    view.setUint32(40, pcm.length * 2, true)
    for (let i = 0; i < pcm.length; i++) {
      const sample = Math.max(-1, Math.min(1, pcm[i]))
      view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
    }
    return new Blob([buffer], { type: 'audio/wav' })
  } finally {
    await context.close()
  }
}

function cosine(a: number[], b: number[]) {
  if (!a.length || a.length !== b.length) return 0
  let dot = 0
  let aa = 0
  let bb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    aa += a[i] * a[i]
    bb += b[i] * b[i]
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0
}

function reportFor(casualty: Casualty, now: Date): FeedMessage[] {
  const injury = casualty.injuredAt
    ? `Injury time ${formatClock(casualty.injuredAt)}.`
    : 'Injury time not recorded.'
  const triage = casualty.triage
    ? `Recorded priority ${casualty.triage}.`
    : 'Triage not recorded; medic assessment required.'
  const mobility = casualty.mobility ? `Mobility ${casualty.mobility}.` : 'Mobility not recorded.'
  const at =
    casualty.junction === null
      ? 'road junction not recorded.'
      : `last recorded at junction ${casualty.junction}.`
  const base = {
    direction: 'incoming' as const,
    casualtyIds: [casualty.id],
    time: now,
    source: 'scenario' as const,
  }
  return [
    {
      ...base,
      id: `DRONE-${casualty.id}`,
      sender: 'Scenario sensor',
      recipient: 'C2',
      text: `Simulated detection: casualty ${casualty.id}; ${at} This is scenario playback, not live drone sensing.`,
    },
    {
      ...base,
      id: `RELAY-${casualty.id}`,
      sender: 'C2',
      recipient: 'Medic team',
      text: `Relay ${casualty.id}: ${triage} ${mobility} ${injury} MIST — mechanism: ${casualty.mist.mechanism || 'not recorded'}; injuries: ${casualty.mist.injuries || 'not recorded'}; signs: ${casualty.mist.signs || 'not recorded'}; treatment: ${casualty.mist.treatment || 'not recorded'}.`,
    },
    {
      ...base,
      id: `ASSESS-${casualty.id}`,
      sender: 'Medic team',
      recipient: 'C2',
      text: `Assessment update for ${casualty.id}: review the recorded triage and mobility at the scene. No vital signs are available in this scenario.`,
    },
  ]
}

export const RadioReport = ({ now, casualties, vehicles, outgoing }: Props) => {
  const [open, setOpen] = useState(true)
  const [audioMessages, setAudioMessages] = useState<FeedMessage[]>([])
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [embeddings, setEmbeddings] = useState<Record<string, number[]>>({})
  const [scenarioMessages, setScenarioMessages] = useState<FeedMessage[]>([])
  const [vehicleMessages, setVehicleMessages] = useState<FeedMessage[]>([])
  const [playing, setPlaying] = useState(false)
  const [scenarioGeneration, setScenarioGeneration] = useState(0)
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const requestedEmbeddings = useRef(new Set<string>())
  const emittedScenarioIds = useRef(new Set<string>())
  const previousScenarioTime = useRef(now.getTime())
  const currentTime = useRef(now)
  const currentCasualties = useRef(casualties)
  const lastVehicleJunction = useRef(new Map<string, number | null>())
  currentTime.current = now
  currentCasualties.current = casualties

  useEffect(() => {
    if (now.getTime() < previousScenarioTime.current) {
      emittedScenarioIds.current.clear()
      setScenarioMessages([])
      setVehicleMessages([])
      lastVehicleJunction.current.clear()
      setScenarioGeneration((generation) => generation + 1)
      setPlaying(casualties.length > 0)
    }
    previousScenarioTime.current = now.getTime()
  }, [casualties.length, now])

  useEffect(() => {
    for (const vehicle of vehicles) {
      const previous = lastVehicleJunction.current.get(vehicle.id)
      if (!lastVehicleJunction.current.has(vehicle.id)) {
        lastVehicleJunction.current.set(vehicle.id, vehicle.junction)
        continue
      }
      lastVehicleJunction.current.set(vehicle.id, vehicle.junction)
      if (vehicle.junction === null || vehicle.junction === previous || vehicle.status === 'idle')
        continue
      const message: FeedMessage = {
        id: `MOVE-${vehicle.id}-${now.getTime()}-${vehicle.junction}`,
        direction: 'outgoing',
        sender: vehicle.id,
        recipient: 'C2',
        casualtyIds: [],
        time: now,
        text: `${vehicle.type.toUpperCase()} position update: reached junction ${vehicle.junction}. Scenario status: ${vehicle.status}.`,
        source: 'mission',
      }
      setVehicleMessages((current) =>
        current.some((item) => item.id === message.id) ? current : [...current, message]
      )
    }
  }, [now, vehicles])

  useEffect(() => {
    const hasNewReports = casualties.some(
      (casualty) =>
        casualty.status !== 'delivered' &&
        reportFor(casualty, now).some((message) => !emittedScenarioIds.current.has(message.id))
    )
    if (hasNewReports && !playing) setPlaying(true)
  }, [casualties, now, playing])

  // biome-ignore lint/correctness/useExhaustiveDependencies: replay the event queue when the scenario clock resets
  useEffect(() => {
    if (!playing) return
    const events = currentCasualties.current
      .filter((c) => c.status !== 'delivered')
      .flatMap((c) => reportFor(c, currentTime.current))
      .filter((event) => !emittedScenarioIds.current.has(event.id))
    if (events.length === 0) {
      setPlaying(false)
      return
    }
    let cursor = 0
    const emit = () => {
      const event = events[cursor++]
      if (!event) {
        window.clearInterval(timer)
        setPlaying(false)
        return
      }
      emittedScenarioIds.current.add(event.id)
      setScenarioMessages((current) =>
        current.some((message) => message.id === event.id) ? current : [...current, event]
      )
    }
    const timer = window.setInterval(emit, 1400)
    emit()
    return () => window.clearInterval(timer)
  }, [playing, scenarioGeneration])

  const messages = useMemo(() => {
    const sent = outgoing.flatMap((message) => {
      const initial = { ...message, direction: 'outgoing' as const, source: 'mission' as const }
      const elapsed = Math.max(0, (now.getTime() - message.time.getTime()) / 60000)
      const progress =
        message.journeyMinutes > 0 ? Math.min(1, elapsed / message.journeyMinutes) : 1
      const reached = Math.floor(progress * Math.max(message.routeJunctions.length - 1, 0))
      const updates: FeedMessage[] = message.routeJunctions
        .slice(1, reached + 1)
        .map((junction, index) => ({
          id: `${message.id}-J${index + 1}`,
          direction: 'outgoing',
          sender: message.recipient,
          recipient: 'C2',
          casualtyIds: message.casualtyIds,
          time: new Date(
            message.time.getTime() +
              ((message.journeyMinutes * (index + 1)) /
                Math.max(message.routeJunctions.length - 1, 1)) *
                60000
          ),
          text: `${message.recipient} update: passed junction ${junction}; continuing along the planned route to ${message.facilityName}.`,
          source: 'mission',
        }))
      if (progress >= 1)
        updates.push({
          ...initial,
          id: `${message.id}-ARRIVED`,
          time: new Date(message.time.getTime() + message.journeyMinutes * 60000),
          sender: message.recipient,
          recipient: 'C2',
          text: `${message.recipient} arrived at ${message.facilityName}. Awaiting handover and next care-team instruction.`,
        })
      return [initial, ...updates]
    })
    return [...scenarioMessages, ...vehicleMessages, ...audioMessages, ...sent].sort(
      (a, b) => a.time.getTime() - b.time.getTime()
    )
  }, [audioMessages, now, outgoing, scenarioMessages, vehicleMessages])

  // Embed generated casualty and dispatch messages too, so Parakeet transcripts
  // can be matched against the simulation's existing radio context.
  useEffect(() => {
    for (const message of messages) {
      if (
        message.embedding ||
        embeddings[message.id] ||
        requestedEmbeddings.current.has(message.id)
      )
        continue
      requestedEmbeddings.current.add(message.id)
      void fetch(`${SERVICE}/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: message.text }),
      })
        .then(async (response) => {
          const result = await response.json()
          if (!response.ok) throw new Error(result.detail ?? 'Embedding failed.')
          setEmbeddings((current) => ({ ...current, [message.id]: result.embedding }))
        })
        .catch(() => undefined)
    }
  }, [embeddings, messages])

  const embeddedMessages = useMemo(
    () =>
      messages.map((message) => ({
        ...message,
        embedding: message.embedding ?? embeddings[message.id],
      })),
    [embeddings, messages]
  )

  const latestMessageId = embeddedMessages.at(-1)?.id ?? null
  useEffect(() => {
    setActiveMessageId(latestMessageId)
  }, [latestMessageId])

  const activeIndex = embeddedMessages.findIndex((message) => message.id === activeMessageId)
  const activeMessage = embeddedMessages[activeIndex]
  const showMessage = (index: number) => {
    const message = embeddedMessages[index]
    if (message) setActiveMessageId(message.id)
  }

  const receiveAudio = async (blob: Blob, filename: string) => {
    setBusy(true)
    setError(null)
    try {
      const wav = await toWav(blob)
      const form = new FormData()
      form.append('audio', wav, filename.replace(/\.[^.]+$/, '.wav'))
      const response = await fetch(`${SERVICE}/transcribe`, { method: 'POST', body: form })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail ?? 'Transcription failed.')
      const transcript = String(result.transcript)
      const linked = casualties.find((c) => transcript.toLowerCase().includes(c.id.toLowerCase()))
      const message: FeedMessage = {
        id: `AUDIO-${Date.now()}`,
        direction: 'incoming',
        sender: 'Field medic · audio',
        recipient: 'C2',
        casualtyIds: linked ? [linked.id] : [],
        time: now,
        text: transcript,
        embedding: result.embedding,
        source: 'audio',
      }
      setAudioMessages((current) => [message, ...current])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not transcribe this recording.')
    } finally {
      setBusy(false)
    }
  }

  const startRecording = async () => {
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : undefined
      const next = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      recorder.current = next
      chunks.current = []
      next.ondataavailable = (event) => event.data.size && chunks.current.push(event.data)
      next.onstop = () => {
        for (const track of stream.getTracks()) track.stop()
        void receiveAudio(
          new Blob(chunks.current, { type: next.mimeType || 'audio/webm' }),
          'radio-message.webm'
        )
      }
      next.start()
      setRecording(true)
    } catch {
      setError('Microphone access is unavailable. Allow microphone access or choose an audio file.')
    }
  }

  const relatedAudio = (message: FeedMessage) => {
    if (!message.embedding) return []
    return embeddedMessages
      .filter((candidate) => candidate.id !== message.id && candidate.embedding)
      .map((candidate) => ({ candidate, score: cosine(message.embedding!, candidate.embedding!) }))
      .filter(({ score }) => score >= 0.72)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
  }

  return (
    <section className="border-grey-700 border-b">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-semibold"
      >
        <span>Radio traffic</span>
        <span className="text-content-fourth text-xs">{messages.length} messages</span>
      </button>
      {open && (
        <div className="px-3 pb-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-content-fourth text-[11px]">
              Scenario dialogue follows simulator time and vehicle junctions
            </span>
            <div className="flex shrink-0 gap-1">
              <span className="rounded border border-[#166534] bg-[#052e16] px-2 py-1 text-[10px] font-bold tracking-wide text-[#86efac]">
                {playing
                  ? 'RADIO LIVE'
                  : scenarioMessages.length
                    ? 'DIALOGUE READY'
                    : 'WAITING FOR SCENARIO'}
              </span>
              <button
                type="button"
                disabled={busy || recording}
                onClick={startRecording}
                className="bg-grey-700 rounded px-2 py-1 text-[11px] disabled:opacity-50"
              >
                Receive audio
              </button>
              {recording && (
                <button
                  type="button"
                  onClick={() => {
                    recorder.current?.stop()
                    setRecording(false)
                  }}
                  className="rounded bg-[#991b1b] px-2 py-1 text-[11px] text-white"
                >
                  Stop
                </button>
              )}
              <label className="bg-grey-700 cursor-pointer rounded px-2 py-1 text-[11px]">
                Audio file
                <input
                  className="sr-only"
                  type="file"
                  accept="audio/*"
                  disabled={busy || recording}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0]
                    if (file) void receiveAudio(file, file.name)
                    event.currentTarget.value = ''
                  }}
                />
              </label>
            </div>
          </div>
          {recording && <p className="mb-2 text-xs text-[#fca5a5]">Listening to radio…</p>}
          {busy && (
            <p className="mb-2 text-xs text-content-fourth">Transcribing and embedding locally…</p>
          )}
          {error && (
            <p role="alert" className="mb-2 text-xs text-[#fca5a5]">
              {error}
            </p>
          )}
          <div className="overflow-hidden rounded-md border border-[#455365] bg-[#0b1118] shadow-lg">
            <div className="flex items-center justify-between border-b border-[#334155] bg-[#17212d] px-3 py-2">
              <div>
                <p className="text-[9px] font-bold tracking-[0.2em] text-[#fbbf24]">FIELD COMMS</p>
                <p className="text-[10px] text-[#93a4b8]">
                  INCIDENT DIALOGUE · {embeddedMessages.length} transmissions
                </p>
              </div>
              {activeMessage && (
                <span className="font-mono text-[10px] text-[#cbd5e1]">
                  {formatClock(activeMessage.time)}
                </span>
              )}
            </div>
            {activeMessage ? (
              <div className="p-3" aria-live="polite">
                <div className="mb-2 flex items-center gap-2">
                  <div
                    className={`!h-5 !w-5 flex shrink-0 items-center justify-center rounded border !text-[8px] font-black ${activeMessage.direction === 'incoming' ? 'border-[#60a5fa] bg-[#172554] text-[#bfdbfe]' : 'border-[#4ade80] bg-[#052e16] text-[#bbf7d0]'}`}
                    style={{ minWidth: '1.25rem', minHeight: '1.25rem' }}
                  >
                    {activeMessage.sender
                      .split(/\s+/)
                      .map((part) => part[0])
                      .join('')
                      .slice(0, 2)
                      .toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-xs font-bold text-white">{activeMessage.sender}</p>
                    <p className="text-[10px] text-[#93a4b8]">
                      TO {activeMessage.recipient.toUpperCase()}
                      {activeMessage.casualtyIds.length
                        ? ` · ${activeMessage.casualtyIds.join(', ')}`
                        : ''}
                    </p>
                  </div>
                  <span
                    className={`ml-auto rounded px-1.5 py-0.5 text-[9px] font-bold tracking-wider ${activeMessage.direction === 'incoming' ? 'bg-[#1e3a5f] text-[#93c5fd]' : 'bg-[#14532d] text-[#86efac]'}`}
                  >
                    {activeMessage.direction === 'incoming' ? 'INCOMING' : 'TRANSMIT'}
                  </span>
                </div>
                <div className="min-h-20 rounded border border-[#334155] bg-[#111a24] px-3 py-3 text-sm leading-6 text-[#f1f5f9]">
                  {activeMessage.text}
                </div>
                {activeMessage.embedding && relatedAudio(activeMessage).length > 0 && (
                  <p className="mt-2 text-[10px] text-[#fde68a]">
                    Related by multilingual E5:{' '}
                    {relatedAudio(activeMessage)
                      .map(({ candidate }) => candidate.sender)
                      .join(', ')}
                  </p>
                )}
                <div className="mt-3 flex items-center justify-between">
                  <button
                    type="button"
                    disabled={activeIndex <= 0}
                    onClick={() => showMessage(activeIndex - 1)}
                    className="rounded border border-[#475569] px-2 py-1 text-[10px] text-[#cbd5e1] disabled:opacity-40"
                  >
                    Previous
                  </button>
                  <span className="font-mono text-[10px] text-[#93a4b8]">
                    {activeIndex + 1} / {embeddedMessages.length}
                  </span>
                  <button
                    type="button"
                    disabled={activeIndex >= embeddedMessages.length - 1}
                    onClick={() => showMessage(activeIndex + 1)}
                    className="rounded border border-[#fbbf24] bg-[#78350f] px-2 py-1 text-[10px] font-bold text-[#fef3c7] disabled:opacity-40"
                  >
                    Next transmission ›
                  </button>
                </div>
              </div>
            ) : (
              <p className="px-3 py-6 text-center text-xs text-[#93a4b8]">
                Start the scenario radio to hear the incident unfold.
              </p>
            )}
          </div>
          <p className="mt-2 text-[10px] text-[#93a4b8]">
            Dialogue uses recorded priority, mobility, injury time and status. No vital signs exist
            in this scenario.
          </p>
          <ol
            className="mt-2 max-h-24 space-y-1 overflow-y-auto"
            aria-label="Previous transmissions"
          >
            {embeddedMessages.slice(-5).map((message, index) => {
              const absoluteIndex =
                embeddedMessages.length - Math.min(embeddedMessages.length, 5) + index
              return (
                <li key={message.id}>
                  <button
                    type="button"
                    onClick={() => showMessage(absoluteIndex)}
                    className={`w-full truncate rounded px-2 py-1 text-left text-[10px] ${message.id === activeMessageId ? 'bg-[#29384a] text-white' : 'text-[#93a4b8] hover:bg-[#17212d]'}`}
                  >
                    {message.sender} <span className="text-[#fbbf24]">›</span> {message.text}
                  </button>
                </li>
              )
            })}
          </ol>
        </div>
      )}
    </section>
  )
}
