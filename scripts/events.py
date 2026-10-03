"""Events: everything that happens during a run (PRD decision 6.11; contract in section 5, "Events").

Producers (the demo script, buttons, the radio) create `Event` nodes with `status = 'pending'`. Only the simulator
applies them: `apply_due` runs inside the tick's change, before dispatch, so a closed road counts in the same minute.
An applied event links `AFFECTS` to the junctions it touched, which places it on the C2 map.

To add an event type (PRD 8.2): a row in the section 5 table, a handler here registered in HANDLERS, a test in
tests/test_events.py, and its undo in `reset_events` if the generic one is not enough.
"""
import json
from datetime import datetime

from turingdb import TuringDB

from cypher import lit, props
from routing import DESTINATION_TYPES, RELAY_TYPES, cypher_time, load_roads, route, rows

MAX_ERROR_CHARS = 300


class EventError(Exception):
    """The event cannot be applied as written (unknown type, bad payload, nothing to act on)."""


def create_clause(event: dict) -> str:
    """One `(:Event {...})` pattern, pending, for a CREATE. `event` is an entry of demo_script.EVENTS."""
    return "(:Event " + props(
        id=lit(event["id"]), at=f"datetime({lit(event['at'])})", type=lit(event["type"]),
        payload=lit(json.dumps(event.get("payload", {}))), status=lit("pending"),
        source=lit(event.get("source", "script")),
    ) + ")"


def due(client: TuringDB, now: datetime) -> list[dict]:
    """Pending events whose time has come, oldest first."""
    pending = rows(client, "MATCH (e:Event) WHERE e.status = 'pending' "
                           "RETURN e.id AS id, e.at AS at, e.type AS type, e.payload AS payload")
    ready = [e for e in pending if e["at"] is not None and e["at"].to_pydatetime() <= now]
    return sorted(ready, key=lambda e: (e["at"], e["id"]))


def apply_due(client: TuringDB, now: datetime) -> list[str]:
    """Apply every due event, inside the caller's change. A failing one is marked `failed` and the tick goes on.
    Each handler returns one line on what happened, stored as `summary` for the screen. Returns the ids applied."""
    applied = []
    for e in due(client, now):
        event = f"MATCH (e:Event {{id: {lit(e['id'])}}})"
        try:
            handler = HANDLERS.get(e["type"])
            if handler is None:
                raise EventError(f"unknown event type {e['type']!r}")
            summary = handler(client, e["id"], json.loads(e["payload"] or "{}"), now)
            client.query(f"{event} SET e.status = 'applied', e.applied_at = {cypher_time(now)}, "
                         f"e.summary = {lit(summary)}")
            applied.append(e["id"])
            print(f"event {e['id']} ({e['type']}) applied: {summary}", flush=True)
        except Exception as err:  # noqa: BLE001 - any failure is recorded on the event, never kills the tick
            message = f"{type(err).__name__}: {err}"[:MAX_ERROR_CHARS]
            client.query(f"{event} SET e.status = 'failed', e.applied_at = {cypher_time(now)}, e.error = {lit(message)}")
            print(f"event {e['id']} ({e['type']}) failed: {message}", flush=True)
        client.query("COMMIT")
    return applied


# --- handlers ------------------------------------------------------------------------------------------------


def way_junctions(client: TuringDB, osm_way_id: int) -> list[int]:
    """The junctions along one OSM way, or EventError if the graph has no road with that id."""
    if osm_way_id == 0:  # build_roads.py gives every gap-joining connector way id 0: not one road
        raise EventError("osm_way_id 0 is the connectors added by build_roads.py, not one road")
    edges = rows(client, f"MATCH (a:Junction)-[r:ROAD]->(b:Junction) WHERE r.osm_way_id = {osm_way_id} "
                         "RETURN id(a) AS a, id(b) AS b")
    if not edges:
        raise EventError(f"no road with osm_way_id {osm_way_id}")
    return sorted({int(r["a"]) for r in edges} | {int(r["b"]) for r in edges})


