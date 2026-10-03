"""Plain-language questions about the scenario, answered from the graph as one sentence and a small table.

Understanding is retrieval, not generation. Every intent below has example phrasings, embedded once with
all-MiniLM-L6-v2; a question takes the intent of its most similar example. Under MIN_SCORE the answer is
"I didn't understand", never a guess. Ids (casualty 3, UGV 1, T1, surgery) are read from the text by rules,
not by the model, so an answer never names a casualty the medic did not say.

To teach a new phrasing, add it to the intent's examples. To add a question, write a handler and register it
with @intent. Handlers only read: the system answers, the medic decides.
"""
import json
import math
import os
import re
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable

from build_roads import haversine_m
from routing import DESTINATION_TYPES, TRIAGE_ORDER, Road, route

TURING_API = os.environ.get("TURING_API", "http://localhost:6666")
DEFAULT_NOW = datetime(2023, 9, 12, 5, 30, tzinfo=timezone.utc)  # scenario start, for graphs without a Clock
# Cosine similarity of all-MiniLM-L6-v2, chosen on tests/test_voice_query.py: questions in scope score 0.6+,
# unrelated speech mostly under 0.4
MIN_SCORE = 0.5
GOLDEN_HOUR_MIN = 60
LOW_BATTERY_PCT = 30
AT_POINT_M = 300  # closer than this to a medical point is "at" it
DEFAULT_SPEED_KMH = {"ugv": 20.0, "ambulance": 80.0}  # graphs seeded before Vehicle.speed_kmh existed
DONE = ("delivered", "dead")  # casualty statuses that need nothing more
LIVE_MISSION = ("planned", "active")


# --- Reading ids from the text ----------------------------------------------------------------------------------

NUMBER_WORDS = {w: i for i, w in enumerate(
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen "
    "seventeen eighteen nineteen twenty".split())}
NUMBER = r"(\d+|" + "|".join(NUMBER_WORDS) + r")\b"
CASUALTY_RE = re.compile(r"\b(?:cas(?:ualty|ualties)?|cass|cast|kas|kass|patient)[\s\-#]*(?:number\s*|no\.?\s*)?" + NUMBER, re.I)
VEHICLE_RE = re.compile(
    r"\b(ugv|ugb|u\.?\s?g\.?\s?v\.?|robot|amb(?:ulance)?)s?[\s\-#]*(?:number\s*|no\.?\s*)?" + NUMBER, re.I)
TRIAGE_RE = re.compile(r"\b(?:t|tee|p|pee|priority|cat(?:egory)?|triage(?:\s+category)?)[\s\-]*([1-4]|one|two|three|four)(?:'?s)?\b",
                       re.I)
TRIAGE_WORDS = {"immediate": "T1", "urgent": "T2", "delayed": "T3", "minimal": "T3", "minor": "T3", "expectant": "T4"}
CAPABILITY_WORDS = [
    (r"\bsurg|\boperat|\btheatre|\btheater", "surgery"),
    (r"\bicu\b|intensive care", "icu"),
    (r"\bstabili[sz]", "stabilisation"),
    (r"first aid", "first_aid"),
    (r"\bdock|\bcharg", "ugv_dock"),
]


def number(word: str) -> int:
    return int(word) if word.isdigit() else NUMBER_WORDS[word.lower()]


@dataclass
class Slots:
    casualty: str | None = None
    vehicle: str | None = None
    triage: str | None = None
    capability: str | None = None


def read_slots(text: str) -> Slots:
    slots = Slots()
    if m := CASUALTY_RE.search(text):
        slots.casualty = f"CAS-{number(m[1])}"
    if m := VEHICLE_RE.search(text):
        kind = "AMB" if m[1].lower().startswith("amb") else "UGV"
        slots.vehicle = f"{kind}-{number(m[2])}"
    if m := TRIAGE_RE.search(text):
        slots.triage = f"T{number(m[1])}"
    else:
        slots.triage = next((t for w, t in TRIAGE_WORDS.items() if re.search(rf"\b{w}\b", text, re.I)), None)
    slots.capability = next((c for pattern, c in CAPABILITY_WORDS if re.search(pattern, text, re.I)), None)
    return slots


def normalise(text: str) -> str:
    """The question as the examples are written: ids spelled one way, so "CAS-3" and "cass three" embed alike."""
    text = CASUALTY_RE.sub(lambda m: f"casualty {number(m[1])}", text)
    text = VEHICLE_RE.sub(lambda m: ("ambulance " if m[1].lower().startswith("amb") else "UGV ") + str(number(m[2])),
                          text)
    text = TRIAGE_RE.sub(lambda m: f"T{number(m[1])}", text)
    return text.strip().lower()


# --- The state of the world, read once per question --------------------------------------------------------------


def cypher(graph: str, change: str | None, query: str) -> list[dict]:
    """Rows of one query over TuringDB's HTTP API (columns named by their RETURN alias)."""
    params = {"graph": graph} | ({"change": change} if change else {})
    req = urllib.request.Request(f"{TURING_API}/query?{urllib.parse.urlencode(params)}", data=query.encode(),
                                 method="POST")
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = json.load(resp)
    if "error" in body:
        raise RuntimeError(f"{body['error']}: {body.get('error_details', '')}")
    columns = body["header"]["column_names"]
    return [dict(zip(columns, values)) for chunk in body["data"] for values in zip(*chunk)]


def node_id(v) -> int | None:
    """An OPTIONAL MATCH that finds nothing returns UINT64_MAX for a node, not null."""
    return None if v is None or v >= 2**63 else int(v)


def when(v) -> datetime | None:
    return datetime.fromisoformat(v) if isinstance(v, str) and v else None


