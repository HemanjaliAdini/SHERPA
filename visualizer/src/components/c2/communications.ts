import { useEffect, useRef, useState } from 'react'
import type { GeoGraph, GraphNode } from './graph-data'
import type { Scenario } from './scenario-data'

export type RadioBubble = { key: string; speaker: string; text: string; time: number }
export type Communication = Omit<RadioBubble, 'time'>

/** Event keys identify transitions, so a poll never repeats the same radio call. */
export function communicationEvents(graph: GeoGraph, scenario: Scenario): Communication[] {
  const events: Communication[] = []
  const nodes = [...graph.nodes.values()]
  const linked = (source: number, type: string) => graph.edges
    .filter((edge) => edge.src === source && edge.type === type)
    .map((edge) => graph.nodes.get(edge.dst)).filter((node): node is GraphNode => !!node)
  for (const casualty of scenario.casualties) {
    const node = graph.nodes.get(casualty.nid)
    if (!node) continue
    const medic = `MED-${casualty.id}`
    if (casualty.status === 'reported') {
      events.push({ key: `report:${casualty.id}`, speaker: casualty.id,
        text: `Medic, report for ${casualty.id}: ${casualty.mist.injuries || 'injury details not recorded'}. ${casualty.mist.signs || ''}` })
      events.push({ key: `assessment:${casualty.id}`, speaker: medic,
        text: `Report received for ${casualty.id}. MIST received. Awaiting the medic’s triage and mobility decision. Triage pending.` })
    }
    if (casualty.status === 'dead' || casualty.triage === 'DEAD') {
      events.push({ key: `status:${casualty.id}:dead`, speaker: medic,
        text: `${casualty.id} recorded as dead. No further evacuation or transport required.` })
      continue
    }
    if (casualty.triage && casualty.status !== 'delivered') events.push({ key: `triage:${casualty.id}:${casualty.triage}:${casualty.mobility}`, speaker: medic,
      text: ['T1', 'T2', 'T3'].includes(casualty.triage)
        ? `${casualty.id}, ${casualty.triage}, ${casualty.mobility || 'mobility not recorded'}. Priority ${casualty.triage === 'T1' ? 'first' : casualty.triage === 'T2' ? 'second' : 'third'}. Request evacuation.`
        : `${casualty.id}: recorded ${casualty.triage}. No automatic evacuation dispatch.` })
    const assigned = scenario.assignments ? scenario.assignments.some((mission) => mission.casualtyId === casualty.id) : graph.edges.some((edge) => edge.type === 'PICKS_UP' && edge.dst === casualty.nid)
    if (casualty.status === 'awaiting_pickup' && ['T1', 'T2', 'T3'].includes(casualty.triage) && !assigned) {
      events.push({ key: `waiting:${casualty.id}:${casualty.triage}`, speaker: 'CMD-1',
        text: `${casualty.id} queued by triage priority. Request received. Awaiting an available suitable vehicle and receiving point.` })
    }
    const held = linked(node.nid, 'HELD_AT')[0]
    if (held && ['delivered', 'awaiting_pickup'].includes(casualty.status)) {
      events.push({ key: `handover:${casualty.id}:${held.id}`, speaker: `MED-${held.id}`,
        text: `${casualty.id} received at ${held.id}. ${casualty.status === 'delivered' ? 'Handover complete.' : 'Request ambulance for onward evacuation.'}` })
    }
  }
  const assignments = scenario.assignments ?? nodes.filter((node) => node.label === 'Mission').flatMap((mission) => {
    const vehicle = linked(mission.nid, 'USES')[0]
    const point = linked(mission.nid, 'DELIVERS_TO')[0]
    if (!vehicle || !point) return []
    return linked(mission.nid, 'PICKS_UP').map((casualty) => ({
      id: mission.id, status: mission.status, casualtyId: casualty.id, casualtyStatus: casualty.status,
      casualtyLat: casualty.lat, casualtyLon: casualty.lon, vehicleId: vehicle.id,
      vehicleLat: vehicle.lat, vehicleLon: vehicle.lon, destinationId: point.id,
    }))
  })
  for (const mission of assignments) {
    const vehicle = { id: mission.vehicleId, lat: mission.vehicleLat, lon: mission.vehicleLon }
    const point = { id: mission.destinationId }
    const casualty = { id: mission.casualtyId, status: mission.casualtyStatus, lat: mission.casualtyLat, lon: mission.casualtyLon }
      events.push({ key: `dispatch:${mission.id}:${casualty.id}`, speaker: 'CMD-1',
        text: casualty.status === 'in_transit' ? `${vehicle.id}, continue transfer of ${casualty.id} to ${point.id}.` : `${vehicle.id}, collect ${casualty.id}. Transfer to ${point.id}.` })
      if (casualty.status === 'assigned') events.push({ key: `moving:${mission.id}:${casualty.id}`, speaker: vehicle.id,
        text: `Copy, command. Moving to ${casualty.id}.` })
      if (casualty.status === 'assigned') {
        const north = (casualty.lat - vehicle.lat) * 111195
        const east = (casualty.lon - vehicle.lon) * 111195 * Math.cos(vehicle.lat * Math.PI / 180)
        if (Math.hypot(north, east) <= 500) {
          events.push({ key: `approach:${mission.id}:${casualty.id}`, speaker: vehicle.id, text: `Approaching ${casualty.id}. Medic, prepare for pickup.` })
          events.push({ key: `ready:${mission.id}:${casualty.id}`, speaker: `MED-${casualty.id}`, text: `Copy ${vehicle.id}. ${casualty.id} ready for transfer.` })
        }
      }
      if (casualty.status === 'in_transit') {
        events.push({ key: `pickup:${mission.id}:${casualty.id}`, speaker: vehicle.id, text: `${casualty.id} aboard. Moving to ${point.id}.` })
        events.push({ key: `aboard:${mission.id}:${casualty.id}`, speaker: casualty.id, text: `With ${vehicle.id}. Transfer under way.` })
        const facility = scenario.facilities.find((item) => item.id === point.id)
        events.push({ key: `receiving:${mission.id}:${casualty.id}`, speaker: `MED-${point.id}`,
          text: facility?.state === 'operational' && facility.medics > 0
            ? `Copy ${vehicle.id}. Receiving team available at ${point.id}.`
            : `${point.id}: receiving-team availability needs confirmation.` })
      }
  }
  return events
}