def mark(client: TuringDB, event_id: str, junctions: list[int]) -> None:
    """Link the event to where it happened; the C2 map draws it at the middle of these junctions."""
    for j in junctions:
        client.query(f"MATCH (e:Event {{id: {lit(event_id)}}}) MATCH (j) WHERE j = {j} CREATE (e)-[:AFFECTS]->(j)")


def place(client: TuringDB, event_id: str, lat: float, lon: float) -> None:
    """An event that happened at one point: the C2 map puts its alert there (a road event sits mid-road)."""
    client.query(f"MATCH (e:Event {{id: {lit(event_id)}}}) SET e.lat = {lat}, e.lon = {lon}")


def road_closed(client: TuringDB, event_id: str, payload: dict, now: datetime) -> str:
    """Close the road both ways (decision 6.6), then re-route the missions it breaks."""
    way = int(payload["osm_way_id"])
    junctions = way_junctions(client, way)
    client.query(f"MATCH (:Junction)-[r:ROAD]->(:Junction) WHERE r.osm_way_id = {way} "
                 f"SET r.status = 'closed', r.closed_by = {lit(event_id)}")
    mark(client, event_id, junctions)
    client.query("COMMIT")  # the closure must be visible to the route searches below
    changed = reroute_broken(client, now)
    replanned = f"; {', '.join(changed)} re-planned" if changed else ""
    return f"{payload.get('reason') or 'Road closed'}: road closed{replanned}"


def road_delayed(client: TuringDB, event_id: str, payload: dict, now: datetime) -> str:
    """A partial blockage (debris, a jam): the road stays open but takes `delay_factor` times longer.
    Vehicles already on it slow down; dispatch and re-routing weigh it in."""
    way = int(payload["osm_way_id"])
    factor = float(payload["delay_factor"])
    if factor < 1:
        raise EventError(f"delay_factor must be 1 or more, got {factor}")
    junctions = way_junctions(client, way)
    client.query(f"MATCH (:Junction)-[r:ROAD]->(:Junction) WHERE r.osm_way_id = {way} "
                 f"SET r.delay_factor = {factor}, r.delayed_by = {lit(event_id)}")
    mark(client, event_id, junctions)
    return f"{payload.get('reason') or 'Road slowed'}: {factor:g}x slower"


MIST_FIELDS = ("mist_mechanism", "mist_injuries", "mist_signs", "mist_treatment")


def casualty_reported(client: TuringDB, event_id: str, payload: dict, now: datetime) -> str:
    """A new casualty, untriaged (`reported`), at its junction; the medic triages it on screen, then dispatch takes
    it. Without `time_of_injury` it was injured at the event's minute."""
    from seed_scenario import snap  # seed_scenario imports this module for create_clause

    cid, lat, lon = str(payload["id"]), float(payload["lat"]), float(payload["lon"])
    if rows(client, f"MATCH (c:Casualty {{id: {lit(cid)}}}) RETURN count(c) AS n")[0]["n"] > 0:
        raise EventError(f"casualty {cid} already exists")
    injured = f"datetime({lit(payload['time_of_injury'])})" if payload.get("time_of_injury") else cypher_time(now)
    mist = {k: lit(str(payload[k])) for k in MIST_FIELDS if payload.get(k)}
    client.query("CREATE (:Casualty " + props(id=lit(cid), lat=lat, lon=lon, time_of_injury=injured,
                                              status=lit("reported"), event_id=lit(event_id), **mist) + ")")
    client.query("COMMIT")  # the new casualty is invisible to the NEAR match below until committed
    junction, distance = snap(client, lat, lon)
    client.query(f"MATCH (c:Casualty {{id: {lit(cid)}}}) MATCH (j) WHERE j = {junction} "
                 f"CREATE (c)-[:NEAR {props(distance_m=distance)}]->(j)")
    place(client, event_id, lat, lon)
    mark(client, event_id, [junction])
    return f"New casualty {cid}" + (f": {payload['mist_mechanism']}" if payload.get("mist_mechanism") else "")