@dataclass
class Casualty:
    nid: int
    id: str
    triage: str
    mobility: str
    status: str
    injured_at: datetime | None
    junction: int | None
    lat: float
    lon: float
    mission: str | None = None
    vehicle: str | None = None
    destination: str | None = None
    pickup_eta: datetime | None = None
    trip_min: float | None = None  # whole trip, for missions from older graphs, which store no times
    held_at: str | None = None  # handover or collection point it was dropped at, waiting for an ambulance
    injuries: str = ""  # from the MIST report


@dataclass
class Vehicle:
    nid: int
    id: str
    type: str
    status: str
    battery_pct: float
    range_km: float
    litter: int
    ambulatory: int
    speed_kmh: float
    junction: int | None
    lat: float
    lon: float
    mission: str | None = None
    max_threat: float = 1.0


@dataclass
class Facility:
    nid: int
    id: str
    name: str
    type: str
    state: str
    free_beds: int
    medics: int
    capabilities: list[str]
    junction: int | None
    lat: float
    lon: float


@dataclass
class Mission:
    nid: int
    id: str
    status: str
    vehicle: str | None
    destination: str | None
    casualties: list[str]
    eta: datetime | None
    trip_min: float | None


@dataclass
class World:
    now: datetime
    casualties: list[Casualty]
    vehicles: list[Vehicle]
    facilities: list[Facility]
    missions: list[Mission]
    threats: list[dict]
    closed_roads: list[dict]  # one row per closed ROAD edge: way, a, b (junction ids)
    load_roads: Callable[[], dict[int, list[Road]]] = lambda: {}
    _roads: dict | None = field(default=None, repr=False)

    def roads(self) -> dict[int, list[Road]]:
        if self._roads is None:
            self._roads = self.load_roads()
        return self._roads

    def casualty(self, cid: str) -> Casualty | None:
        return next((c for c in self.casualties if c.id == cid), None)

    def vehicle(self, vid: str) -> Vehicle | None:
        return next((v for v in self.vehicles if v.id == vid), None)

    def facility(self, fid: str) -> Facility | None:
        return next((f for f in self.facilities if f.id == fid), None)


def load_world(graph: str, change: str | None = None, now: datetime | None = None) -> World:
    """The scenario at `now`, or at the simulator's Clock when not given."""
    q = lambda query: cypher(graph, change, query)  # noqa: E731
    if now is None:
        clock_rows = q("MATCH (k:Clock) RETURN k.now AS now")
        now = (when(clock_rows[0]["now"]) if clock_rows else None) or DEFAULT_NOW
    casualties = [Casualty(int(r["nid"]), r["id"], r["triage"] or "", r["mobility"] or "", r["status"] or "",
                           when(r["toi"]), node_id(r["j"]), r["lat"], r["lon"], injuries=r["injuries"] or "")
                  for r in q(
        "MATCH (c:Casualty) OPTIONAL MATCH (c)-[:NEAR]->(j) RETURN id(c) AS nid, c.id AS id, "
        "c.triage_category AS triage, c.mobility AS mobility, c.status AS status, c.time_of_injury AS toi, "
        "c.lat AS lat, c.lon AS lon, c.mist_injuries AS injuries, id(j) AS j")]
    vehicles = [Vehicle(int(r["nid"]), r["id"], r["type"], r["status"] or "", r["battery"] or 100.0,
                        r["range"] or 0.0, r["litter"] or 0, r["amb"] or 0,
                        r["speed"] or DEFAULT_SPEED_KMH.get(r["type"], 20.0), node_id(r["j"]), r["lat"], r["lon"],
                        max_threat=1.0 if r["max_threat"] is None else r["max_threat"])
                for r in q(
        "MATCH (v:Vehicle) OPTIONAL MATCH (v)-[:NEAR]->(j) RETURN id(v) AS nid, v.id AS id, v.type AS type, "
        "v.status AS status, v.battery_pct AS battery, v.range_km AS range, v.litter_capacity AS litter, "
        "v.ambulatory_capacity AS amb, v.speed_kmh AS speed, v.max_threat AS max_threat, v.lat AS lat, "
        "v.lon AS lon, id(j) AS j")]
    facilities = [Facility(int(r["nid"]), r["id"], r["name"] or r["id"], r["type"] or "", r["state"] or "",
                           int(r["beds"] or 0), int(r["medics"] or 0), list(r["caps"] or []), node_id(r["j"]),
                           r["lat"], r["lon"]) for r in q(
        "MATCH (m:MedicalPoint) OPTIONAL MATCH (m)-[:NEAR]->(j) RETURN id(m) AS nid, m.id AS id, m.name AS name, "
        "m.type AS type, m.state AS state, m.free_beds AS beds, m.medics_available AS medics, "
        "m.capabilities AS caps, m.lat AS lat, m.lon AS lon, id(j) AS j")]

    missions: dict[str, Mission] = {}
    for r in q("MATCH (m:Mission) RETURN id(m) AS nid, m.id AS id, m.status AS status, m.eta AS eta, "
               "m.eta_min AS eta_min"):
        missions[r["id"]] = Mission(int(r["nid"]), r["id"], r["status"] or "", None, None, [], when(r["eta"]),
                                    r["eta_min"])
    for r in q("MATCH (m:Mission)-[:USES]->(v:Vehicle) RETURN m.id AS m, v.id AS v"):
        missions[r["m"]].vehicle = r["v"]
    for r in q("MATCH (m:Mission)-[:DELIVERS_TO]->(f:MedicalPoint) RETURN m.id AS m, f.id AS f"):
        missions[r["m"]].destination = r["f"]
    by_id = {c.id: c for c in casualties}
    for r in q("MATCH (m:Mission)-[p:PICKS_UP]->(c:Casualty) RETURN m.id AS m, c.id AS c, p.eta AS eta, "
               "p.order AS k ORDER BY k"):
        m, c = missions[r["m"]], by_id.get(r["c"])
        m.casualties.append(r["c"])
        if c and m.status in LIVE_MISSION:
            c.mission, c.vehicle, c.destination = m.id, m.vehicle, m.destination
            c.pickup_eta, c.trip_min = when(r["eta"]), m.trip_min
    for v in vehicles:
        v.mission = next((m.id for m in missions.values() if m.vehicle == v.id and m.status in LIVE_MISSION), None)
    for r in q("MATCH (c:Casualty)-[:HELD_AT]->(p:MedicalPoint) RETURN c.id AS c, p.id AS p"):
        if r["c"] in by_id:
            by_id[r["c"]].held_at = r["p"]

    threats = q("MATCH (t:Threat) RETURN id(t) AS nid, t.id AS id, t.type AS type, t.level AS level, "
                "t.active AS active")
    closed = q("MATCH (a:Junction)-[r:ROAD]->(b:Junction) WHERE r.status = 'closed' "
               "RETURN r.osm_way_id AS way, r.bridge AS bridge, r.highway AS highway, id(a) AS a, id(b) AS b")

    def roads() -> dict[int, list[Road]]:
        out: dict[int, list[Road]] = {}
        for r in q("MATCH (a:Junction)-[r:ROAD]->(b:Junction) WHERE r.status <> 'closed' RETURN id(a) AS a, "
                   "id(b) AS b, r.length_m AS len, r.speed_ugv_kmh AS ugv, r.speed_ambulance_kmh AS amb, "
                   "r.delay_factor AS delay, r.threat_level AS threat"):
            out.setdefault(int(r["a"]), []).append(Road(int(r["b"]), r["len"], r["ugv"], r["amb"], r["delay"] or 1.0,
                                                        r["threat"] or 0.0))
        return out

    return World(now, casualties, vehicles, facilities, list(missions.values()), threats, closed, roads)


