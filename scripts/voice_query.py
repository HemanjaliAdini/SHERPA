"""Plain-language questions about the scenario, in English or Ukrainian, answered from the graph as one sentence
and a small table, in the language of the question.

Understanding is retrieval, not generation. Every intent below has example phrasings in both languages (the
Ukrainian ones are in voice_text.py), embedded once with paraphrase-multilingual-MiniLM-L12-v2; a question takes the
intent of its most similar example. Under MIN_SCORE the answer is "I didn't understand", never a guess. Ids
(casualty 3, UGV 1, T1, surgery) are read from the text by rules, not by the model, so an answer never names a
casualty the medic did not say.

To teach a new phrasing, add it to the intent's examples (English here, Ukrainian in voice_text.py). To add a
question, write a handler and register it with @intent. Handlers only read: the system answers, the medic decides.
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
from voice_text import CAPABILITY_LABELS, LABELS, TEXT, UK_EXAMPLES, UK_TITLES, UK_VALUES

TURING_API = os.environ.get("TURING_API", "http://localhost:6666")
DEFAULT_NOW = datetime(2023, 9, 12, 5, 30, tzinfo=timezone.utc)  # scenario start, for graphs without a Clock
# Cosine similarity of paraphrase-multilingual-MiniLM-L12-v2, chosen on tests/test_voice_query.py: questions in
# scope score 0.6+ in both languages; 0.5 let through about half the unrelated speech
MIN_SCORE = 0.6
# Fillers and courtesies: too short to embed reliably ("uh" scored 0.83 against "sitrep"), so never matched
NOT_QUESTIONS = {"uh", "um", "erm", "hmm", "ok", "okay", "yes", "no", "thanks", "thank you", "hello", "hi", "cheers",
                 "е", "ем", "гм", "так", "ні", "добре", "гаразд", "дякую", "спасибі", "привіт", "алло"}
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
# Ukrainian numbers as they follow a noun: cardinal and ordinal, in the cases speech produces
for n, words in enumerate([
    "один одна одне одного одному перший перша першого першому першої",
    "два дві двох другий друга другого другому другої",
    "три трьох третій третя третього третьому третьої",
    "чотири чотирьох четвертий четверта четвертого четвертому",
    "п'ять п'яти п'ятий п'ята п'ятого п'ятому",
    "шість шести шостий шоста шостого шостому",
    "сім семи сьомий сьома сьомого",
    "вісім восьми восьмий восьма восьмого",
    "дев'ять дев'яти дев'ятий дев'ята дев'ятого",
    "десять десяти десятий десята десятого",
], start=1):
    NUMBER_WORDS |= dict.fromkeys(words.split(), n)
NUMBER = r"(\d+|" + "|".join(sorted(map(re.escape, NUMBER_WORDS), key=len, reverse=True)) + r")(?!\w)"
SEP = r"[\s\-#№]*(?:number\s*|no\.?\s*|номер\s*)?"
CASUALTY_WORD = r"(?:cas(?:ualty|ualties)?|cass|cast|kas|kass|patient|поранен\w*|постраждал\w*|потерпіл\w*|пацієнт\w*|кас)"
CASUALTY_RE = re.compile(r"\b" + CASUALTY_WORD + SEP + NUMBER + r"(?!\s*категорі)", re.I)  # not "поранені першої категорії"
AMBULANCE = r"amb(?:ulance)?s?|швидк\w*|амбуланс\w*|санітарк\w*"
VEHICLE_WORD = rf"(ugv|ugb|u\.?\s?g\.?\s?v\.?|robots?|{AMBULANCE}|робот\w*|нрк)"
VEHICLE_RE = re.compile(r"\b" + VEHICLE_WORD + SEP + NUMBER, re.I)
# Ukrainian also puts an ordinal first ("третього пораненого", "другий робот"); only ordinals, so that a count
# ("три поранених", three casualties) is not read as an id
ORDINAL = r"(\w*(?:перш|друг|трет|четверт|п'ят|шост|сьом|восьм|дев'ят|десят)\w*)"
CASUALTY_FIRST_RE = re.compile(r"(?<!\w)" + ORDINAL + r"\s+" + CASUALTY_WORD + r"(?!\w)", re.I)
VEHICLE_FIRST_RE = re.compile(r"(?<!\w)" + ORDINAL + r"\s+" + VEHICLE_WORD + r"(?!\w)", re.I)
TRIAGE_FIRST_RE = re.compile(r"(?<!\w)" + ORDINAL + r"\s+категорі\w*", re.I)  # "першої категорії"
TRIAGE_RE = re.compile(r"(?<!\w)(?:t|tee|p|pee|priority|cat(?:egory)?|triage(?:\s+category)?|т|пріоритет\w*|"
                       r"категорі\w*)[\s\-]*([1-4]|one|two|three|four|один|два|три|чотири|перш\w*|друг\w*|трет\w*)"
                       r"(?:'?s)?(?!\w)", re.I)
TRIAGE_WORDS = {"immediate": "T1", "urgent": "T2", "delayed": "T3", "minimal": "T3", "minor": "T3", "expectant": "T4",
                r"невідкладн\w*": "T1", r"термінов\w*": "T2", r"відстрочен\w*": "T3", r"відкладен\w*": "T3"}
CAPABILITY_WORDS = [
    (r"\bsurg|\boperat|\btheatre|\btheater|\bоперац|\bхірург", "surgery"),
    (r"\bicu\b|intensive care|\bреанімац|\bінтенсивн", "icu"),
    (r"\bstabili[sz]|\bстабіліз", "stabilisation"),
    (r"first aid|\bперш\w* допомог", "first_aid"),
    (r"\bdock|\bcharg", "ugv_dock"),
]
CYRILLIC = re.compile(r"[а-яіїєґ]", re.I)


def number(word: str) -> int:
    word = word.lower()
    if word.isdigit():
        return int(word)
    if word in NUMBER_WORDS:
        return NUMBER_WORDS[word]
    return next(n for n, stem in enumerate(("перш", "друг", "трет", "четверт", "п'ят", "шост", "сьом", "восьм",
                                            "дев'ят", "десят"), start=1) if stem in word)


def language(text: str) -> str:
    """'uk' for a question in Cyrillic (Parakeet writes Ukrainian in Cyrillic), else 'en'."""
    return "uk" if CYRILLIC.search(text) else "en"


def tidy(text: str) -> str:
    """One apostrophe for Ukrainian (п'ять, not п’ять or пʼять), so the number words match."""
    return re.sub(r"[’ʼ`]", "'", text)


@dataclass
class Slots:
    casualty: str | None = None
    vehicle: str | None = None
    triage: str | None = None
    capability: str | None = None
    lang: str = "en"  # language of the question, and of the answer


def is_ambulance(word: str) -> bool:
    return re.fullmatch(AMBULANCE, word, re.I) is not None


def read_slots(text: str) -> Slots:
    text = tidy(text)
    slots = Slots(lang=language(text))
    if m := CASUALTY_RE.search(text) or CASUALTY_FIRST_RE.search(text):
        slots.casualty = f"CAS-{number(m[1])}"
    if m := VEHICLE_RE.search(text):
        slots.vehicle = f"{'AMB' if is_ambulance(m[1]) else 'UGV'}-{number(m[2])}"
    elif m := VEHICLE_FIRST_RE.search(text):
        slots.vehicle = f"{'AMB' if is_ambulance(m[2]) else 'UGV'}-{number(m[1])}"
    if m := TRIAGE_RE.search(text) or TRIAGE_FIRST_RE.search(text):
        slots.triage = f"T{number(m[1])}"
    else:
        slots.triage = next((t for w, t in TRIAGE_WORDS.items() if re.search(rf"\b{w}\b", text, re.I)), None)
    slots.capability = next((c for pattern, c in CAPABILITY_WORDS if re.search(pattern, text, re.I)), None)
    return slots


def normalise(text: str) -> str:
    """The question with ids spelled one way, so "CAS-3", "cass three" and "пораненого номер три" embed alike."""
    text = tidy(text)
    text = CASUALTY_RE.sub(lambda m: f"casualty {number(m[1])}", text)
    text = CASUALTY_FIRST_RE.sub(lambda m: f"casualty {number(m[1])}", text)
    text = VEHICLE_RE.sub(lambda m: f"{'ambulance' if is_ambulance(m[1]) else 'UGV'} {number(m[2])}", text)
    text = VEHICLE_FIRST_RE.sub(lambda m: f"{'ambulance' if is_ambulance(m[2]) else 'UGV'} {number(m[1])}", text)
    text = TRIAGE_RE.sub(lambda m: f"T{number(m[1])}", text)
    text = TRIAGE_FIRST_RE.sub(lambda m: f"T{number(m[1])}", text)
    return text.strip().lower()


# --- The state of the world, read once per question --------------------------------------------------------------


def cypher(graph: str, change: str | None, query: str) -> list[dict]:
    """Rows of one query over TuringDB's HTTP API (columns named by their RETURN alias)."""
    params = {"graph": graph} | ({"change": change} if change else {})
    req = urllib.request.Request(f"{TURING_API}/query?{urllib.parse.urlencode(params)}", data=query.encode(),
                                 method="POST")
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = json.load(resp)
    if body.get("error") == "GRAPH_NOT_FOUND":
        raise RuntimeError(f"There is no graph '{graph}' in TuringDB. Check ?graph= in the page address.")
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

    def title_in(self, lang: str) -> str:
        return UK_TITLES.get(self.name, self.title) if lang == "uk" else self.title

    def examples_in(self, lang: str) -> list[str]:
        return UK_EXAMPLES.get(self.name, []) if lang == "uk" else self.examples


INTENTS: list[Intent] = []


def intent(name: str, title: str, examples: list[str], needs: str | None = None):
    def register(handler):
        INTENTS.append(Intent(name, title, examples, handler, needs))
        return handler
    return register


def tr(lang: str, key: str, **kw) -> str:
    """A sentence from voice_text.TEXT in the question's language."""
    return TEXT[key][lang == "uk"].format(**kw)


def labels(lang: str, *keys: str) -> list[str]:
    return [LABELS[k][lang == "uk"] for k in keys]


def value(lang: str, v) -> str:
    """A value from the graph (status, mobility, vehicle type), in Ukrainian when asked in Ukrainian."""
    return UK_VALUES.get(v, v) if lang == "uk" and isinstance(v, str) else v


def minutes_since(t: datetime | None, now: datetime) -> float | None:
    return None if t is None else max(0.0, (now - t).total_seconds() / 60)


def duration(minutes: float | None, lang: str = "en") -> str:
    if minutes is None:
        return tr(lang, "unknown")
    m = round(minutes)
    return tr(lang, "hours", h=m // 60, m=m % 60) if m >= 60 else tr(lang, "minutes", m=m)


def clock(t: datetime | None) -> str:
    return t.strftime("%H:%MZ") if t else "--:--"


def km(metres: float, lang: str = "en") -> str:
    return tr(lang, "km", km=metres / 1000)


def active(casualties: list[Casualty]) -> list[Casualty]:
    """Casualties still needing evacuation, most urgent first, then longest waiting; untriaged last."""
    return sorted((c for c in casualties if c.status not in DONE),
                  key=lambda c: (TRIAGE_ORDER.get(c.triage, 9), c.injured_at or DEFAULT_NOW))


def triaged(c: Casualty) -> bool:
    return c.triage in TRIAGE_ORDER


def plan_of(c: Casualty, now: datetime, lang: str = "en") -> str:
    if c.mission and c.status == "in_transit":
        return tr(lang, "plan_on_board", vid=c.vehicle or "?", mid=c.mission, dest=c.destination or "?")
    if c.mission:
        eta = tr(lang, "plan_pickup", t=clock(c.pickup_eta)) if c.pickup_eta else (
            tr(lang, "plan_trip", d=duration(c.trip_min, lang)) if c.trip_min else "")
        return tr(lang, "plan_mission", mid=c.mission, vid=c.vehicle or "?", dest=c.destination or "?", eta=eta)
    if c.held_at:
        return tr(lang, "plan_relay", fid=c.held_at)
    key = {"no_resource": "plan_no_resource", "awaiting_pickup": "plan_awaiting", "reported": "plan_reported"}
    return tr(lang, key[c.status]) if c.status in key else value(lang, c.status)


def where(world: World, lat: float, lon: float, lang: str = "en") -> str:
    """Straight-line distance to the nearest medical point, as a spoken landmark."""
    f = min(world.facilities, key=lambda f: haversine_m((lat, lon), (f.lat, f.lon)), default=None)
    if f is None:
        return f"{lat:.4f}, {lon:.4f}"
    metres = haversine_m((lat, lon), (f.lat, f.lon))
    return tr(lang, "at_point", fid=f.id) if metres < AT_POINT_M else \
        tr(lang, "from_point", dist=km(metres, lang), fid=f.id)


def waited(c: Casualty, world: World, lang: str) -> str:
    return duration(minutes_since(c.injured_at, world.now), lang)


def casualty_row(c: Casualty, world: World, lang: str) -> list:
    return [c.id, c.triage or tr(lang, "untriaged"), value(lang, c.mobility), waited(c, world, lang),
            plan_of(c, world.now, lang)]


def casualty_table(world: World, casualties: list[Casualty], say: str, lang: str) -> Answer:
    return Answer(say, labels(lang, "casualty", "triage", "mobility", "waiting", "plan"),
                  [casualty_row(c, world, lang) for c in casualties], [c.nid for c in casualties])


def names(items: list[str], lang: str = "en") -> str:
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + tr(lang, "and") + items[-1]


def ids(items, lang: str) -> str:
    return names([x.id for x in items], lang)


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
def most_critical(world: World, slots: Slots) -> Answer:
    lang = slots.lang
    q = active(world.casualties)
    ranked = [c for c in q if triaged(c)]
    untriaged = [c for c in q if not triaged(c)]
    if not q:
        return Answer(tr(lang, "no_active"))
    if not ranked:
        return casualty_table(world, untriaged, tr(lang, "none_triaged", n=len(untriaged), ids=ids(untriaged, lang)),
                              lang)
    c = ranked[0]
    note = tr(lang, "untriaged_note", n=len(untriaged), ids=ids(untriaged, lang)) if untriaged else ""
    return casualty_table(world, ranked[:3] + untriaged, tr(
        lang, "most_critical", id=c.id, triage=c.triage, mobility=value(lang, c.mobility) or tr(lang, "mobility_unknown"),
        wait=waited(c, world, lang), plan=plan_of(c, world.now, lang), note=note), lang)


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
def queue(world: World, slots: Slots) -> Answer:
    q = active(world.casualties)
    if not q:
        return Answer(tr(slots.lang, "no_active"))
    return casualty_table(world, q, tr(slots.lang, "queue", n=len(q), ids=ids(q, slots.lang)), slots.lang)


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
    lang = slots.lang
    q = active(world.casualties)
    counts: dict[str, list[Casualty]] = {}
    for c in q:
        counts.setdefault(c.triage, []).append(c)
    rows = [[t or tr(lang, "untriaged"), len(cs), ", ".join(c.id for c in cs)]
            for t, cs in sorted(counts.items(), key=lambda kv: TRIAGE_ORDER.get(kv[0], 9))]
    if slots.triage:
        n = len(counts.get(slots.triage, []))
        say = tr(lang, "count_one", n=n, triage=slots.triage, noun="casualty" if n == 1 else "casualties",
                 total=len(q))
        highlight = [c.nid for c in counts.get(slots.triage, [])]
    else:
        say = tr(lang, "count_all", total=len(q), breakdown=", ".join(f"{r[1]} {r[0]}" for r in rows))
        highlight = [c.nid for c in q]
    return Answer(say, labels(lang, "triage", "count", "casualties"), rows, highlight)


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
        return Answer(tr(slots.lang, "none_of_triage", triage=slots.triage))
    return casualty_table(world, cs, tr(slots.lang, "by_triage", n=len(cs), triage=slots.triage,
                                        ids=ids(cs, slots.lang)), slots.lang)


@intent("longest_waiting", "Longest waiting", [
    "who has been waiting the longest",
    "which casualty has waited longest",
    "who was injured first",
    "longest time since injury",
    "who has been on the ground the longest",
    "which casualty has been waiting the most time",
    "oldest casualty",
])
def longest_waiting(world: World, slots: Slots) -> Answer:
    lang = slots.lang
    q = sorted(active(world.casualties), key=lambda c: c.injured_at or world.now)
    if not q:
        return Answer(tr(lang, "no_active"))
    c = q[0]
    return casualty_table(world, q, tr(lang, "longest", id=c.id, triage=c.triage or tr(lang, "not_triaged"),
                                       wait=waited(c, world, lang)), lang)


@intent("golden_hour", "Past the golden hour", [
    "which casualties are past the golden hour",
    "who has been waiting more than an hour",
    "who is over sixty minutes since injury",
    "has anyone passed the golden hour",
    "which casualties are running out of time",
    "who is outside the golden hour",
    "who is going to miss the golden hour",
    "has anyone been waiting over an hour",
])
def golden_hour(world: World, slots: Slots) -> Answer:
    lang = slots.lang
    q = active(world.casualties)
    late = [c for c in q if (minutes_since(c.injured_at, world.now) or 0) >= GOLDEN_HOUR_MIN]
    if not late:
        return casualty_table(world, q, tr(lang, "golden_none"), lang)
    t1 = [c for c in late if c.triage == "T1"]
    return casualty_table(world, late, tr(lang, "golden", n=len(late), total=len(q),
                                          t1=tr(lang, "golden_t1", ids=ids(t1, lang)) if t1 else ""), lang)


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
    lang = slots.lang
    c = world.casualty(slots.casualty)
    if c is None:
        return Answer(tr(lang, "cant_find", id=slots.casualty))
    rows = [(*labels(lang, "triage"), c.triage or tr(lang, "not_triaged_yet")),
            (*labels(lang, "mobility"), value(lang, c.mobility)), (*labels(lang, "injuries"), c.injuries),
            (*labels(lang, "injured"), clock(c.injured_at)), (*labels(lang, "waiting"), waited(c, world, lang)),
            (*labels(lang, "status"), value(lang, c.status)), (*labels(lang, "plan"), plan_of(c, world.now, lang)),
            (*labels(lang, "location"), where(world, c.lat, c.lon, lang))]
    rows = [list(r) for r in rows if r[1]]
    if c.status in DONE:
        say = tr(lang, "status_done", id=c.id, status=value(lang, c.status))
    elif not triaged(c):
        say = tr(lang, "status_untriaged", id=c.id, injuries=f": {c.injuries}" if c.injuries else "")
    else:
        say = tr(lang, "status", id=c.id, triage=c.triage, mobility=value(lang, c.mobility),
                 wait=waited(c, world, lang), plan=plan_of(c, world.now, lang))
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
    lang = slots.lang
    c = world.casualty(slots.casualty)
    if c is None:
        return Answer(tr(lang, "cant_find", id=slots.casualty))
    if c.status in DONE:
        return Answer(tr(lang, "status_done", id=c.id, status=value(lang, c.status)), highlight=[c.nid])
    if not triaged(c):
        return Answer(tr(lang, "eta_untriaged", id=c.id), highlight=[c.nid])
    if not c.mission:
        return Answer(tr(lang, "eta_none", id=c.id, plan=plan_of(c, world.now, lang)), highlight=[c.nid])
    v, f = world.vehicle(c.vehicle or ""), world.facility(c.destination or "")
    m = next((m for m in world.missions if m.id == c.mission), None)
    lit = [c.nid] + [x.nid for x in (v, f) if x]
    common = {"vid": c.vehicle, "mid": c.mission, "id": c.id, "dest": c.destination}
    if c.status == "in_transit":
        arrival = tr(lang, "eta_arrival", t=clock(m.eta)) if m and m.eta else ""
        return Answer(tr(lang, "eta_on_board", arrival=arrival, **common),
                      labels(lang, "mission", "vehicle", "status", "destination", "arrival"),
                      [[c.mission, c.vehicle, *labels(lang, "on_board"), c.destination,
                        clock(m.eta) if m and m.eta else ""]], lit)
    if c.pickup_eta:
        say = tr(lang, "eta_pickup", t=clock(c.pickup_eta), wait=duration(minutes_since(world.now, c.pickup_eta), lang),
                 **common)
    elif c.trip_min:
        say = tr(lang, "eta_trip", trip=duration(c.trip_min, lang), **common)
    else:
        say = tr(lang, "eta_going", **common)
    return Answer(say, labels(lang, "mission", "vehicle", "pickup", "destination"),
                  [[c.mission, c.vehicle, clock(c.pickup_eta) if c.pickup_eta else duration(c.trip_min, lang),
                    c.destination]], lit)


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
def unassigned(world: World, slots: Slots) -> Answer:
    lang = slots.lang
    q = active(world.casualties)
    cs = [c for c in q if triaged(c) and not c.mission]
    untriaged = [c for c in q if not triaged(c)]
    note = tr(lang, "untriaged_note", n=len(untriaged), ids=ids(untriaged, lang)) if untriaged else ""
    if not cs:
        return casualty_table(world, untriaged, tr(lang, "all_tasked") + note, lang)
    stuck = [c for c in cs if c.status == "no_resource"]
    return casualty_table(world, cs + untriaged, tr(
        lang, "unassigned", n=len(cs), ids=ids(cs, lang), note=note,
        stuck=tr(lang, "no_resource_for", ids=ids(stuck, lang)) if stuck else tr(lang, "end")), lang)


@intent("stretcher", "Stretcher cases", [
    "which casualties need a stretcher",
    "who is a litter casualty",
    "who can't walk",
    "show me the stretcher cases",
    "which casualties are on litters",
    "how many stretcher patients",
])
def stretcher(world: World, slots: Slots) -> Answer:
    cs = [c for c in active(world.casualties) if c.mobility == "litter"]
    if not cs:
        return Answer(tr(slots.lang, "no_stretcher"))
    return casualty_table(world, cs, tr(slots.lang, "stretcher", n=len(cs), ids=ids(cs, slots.lang)), slots.lang)


@intent("walking", "Walking wounded", [
    "who can walk",
    "which casualties are walking wounded",
    "show me the ambulatory casualties",
    "which casualties can move on foot",
    "who can walk to the collection point",
    "how many walking wounded",
])
def walking(world: World, slots: Slots) -> Answer:
    cs = [c for c in active(world.casualties) if c.mobility == "ambulatory"]
    if not cs:
        return Answer(tr(slots.lang, "no_walking"))
    return casualty_table(world, cs, tr(slots.lang, "walking", n=len(cs), ids=ids(cs, slots.lang)), slots.lang)


def range_left(v: Vehicle) -> float:
    return v.range_km * v.battery_pct / 100


def vehicle_columns(lang: str) -> list[str]:
    return labels(lang, "vehicle", "type", "status", "battery", "range_left", "mission")


def vehicle_row(v: Vehicle, lang: str) -> list:
    return [v.id, value(lang, v.type), value(lang, v.status), f"{v.battery_pct:.0f}%",
            tr(lang, "km_whole", km=range_left(v)), v.mission or ""]


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
def vehicles(world: World, slots: Slots) -> Answer:
    lang = slots.lang
    idle = [v for v in world.vehicles if v.status == "idle"]
    say = tr(lang, "vehicles_idle", n=len(idle), total=len(world.vehicles), ids=ids(idle, lang)) if idle else \
        tr(lang, "vehicles_none", total=len(world.vehicles))
    return Answer(say, vehicle_columns(lang), [vehicle_row(v, lang) for v in world.vehicles], [v.nid for v in idle])


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
    lang = slots.lang
    v = world.vehicle(slots.vehicle)
    if v is None:
        return Answer(tr(lang, "cant_find", id=slots.vehicle))
    m = next((m for m in world.missions if m.id == v.mission), None)
    doing = tr(lang, "vehicle_mission", mid=m.id, ids=names(m.casualties, lang), dest=m.destination) if m else \
        value(lang, v.status)
    return Answer(tr(lang, "vehicle_status", id=v.id, doing=doing, battery=f"{v.battery_pct:.0f}",
                     range=tr(lang, "km_whole", km=range_left(v)), where=where(world, v.lat, v.lon, lang)),
                  vehicle_columns(lang), [vehicle_row(v, lang)], [v.nid])


@intent("battery", "Battery and range", [
    "what is the battery on the UGVs",
    "which robot is low on battery",
    "battery levels",
    "how much charge do the UGVs have",
    "do any vehicles need charging",
    "what is the range of the robots",
])
def battery(world: World, slots: Slots) -> Answer:
    lang = slots.lang
    vs = sorted(world.vehicles, key=lambda v: v.battery_pct)
    low = [v for v in vs if v.battery_pct < LOW_BATTERY_PCT]
    say = tr(lang, "low_battery", ids=ids(low, lang)) if low else tr(lang, "no_low_battery", pct=LOW_BATTERY_PCT)
    if vs:
        say += tr(lang, "lowest_battery", id=vs[0].id, pct=f"{vs[0].battery_pct:.0f}")
    return Answer(say, vehicle_columns(lang), [vehicle_row(v, lang) for v in vs], [v.nid for v in low])


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
    lang = slots.lang
    c = world.casualty(slots.casualty)
    if c is None:
        return Answer(tr(lang, "cant_find", id=slots.casualty))
    if c.status in DONE:
        return Answer(tr(lang, "status_done", id=c.id, status=value(lang, c.status)), highlight=[c.nid])
    if c.junction is None:
        return Answer(tr(lang, "not_on_roads", id=c.id), highlight=[c.nid])
    options = []
    for v in world.vehicles:
        r = (route(world.roads(), v.junction, c.junction, v.type, v.speed_kmh, v.max_threat)
             if v.junction is not None else None)
        options.append((v, r))
    options.sort(key=lambda o: (o[1] is None, o[1][1] if o[1] else math.inf))
    yes_no = lambda ok: tr(lang, "yes" if ok else "no")  # noqa: E731
    rows = [[v.id, value(lang, v.status), tr(lang, "min", m=f"{r[1]:.0f}") if r else tr(lang, "no_route"),
             km(r[2] * 1000, lang) if r else "", yes_no(can_carry(v, c)), yes_no(r and r[2] <= range_left(v))]
            for v, r in options]
    columns = labels(lang, "vehicle", "status", "time", "distance", "can_carry", "in_range")
    fit = [(v, r) for v, r in options if r and v.status == "idle" and can_carry(v, c) and r[2] <= range_left(v)]
    if fit:
        v, r = fit[0]
        return Answer(tr(lang, "fastest", vid=v.id, id=c.id, min=f"{r[1]:.0f}", km=f"{r[2]:.1f}"), columns, rows,
                      [c.nid, v.nid], [r[0]])
    busy = next(((v, r) for v, r in options if r and can_carry(v, c) and r[2] <= range_left(v)), None)
    later = tr(lang, "fastest_busy", vid=busy[0].id, mid=busy[0].mission, min=f"{busy[1][1]:.0f}") if busy else ""
    return Answer(tr(lang, "none_fit", id=c.id, mobility=value(lang, c.mobility), later=later), columns, rows,
                  [c.nid])


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
    lang = slots.lang
    c = world.casualty(slots.casualty)
    if c is None:
        return Answer(tr(lang, "cant_find", id=slots.casualty))
    if c.status in DONE:
        return Answer(tr(lang, "status_done", id=c.id, status=value(lang, c.status)), highlight=[c.nid])
    if c.junction is None:
        return Answer(tr(lang, "not_on_roads", id=c.id), highlight=[c.nid])
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
    rows = [[f.id, f.name, value(lang, f.state), f.free_beds,
             tr(lang, "min", m=f"{r[1]:.0f}") if r else tr(lang, "no_route"), km(r[2] * 1000, lang) if r else ""]
            for f, r in options]
    columns = labels(lang, "point", "name", "state", "free_beds", "ambulance_time", "distance")
    fit = [(f, r) for f, r in options if r and f.state == "operational" and f.free_beds > 0]
    if not fit:
        return Answer(tr(lang, "no_facility", id=c.id), columns, rows, [c.nid])
    f, r = fit[0]
    return Answer(tr(lang, "facility", id=c.id, name=f.name, fid=f.id, min=f"{r[1]:.0f}", beds=f.free_beds),
                  columns, rows, [c.nid, f.nid], [r[0]])


def facility_columns(lang: str) -> list[str]:
    return labels(lang, "point", "name", "type", "state", "free_beds", "medics")


def facility_row(f: Facility, lang: str) -> list:
    return [f.id, f.name, f.type, value(lang, f.state), f.free_beds, f.medics]


@intent("beds", "Free beds", [
    "how many beds are free",
    "which medical points have space",
    "where are there free beds",
    "bed availability",
    "which hospitals can take more casualties",
    "is role 1 full",
    "capacity of the medical points",
])
def beds(world: World, slots: Slots) -> Answer:
    lang = slots.lang
    fs = sorted((f for f in world.facilities if f.free_beds > 0), key=lambda f: -f.free_beds)
    most = tr(lang, "beds_most", fid=fs[0].id, beds=fs[0].free_beds) if fs else tr(lang, "end")
    return Answer(tr(lang, "beds", total=sum(f.free_beds for f in fs), n=len(fs), most=most),
                  facility_columns(lang), [facility_row(f, lang) for f in fs], [f.nid for f in fs])


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
    lang = slots.lang
    fs = [f for f in world.facilities if slots.capability in f.capabilities]
    label = CAPABILITY_LABELS.get(slots.capability, (slots.capability,) * 2)[lang == "uk"]
    if not fs:
        return Answer(tr(lang, "no_capability", label=label))
    return Answer(tr(lang, "capability", label=label[:1].upper() + label[1:], ids=ids(fs, lang)),
                  facility_columns(lang), [facility_row(f, lang) for f in fs], [f.nid for f in fs])


@intent("medics", "Medics available", [
    "how many medics are available",
    "where are the medics",
    "which point has the most medics",
    "do we have enough medics",
    "medical staff available",
    "how many doctors do we have",
])
def medics(world: World, slots: Slots) -> Answer:
    lang = slots.lang
    fs = sorted(world.facilities, key=lambda f: -f.medics)
    most = tr(lang, "medics_most", fid=fs[0].id, n=fs[0].medics) if fs else tr(lang, "end")
    return Answer(tr(lang, "medics", total=sum(f.medics for f in fs), most=most), facility_columns(lang),
                  [facility_row(f, lang) for f in fs], [f.nid for f in fs if f.medics > 0])


@intent("missions", "Missions", [
    "what missions are running",
    "show current missions",
    "list the active missions",
    "what are the vehicles doing",
    "which casualties are being evacuated",
    "show me all evacuation missions",
    "what is in progress",
])
def missions(world: World, slots: Slots) -> Answer:
    lang = slots.lang
    ms = world.missions
    if not ms:
        return Answer(tr(lang, "no_missions"))
    rows = [[m.id, value(lang, m.status), m.vehicle or "", ", ".join(m.casualties), m.destination or "",
             clock(m.eta) if m.eta else duration(m.trip_min, lang)] for m in ms]
    nids = [m.nid for m in ms] + [x.nid for m in ms for x in
                                   [world.vehicle(m.vehicle or ""), world.facility(m.destination or "")] if x]
    items = "; ".join(tr(lang, "mission_item", mid=m.id, vid=m.vehicle, ids=names(m.casualties, lang)) for m in ms)
    return Answer(tr(lang, "missions", n=len(ms), list=items),
                  labels(lang, "mission", "status", "vehicle", "casualties", "to", "eta_trip"), rows, nids)


@intent("threats", "Threats", [
    "are there any active threats",
    "is there a drone threat",
    "where is the threat",
    "any danger on the roads",
    "is it safe to move",
    "what threats are on the map",
    "show me threats",
])
def threats(world: World, slots: Slots) -> Answer:
    lang = slots.lang
    act = [t for t in world.threats if t["active"]]
    rows = [[t["id"], value(lang, t["type"]), t["level"], *labels(lang, "active" if t["active"] else "inactive")]
            for t in world.threats]
    say = tr(lang, "threats", n=len(act), noun="threat" if len(act) == 1 else "threats", list=names(
        [tr(lang, "threat_item", id=t["id"], type=value(lang, t["type"]), level=t["level"]) for t in act], lang)) \
        if act else tr(lang, "no_threats")
    return Answer(say, labels(lang, "threat", "type", "level", "state"), rows, [int(t["nid"]) for t in act])


@intent("closed_roads", "Closed roads", [
    "which roads are closed",
    "is any road blocked",
    "any route closures",
    "is the bridge down",
    "what roads can't we use",
    "show me blocked roads",
])
def closed_roads(world: World, slots: Slots) -> Answer:
    lang = slots.lang
    ways: dict = {}
    for r in world.closed_roads:
        ways.setdefault(r["way"], r)
    if not ways:
        return Answer(tr(lang, "roads_open"))
    rows = [[w, r["highway"], tr(lang, "yes") if r["bridge"] else ""] for w, r in ways.items()]
    bridges = sum(1 for r in ways.values() if r["bridge"])
    return Answer(tr(lang, "roads_closed", n=len(ways), noun="road" if len(ways) == 1 else "roads",
                     bridges=tr(lang, "roads_bridges", b=bridges) if bridges else tr(lang, "end")),
                  labels(lang, "osm_way", "class", "bridge"), rows,
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
def sitrep(world: World, slots: Slots) -> Answer:
    lang = slots.lang
    q = active(world.casualties)
    untriaged = [c for c in q if not triaged(c)]
    no_vehicle = [c for c in q if triaged(c) and not c.mission]
    late = [c for c in q if (minutes_since(c.injured_at, world.now) or 0) >= GOLDEN_HOUR_MIN]
    idle = [v for v in world.vehicles if v.status == "idle"]
    listed = lambda cs: ids(cs, lang) if cs else tr(lang, "none")  # noqa: E731
    rows = [[*labels(lang, "active_casualties"), ", ".join(f"{sum(c.triage == t for c in q)} {t}"
                                                           for t in ("T1", "T2", "T3"))],
            [*labels(lang, "not_triaged"), listed(untriaged)],
            [*labels(lang, "triaged_no_vehicle"), listed(no_vehicle)],
            [*labels(lang, "past_golden_hour"), listed(late)],
            [*labels(lang, "vehicles_idle"), tr(lang, "of", a=len(idle), b=len(world.vehicles))],
            [*labels(lang, "missions_under_way"), str(sum(m.status in LIVE_MISSION for m in world.missions))],
            [*labels(lang, "free_beds"), str(sum(f.free_beds for f in world.facilities))],
            [*labels(lang, "active_threats"), str(sum(1 for t in world.threats if t["active"]))],
            [*labels(lang, "closed_roads"), str(len({r["way"] for r in world.closed_roads}))]]
    say = tr(lang, "sitrep", total=len(q), u=len(untriaged), nv=len(no_vehicle), late=len(late), idle=len(idle))
    return Answer(say, [clock(world.now), *labels(lang, "now")], rows, [c.nid for c in untriaged + no_vehicle])


@intent("help", "What I can answer", [
    "what can I ask",
    "help",
    "what questions can you answer",
    "what can you do",
    "list commands",
])
def help_(world: World, slots: Slots) -> Answer:
    lang = slots.lang
    return Answer(tr(lang, "help"), labels(lang, "topic", "try_saying"),
                  [[i.title_in(lang), i.examples_in(lang)[0]] for i in INTENTS if i.name != "help"])


# --- Matching a question to an intent ----------------------------------------------------------------------------


class Matcher:
    """Nearest example phrasing, in either language. `encode` turns texts into unit vectors
    (paraphrase-multilingual-MiniLM-L12-v2 in the server). Examples go through normalise() like questions do."""

    def __init__(self, encode: Callable):
        self.encode = encode
        pairs = [(i, e) for i in INTENTS for e in i.examples + i.examples_in("uk")]
        self.owners = [i for i, _ in pairs]
        self.vectors = encode([normalise(e) for _, e in pairs])

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
    """The answer to one question, in its language, as the JSON the C2 page shows."""
    question = question.strip()
    lang = language(question)
    if not question:
        return {"understood": False, "question": "", "lang": lang, "say": tr(lang, "no_question")}
    t0 = time.perf_counter()
    ranked = matcher.rank(question)
    best, score = ranked[0]
    slots = read_slots(question)
    out = {"question": question, "lang": lang, "intent": best.name, "title": best.title_in(lang),
           "score": round(score, 3), "slots": {k: v for k, v in vars(slots).items() if v and k != "lang"}}
    if score < MIN_SCORE or re.sub(r"[^\w' ]", "", question.lower()).strip() in NOT_QUESTIONS:
        return out | {"understood": False, "say": tr(lang, "not_understood"),
                      "suggestions": [i.examples_in(lang)[0] for i, _ in ranked[:3]]}
    if best.needs and getattr(slots, best.needs) is None:
        return out | {"understood": False, "say": tr(lang, f"ask_{best.needs}"),
                      "suggestions": best.examples_in(lang)[:2]}
    understood_ms = (time.perf_counter() - t0) * 1000
    t1 = time.perf_counter()
    world = world or load_world(graph, change, now)
    answer = best.handler(world, slots)
    return out | {"understood": True, "say": answer.say, "columns": answer.columns,
                  "rows": [[str(x) for x in row] for row in answer.rows], "highlight": answer.highlight,
                  "paths": answer.paths,
                  "ms": {"understand": round(understood_ms), "answer": round((time.perf_counter() - t1) * 1000)}}