def stopping_vehicle(client: TuringDB, payload: dict) -> str:
    """The vehicle a battery event stops: `vehicle_id`, or with `vehicle_type` the first one of that type carrying
    a casualty, else the first on a mission (a scripted demo cannot know who is loaded at that minute)."""
    alive = {r["id"]: r for r in rows(client, "MATCH (v:Vehicle) WHERE v.status <> 'disabled' "
                                              "RETURN v.id AS id, v.type AS type, v.status AS status")}
    if payload.get("vehicle_id"):
        if payload["vehicle_id"] not in alive:
            raise EventError(f"no working vehicle {payload['vehicle_id']}")
        return payload["vehicle_id"]
    kind = payload["vehicle_type"]
    loaded = {r["vid"] for r in rows(client, (
        "MATCH (m:Mission)-[:USES]->(v:Vehicle), (m)-[:PICKS_UP]->(c:Casualty) "
        "WHERE c.status = 'in_transit' RETURN v.id AS vid, m.status AS status"
    )) if r["status"] in ("planned", "active")}
    ours = sorted(vid for vid, v in alive.items() if v["type"] == kind)
    for wanted in (lambda vid: vid in loaded, lambda vid: alive[vid]["status"] == "tasked"):
        found = [vid for vid in ours if wanted(vid)]
        if found:
            return found[0]
    raise EventError(f"no {kind} on a mission to stop")


def battery_depleted(client: TuringDB, event_id: str, payload: dict, now: datetime) -> str:
    """The vehicle stops where it is, for good (`disabled`). Its mission is cancelled: a casualty not yet picked up
    goes back in line; a casualty on board is left there, stranded (`stranded_by`, `stranded_from` = the vehicle
    type), and dispatch sends it the next free vehicle of that type before anyone else (routing.dispatch)."""
    from simulate import mission_legs, move_near

    vid = stopping_vehicle(client, payload)
    vehicle = f"MATCH (v:Vehicle {{id: {lit(vid)}}})"
    v = rows(client, f"{vehicle}-[:NEAR]->(j) RETURN v.lat AS lat, v.lon AS lon, v.type AS type, "
                     "v.speed_kmh AS speed, id(j) AS j")[0]
    here = int(v["j"])
    stranded = []
    for m in rows(client, f"MATCH (m:Mission)-[:USES]->(v:Vehicle {{id: {lit(vid)}}}) "
                          "RETURN m.id AS id, m.status AS status, m.progress_m AS progress"):
        if m["status"] not in ("planned", "active"):
            continue
        legs, junctions = mission_legs(client, m["id"], v["type"], v["speed"])
        here = junctions[last_passed(legs, m["progress"] or 0.0)]
        mission = f"MATCH (m:Mission {{id: {lit(m['id'])}}})"
        for c in rows(client, f"{mission}-[:PICKS_UP]->(c:Casualty) RETURN c.id AS id, c.status AS status"):
            casualty = f"MATCH (c:Casualty {{id: {lit(c['id'])}}})"
            if c["status"] == "in_transit":
                client.query(f"{casualty}-[h:HELD_AT]->() DELETE h")  # any vehicle may fetch it, not ambulances only
                client.query(f"{casualty} SET c.status = 'awaiting_pickup', c.stranded_by = {lit(event_id)}, "
                             f"c.stranded_from = {lit(v['type'])}")
                move_near(client, "Casualty", c["id"], here, v["lat"], v["lon"])
                stranded.append(c["id"])
            elif c["status"] == "assigned":
                client.query(f"{casualty} SET c.status = 'awaiting_pickup'")
        client.query(f"{mission}-[r:PICKS_UP]->() SET r.status = 'cancelled', m.status = 'cancelled'")
    move_near(client, "Vehicle", vid, here, v["lat"], v["lon"])
    client.query(f"{vehicle} SET v.status = 'disabled', v.battery_pct = 0, v.disabled_by = {lit(event_id)}")
    place(client, event_id, v["lat"], v["lon"])
    if stranded:  # resolve_events waits until every one of them is picked up
        client.query(f"MATCH (e:Event {{id: {lit(event_id)}}}) SET e.stranded = {lit(','.join(stranded))}")
    mark(client, event_id, [here])
    client.query("COMMIT")  # the same tick's dispatch sees the stranded casualty
    left = f"; {', '.join(stranded)} stranded, picked up first" if stranded else ""
    return f"{vid} stopped: {payload.get('reason') or 'battery depleted'}{left}"