# --- Answers ---------------------------------------------------------------------------------------------------


@dataclass
class Answer:
    say: str
    columns: list[str] = field(default_factory=list)
    rows: list[list] = field(default_factory=list)
    highlight: list[int] = field(default_factory=list)  # node ids to light up on the map
    paths: list[list[int]] = field(default_factory=list)  # routes as junction ids, drawn on the map


@dataclass
class Intent:
    name: str
    title: str
    examples: list[str]
    handler: Callable[[World, Slots], Answer]
    needs: str | None = None  # slot the question must name, e.g. "casualty"


INTENTS: list[Intent] = []
ASK_FOR = {
    "casualty": "Which casualty do you mean? Say for example \"casualty 3\".",
    "vehicle": "Which vehicle do you mean? Say for example \"UGV 1\" or \"ambulance 2\".",
    "triage": "Which triage category? Say for example \"T1\".",
    "capability": "Which capability? For example surgery, ICU, stabilisation or first aid.",
}


def intent(name: str, title: str, examples: list[str], needs: str | None = None):
    def register(handler):
        INTENTS.append(Intent(name, title, examples, handler, needs))
        return handler
    return register


def minutes_since(t: datetime | None, now: datetime) -> float | None:
    return None if t is None else max(0.0, (now - t).total_seconds() / 60)


def duration(minutes: float | None) -> str:
    if minutes is None:
        return "unknown"
    m = round(minutes)
    return f"{m // 60}h {m % 60:02d}m" if m >= 60 else f"{m}m"


def clock(t: datetime | None) -> str:
    return t.strftime("%H:%MZ") if t else "--:--"


def km(metres: float) -> str:
    return f"{metres / 1000:.1f} km"


def active(casualties: list[Casualty]) -> list[Casualty]:
    """Casualties still needing evacuation, most urgent first, then longest waiting; untriaged last."""
    return sorted((c for c in casualties if c.status not in DONE),
                  key=lambda c: (TRIAGE_ORDER.get(c.triage, 9), c.injured_at or DEFAULT_NOW))


def triaged(c: Casualty) -> bool:
    return c.triage in TRIAGE_ORDER


def plan_of(c: Casualty, now: datetime) -> str:
    if c.mission and c.status == "in_transit":
        return f"on board {c.vehicle or '?'} ({c.mission}) to {c.destination or '?'}"
    if c.mission:
        eta = f", pickup {clock(c.pickup_eta)}" if c.pickup_eta else (
            f", trip {duration(c.trip_min)}" if c.trip_min else "")
        return f"{c.mission}: {c.vehicle or '?'} to {c.destination or '?'}{eta}"
    if c.held_at:
        return f"at {c.held_at}, waiting for an ambulance"
    return {"no_resource": "NO VEHICLE AVAILABLE", "awaiting_pickup": "awaiting a vehicle",
            "reported": "NOT TRIAGED YET"}.get(c.status, c.status)


def where(world: World, lat: float, lon: float) -> str:
    """Straight-line distance to the nearest medical point, as a spoken landmark."""
    f = min(world.facilities, key=lambda f: haversine_m((lat, lon), (f.lat, f.lon)), default=None)
    if f is None:
        return f"{lat:.4f}, {lon:.4f}"
    metres = haversine_m((lat, lon), (f.lat, f.lon))
    return f"at {f.id}" if metres < AT_POINT_M else f"{km(metres)} from {f.id}"


CASUALTY_COLUMNS = ["Casualty", "Triage", "Mobility", "Waiting", "Plan"]


def casualty_row(c: Casualty, now: datetime) -> list:
    return [c.id, c.triage or "untriaged", c.mobility, duration(minutes_since(c.injured_at, now)), plan_of(c, now)]


