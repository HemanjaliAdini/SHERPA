"""Simulator: pure movement on hand-built routes, then ticks against a real scenario graph (needs TuringDB)."""
from pytest import approx

from build_roads import haversine_m
import simulate
from simulate import Leg, advance, distance_to_junction, position_at

# Two roads in a straight line along a meridian: 1,000 m at 300 m/min, then 2,000 m at 500 m/min
A, B, C = (47.0, 35.0), (47.0 + 1000 / 111_195, 35.0), (47.0 + 3000 / 111_195, 35.0)
LEGS = [Leg(1000, 300, [A, B]), Leg(2000, 500, [B, C])]


def test_advance_along_route():
    assert advance(LEGS, 0, 1) == approx(300)
    assert advance(LEGS, 900, 1) == approx(1000 + (1 - 100 / 300) * 500)  # crosses onto the faster road
    assert advance(LEGS, 0, 4) == approx(1000 + (4 - 1000 / 300) * 500)
    assert advance(LEGS, 2900, 1) == approx(3000)  # stops at the end


def test_position_follows_the_geometry():
    for progress in (0, 300, 1000, 2500, 3000):
        lat, lon = position_at(LEGS, progress)
        assert haversine_m(A, (lat, lon)) == approx(progress, abs=1)


def test_position_on_a_bent_road():
    corner = (47.0, 35.0 + 500 / 75_850)  # 500 m east, then 500 m north
    end = (47.0 + 500 / 111_195, corner[1])
    legs = [Leg(1000, 300, [A, corner, end])]
    lat, lon = position_at(legs, 750)
    assert haversine_m(corner, (lat, lon)) == approx(250, abs=2)
    assert lon == approx(corner[1])


def test_distance_to_junction():
    assert distance_to_junction(LEGS, 0) == 0
    assert distance_to_junction(LEGS, 1) == 1000
    assert distance_to_junction(LEGS, 2) == 3000


# --- ticks against a real scenario graph ---------------------------------------------------------------------

import subprocess  # noqa: E402
from datetime import timedelta  # noqa: E402
from pathlib import Path  # noqa: E402

import pytest  # noqa: E402
from turingdb import TuringDB  # noqa: E402

from routing import read_clock, rows  # noqa: E402
from seed_scenario import VEHICLES  # noqa: E402
from simulate import in_change, loop_once, reset_writes, tick_writes  # noqa: E402

GRAPH = "simtest"
ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture(scope="module")
def db():
    client = TuringDB(host="http://localhost:6666")
    try:
        # An in-memory TuringDB (run.sh) has graphs only in the loaded list, never on disk
        graphs = client.list_available_graphs() + client.list_loaded_graphs()
    except Exception:
        pytest.skip("TuringDB is not running on localhost:6666")
    if GRAPH not in graphs:
        subprocess.run([str(ROOT / "scripts" / "build_graph.sh"), GRAPH], check=True, cwd=ROOT)
    client.load_graph(GRAPH, raise_if_loaded=False)
    client.set_graph(GRAPH)
    return client


@pytest.fixture
def fresh(db):
    """The scenario at its start; whatever a test leaves in an open change is thrown away."""
    in_change(db, reset_writes)
    yield db
    db.checkout()


@pytest.fixture
def scratch(fresh):
    """An open change on top of the fresh scenario, deleted after the test."""
    fresh.new_change()
    yield fresh
    fresh.query("CHANGE DELETE")


def triage(client, cid, category, mobility="litter"):
    client.query(f"MATCH (c:Casualty {{id: '{cid}'}}) SET c.triage_category = '{category}', "
                 f"c.mobility = '{mobility}', c.status = 'awaiting_pickup'")
    client.query("COMMIT")


def tick(client):
    tick_writes(client)
    client.query("COMMIT")


def one(client, query):
    return rows(client, query)[0]


def head_commit(client):
    """CALL db.history() lists the newest commit first, marked '(HEAD)'."""
    return str(client.query("CALL db.history()").iloc[0, 0]).removesuffix("(HEAD)")


def missions(client):
    return {r["cid"]: r for r in rows(client, (
        "MATCH (m:Mission)-[:PICKS_UP]->(c:Casualty), (m)-[:USES]->(v:Vehicle), (m)-[:DELIVERS_TO]->(p) "
        "RETURN c.id AS cid, m.id AS mid, m.status AS status, v.id AS vid, v.type AS vtype, p.id AS pid, "
        "p.type AS ptype"
    ))}


def tick_until(client, done, limit=200):
    for _ in range(limit):
        tick(client)
        if done():
            return
    raise AssertionError(f"condition not reached in {limit} ticks")


