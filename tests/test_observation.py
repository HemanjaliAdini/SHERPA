"""The `observation` event (A2c): association, fusion and the recommendation stored on the casualty, and reset.
Needs TuringDB on localhost:6666 and the scratch graph with the doctrine (build_graph.sh loads it)."""
from simulate import in_change, reset_writes, tick_writes
from test_events import add_event, event, no_script
from test_simulate import db, fresh, one, scratch  # noqa: F401 - fixtures

CAS1 = (47.4430, 35.8335)  # seed_scenario.py


def casualty(client, cid):
    return one(client, f"MATCH (c:Casualty {{id: '{cid}'}}) RETURN c.recommended_category AS triage, "
                       "c.recommendation_confidence AS confidence, c.recommendation_disagree AS disagree, "
                       "c.recommended_mobility AS mobility, c.recommendation_evidence AS evidence")


def observe(client, eid, source, finding, answer, confidence=None, casualty_id=None, at=CAS1, minutes=0):
    payload = {"source": source, "finding": finding, "answer": answer, "lat": at[0], "lon": at[1]}
    if confidence is not None:
        payload["confidence"] = confidence
    if casualty_id:
        payload["casualty_id"] = casualty_id
    add_event(client, eid, minutes, "observation", payload)


def count_casualties(client):
    return one(client, "MATCH (c:Casualty) RETURN count(c) AS n")["n"]


def test_drone_then_app_on_the_same_casualty(fresh, scratch):
    no_script(scratch)
    observe(scratch, "OBS-T1", "drone", "bleeding_severe", "yes", 0.5, casualty_id="CAS-1")
    observe(scratch, "OBS-T2", "drone", "mobility", "no", 0.8, casualty_id="CAS-1")
    tick_writes(scratch)
    c = casualty(scratch, "CAS-1")
    assert (c["triage"], c["confidence"], c["mobility"]) == ("T1", 0.5, "litter")

    # 20 m away, no casualty_id: the same person, not a new casualty
    before = count_casualties(scratch)
    observe(scratch, "OBS-T3", "app", "bleeding_severe", "yes", at=(CAS1[0] + 0.00018, CAS1[1]))
    tick_writes(scratch)
    assert count_casualties(scratch) == before
    c = casualty(scratch, "CAS-1")
    assert (c["triage"], c["confidence"]) == ("T1", 0.95)
    assert "bleeding_severe: app yes, drone yes 0.50" in c["evidence"]
    assert event(scratch, "OBS-T3")["status"] == "applied"


def test_sources_disagree(fresh, scratch):
    no_script(scratch)
    observe(scratch, "OBS-T1", "drone", "bleeding_severe", "yes", 0.8, casualty_id="CAS-5")
    observe(scratch, "OBS-T2", "app", "bleeding_severe", "no", casualty_id="CAS-5")
    tick_writes(scratch)
    c = casualty(scratch, "CAS-5")
    assert (c["triage"], c["disagree"]) == (None, "bleeding_severe")


def test_someone_nobody_reported_becomes_a_new_casualty(fresh, scratch):
    no_script(scratch)
    before = count_casualties(scratch)
    observe(scratch, "OBS-T1", "drone", "mobility", "yes", 0.7, at=(47.4500, 35.8200))
    tick_writes(scratch)
    assert count_casualties(scratch) == before + 1
    new = one(scratch, "MATCH (c:Casualty) WHERE c.event_id = 'OBS-T1' RETURN c.id AS id, "
                       "c.recommended_category AS triage, c.status AS status")
    assert (new["triage"], new["status"]) == ("T3", "reported")  # walks: MITT


def test_reset_undoes_the_fusion(fresh, scratch):
    no_script(scratch)
    observe(scratch, "OBS-T1", "app", "bleeding_severe", "yes", casualty_id="CAS-2")
    tick_writes(scratch)
    assert casualty(scratch, "CAS-2")["triage"] == "T1"
    reset_writes(scratch)
    # the test's observation is gone; on a demo graph the reset applies the script's 05:30 reports again
    assert one(scratch, "MATCH (o:Observation {id: 'OBS-T1'}) RETURN count(o) AS n")["n"] == 0
    assert casualty(scratch, "CAS-2")["triage"] != "T1"
    assert one(scratch, "MATCH (:Casualty {id: 'CAS-2'})-[h:HAS_FINDING]->(f:Finding {key: 'bleeding_severe'}) "
                        "RETURN count(h) AS n")["n"] == 0