def casualty_table(world: World, casualties: list[Casualty], say: str) -> Answer:
    return Answer(say, CASUALTY_COLUMNS, [casualty_row(c, world.now) for c in casualties],
                  [c.nid for c in casualties])


def names(items: list[str]) -> str:
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]


@intent("most_critical", "Most critical casualty", [
    "which casualty is the most critical",
    "which casualty on my map right now is the most critical",
    "who is the most critical patient",
    "who should we evacuate first",
    "who needs evacuation most urgently",
    "who is the highest priority casualty",
    "which casualty is in the worst condition",
    "who do I pick up first",
    "top priority casualty",
    "who is the most urgent right now",
    "which patient is the sickest",
    "who is the worst off",
])
def most_critical(world: World, _: Slots) -> Answer:
    q = active(world.casualties)
    ranked = [c for c in q if triaged(c)]
    untriaged = [c for c in q if not triaged(c)]
    if not q:
        return Answer("There are no active casualties on the map.")
    if not ranked:
        return casualty_table(world, untriaged, (
            f"No casualty has been triaged yet. {len(untriaged)} reports wait for triage: "
            f"{names([c.id for c in untriaged])}."))
    c = ranked[0]
    note = f" {len(untriaged)} not triaged yet: {names([u.id for u in untriaged])}." if untriaged else ""
    return casualty_table(world, ranked[:3] + untriaged, (
        f"{c.id} is the most critical: {c.triage}, {c.mobility or 'mobility unknown'}, waiting "
        f"{duration(minutes_since(c.injured_at, world.now))}, {plan_of(c, world.now)}.{note}"))


@intent("queue", "All casualties by priority", [
    "list all casualties in order of priority",
    "show me the evacuation queue",
    "show all casualties",
    "give me the casualty list",
    "rank the casualties by urgency",
    "what casualties do we have",
    "who is on the map",
    "show me every casualty and their triage",
    "who is waiting for evacuation",
    "give me the list of the wounded",
])
def queue(world: World, _: Slots) -> Answer:
    q = active(world.casualties)
    if not q:
        return Answer("There are no active casualties on the map.")
    return casualty_table(world, q, f"{len(q)} casualties, most urgent first: {names([c.id for c in q])}.")


@intent("triage_count", "Casualty count by triage", [
    "how many casualties do we have",
    "how many casualties are there",
    "how many T1 casualties are there",
    "count casualties by triage category",
    "what is the breakdown by triage",
    "how many immediate casualties",
    "how many wounded in total",
    "how many T2s",
])
def triage_count(world: World, slots: Slots) -> Answer:
    q = active(world.casualties)
    counts: dict[str, list[Casualty]] = {}
    for c in q:
        counts.setdefault(c.triage, []).append(c)
    rows = [[t or "untriaged", len(cs), ", ".join(c.id for c in cs)] for t, cs in sorted(counts.items(),
                                                                          key=lambda kv: TRIAGE_ORDER.get(kv[0], 9))]
    if slots.triage:
        n = len(counts.get(slots.triage, []))
        say = f"{n} {slots.triage} casualt{'y' if n == 1 else 'ies'}, out of {len(q)} active."
        highlight = [c.nid for c in counts.get(slots.triage, [])]
    else:
        say = f"{len(q)} active casualties: " + ", ".join(f"{r[1]} {r[0]}" for r in rows) + "."
        highlight = [c.nid for c in q]
    return Answer(say, ["Triage", "Count", "Casualties"], rows, highlight)


@intent("by_triage", "Casualties of one triage category", [
    "show me all T1 casualties",
    "which casualties are T2",
    "list the T3 casualties",
    "who is T1",
    "show me the immediate casualties",
    "which casualties are urgent",
    "where are the T1s",
    "list priority one casualties",
], needs="triage")
def by_triage(world: World, slots: Slots) -> Answer:
    cs = [c for c in active(world.casualties) if c.triage == slots.triage]
    if not cs:
        return Answer(f"There are no active {slots.triage} casualties.")
    return casualty_table(world, cs, f"{len(cs)} {slots.triage}: {names([c.id for c in cs])}.")


@intent("longest_waiting", "Longest waiting", [
    "who has been waiting the longest",
    "which casualty has waited longest",
    "who was injured first",
    "longest time since injury",
    "who has been on the ground the longest",
    "which casualty has been waiting the most time",
    "oldest casualty",
])
def longest_waiting(world: World, _: Slots) -> Answer:
    q = sorted(active(world.casualties), key=lambda c: c.injured_at or world.now)
    if not q:
        return Answer("There are no active casualties on the map.")
    c = q[0]
    return casualty_table(world, q, (f"{c.id} ({c.triage or 'not triaged'}) has waited longest: "
                                     f"{duration(minutes_since(c.injured_at, world.now))} since injury."))


@intent("golden_hour", "Past the golden hour", [
    "which casualties are past the golden hour",
    "who has been waiting more than an hour",
    "who is over sixty minutes since injury",
    "has anyone passed the golden hour",
    "which casualties are running out of time",
    "who is outside the golden hour",
    "who is going to miss the golden hour",
])
def golden_hour(world: World, _: Slots) -> Answer:
    q = active(world.casualties)
    late = [c for c in q if (minutes_since(c.injured_at, world.now) or 0) >= GOLDEN_HOUR_MIN]
    if not late:
        return casualty_table(world, q, "Nobody is past the golden hour yet.")
    t1 = [c.id for c in late if c.triage == "T1"]
    return casualty_table(world, late, (f"{len(late)} of {len(q)} casualties are past the golden hour"
                                        + (f", including T1 {names(t1)}." if t1 else ".")))