def test_untriaged_and_dead_not_dispatched(scratch):
    triage(scratch, "CAS-1", "DEAD")
    for _ in range(10):
        tick(scratch)
    assert one(scratch, "MATCH (m:Mission) RETURN count(m) AS n")["n"] == 0


def test_batch_dispatched_on_first_tick(scratch):
    for cid, category in [("CAS-4", "T3"), ("CAS-2", "T3"), ("CAS-5", "T2"), ("CAS-3", "T1"), ("CAS-1", "T1")]:
        triage(scratch, cid, category)
    assert loop_once(scratch) > 0  # paused: no tick
    assert one(scratch, "MATCH (m:Mission) RETURN count(m) AS n")["n"] == 0
    tick(scratch)
    by_casualty = missions(scratch)
    first_two = sorted((m["mid"], cid) for cid, m in by_casualty.items())[:2]
    assert {cid for _, cid in first_two} == {"CAS-1", "CAS-3"}  # the T1s get the first missions
    assert len(by_casualty) == len(VEHICLES)  # every vehicle used, one casualty left waiting
    assert {m["status"] for m in by_casualty.values()} == {"active"}  # on their way, not finished


def test_no_reassignment(scratch):
    for cid, category in [("CAS-1", "T1"), ("CAS-2", "T3"), ("CAS-3", "T1"), ("CAS-4", "T3"), ("CAS-5", "T2")]:
        triage(scratch, cid, category)
    tick(scratch)
    before = {cid: m["vid"] for cid, m in missions(scratch).items()}
    waiting = next(c for c in ("CAS-1", "CAS-2", "CAS-3", "CAS-4", "CAS-5") if c not in before)
    triage(scratch, waiting, "T1")  # now urgent, but every vehicle is busy
    tick(scratch)
    assert {cid: m["vid"] for cid, m in missions(scratch).items()} == before
    assert one(scratch, f"MATCH (c:Casualty {{id: '{waiting}'}}) RETURN c.status AS s")["s"] == "awaiting_pickup"


def test_pickup_rides_with_vehicle(scratch):
    triage(scratch, "CAS-1", "T1")
    status = lambda: one(scratch, "MATCH (c:Casualty {id: 'CAS-1'}) RETURN c.status AS s")["s"]  # noqa: E731
    tick_until(scratch, lambda: status() == "in_transit")
    for _ in range(2):
        tick(scratch)
        if status() != "in_transit":
            break
        pos = one(scratch, "MATCH (m:Mission)-[:PICKS_UP]->(c:Casualty {id: 'CAS-1'}), (m)-[:USES]->(v) "
                           "RETURN c.lat AS clat, c.lon AS clon, v.lat AS vlat, v.lon AS vlon")
        assert (pos["clat"], pos["clon"]) == approx((pos["vlat"], pos["vlon"]))


def test_drop_at_handover_then_ambulance_then_bed(scratch):
    triage(scratch, "CAS-1", "T1")
    tick(scratch)
    first = missions(scratch)["CAS-1"]
    assert first["vtype"] == "ugv" and first["ptype"] in ("handover", "ccp")
    beds_before = one(scratch, "MATCH (p:MedicalPoint {id: 'R1-A'}) RETURN p.free_beds AS b")["b"]
    tick_until(scratch, lambda: one(scratch, f"MATCH (m:Mission {{id: '{first['mid']}'}}) RETURN m.status AS s")["s"]
               == "done")
    drop = one(scratch, (
        f"MATCH (p:MedicalPoint {{id: '{first['pid']}'}})-[:NEAR]->(j), (v:Vehicle {{id: '{first['vid']}'}})-[:NEAR]->(vj), "
        "(c:Casualty {id: 'CAS-1'})-[:NEAR]->(cj), (c)-[:HELD_AT]->(h) "
        "RETURN id(j) AS j, id(vj) AS vj, id(cj) AS cj, h.id AS held, c.status AS cs, v.status AS vs"
    ))
    assert (drop["vs"], drop["cs"], drop["held"]) == ("idle", "awaiting_pickup", first["pid"])
    assert drop["vj"] == drop["j"] == drop["cj"]
    tick(scratch)
    second = next(m for m in rows(scratch, (
        "MATCH (m:Mission)-[:PICKS_UP]->(c:Casualty {id: 'CAS-1'}), (m)-[:USES]->(v), (m)-[:DELIVERS_TO]->(p) "
        "WHERE m.status <> 'done' RETURN m.id AS mid, v.type AS vtype, p.id AS pid"
    )))
    assert second["vtype"] == "ambulance"
    tick_until(scratch, lambda: one(scratch, "MATCH (c:Casualty {id: 'CAS-1'}) RETURN c.status AS s")["s"] == "delivered")
    end = one(scratch, f"MATCH (c:Casualty {{id: 'CAS-1'}})-[:HELD_AT]->(p) RETURN p.id AS pid, p.free_beds AS b")
    assert end["pid"] == second["pid"]
    if second["pid"] == "R1-A":
        assert end["b"] == beds_before - 1


