"""Communication entities augment the graph without replacing casualties or transport."""
from test_simulate import db, fresh  # shared live scratch-graph fixtures
from scene_entities import ensure_scene_entities
from routing import rows


def test_scene_entities_are_separate_and_idempotent(fresh):
    before = rows(fresh, 'MATCH (c:Casualty) RETURN c.id AS id, c.status AS status, c.lat AS lat, c.lon AS lon')
    ensure_scene_entities(fresh)
    first = rows(fresh, 'MATCH (n:Medic) RETURN n.id AS id')
    assert len(first) == 14
    assert len(rows(fresh, 'MATCH (n:Command) RETURN n.id AS id')) == 1
    assert len(rows(fresh, 'MATCH (m:Medic)-[:ATTENDS]->(c:Casualty) RETURN m.id AS id')) == 5
    assert len(rows(fresh, 'MATCH (m:Medic)-[:BASED_AT]->(p:MedicalPoint) RETURN m.id AS id')) == 9
    ensure_scene_entities(fresh)
    assert rows(fresh, 'MATCH (n:Medic) RETURN n.id AS id') == first
    assert rows(fresh, 'MATCH (c:Casualty) RETURN c.id AS id, c.status AS status, c.lat AS lat, c.lon AS lon') == before
