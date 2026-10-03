"""Sensor fusion and the triage recommendation (PRD section 5, "Sensor fusion"; task A2b). Pure: no database.

Sources answer doctrine Findings with yes / no / unsure. fuse() gives one answer per Finding, as Noo's engine expects
(app/src/triage/assess.ts): one yes is enough, a yes against a no is unsure ("sources disagree"). recommend() applies
the doctrine unchanged (any yes Finding indicates its injury; all members of a Condition together; the most urgent
category wins), then MITT's "walks -> T3" when the doctrine ranks nothing (PRD 6.18). The confidence only informs.
"""

import json
from math import prod
from pathlib import Path
from typing import NamedTuple

APP_CONFIDENCE = 0.9  # the app gives none: a soldier without medical training answers (PRD 6.14)
MOBILITY = "mobility"  # ours, not in the doctrine: walks (yes) or not (no)
TRIAGE = {"immediate": "T1", "delayed": "T2", "minimal": "T3", "expectant": "Expectant"}
MITT_WALKS = ("T3", 3)
TCCC = "tccc-handbook"  # the engine uses only links that cite the TCCC handbook


class Observation(NamedTuple):
    source: str  # 'drone' or 'app'
    finding: str  # a doctrine Finding key, or MOBILITY
    answer: str  # 'yes', 'no' or 'unsure'
    at: float  # when it was observed (any increasing number: scenario minutes, epoch seconds)
    confidence: float | None = None  # the drone's; the app gives none


class Fused(NamedTuple):
    answer: str  # what the engine receives: 'yes', 'no' or 'unsure'
    confidence: float | None  # combined, over the sources that gave that answer; None when unsure
    sources: tuple[tuple[str, str, float], ...]  # (source, answer, confidence), newest per source
    disagree: bool  # a yes against a no


class Doctrine(NamedTuple):
    links: tuple[tuple[str, str], ...]  # (finding, injury)
    conditions: tuple[tuple[frozenset[str], str], ...]  # (all these findings, injury)
    categories: dict[str, tuple[str, int]]  # injury -> (category key, rank), the most urgent one


class Recommendation(NamedTuple):
    triage: str | None  # 'T1', 'T2', 'T3', 'Expectant'; None: no recommendation, the coordinator decides
    rank: int | None
    confidence: float | None
    reasons: tuple[str, ...]
    disagree: tuple[str, ...]  # Findings where the sources disagree, shown to the coordinator


def confidence_of(o: Observation) -> float:
    return APP_CONFIDENCE if o.source == "app" else float(o.confidence if o.confidence is not None else 0.0)


def fuse(observations: list[Observation]) -> dict[str, Fused]:
    """One answer per Finding from the newest observation of each source."""
    newest: dict[tuple[str, str], Observation] = {}
    for o in observations:
        k = (o.finding, o.source)
        if k not in newest or o.at >= newest[k].at:
            newest[k] = o
    by_finding: dict[str, list[Observation]] = {}
    for (finding, _), o in newest.items():
        by_finding.setdefault(finding, []).append(o)

    fused = {}
    for finding, obs in by_finding.items():
        yes = [o for o in obs if o.answer == "yes"]
        no = [o for o in obs if o.answer == "no"]
        answer = "unsure" if yes and no else "yes" if yes else "no" if no else "unsure"
        backing = yes if answer == "yes" else no if answer == "no" else []
        confidence = 1 - prod(1 - confidence_of(o) for o in backing) if backing else None
        sources = tuple(sorted((o.source, o.answer, confidence_of(o)) for o in obs))
        fused[finding] = Fused(answer, confidence, sources, bool(yes and no))
    return fused


def recommend(fused: dict[str, Fused], doctrine: Doctrine) -> Recommendation:
    yes = {f for f, v in fused.items() if v.answer == "yes"}
    disagree = tuple(sorted(f for f, v in fused.items() if v.disagree))

    # (injury, the Findings behind it, their confidence: a Condition needs all, so its weakest member)
    found = [(injury, (f,), fused[f].confidence) for f, injury in doctrine.links if f in yes]
    found += [(injury, tuple(sorted(members)), min(fused[f].confidence for f in members))
              for members, injury in doctrine.conditions if members <= yes]
    ranked = [(doctrine.categories[i], i, fs, c) for i, fs, c in found if i in doctrine.categories]
    if ranked:
        rank = min(cat[1] for cat, *_ in ranked)
        top = [(cat, i, fs, c) for cat, i, fs, c in ranked if cat[1] == rank]
        reasons = tuple(sorted({f"{' + '.join(fs)} -> {i} -> {cat[0]}" for cat, i, fs, _ in top}))
        return Recommendation(TRIAGE[top[0][0][0]], rank, max(c for *_, c in top), reasons, disagree)

    walks = fused.get(MOBILITY)
    if walks and walks.answer == "yes":
        return Recommendation(*MITT_WALKS, walks.confidence, ("walks (MITT)",), disagree)
    return Recommendation(None, None, None, ("doctrine does not rank this: coordinator decides",), disagree)


def doctrine_from_jsonl(path: Path) -> Doctrine:
    """The rules the engine reads (DECISION-SPEC.md Q1, Q2, Q11), from the JSONL export."""
    lines = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    nodes = {d["id"]: d for d in lines if d["type"] == "node"}
    rels = [d for d in lines if d["type"] == "relationship"]
    key = lambda end: nodes[end["id"]]["properties"]["key"]  # noqa: E731
    label = lambda end: nodes[end["id"]]["labels"][0]  # noqa: E731
    tccc = lambda r: TCCC in r["properties"].get("sources_json", "")  # noqa: E731

    links = tuple((key(r["start"]), key(r["end"])) for r in rels
                  if r["label"] == "INDICATES" and label(r["start"]) == "Finding" and tccc(r))
    members: dict[int, set[str]] = {}
    for r in rels:
        if r["label"] == "PART_OF":
            members.setdefault(r["end"]["id"], set()).add(key(r["start"]))
    conditions = tuple((frozenset(members[r["start"]["id"]]), key(r["end"])) for r in rels
                       if r["label"] == "INDICATES" and label(r["start"]) == "Condition" and tccc(r))
    categories: dict[str, tuple[str, int]] = {}
    for r in rels:
        if r["label"] == "TRIAGES_TO":
            injury, cat = key(r["start"]), nodes[r["end"]["id"]]["properties"]
            if injury not in categories or cat["rank"] < categories[injury][1]:
                categories[injury] = (cat["key"], cat["rank"])
    return Doctrine(links, conditions, categories)
