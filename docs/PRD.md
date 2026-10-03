# The Golden Hours: System Design

Team document, EDTH London (2–4 Oct 2026). This is what we are actually building.

---

## 1. The problem

Getting wounded troops to surgery within an hour nearly halved combat deaths in Afghanistan (13.7% → 7.6%). That "golden hour" depended on fast evacuation through uncontested airspace.

Cheap drones have ended that. In Ukraine, casualties are held forward for hours, days or even weeks, evacuated in brief windows by ground robots or on foot, and kept alive by supplies pushed forward to them.

The physiology hasn't changed, but the logistics have. Evacuation is no longer one fast transfer: it is a continuous coordination problem across casualties, routes, windows, assets and resupply. Commanders lack a single live picture of these relationships, so they can't prioritise who moves, when, by what means, and what must reach them first.

**Who is the user or stakeholder?** The C2 (command and control) of a medical brigade, and ambulance coordinators.

**Does this actually work in the real world?** Maybe. To validate with mentors.

**Is it novel, useful and mass-producible?** Yes.

**Dual use.** The same system applies to organising ambulance services, disaster rescue and civilian mass-casualty events.

### Current trauma pathway

```
Point of wounding
      ↓
Stabilisation / triage point
      ↓
Role 1
      ↓
Role 2 / Role 2 enhanced
      ↓
Field hospital
      ↓
Hospital at home
```

- The number of points at each level is a funnel: there are more stabilisation points than Role 1s, and so on.
- Distance from the frontline increases as you go down.
- So does the seniority of the staff, from a soldier with basic first-aid training to a consultant.

---

## 2. Scenario area

We simulate the area around **Orikhiv, Zaporizhzhia oblast (Ukraine)**, using OpenStreetMap road data. Main roads in view: T0408, T0803, T0812, T0815.

![Scenario area around Orikhiv](img/area-orikhiv.png)

---

## 3. System requirements

### What the system does

1. **Casualties arrive with their information already collected.** We receive data already prepared as a MIST/MISTAT report, or with the information needed to take a triage decision. The base system is the graph database and the map working as if casualties appear from nowhere with all their information. Drones and sensors come later. Starting point: there are X casualties with this information.
2. **The medic responds to a list of reports.** The medic sees the list and decides, for example: walk those who can walk to the triage point, or allocate UGVs to different people in a different order.
3. **The medic simulates the evacuation path.** The system assigns vehicles, medical points and open roads, using shortest path.
4. **The system handles changing events,** for example a bridge collapse, or a stabilisation point that is overwhelmed or has lost power.
5. **Information arrives asynchronously.** Different messages arrive at different times, and decisions must update from each one.
6. **The database tells each UGV where to go next.**
7. **Replay to learn from deployments.** Replaying TuringDB history answers questions such as "if we had one more UGV, how many more lives could we have saved?"
8. **Everything is live on a map:** casualties, medics, vehicles and medical points.

### Nice to have

1. **Real detections from drones and devices.** Use a vision model on drone images instead of simulated detections, and gather as much information as possible from drones or electronic devices (such as phones) to feed triage.
2. **Request more resources.** When UGVs or medics are short, send a message or call to one of us, simulating getting more UGVs ready as soon as possible.
3. **Plain-language questions** to a local LLM, translated into graph queries.
4. **A triage system,** possibly based on the NHS Major Incident Triage Tool (below).

![NHS Major Incident Triage Tool](img/triage-mitt.png)

### Out of scope (deliberately)

- **AI that decides clinical priority.** The AI collects and organises information; the human decides.
- **Real patient data.** The scenario is synthetic.
- **Anything that could work as targeting or weapons guidance.** This is casualty care only.
- **Cloud services.** Everything runs on our laptops, offline, as it would in the field.

---

## 4. Data model

### Entities

```
(:Casualty {
  id,
  lat,
  lon,
  time_of_injury,
  status,
  triage_category,
  mobility
})

(:MedicalPoint {
  id,
  name,
  lat,
  lon,
  type,
  capabilities,
  medics_available,
  medics_total,
  state,
  free_beds
})

(:Vehicle {
  id,
  type,
  lat,
  lon,
  litter_capacity,
  ambulatory_capacity,
  range_km,
  battery_pct,
  max_threat,
  status
})

(:Junction {
  id,
  lat,
  lon
})

(:Threat {
  id,
  type,
  level,
  active
})

(:Mission {
  id,
  status,
  created_at,
  eta
})
```

### Relationships

```
(:Junction)-[:ROAD {
  id,
  geometry,
  length_m,
  surface,
  status,
  threat_level,
  speed_ugv_kmh,
  speed_ambulance_kmh
}]->(:Junction)

(:Threat)-[:AFFECTS]->(:Junction)

(:Casualty)-[:NEAR {distance_m}]->(:Junction)
(:Vehicle)-[:NEAR {distance_m}]->(:Junction)
(:MedicalPoint)-[:NEAR {distance_m}]->(:Junction)

(:MedicalPoint)-[:CREATED]->(:Mission)

(:Mission)-[:USES]->(:Vehicle)

(:Mission)-[:PICKS_UP {
  order,
  status,
  eta
}]->(:Casualty)

(:Mission)-[:DELIVERS_TO]->(:MedicalPoint)

(:Mission)-[:ROUTE_STEP {
  order
}]->(:Junction)

(:Casualty)-[:HELD_AT]->(:MedicalPoint)
```

### Next step: refilling resources

```
(:MedicalPoint)-[:REQUESTS_VEHICLE]->(:MedicalPoint)
(:MedicalPoint)-[:REQUESTS_MEDICS]->(:MedicalPoint)
```

---

## 5. Open decisions (to settle when we build the graph)

Not decided yet. To compare with what a teammate is building before we choose.

1. **Route weights must be precomputed.** TuringDB's `shortestPath` uses a single numeric edge property as the weight, so it cannot compute `length_m / speed` inside the query. Option: store `minutes_ugv` and `minutes_ambulance` on each `ROAD`.
2. **Threat and closed roads inside the weight.** It is unknown whether `shortestPath` can skip edges by a property. Option: when a road is closed, or its threat exceeds what a vehicle type tolerates, raise that type's weight to 1,000,000. Also choose one source of truth for threat: `Threat-[:AFFECTS]->Junction` or `ROAD.threat_level`, not both.
3. **Asynchronous messages need time and source.** `Casualty` has no `reported_at` or `last_update`. Options: add `reported_at` and `source` to `Casualty`, or add a `Report` (MIST) node linked to each casualty, which keeps the message history for audit.
4. **A metric for "lives saved" when replaying.** We have no survival model. Option: % of casualties of each triage category that reach the right medical point within their target time (for example category 1 within 60 minutes, following NATO's 10-1-2). "One more UGV" is then a branch with an extra vehicle, compared with the base scenario on this metric.
5. **Data types.** The TuringDB SDK lists text, integers, decimals and booleans. Option: store `geometry` and `capabilities` as text (JSON), and times as seconds (`Int64`).
6. **Triage protocol for synthetic casualties.** Option: generate them consistent with the NHS Major Incident Triage Tool (categories 1, 2, 3 and dead), in use in England since June 2024.