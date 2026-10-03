"""Voice questions: ids read from the text, answers on a hand-built world, and intent matching with the real
embedding model (skipped unless `uv sync --extra voice`). No TuringDB needed."""
from datetime import datetime, timezone

import pytest

from routing import Road
from voice_query import (INTENTS, MIN_SCORE, Casualty, Facility, Matcher, Mission, Slots, Vehicle, World, ask,
                         normalise, read_slots)


@pytest.mark.parametrize("text, casualty", [
    ("What's the status of CAS-3?", "CAS-3"),
    ("where is cass three", "CAS-3"),
    ("casualty number 12", "CAS-12"),
    ("tell me about casualty two", "CAS-2"),
    ("who is the most critical", None),
])
def test_reads_the_casualty(text, casualty):
    assert read_slots(text).casualty == casualty


@pytest.mark.parametrize("text, vehicle", [
    ("UGV 1 battery", "UGV-1"),
    ("where is u g v two", "UGV-2"),
    ("what is ambulance two doing", "AMB-2"),
    ("AMB-1", "AMB-1"),
])
def test_reads_the_vehicle(text, vehicle):
    assert read_slots(text).vehicle == vehicle


@pytest.mark.parametrize("text, triage", [
    ("show me the T1s", "T1"),
    ("priority one casualties", "T1"),
    ("P2", "T2"),
    ("which casualties are immediate", "T1"),
    ("what's at 1 o'clock", None),
])
def test_reads_the_triage_category(text, triage):
    assert read_slots(text).triage == triage


def test_ids_are_spelled_like_the_examples_before_matching():
    assert normalise("Where's CAS-3 and UGV two?") == "where's casualty 3 and ugv 2?"


NOW = datetime(2023, 9, 12, 5, 30, tzinfo=timezone.utc)


def at(hh_mm: str) -> datetime:
    return datetime.fromisoformat(f"2023-09-12T{hh_mm}:00+00:00")


def world() -> World:
    # Roads: vehicles wait at junction 1, casualties at 3 and 4, the Role 1 at 5
    roads = {1: [Road(3, 6000, 20, 60, 1.0), Road(4, 2000, 20, 60, 1.0)], 3: [Road(5, 9000, 20, 60, 1.0)],
             4: [Road(5, 9000, 20, 60, 1.0)]}
    return World(
        now=NOW,
        casualties=[
            Casualty(11, "CAS-1", "T2", "litter", "awaiting_pickup", at("04:00"), 4, 47.44, 35.83),
            Casualty(12, "CAS-2", "T1", "litter", "assigned", at("05:10"), 3, 47.44, 35.84, "M-1", "AMB-1", "R1-A",
                     at("05:45")),
            Casualty(13, "CAS-3", "T1", "ambulatory", "no_resource", at("05:20"), 4, 47.44, 35.85),
        ],
        vehicles=[
            Vehicle(21, "UGV-1", "ugv", "idle", 20.0, 25.0, 1, 0, 20.0, 1, 47.50, 35.81),
            Vehicle(22, "AMB-1", "ambulance", "tasked", 100.0, 300.0, 4, 2, 80.0, 1, 47.56, 35.79, "M-1"),
        ],
        facilities=[Facility(31, "R1-A", "Role 1 Orikhiv", "role1", "operational", 3, 3,
                             ["first_aid", "stabilisation"], 5, 47.56, 35.79)],
        missions=[Mission(41, "M-1", "planned", "AMB-1", "R1-A", ["CAS-2"], at("06:10"), None)],
        threats=[{"nid": 51, "id": "THR-1", "type": "fpv_drone", "level": 0.7, "active": True}],
        closed_roads=[],
        load_roads=lambda: roads,
    )


def handler(name: str):
    return next(i.handler for i in INTENTS if i.name == name)


def test_most_critical_is_the_earliest_injured_t1():
    answer = handler("most_critical")(world(), Slots())
    assert answer.say.startswith("CAS-2 is the most critical")
    assert [r[0] for r in answer.rows] == ["CAS-2", "CAS-3", "CAS-1"]
    assert answer.highlight[0] == 12


def test_golden_hour_counts_from_the_time_of_injury():
    answer = handler("golden_hour")(world(), Slots())
    assert [r[0] for r in answer.rows] == ["CAS-1"]  # injured 04:00, 90 min ago


def test_unassigned_flags_no_resource():
    answer = handler("unassigned")(world(), Slots())
    assert [r[0] for r in answer.rows] == ["CAS-3", "CAS-1"]  # priority order
    assert "No resource for CAS-3" in answer.say


def test_nearest_vehicle_is_idle_able_to_carry_and_in_range():
    answer = handler("nearest_vehicle")(world(), Slots(casualty="CAS-1"))
    # UGV-1 at 20 % battery has 5 km of range: CAS-1 is 2 km away
    assert answer.say.startswith("UGV-1 is the fastest idle vehicle for CAS-1: 6 min")
    assert answer.paths == [[1, 4]]


def test_nearest_vehicle_out_of_range_names_the_busy_alternative():
    answer = handler("nearest_vehicle")(world(), Slots(casualty="CAS-2"))  # 6 km: beyond UGV-1's 5 km
    assert answer.say.startswith("No idle vehicle")
    assert "AMB-1 (M-1)" in answer.say