export type RadioMessage = Communication & { casualtyId: string; recipient: string; time: number }

function recipientFor(event: Communication, graph: GeoGraph, scenario: Scenario, casualtyId: string): string {
  const phase = event.key.split(':')[0]
  const missionId = event.key.split(':')[1]
  const mission = [...graph.nodes.values()].find((node) => node.label === 'Mission' && node.id === missionId)
  const assignment = scenario.assignments?.find((mission) => mission.id === missionId && mission.casualtyId === casualtyId)
  const linkedId = (type: string) => {
    if (assignment) return type === 'USES' ? assignment.vehicleId : assignment.destinationId
    const edge = graph.edges.find((edge) => edge.src === mission?.nid && edge.type === type)
    return edge ? graph.nodes.get(edge.dst)?.id : undefined
  }
  switch (phase) {
    case 'report': return `MED-${casualtyId}`
    case 'assessment': return casualtyId
    case 'triage': return 'CMD-1'
    case 'status': return 'CMD-1'
    case 'waiting': return `MED-${casualtyId}`
    case 'dispatch': case 'ready': case 'receiving': return linkedId('USES') ?? 'Transport team'
    case 'approach': return `MED-${casualtyId}`
    case 'pickup': return `MED-${linkedId('DELIVERS_TO') ?? 'receiving point'}`
    case 'aboard': return linkedId('USES') ?? 'Transport team'
    default: return 'CMD-1'
  }
}

/** Capture scenario messages continuously, preserving separate history for every casualty. */
export function useRadioHistory(graph: GeoGraph | undefined, scenario: Scenario | undefined, now: Date, graphName: string) {
  const [history, setHistory] = useState<RadioMessage[]>([])
  const seen = useRef(new Set<string>())
  const triageSignatures = useRef(new Map<string, string>())
  const sequence = useRef(0)
  const lastClock = useRef<number | null>(null)
  const previousReset = useRef(true)
  const epoch = useRef(graphName)
  useEffect(() => {
    if (!graph || !scenario) return
    const atStart = scenario.casualties.every((casualty) => casualty.status === 'reported' && !casualty.triage)
    const reset = epoch.current !== graphName || (lastClock.current !== null && now.getTime() < lastClock.current) || (atStart && !previousReset.current)
    if (reset) { seen.current.clear(); triageSignatures.current.clear() }
    for (const casualty of scenario.casualties) {
      const signature = `${casualty.triage}:${casualty.mobility}`
      if (triageSignatures.current.get(casualty.id) !== signature) seen.current.delete(`triage:${casualty.id}:${signature}`)
      triageSignatures.current.set(casualty.id, signature)
    }
    epoch.current = graphName
    lastClock.current = now.getTime()
    previousReset.current = atStart
    const incoming: RadioMessage[] = []
    const speakers = new Set([...graph.nodes.values()].map((node) => node.id))
    for (const event of communicationEvents(graph, scenario)) {
      if (seen.current.has(event.key) || !speakers.has(event.speaker)) continue
      const casualtyId = event.key.split(':').find((part) => scenario.casualties.some((casualty) => casualty.id === part))
      if (!casualtyId) continue
      seen.current.add(event.key)
      incoming.push({ ...event, key: `${event.key}:message-${++sequence.current}`, casualtyId, recipient: recipientFor(event, graph, scenario, casualtyId), time: now.getTime() })
    }
    if (reset || incoming.length) setHistory((current) => [...(reset ? [] : current), ...incoming])
  }, [graph, scenario, now, graphName])
  return history
}
