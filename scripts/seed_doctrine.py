"""Load Noo's TCCC doctrine graph into a scenario graph, read-only (PRD section 5, "Sensor fusion"; task A2a).

data/doctrine/triage_v3.jsonl is copied from branch feat/triage-app (app/assets/graph/triage_v3.jsonl): the triage
rules as Finding -INDICATES-> Injury -TRIAGES_TO-> TriageCategory, plus treatments, tiers and kit. It never stores
casualties. Empty list properties are left out (none of them is read: kit comes from CONSUMES edges).

Usage: uv run python scripts/seed_doctrine.py [graph]   (build_graph.sh runs it after seed_scenario.py)
"""

import json
import sys
from pathlib import Path

from turingdb import TuringDB

from cypher import lit, props

DOCTRINE = Path(__file__).resolve().parent.parent / "data" / "doctrine" / "triage_v3.jsonl"


def create_statement(lines: list[dict]) -> str:
    """One CREATE for every node, then every relationship, of the JSONL export."""
    nodes = [d for d in lines if d["type"] == "node"]
    rels = [d for d in lines if d["type"] == "relationship"]
    parts = []
    for d in nodes:
        p = {k: lit(v) for k, v in d["properties"].items() if v != []}
        parts.append(f"(d{d['id']}:{':'.join(d['labels'])} {props(**p)})")
    for d in rels:
        p = {k: lit(v) for k, v in d["properties"].items() if v != []}
        parts.append(f"(d{d['start']['id']})-[:{d['label']} {props(**p)}]->(d{d['end']['id']})")
    return "CREATE " + ",\n       ".join(parts)


def main() -> None:
    graph = sys.argv[1] if len(sys.argv) > 1 else "evac"
    client = TuringDB(host="http://localhost:6666")
    client.set_graph(graph)
    if int(client.query("MATCH (f:Finding) RETURN count(f)").iloc[0, 0]) > 0:
        print(f"graph '{graph}' already has the doctrine graph")
        return
    lines = [json.loads(line) for line in DOCTRINE.read_text().splitlines() if line.strip()]
    client.new_change()
    try:
        client.query(create_statement(lines))
        client.query("COMMIT")
        client.query("CHANGE SUBMIT")
    except Exception:
        client.query("CHANGE DELETE")
        raise
    finally:
        client.checkout()
    print(client.query("MATCH (f:Finding) RETURN count(f) AS findings"))


if __name__ == "__main__":
    main()