def test_unknown_casualty_is_said_not_guessed():
    assert handler("casualty_status")(world(), Slots(casualty="CAS-9")).say == "I can't find CAS-9 on the map."


# --- Matching, with the real embedding model ------------------------------------------------------------------

UNDERSTOOD = [
    ("Which casualty on my map right now is the most critical?", "most_critical"),
    ("Who's the worst off?", "most_critical"),
    ("Who needs to go first?", "most_critical"),
    ("Who do we move first", "most_critical"),
    ("Give me the list of wounded", "queue"),
    ("Show me everyone in the queue", "queue"),
    ("How many T1s have we got?", "triage_count"),
    ("How many wounded are there?", "triage_count"),
    ("Show me the T1s", "by_triage"),
    ("Which ones are priority one", "by_triage"),
    ("Who's been waiting longest?", "longest_waiting"),
    ("Who's past the golden hour?", "golden_hour"),
    ("Anyone over an hour?", "golden_hour"),
    ("What's the status of cas three?", "casualty_status"),
    ("Tell me about CAS-2.", "casualty_status"),
    ("What's the ETA on casualty one?", "casualty_eta"),
    ("Who hasn't got a vehicle?", "unassigned"),
    ("Which casualties are still uncovered", "unassigned"),
    ("Who needs a litter?", "stretcher"),
    ("Who's walking wounded?", "walking"),
    ("What's free?", "vehicles"),
    ("Any vehicles available?", "vehicles"),
    ("Where's UGV two?", "vehicle_status"),
    ("What's ambulance one doing?", "vehicle_status"),
    ("Any robots low on battery?", "battery"),
    ("Closest vehicle to casualty three?", "nearest_vehicle"),
    ("Where do I send casualty one?", "nearest_facility"),
    ("Which hospital for casualty two?", "nearest_facility"),
    ("Where are the free beds?", "beds"),
    ("Who has surgical capability?", "capability"),
    ("Where's the ICU?", "capability"),
    ("How many medics have we got?", "medics"),
    ("What missions are active?", "missions"),
    ("Any threats?", "threats"),
    ("Any drones about?", "threats"),
    ("Are any roads closed?", "closed_roads"),
    ("Has the bridge been blown?", "closed_roads"),
    ("Give me a sitrep", "sitrep"),
    ("What can you do?", "help"),
]
NOT_UNDERSTOOD = [
    "What's the weather like tomorrow?", "Tell me a joke", "Play some music", "What time is it?",
    "How do I apply a tourniquet?", "Call my mum", "What is the capital of France?", "Uh",
    "Testing testing one two three", "Open the door", "How far is London?", "Order more bandages", "Thank you",
    "Good morning", "Who won the football", "Write me a poem",
]


@pytest.fixture(scope="module")
def matcher() -> Matcher:
    st = pytest.importorskip("sentence_transformers")
    model = st.SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2", device="cpu")
    return Matcher(lambda texts: model.encode(texts, normalize_embeddings=True))


@pytest.mark.parametrize("question, intent", UNDERSTOOD)
def test_understands(matcher, question, intent):
    best, score = matcher.rank(question)[0]
    assert (best.name, score >= MIN_SCORE) == (intent, True)


@pytest.mark.parametrize("question", NOT_UNDERSTOOD)
def test_says_it_does_not_understand(matcher, question):
    result = ask(matcher, question, "unused", world=world())
    assert not result["understood"] and result["say"] == "Sorry, I didn't understand that."


def test_asks_which_casualty_when_none_is_named(matcher):
    result = ask(matcher, "where should this casualty go", "unused", world=world())
    assert not result["understood"] and result["say"].startswith("Which casualty")


def test_answers_end_to_end(matcher):
    result = ask(matcher, "Which casualty on my map right now is the most critical?", "unused", world=world())
    assert result["understood"] and result["rows"][0][0] == "CAS-2"


def test_untriaged_casualties_are_named_but_never_ranked():
    w = world()
    w.casualties.append(Casualty(14, "CAS-4", "", "", "reported", at("03:00"), 4, 47.44, 35.83))
    answer = handler("most_critical")(w, Slots())
    assert answer.say.startswith("CAS-2 is the most critical")
    assert answer.say.endswith("1 not triaged yet: CAS-4.")
    assert "CAS-4" not in handler("unassigned")(w, Slots()).say.split(".")[0]


def test_casualty_at_a_relay_point_waits_for_an_ambulance_not_a_ugv():
    w = world()
    cas = w.casualty("CAS-1")
    cas.held_at = "HP-1"
    answer = handler("nearest_vehicle")(w, Slots(casualty="CAS-1"))
    assert answer.say.startswith("No idle vehicle")  # UGV-1 is idle and close, but UGVs do not take relays
    assert "waiting for an ambulance" in handler("casualty_status")(w, Slots(casualty="CAS-1")).say


def test_delivered_and_dead_casualties_leave_the_queue():
    w = world()
    w.casualty("CAS-1").status = "delivered"
    w.casualty("CAS-3").status = "dead"
    assert [r[0] for r in handler("queue")(w, Slots()).rows] == ["CAS-2"]