def road_reopened(client: TuringDB, event_id: str, payload: dict, now: datetime) -> str:
    """The road is open again at its normal speed (a crater filled, debris cleared): undoes `road_closed` and
    `road_delayed` on that way, resolves the events that did it, and puts blocked missions back on the road."""
    way = int(payload["osm_way_id"])
    junctions = way_junctions(client, way)
    edges = rows(client, f"MATCH (:Junction)-[r:ROAD]->(:Junction) WHERE r.osm_way_id = {way} "
                         "RETURN r.status AS status, r.closed_by AS closed_by, r.delayed_by AS delayed_by")
    if all(r["status"] != "closed" and not isinstance(r["delayed_by"], str) for r in edges):
        raise EventError(f"road {way} is neither closed nor slowed")
    causes = sorted({r[k] for r in edges for k in ("closed_by", "delayed_by") if isinstance(r[k], str)})
    road = f"MATCH (:Junction)-[r:ROAD]->(:Junction) WHERE r.osm_way_id = {way}"
    client.query(f"{road} AND r.status = 'closed' SET r.status = 'open' REMOVE r.closed_by")
    client.query(f"{road} AND r.delayed_by IS NOT NULL SET r.delay_factor = 1.0 REMOVE r.delayed_by")
    reason = payload.get("reason") or "Road reopened"
    for cause in causes:
        resolve(client, cause, f"{reason} ({event_id})", now)
    mark(client, event_id, junctions)
    client.query("COMMIT")  # the open road must be visible to the route searches below
    resumed = resume_blocked(client, now)
    return f"{reason}: road open again" + (f"; {', '.join(resumed)} back on the road" if resumed else "")


HANDLERS = {
    "road_closed": road_closed,
    "road_delayed": road_delayed,
    "road_reopened": road_reopened,
    "casualty_reported": casualty_reported,
    "battery_depleted": battery_depleted,
}


# --- resolving: an applied event whose effect is over (section 5, "Resolved") -------------------------------


def resolve(client: TuringDB, event_id: str, resolution: str, now: datetime) -> None:
    client.query(f"MATCH (e:Event {{id: {lit(event_id)}}}) SET e.status = 'resolved', "
                 f"e.resolved_at = {cypher_time(now)}, e.resolution = {lit(resolution)}")
    print(f"event {event_id} resolved: {resolution}", flush=True)


def casualty_delivered(client: TuringDB, event: dict) -> str | None:
    """A reported casualty is resolved once it reaches a bed."""
    cid = json.loads(event["payload"] or "{}").get("id")
    found = rows(client, f"MATCH (c:Casualty {{id: {lit(cid)}}})-[:HELD_AT]->(p:MedicalPoint) "
                         "WHERE c.status = 'delivered' RETURN p.id AS p")
    return f"{cid} delivered to {found[0]['p']}" if found else None


def stranded_rescued(client: TuringDB, event: dict) -> str | None:
    """A flat battery is resolved once every casualty it stranded is on board another vehicle (the vehicle itself
    stays stopped)."""
    if not isinstance(event["stranded"], str):
        return None  # nobody was on board: nothing to resolve
    rides = []
    for cid in event["stranded"].split(","):
        carrier = rows(client, f"MATCH (m:Mission)-[:PICKS_UP]->(c:Casualty {{id: {lit(cid)}}}), (m)-[:USES]->(v) "
                               "WHERE c.status = 'in_transit' AND m.status = 'active' RETURN v.id AS v")
        if not carrier:
            return None
        rides.append(f"{cid} picked up by {carrier[0]['v']}")
    return "; ".join(rides)


RESOLVERS = {"casualty_reported": casualty_delivered, "battery_depleted": stranded_rescued}