@intent("casualty_status", "One casualty", [
    "what is the status of casualty 3",
    "tell me about casualty 2",
    "how is casualty 1 doing",
    "where is casualty 4",
    "what is happening with casualty 5",
    "give me an update on casualty 3",
    "what triage is casualty 1",
    "details for casualty 2",
    "show me casualty 6",
], needs="casualty")
def casualty_status(world: World, slots: Slots) -> Answer:
    c = world.casualty(slots.casualty)
    if c is None:
        return Answer(f"I can't find {slots.casualty} on the map.")
    rows = [["Triage", c.triage or "not triaged yet"], ["Mobility", c.mobility], ["Injuries", c.injuries],
            ["Injured", clock(c.injured_at)], ["Waiting", duration(minutes_since(c.injured_at, world.now))],
            ["Status", c.status], ["Plan", plan_of(c, world.now)], ["Location", where(world, c.lat, c.lon)]]
    rows = [r for r in rows if r[1]]
    if c.status in DONE:
        say = f"{c.id} is {c.status}."
    elif not triaged(c):
        say = f"{c.id} is not triaged yet" + (f": {c.injuries}." if c.injuries else ".")
    else:
        say = (f"{c.id}: {c.triage}, {c.mobility}, waiting {duration(minutes_since(c.injured_at, world.now))}, "
               f"{plan_of(c, world.now)}.")
    return Answer(say, [c.id, ""], rows, [c.nid])


@intent("casualty_eta", "When a casualty is collected", [
    "when will casualty 3 be picked up",
    "what is the ETA for casualty 1",
    "how long until casualty 2 is collected",
    "when does casualty 4 get to hospital",
    "how long until a vehicle reaches casualty 5",
    "is anyone coming for casualty 3",
    "which vehicle is going to casualty 2",
], needs="casualty")
def casualty_eta(world: World, slots: Slots) -> Answer:
    c = world.casualty(slots.casualty)
    if c is None:
        return Answer(f"I can't find {slots.casualty} on the map.")
    if c.status in DONE:
        return Answer(f"{c.id} is {c.status}.", highlight=[c.nid])
    if not triaged(c):
        return Answer(f"{c.id} is not triaged yet; it is dispatched once a medic triages it.", highlight=[c.nid])
    if not c.mission:
        return Answer(f"Nobody is tasked to {c.id} yet ({plan_of(c, world.now)}). Ask for the nearest vehicle to "
                      f"{c.id}.", highlight=[c.nid])
    v, f = world.vehicle(c.vehicle or ""), world.facility(c.destination or "")
    m = next((m for m in world.missions if m.id == c.mission), None)
    if c.status == "in_transit":
        arrival = f", arriving {clock(m.eta)}" if m and m.eta else ""
        timing = f"has {c.id} on board"
        return Answer(f"{c.vehicle} on {c.mission} {timing}, to {c.destination}{arrival}.",
                      ["Mission", "Vehicle", "Status", "Destination", "Arrival"],
                      [[c.mission, c.vehicle, "on board", c.destination, clock(m.eta) if m and m.eta else ""]],
                      [c.nid] + [x.nid for x in (v, f) if x])
    if c.pickup_eta:
        timing = f"picks {c.id} up at {clock(c.pickup_eta)} (in {duration(minutes_since(world.now, c.pickup_eta))})"
    else:
        timing = f"is on a {duration(c.trip_min)} trip with {c.id}" if c.trip_min else f"is going to {c.id}"
    return Answer(f"{c.vehicle} on {c.mission} {timing}, to {c.destination}.",
                  ["Mission", "Vehicle", "Pickup", "Destination"],
                  [[c.mission, c.vehicle, clock(c.pickup_eta) if c.pickup_eta else duration(c.trip_min),
                    c.destination]],
                  [c.nid] + [x.nid for x in (v, f) if x])


@intent("unassigned", "Casualties without a vehicle", [
    "which casualties have no vehicle assigned",
    "who is still waiting for a pickup",
    "which casualties have no resource",
    "who has not been assigned a mission",
    "which casualties are unassigned",
    "who is not covered yet",
    "who still needs a vehicle",
    "are there casualties nobody is going for",
    "which casualties are still uncovered",
])
def unassigned(world: World, _: Slots) -> Answer:
    q = active(world.casualties)
    cs = [c for c in q if triaged(c) and not c.mission]
    untriaged = [c for c in q if not triaged(c)]
    note = f" {len(untriaged)} more not triaged yet: {names([c.id for c in untriaged])}." if untriaged else ""
    if not cs:
        return casualty_table(world, untriaged, "Every triaged casualty has a vehicle tasked." + note)
    stuck = [c.id for c in cs if c.status == "no_resource"]
    return casualty_table(world, cs + untriaged, f"{len(cs)} triaged without a vehicle: {names([c.id for c in cs])}"
                          + (f". No resource for {names(stuck)}." if stuck else ".") + note)


@intent("stretcher", "Stretcher cases", [
    "which casualties need a stretcher",
    "who is a litter casualty",
    "who can't walk",
    "show me the stretcher cases",
    "which casualties are on litters",
    "how many stretcher patients",
])
def stretcher(world: World, _: Slots) -> Answer:
    cs = [c for c in active(world.casualties) if c.mobility == "litter"]
    if not cs:
        return Answer("No active casualty needs a stretcher.")
    return casualty_table(world, cs, f"{len(cs)} stretcher cases: {names([c.id for c in cs])}.")


@intent("walking", "Walking wounded", [
    "who can walk",
    "which casualties are walking wounded",
    "show me the ambulatory casualties",
    "which casualties can move on foot",
    "who can walk to the collection point",
    "how many walking wounded",
])
def walking(world: World, _: Slots) -> Answer:
    cs = [c for c in active(world.casualties) if c.mobility == "ambulatory"]
    if not cs:
        return Answer("No active casualty can walk.")
    return casualty_table(world, cs, f"{len(cs)} can walk: {names([c.id for c in cs])}.")


