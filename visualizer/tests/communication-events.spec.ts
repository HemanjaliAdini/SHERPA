import { expect, test } from '@playwright/test'
import { communicationEvents } from '../src/components/c2/communications'
import type { GeoGraph, GraphNode } from '../src/components/c2/graph-data'
import type { Scenario } from '../src/components/c2/scenario-data'

const node = (nid: number, id: string, label: string, status = ''): GraphNode => ({ nid, id, label, status, lat: 47, lon: 35, kind: '', tag: id, derived: false })
function world(status: string, triage: string, mission = true) {
  const casualty = node(1, 'CAS-2', 'Casualty', status)
  const vehicle = node(2, 'AMB-1', 'Vehicle', 'tasked')
  const facility = node(3, 'R1-A', 'MedicalPoint')
  const assignment = node(4, 'M-1', 'Mission', 'active')
  const graph = { nodes: new Map([casualty, vehicle, facility, ...(mission ? [assignment] : [])].map((n) => [n.nid, n])),
    edges: mission ? ['USES', 'PICKS_UP', 'DELIVERS_TO'].map((type, i) => ({ src: 4, dst: [2, 1, 3][i], type })) : [] } as unknown as GeoGraph
  const scenario = { casualties: [{ nid: 1, id: 'CAS-2', triage, status, mobility: 'litter', recommendation: { evidence: ['bleeding_severe: app yes'] } }],
    vehicles: [], facilities: [{ id: 'R1-A', state: 'operational', medics: 3 }] } as unknown as Scenario
  return { graph, scenario }
}
test('untriaged reports go from the soldier at the casualty to the medical coordinator', () => {
  const { graph, scenario } = world('reported', '', false)
  const events = communicationEvents(graph, scenario)
  expect(events[0].speaker).toBe('CAS-2')
  expect(events[0].text).toContain('bleeding severe: app yes')
  expect(events[1].speaker).toBe('MED-R1-A')
  expect(events[1].text).toContain('Triage pending')
})
test('dispatch and approach use the assigned ambulance and casualty', () => {
  const { graph, scenario } = world('assigned', 'T1')
  const events = communicationEvents(graph, scenario)
  expect(events.find((event) => event.speaker === 'CMD-1')?.text).toContain('AMB-1, collect CAS-2')
  expect(events.find((event) => event.key.startsWith('approach:'))?.text).toContain('Approaching CAS-2')
  graph.nodes.get(2)!.lat = 47.1
  expect(communicationEvents(graph, scenario).some((event) => event.key.startsWith('approach:'))).toBe(false)
})
test('pickup speaks from the vehicle, casualty and receiving medics', () => {
  const { graph, scenario } = world('in_transit', 'T1')
  const events = communicationEvents(graph, scenario)
  expect(events.find((event) => event.key.startsWith('pickup:'))?.text).toBe('CAS-2 aboard. Moving to R1-A.')
  expect(events.find((event) => event.key.startsWith('aboard:'))?.speaker).toBe('CAS-2')
  expect(events.find((event) => event.key.startsWith('receiving:'))?.speaker).toBe('MED-R1-A')
  expect(events.some((event) => event.key.startsWith('approach:'))).toBe(false)
})
test('completed transfer and relay request come from the receiving team', () => {
  const { graph, scenario } = world('delivered', 'T1', false)
  graph.edges.push({ src: 1, dst: 3, type: 'HELD_AT' } as GeoGraph['edges'][number])
  expect(communicationEvents(graph, scenario)).toEqual([{ key: 'handover:CAS-2:R1-A', speaker: 'MED-R1-A', text: 'CAS-2 received at R1-A. Handover complete.' }])
  scenario.casualties[0].status = 'awaiting_pickup'
  expect(communicationEvents(graph, scenario).find((event) => event.key.startsWith('handover:'))?.text).toContain('Request ambulance for onward evacuation')
})

test('dead casualties generate a death status update even after a T3 triage decision', () => {
  const { graph, scenario } = world('dead', 'T3')
  const events = communicationEvents(graph, scenario)
  expect(events.some((event) => event.key.startsWith('status:CAS-2:dead'))).toBe(true)
  expect(events.find((event) => event.key.startsWith('status:CAS-2:dead'))?.text).toContain('dead')
  expect(events.find((event) => event.key.startsWith('triage:CAS-2')))?.toBeUndefined()
})

test('radio assignment stays complete when map mission nodes or edges lag behind', () => {
  const { graph, scenario } = world('assigned', 'T1', false)
  scenario.assignments = [{ id: 'M-9', status: 'active', casualtyId: 'CAS-2', casualtyStatus: 'assigned',
    casualtyLat: 47, casualtyLon: 35, vehicleId: 'AMB-2', vehicleLat: 47.1, vehicleLon: 35, destinationId: 'R1-B' }]
  const events = communicationEvents(graph, scenario)
  expect(events.find((event) => event.key.startsWith('dispatch:'))?.text).toBe('AMB-2, collect CAS-2. Transfer to R1-B.')
  expect(events.find((event) => event.key.startsWith('moving:'))?.speaker).toBe('AMB-2')
  expect(events.some((event) => event.key.startsWith('waiting:'))).toBe(false)
})