def resolve_events(client: TuringDB, now: datetime) -> list[str]:
    """Resolve the applied events whose effect is over; road events are resolved by `road_reopened`. Runs at the
    end of the tick, after movement. Returns the ids resolved."""
    done = []
    for e in rows(client, "MATCH (e:Event) WHERE e.status = 'applied' "
                          "RETURN e.id AS id, e.type AS type, e.payload AS payload, e.stranded AS stranded"):
        check = RESOLVERS.get(e["type"])
        resolution = check(client, e) if check else None
        if resolution:
            resolve(client, e["id"], resolution, now)
            done.append(e["id"])
    return done


# --- re-routing after a closure (section 5, "Re-route after road_closed") ------------------------------------


def last_passed(legs, progress_m: float) -> int:
    """Index of the last ROUTE_STEP junction at or behind `progress_m`."""
    from simulate import distance_to_junction
    return max(k for k in range(len(legs) + 1) if distance_to_junction(legs, k) <= progress_m + 1e-6)


def reroute_broken(client: TuringDB, now: datetime) -> list[str]:
    """Missions with a closed road still ahead of their vehicle: the vehicle backs up to the last junction it
    passed; empty, the mission is cancelled for the same tick's dispatch; loaded, it gets a new route.
    Returns the ids of the missions changed."""
    from simulate import mission_legs, move_near

    roads = load_roads(client)  # open roads only
    open_pairs = {(a, r.dst) for a, out in roads.items() for r in out}
    changed = []
    for m in rows(client, (
        "MATCH (m:Mission)-[:USES]->(v:Vehicle) WHERE m.status = 'planned' OR m.status = 'active' "
        "RETURN m.id AS id, m.progress_m AS progress, v.id AS vid, v.type AS type, v.speed_kmh AS speed, "
        "v.max_threat AS max_threat"
    )):
        m["max_threat"] = 1.0 if m["max_threat"] is None else m["max_threat"]
        legs, junctions = mission_legs(client, m["id"], m["type"], m["speed"])
        passed = last_passed(legs, m["progress"] or 0.0)
        ahead = list(zip(junctions[passed:], junctions[passed + 1:]))
        if all(pair in open_pairs for pair in ahead):
            continue
        here = junctions[passed]
        j = rows(client, f"MATCH (j) WHERE j = {here} RETURN j.lat AS lat, j.lon AS lon")[0]
        move_near(client, "Vehicle", m["vid"], here, j["lat"], j["lon"])
        loaded = rows(client, f"MATCH (m:Mission {{id: {lit(m['id'])}}})-[:PICKS_UP]->(c:Casualty) "
                              "WHERE c.status = 'in_transit' RETURN count(c) AS n")[0]["n"] > 0
        if loaded:
            new_route(client, m, here, roads, now)
        else:
            cancel(client, m["id"])
        changed.append(m["id"])
        client.query("COMMIT")  # dispatch and movement in this tick read the new state
    return changed


def resume_blocked(client: TuringDB, now: datetime) -> list[str]:
    """Blocked missions try again from where their vehicle waits; the ones with a route now are active again."""
    roads = load_roads(client)
    resumed = []
    for m in rows(client, (
        "MATCH (m:Mission)-[:USES]->(v:Vehicle)-[:NEAR]->(j) WHERE m.status = 'blocked' "
        "RETURN m.id AS id, v.type AS type, v.speed_kmh AS speed, v.max_threat AS max_threat, id(j) AS j"
    )):
        m["max_threat"] = 1.0 if m["max_threat"] is None else m["max_threat"]
        client.query(f"MATCH (m:Mission {{id: {lit(m['id'])}}}) SET m.status = 'active'")
        new_route(client, m, int(m["j"]), roads, now)  # sets it back to blocked if there is still no way
        if rows(client, f"MATCH (m:Mission {{id: {lit(m['id'])}}}) RETURN m.status AS s")[0]["s"] == "active":
            resumed.append(m["id"])
    client.query("COMMIT")
    return resumed