VEHICLE_COLUMNS = ["Vehicle", "Type", "Status", "Battery", "Range left", "Mission"]


def range_left(v: Vehicle) -> float:
    return v.range_km * v.battery_pct / 100


def vehicle_row(v: Vehicle) -> list:
    return [v.id, v.type, v.status, f"{v.battery_pct:.0f}%", f"{range_left(v):.0f} km", v.mission or ""]


@intent("vehicles", "Available vehicles", [
    "which vehicles are free",
    "what vehicles are available",
    "is there an idle vehicle",
    "which UGVs are available",
    "do we have any ambulances free",
    "what assets can I task right now",
    "show me all vehicles",
    "what is the status of the fleet",
])
def vehicles(world: World, _: Slots) -> Answer:
    idle = [v.id for v in world.vehicles if v.status == "idle"]
    say = f"{len(idle)} of {len(world.vehicles)} vehicles idle: {names(idle)}." if idle else \
        f"No vehicle is idle; all {len(world.vehicles)} are tasked."
    return Answer(say, VEHICLE_COLUMNS, [vehicle_row(v) for v in world.vehicles],
                  [v.nid for v in world.vehicles if v.status == "idle"])


@intent("vehicle_status", "One vehicle", [
    "where is UGV 1",
    "what is ambulance 2 doing",
    "status of UGV 2",
    "is ambulance 1 busy",
    "what mission is UGV 1 on",
    "tell me about ambulance 2",
    "how far can UGV 2 go",
], needs="vehicle")
def vehicle_status(world: World, slots: Slots) -> Answer:
    v = world.vehicle(slots.vehicle)
    if v is None:
        return Answer(f"I can't find {slots.vehicle} on the map.")
    m = next((m for m in world.missions if m.id == v.mission), None)
    doing = f"on {m.id} for {names(m.casualties)} to {m.destination}" if m else v.status
    return Answer(f"{v.id} is {doing}, {v.battery_pct:.0f}% battery, {range_left(v):.0f} km range left, "
                  f"{where(world, v.lat, v.lon)}.", VEHICLE_COLUMNS, [vehicle_row(v)], [v.nid])


@intent("battery", "Battery and range", [
    "what is the battery on the UGVs",
    "which robot is low on battery",
    "battery levels",
    "how much charge do the UGVs have",
    "do any vehicles need charging",
    "what is the range of the robots",
])
def battery(world: World, _: Slots) -> Answer:
    vs = sorted(world.vehicles, key=lambda v: v.battery_pct)
    low = [v.id for v in vs if v.battery_pct < LOW_BATTERY_PCT]
    say = (f"Low battery: {names(low)}." if low else "No vehicle is below "
           f"{LOW_BATTERY_PCT}% battery.") + (f" Lowest is {vs[0].id} at {vs[0].battery_pct:.0f}%." if vs else "")
    return Answer(say, VEHICLE_COLUMNS, [vehicle_row(v) for v in vs], [v.nid for v in vs if v.id in low])


def can_carry(v: Vehicle, c: Casualty) -> bool:
    """As routing.py: a casualty already at a relay point is for ambulances only."""
    if c.held_at and v.type == "ugv":
        return False
    return v.litter > 0 or (c.mobility == "ambulatory" and v.ambulatory > 0)


@intent("nearest_vehicle", "Fastest vehicle to a casualty", [
    "what is the nearest vehicle to casualty 3",
    "which vehicle is closest to casualty 1",
    "fastest UGV to casualty 5",
    "what can get to casualty 2 quickest",
    "how quickly can we reach casualty 4",
    "which ambulance is closest to casualty 1",
    "who can pick up casualty 3",
], needs="casualty")
def nearest_vehicle(world: World, slots: Slots) -> Answer:
    c = world.casualty(slots.casualty)
    if c is None:
        return Answer(f"I can't find {slots.casualty} on the map.")
    if c.junction is None:
        return Answer(f"{c.id} is not linked to the road network.", highlight=[c.nid])
    options = []
    for v in world.vehicles:
        r = (route(world.roads(), v.junction, c.junction, v.type, v.speed_kmh, v.max_threat)
             if v.junction is not None else None)
        options.append((v, r))
    options.sort(key=lambda o: (o[1] is None, o[1][1] if o[1] else math.inf))
    rows = [[v.id, v.status, f"{r[1]:.0f} min" if r else "no route", f"{r[2]:.1f} km" if r else "",
             "yes" if can_carry(v, c) else "no", "yes" if r and r[2] <= range_left(v) else "no"]
            for v, r in options]
    fit = [(v, r) for v, r in options if r and v.status == "idle" and can_carry(v, c)
           and r[2] <= range_left(v)]
    if fit:
        v, r = fit[0]
        say = f"{v.id} is the fastest idle vehicle for {c.id}: {r[1]:.0f} min by road ({r[2]:.1f} km)."
        return Answer(say, ["Vehicle", "Status", "Time", "Distance", "Can carry", "In range"], rows,
                      [c.nid, v.nid], [r[0]])
    busy = next(((v, r) for v, r in options if r and can_carry(v, c) and r[2] <= range_left(v)), None)
    later = f" Fastest tasked: {busy[0].id} ({busy[0].mission}), {busy[1][1]:.0f} min." if busy else ""
    return Answer(f"No idle vehicle can reach and carry {c.id} ({c.mobility}).{later}",
                  ["Vehicle", "Status", "Time", "Distance", "Can carry", "In range"], rows, [c.nid])


