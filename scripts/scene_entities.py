"""Add a stationary medic team at each medical point, and command, to an evacuation graph.
No medic is placed with a casualty: medics stay at medical points and the data comes to them (PRD 6.16).
Idempotent: existing entity ids are preserved. These teams communicate; routing still moves vehicles/casualties.
Usage: uv run python scripts/scene_entities.py [graph]
"""
import sys
from turingdb import TuringDB
from cypher import lit, props
from routing import rows


def ensure_scene_entities(client):
    # Graphs built before PRD 6.16 have a field medic with each casualty: remove them
    if rows(client, 'MATCH (m:Medic)-[:ATTENDS]->() RETURN m.id AS id'):
        client.new_change()
        try:
            client.query('MATCH (m:Medic)-[:ATTENDS]->() DETACH DELETE m')
            client.query('COMMIT')
            client.query('CHANGE SUBMIT')
        except Exception:
            client.query('CHANGE DELETE')
            raise
        finally:
            client.checkout()
    existing = {r['id'] for r in rows(client, 'MATCH (n) RETURN n.id AS id')}
    points = rows(client, 'MATCH (p:MedicalPoint) RETURN p.id AS id, p.lat AS lat, p.lon AS lon')
    additions = []
    for label, entities, prefix, relationship, role in [
        ('MedicalPoint', points, 'MED-', 'BASED_AT', 'receiving'),
    ]:
        for entity in entities:
            eid = prefix + entity['id']
            if eid in existing:
                continue
            additions.append(
                f"MATCH (target:{label} {{id: {lit(entity['id'])}}}) CREATE "
                f"(medic:Medic {props(id=lit(eid), type=lit(role), lat=entity['lat'] + 0.0005, lon=entity['lon'] + 0.0005, status=lit('available'))})"
                f"-[:{relationship}]->(target)"
            )
    if 'CMD-1' not in existing and points:
        point = next((p for p in points if p['id'] == 'R1-A'), points[0])
        additions.append(f"CREATE (:Command {props(id=lit('CMD-1'), lat=point['lat'] + 0.0015, lon=point['lon'] - 0.0015, status=lit('coordinating'))})")
    if not additions:
        return
    client.new_change()
    try:
        for query in additions:
            client.query(query)
        client.query('COMMIT')
        client.query('CHANGE SUBMIT')
    except Exception:
        client.query('CHANGE DELETE')
        raise
    finally:
        client.checkout()
    print(f'Added {len(additions)} communication entities', flush=True)


if __name__ == '__main__':
    client = TuringDB(host='http://localhost:6666')
    client.set_graph(sys.argv[1] if len(sys.argv) > 1 else 'evac')
    ensure_scene_entities(client)
