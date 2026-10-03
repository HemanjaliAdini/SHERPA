"""Sensor fusion and the triage recommendation on Noo's real doctrine graph (no TuringDB needed).
The cases are the table in PRD section 5, "Sensor fusion" (CAS-6 to CAS-11)."""
from pathlib import Path

from pytest import approx, fixture

from fusion import Observation, doctrine_from_jsonl, fuse, recommend

DOCTRINE = Path(__file__).resolve().parent.parent / "data" / "doctrine" / "triage_v3.jsonl"


@fixture(scope="module")
def doctrine():
    return doctrine_from_jsonl(DOCTRINE)


def drone(finding, answer, confidence, at=0):
    return Observation("drone", finding, answer, at, confidence)


def app(finding, answer, at=0):
    return Observation("app", finding, answer, at)


def test_doctrine_reaches_eight_findings(doctrine):
    # PRD 7.15: 8 TCCC Findings reach a category, plus the torso trauma + breathing distress Condition
    ranked = {f for f, injury in doctrine.links if injury in doctrine.categories}
    assert len(ranked) == 8
    assert (frozenset({"torso_trauma", "breathing_distress"}), "tension_pneumothorax") in doctrine.conditions


def test_cas6_drone_and_app_agree(doctrine):
    fused = fuse([drone("bleeding_severe", "yes", 0.5), app("bleeding_severe", "yes")])
    assert fused["bleeding_severe"].answer == "yes"
    r = recommend(fused, doctrine)
    assert (r.triage, r.confidence) == ("T1", approx(0.95))
    assert r.reasons == ("bleeding_severe -> massive_haemorrhage -> immediate",)


def test_cas7_drone_alone_still_recommends(doctrine):
    r = recommend(fuse([drone("bleeding_severe", "yes", 0.5)]), doctrine)
    assert (r.triage, r.confidence) == ("T1", approx(0.5))


def test_cas8_app_breathing_distress(doctrine):
    r = recommend(fuse([app("breathing_distress", "yes")]), doctrine)
    assert (r.triage, r.confidence) == ("T1", approx(0.9))


def test_cas9_lying_alone_gives_no_recommendation(doctrine):
    r = recommend(fuse([drone("mobility", "no", 0.8)]), doctrine)
    assert (r.triage, r.confidence) == (None, None)


def test_cas10_sources_disagree(doctrine):
    fused = fuse([drone("bleeding_severe", "yes", 0.8), app("bleeding_severe", "no")])
    assert (fused["bleeding_severe"].answer, fused["bleeding_severe"].disagree) == ("unsure", True)
    r = recommend(fused, doctrine)
    assert (r.triage, r.disagree) == (None, ("bleeding_severe",))


def test_cas11_walking_is_t3_by_mitt(doctrine):
    r = recommend(fuse([drone("mobility", "yes", 0.7)]), doctrine)
    assert (r.triage, r.confidence, r.reasons) == ("T3", approx(0.7), ("walks (MITT)",))


def test_doctrine_beats_mitt(doctrine):
    # walking but bleeding badly: the doctrine's T1 wins over MITT's T3
    r = recommend(fuse([drone("mobility", "yes", 0.7), app("bleeding_severe", "yes")]), doctrine)
    assert r.triage == "T1"


def test_only_the_newest_observation_of_each_source_counts(doctrine):
    fused = fuse([app("bleeding_severe", "yes", at=1), app("bleeding_severe", "no", at=2)])
    assert fused["bleeding_severe"].answer == "no"
    assert recommend(fused, doctrine).triage is None


def test_torso_trauma_alone_is_t2_and_with_breathing_distress_t1(doctrine):
    assert recommend(fuse([app("torso_trauma", "yes")]), doctrine).triage == "T2"
    r = recommend(fuse([app("torso_trauma", "yes"), drone("breathing_distress", "yes", 0.4)]), doctrine)
    assert r.triage == "T1"
    assert "breathing_distress + torso_trauma -> tension_pneumothorax -> immediate" in r.reasons