@intent("nearest_facility", "Where a casualty should go", [
    "where should casualty 1 go",
    "which medical point should casualty 3 go to",
    "nearest hospital with beds for casualty 2",
    "closest role 1 for casualty 4",
    "where is the nearest treatment for casualty 5",
    "what is the best destination for casualty 1",
    "which hospital can take casualty 3",
], needs="casualty")
def nearest_facility(world: World, slots: Slots) -> Answer:
    c = world.casualty(slots.casualty)
    if c is None:
        return Answer(f"I can't find {slots.casualty} on the map.")
    if c.junction is None:
        return Answer(f"{c.id} is not linked to the road network.", highlight=[c.nid])
    # Where the dispatcher sends ambulances (routing.DESTINATION_TYPES), on roads within their threat limit
    ambulances = [v for v in world.vehicles if v.type == "ambulance"]
    max_threat = max((v.max_threat for v in ambulances), default=1.0)
    options = []
    for f in world.facilities:
        if f.type not in DESTINATION_TYPES["ambulance"] or f.junction is None:
            continue
        r = route(world.roads(), c.junction, f.junction, "ambulance", DEFAULT_SPEED_KMH["ambulance"], max_threat)
        options.append((f, r))
    options.sort(key=lambda o: (o[1] is None, o[1][1] if o[1] else math.inf))
    rows = [[f.id, f.name, f.state, f.free_beds, f"{r[1]:.0f} min" if r else "no route",
             f"{r[2]:.1f} km" if r else ""] for f, r in options]
    columns = ["Point", "Name", "State", "Free beds", "Ambulance time", "Distance"]
    fit = [(f, r) for f, r in options if r and f.state == "operational" and f.free_beds > 0]
    if not fit:
        return Answer(f"No operational Role 1 or higher with a free bed can be reached from {c.id}.", columns,
                      rows, [c.nid])
    f, r = fit[0]
    return Answer(f"Nearest Role 1 or higher with a free bed for {c.id}: {f.name} ({f.id}), {r[1]:.0f} min by "
                  f"ambulance, {f.free_beds} beds free.", columns, rows, [c.nid, f.nid], [r[0]])


FACILITY_COLUMNS = ["Point", "Name", "Type", "State", "Free beds", "Medics"]


def facility_row(f: Facility) -> list:
    return [f.id, f.name, f.type, f.state, f.free_beds, f.medics]


@intent("beds", "Free beds", [
    "how many beds are free",
    "which medical points have space",
    "where are there free beds",
    "bed availability",
    "which hospitals can take more casualties",
    "is role 1 full",
    "capacity of the medical points",
])
def beds(world: World, _: Slots) -> Answer:
    fs = sorted((f for f in world.facilities if f.free_beds > 0), key=lambda f: -f.free_beds)
    total = sum(f.free_beds for f in fs)
    return Answer(f"{total} free beds across {len(fs)} points" + (f"; most at {fs[0].id} ({fs[0].free_beds})."
                                                                   if fs else "."),
                  FACILITY_COLUMNS, [facility_row(f) for f in fs], [f.nid for f in fs])


@intent("capability", "Points with a capability", [
    "where can we do surgery",
    "which medical points have surgery",
    "where is the nearest ICU",
    "which facilities can stabilise",
    "where can I get first aid",
    "which hospital has intensive care",
    "list facilities with a surgeon",
], needs="capability")
def capability(world: World, slots: Slots) -> Answer:
    fs = [f for f in world.facilities if slots.capability in f.capabilities]
    label = slots.capability.replace("_", " ")
    if not fs:
        return Answer(f"No medical point on the map has {label}.")
    return Answer(f"{label.capitalize()} at {names([f.id for f in fs])}.", FACILITY_COLUMNS,
                  [facility_row(f) for f in fs], [f.nid for f in fs])


@intent("medics", "Medics available", [
    "how many medics are available",
    "where are the medics",
    "which point has the most medics",
    "do we have enough medics",
    "medical staff available",
    "how many doctors do we have",
])
def medics(world: World, _: Slots) -> Answer:
    fs = sorted(world.facilities, key=lambda f: -f.medics)
    return Answer(f"{sum(f.medics for f in fs)} medics available" + (f"; most at {fs[0].id} ({fs[0].medics})."
                                                                       if fs else "."),
                  FACILITY_COLUMNS, [facility_row(f) for f in fs], [f.nid for f in fs if f.medics > 0])


@intent("missions", "Missions", [
    "what missions are running",
    "show current missions",
    "list the active missions",
    "what are the vehicles doing",
    "which casualties are being evacuated",
    "show me all evacuation missions",
    "what is in progress",
])
def missions(world: World, _: Slots) -> Answer:
    ms = world.missions
    if not ms:
        return Answer("There are no missions yet.")
    rows = [[m.id, m.status, m.vehicle or "", ", ".join(m.casualties), m.destination or "",
             clock(m.eta) if m.eta else duration(m.trip_min)] for m in ms]
    nids = [m.nid for m in ms] + [x.nid for m in ms for x in
                                   [world.vehicle(m.vehicle or ""), world.facility(m.destination or "")] if x]
    return Answer(f"{len(ms)} missions: " + "; ".join(f"{m.id} {m.vehicle} for {names(m.casualties)}" for m in ms)
                  + ".", ["Mission", "Status", "Vehicle", "Casualties", "To", "ETA / trip"], rows, nids)


@intent("threats", "Threats", [
    "are there any active threats",
    "is there a drone threat",
    "where is the threat",
    "any danger on the roads",
    "is it safe to move",
    "what threats are on the map",
    "show me threats",
])
def threats(world: World, _: Slots) -> Answer:
    act = [t for t in world.threats if t["active"]]
    rows = [[t["id"], t["type"], t["level"], "active" if t["active"] else "inactive"] for t in world.threats]
    say = (f"{len(act)} active threat{'s' if len(act) > 1 else ''}: "
           + names([f"{t['id']} ({t['type']}, level {t['level']})" for t in act]) + ".") if act else \
        "No active threats on the map."
    return Answer(say, ["Threat", "Type", "Level", "State"], rows, [int(t["nid"]) for t in act])