def cancel(client: TuringDB, mission_id: str) -> None:
    """Nobody on board yet: free the vehicle and put the casualty back in line; dispatch plans it again."""
    mission = f"MATCH (m:Mission {{id: {lit(mission_id)}}})"
    client.query(f"{mission}-[r:PICKS_UP]->(c:Casualty) SET r.status = 'cancelled', c.status = 'awaiting_pickup'")
    client.query(f"{mission}-[:USES]->(v:Vehicle) SET m.status = 'cancelled', v.status = 'idle'")
    print(f"mission {mission_id} cancelled by a closed road; its casualty goes back to dispatch", flush=True)


def new_route(client: TuringDB, m: dict, here: int, roads, now: datetime) -> None:
    """A casualty on board: a new route from `here` to the same destination, or to the nearest reachable one of
    the vehicle's type. With none reachable the mission is `blocked` and the vehicle waits at `here`."""
    mission = f"MATCH (m:Mission {{id: {lit(m['id'])}}})"
    dest = rows(client, f"{mission}-[:DELIVERS_TO]->(p:MedicalPoint)-[:NEAR]->(j) RETURN p.id AS id, id(j) AS j")[0]
    found = route(roads, here, int(dest["j"]), m["type"], m["speed"], m["max_threat"])
    target = dest["id"]
    if found is None:
        options = []
        for p in rows(client, "MATCH (p:MedicalPoint)-[:NEAR]->(j) WHERE p.state = 'operational' "
                              "RETURN p.id AS id, p.type AS type, p.free_beds AS beds, id(j) AS j"):
            if p["type"] not in DESTINATION_TYPES[m["type"]] or (p["type"] not in RELAY_TYPES and p["beds"] <= 0):
                continue
            r = route(roads, here, int(p["j"]), m["type"], m["speed"], m["max_threat"])
            if r is not None:
                options.append((r[1], p["id"], r))
        if not options:
            client.query(f"{mission} SET m.status = 'blocked'")
            print(f"mission {m['id']} blocked: no open road to any destination", flush=True)
            return
        _, target, found = min(options)
        client.query(f"{mission}-[d:DELIVERS_TO]->() DELETE d")
        client.query(f"{mission} MATCH (p:MedicalPoint {{id: {lit(target)}}}) CREATE (m)-[:DELIVERS_TO]->(p)")
    steps, minutes, _ = found
    client.query(f"{mission}-[s:ROUTE_STEP]->() DELETE s")
    for order, junction in enumerate(steps, 1):
        client.query(f"{mission} MATCH (j) WHERE j = {junction} CREATE (m)-[:ROUTE_STEP {props(order=order)}]->(j)")
    eta = now.timestamp() + minutes * 60
    client.query(f"{mission} SET m.progress_m = 0.0, "
                 f"m.eta = {cypher_time(datetime.fromtimestamp(eta, tz=now.tzinfo))}")
    print(f"mission {m['id']} re-routed to {target}: {minutes:.0f} min", flush=True)


# --- reset (section 5, "Reset") ------------------------------------------------------------------------------


def reset_events(client: TuringDB) -> None:
    """Undo every event and put the demo script back: roads reopen and lose their delays, stopped vehicles run again
    (reset_writes restores their battery), nobody is stranded, nodes an event created (they carry `event_id`) go,
    and the script's events are recreated pending (so edits to the script take effect on Reset). Live events are
    deleted."""
    from demo_script import EVENTS

    client.query("MATCH (:Junction)-[r:ROAD]->(:Junction) WHERE r.closed_by IS NOT NULL "
                 "SET r.status = 'open' REMOVE r.closed_by")
    client.query("MATCH (:Junction)-[r:ROAD]->(:Junction) WHERE r.delayed_by IS NOT NULL "
                 "SET r.delay_factor = 1.0 REMOVE r.delayed_by")
    client.query("MATCH (v:Vehicle) WHERE v.disabled_by IS NOT NULL SET v.status = 'idle' REMOVE v.disabled_by")
    client.query("MATCH (c:Casualty) WHERE c.stranded_by IS NOT NULL REMOVE c.stranded_by, c.stranded_from")
    client.query("MATCH (n) WHERE n.event_id IS NOT NULL DETACH DELETE n")
    client.query("MATCH (e:Event) DETACH DELETE e")
    if EVENTS:
        client.query("CREATE " + ", ".join(create_clause(e) for e in EVENTS))