def test_paused_does_not_move(fresh):
    commits = len(fresh.query("CALL db.history()"))
    clock = read_clock(fresh)
    where = rows(fresh, "MATCH (v:Vehicle) RETURN v.id AS id, v.lat AS lat, v.lon AS lon ORDER BY id")
    for _ in range(3):
        assert loop_once(fresh) > 0
    assert len(fresh.query("CALL db.history()")) == commits
    assert read_clock(fresh) == clock
    assert rows(fresh, "MATCH (v:Vehicle) RETURN v.id AS id, v.lat AS lat, v.lon AS lon ORDER BY id") == where


def test_tick_advances_clock_and_commits(fresh):
    commits = len(fresh.query("CALL db.history()"))
    clock = read_clock(fresh)
    for _ in range(3):
        in_change(fresh, tick_writes)
    assert read_clock(fresh) == clock + timedelta(minutes=3)
    assert len(fresh.query("CALL db.history()")) >= commits + 3


def test_commit_carries_scenario_time(fresh):
    in_change(fresh, tick_writes)
    in_change(fresh, tick_writes)
    expected = read_clock(fresh)
    head = head_commit(fresh)
    fresh.query(f"LOAD COMMIT '{head}'")
    fresh.set_commit(head)
    try:
        assert read_clock(fresh) == expected
    finally:
        fresh.checkout()


def test_reset_restores_seed_keeps_history(fresh):
    def setup(c):
        triage(c, "CAS-1", "T1")
        for _ in range(5):
            tick(c)
    in_change(fresh, setup)
    mid_run = head_commit(fresh)
    moved = one(fresh, "MATCH (v:Vehicle)<-[:USES]-(m:Mission) RETURN v.id AS id, v.lat AS lat")
    in_change(fresh, reset_writes)
    assert one(fresh, "MATCH (m:Mission) RETURN count(m) AS n")["n"] == 0
    seed = {v[0]: (v[2], v[3]) for v in VEHICLES}
    for v in rows(fresh, "MATCH (v:Vehicle) RETURN v.id AS id, v.lat AS lat, v.lon AS lon, v.status AS s"):
        assert (v["lat"], v["lon"]) == approx(seed[v["id"]]) and v["s"] == "idle"
    cas = rows(fresh, "MATCH (c:Casualty) RETURN c.status AS s, c.triage_category AS t")
    assert all(c["s"] == "reported" and c["t"] is None for c in cas)
    assert str(read_clock(fresh)).startswith("2023-09-12 05:30")
    assert one(fresh, "MATCH (s:SimControl) RETURN s.running AS r")["r"] is False
    fresh.query(f"LOAD COMMIT '{mid_run}'")
    fresh.set_commit(mid_run)
    try:
        assert one(fresh, f"MATCH (v:Vehicle {{id: '{moved['id']}'}}) RETURN v.lat AS lat")["lat"] == approx(moved["lat"])
        assert one(fresh, "MATCH (m:Mission) RETURN count(m) AS n")["n"] == 1
    finally:
        fresh.checkout()


def test_reset_button_flag(fresh):
    in_change(fresh, lambda c: (triage(c, "CAS-1", "T1"), tick(c)))
    in_change(fresh, lambda c: c.query("MATCH (s:SimControl) SET s.reset = true"))
    loop_once(fresh)
    assert one(fresh, "MATCH (m:Mission) RETURN count(m) AS n")["n"] == 0
    assert one(fresh, "MATCH (s:SimControl) RETURN s.reset AS r, s.running AS run") == {"r": False, "run": False}


def test_rejected_pass_does_not_kill_the_simulator(monkeypatch):
    from turingdb.exceptions import TuringDBException

    def rejected(client):
        raise TuringDBException("EXEC_ERROR: node modified on main")

    monkeypatch.setattr(simulate, "loop_once", rejected)
    assert simulate.run_pass(None) == simulate.PAUSED_POLL_S


def test_two_resets_in_a_row(fresh):
    """A reset right after a reset changes nothing else; it must still commit (a new run), not be refused."""
    in_change(fresh, reset_writes)
    in_change(fresh, reset_writes)
    assert one(fresh, "MATCH (k:Clock) RETURN k.run AS run")["run"] >= 2