@intent("closed_roads", "Closed roads", [
    "which roads are closed",
    "is any road blocked",
    "any route closures",
    "is the bridge down",
    "what roads can't we use",
    "show me blocked roads",
])
def closed_roads(world: World, _: Slots) -> Answer:
    ways: dict = {}
    for r in world.closed_roads:
        ways.setdefault(r["way"], r)
    if not ways:
        return Answer("All roads are open.")
    rows = [[w, r["highway"], "yes" if r["bridge"] else ""] for w, r in ways.items()]
    bridges = sum(1 for r in ways.values() if r["bridge"])
    return Answer(f"{len(ways)} road{'s' if len(ways) > 1 else ''} closed" + (f", {bridges} of them bridges."
                                                                            if bridges else "."),
                  ["OSM way", "Class", "Bridge"], rows,
                  paths=[[int(r["a"]), int(r["b"])] for r in world.closed_roads])


@intent("sitrep", "Situation summary", [
    "give me a summary",
    "sitrep",
    "situation report",
    "what is the overall picture",
    "brief me",
    "what is the current situation",
    "give me an overview",
])
def sitrep(world: World, _: Slots) -> Answer:
    q = active(world.casualties)
    untriaged = [c for c in q if not triaged(c)]
    no_vehicle = [c for c in q if triaged(c) and not c.mission]
    late = [c for c in q if (minutes_since(c.injured_at, world.now) or 0) >= GOLDEN_HOUR_MIN]
    idle = [v for v in world.vehicles if v.status == "idle"]
    rows = [["Active casualties", ", ".join(f"{sum(c.triage == t for c in q)} {t}" for t in ("T1", "T2", "T3"))],
            ["Not triaged", names([c.id for c in untriaged]) if untriaged else "none"],
            ["Triaged, no vehicle", names([c.id for c in no_vehicle]) if no_vehicle else "none"],
            ["Past golden hour", names([c.id for c in late]) if late else "none"],
            ["Vehicles idle", f"{len(idle)} of {len(world.vehicles)}"],
            ["Missions under way", str(sum(m.status in LIVE_MISSION for m in world.missions))],
            ["Free beds", str(sum(f.free_beds for f in world.facilities))],
            ["Active threats", str(sum(1 for t in world.threats if t["active"]))],
            ["Closed roads", str(len({r["way"] for r in world.closed_roads}))]]
    say = (f"{len(q)} casualties, {len(untriaged)} not triaged, {len(no_vehicle)} triaged without a vehicle, "
           f"{len(late)} past the golden hour. {len(idle)} vehicles idle.")
    return Answer(say, [clock(world.now), "Now"], rows, [c.nid for c in untriaged + no_vehicle])


@intent("help", "What I can answer", [
    "what can I ask",
    "help",
    "what questions can you answer",
    "what can you do",
    "list commands",
])
def help_(world: World, _: Slots) -> Answer:
    return Answer("You can ask me about casualties, vehicles, medical points, missions, threats and roads.",
                  ["Topic", "Try saying"], [[i.title, i.examples[0]] for i in INTENTS if i.name != "help"])


# --- Matching a question to an intent ----------------------------------------------------------------------------


class Matcher:
    """Nearest example phrasing. `encode` turns texts into unit vectors (all-MiniLM-L6-v2 in the server)."""

    def __init__(self, encode: Callable):
        self.encode = encode
        self.owners = [i for i in INTENTS for _ in i.examples]
        self.vectors = encode([e.lower() for i in INTENTS for e in i.examples])

    def rank(self, text: str) -> list[tuple[Intent, float]]:
        """One (intent, best score) per intent, best first."""
        scores = self.vectors @ self.encode([normalise(text)])[0]
        best: dict[str, tuple[Intent, float]] = {}
        for owner, s in zip(self.owners, scores):
            if owner.name not in best or s > best[owner.name][1]:
                best[owner.name] = (owner, float(s))
        return sorted(best.values(), key=lambda b: -b[1])


def ask(matcher: Matcher, question: str, graph: str, change: str | None = None, now: datetime | None = None,
        world: World | None = None) -> dict:
    """The answer to one question, as the JSON the C2 page shows."""
    question = question.strip()
    if not question:
        return {"understood": False, "question": "", "say": "I didn't hear a question. Try again."}
    t0 = time.perf_counter()
    ranked = matcher.rank(question)
    best, score = ranked[0]
    slots = read_slots(question)
    out = {"question": question, "intent": best.name, "title": best.title, "score": round(score, 3),
           "slots": {k: v for k, v in vars(slots).items() if v}}
    if score < MIN_SCORE:
        return out | {"understood": False, "say": "Sorry, I didn't understand that.",
                      "suggestions": [i.examples[0] for i, _ in ranked[:3]]}
    if best.needs and getattr(slots, best.needs) is None:
        return out | {"understood": False, "say": ASK_FOR[best.needs], "suggestions": best.examples[:2]}
    understood_ms = (time.perf_counter() - t0) * 1000
    t1 = time.perf_counter()
    world = world or load_world(graph, change, now)
    answer = best.handler(world, slots)
    return out | {"understood": True, "say": answer.say, "columns": answer.columns,
                  "rows": [[str(x) for x in row] for row in answer.rows], "highlight": answer.highlight,
                  "paths": answer.paths,
                  "ms": {"understand": round(understood_ms), "answer": round((time.perf_counter() - t1) * 1000)}}
