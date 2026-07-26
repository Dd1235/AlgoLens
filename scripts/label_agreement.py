#!/usr/bin/env python3
"""
Score our LLM labels against Codeforces' official tags.

Every other judge in the corpus ships either no tags or coarse ones, so there
is normally no way to measure whether the annotator is labeling accurately —
only whether a human reviewer objects. Codeforces publishes per-problem tags,
which makes its slice the one place with usable ground truth.

Read it as a diagnostic, not a verdict. CF tags are sparse and conservative:
low precision here often means "we labeled something CF didn't bother to",
which helps search recall. Low *recall* is the alarming direction — that is a
technique the annotator missed, and missed labels are unfindable problems.

  python3 scripts/label_agreement.py
  python3 scripts/label_agreement.py --min-support 20
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CORPUS = ROOT / "data" / "problemset_llm" / "codeforces"

# Official CF tag -> the label(s) in our vocabulary that mean the same thing.
# Patterns and tags are pooled: CF makes no technique/topic split, we do.
EQUIVALENTS: dict[str, set[str]] = {
    "binary search": {"binary-search", "binary-search-answer"},
    "bitmasks": {"bitmask", "bitmask-dp", "bit-manipulation"},
    "combinatorics": {"combinatorics"},
    "constructive algorithms": {"constructive-algorithm"},
    "dfs and similar": {"dfs", "depth-first-search"},
    "dp": {"dynamic-programming"},
    "dsu": {"union-find"},
    "flows": {"max-flow", "min-cut", "min-cost-flow"},
    "geometry": {"geometry"},
    "graph matchings": {"bipartite-matching"},
    "graphs": {"graph"},
    "greedy": {"greedy"},
    "hashing": {"rolling-hash", "hashing"},
    "math": {"math"},
    "number theory": {"number-theory"},
    "probabilities": {"probability-dp", "probability"},
    "shortest paths": {"shortest-path", "dijkstra", "bellman-ford"},
    "sortings": {"sorting"},
    "strings": {"string"},
    "trees": {"tree"},
    "two pointers": {"two-pointers"},
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-support", type=int, default=10,
                    help="skip tags CF uses on fewer than this many problems")
    args = ap.parse_args()

    records = []
    for path in sorted(CORPUS.glob("*.json")):
        r = json.loads(path.read_text())
        if r.get("source_tags"):
            records.append(r)
    if not records:
        print("no codeforces records carry source_tags — nothing to score")
        return 0

    def ours(r: dict) -> set[str]:
        return set(r.get("patterns") or []) | set(r.get("tags") or [])

    print(f"n={len(records)} codeforces records with official tags")
    print("precision = of ours, how many CF agrees with · recall = of CF's, how many we caught\n")
    header = f"{'official tag':26} {'CF':>5} {'ours':>5} {'prec':>6} {'recall':>7}"
    print(header)
    print("-" * len(header))

    rows = []
    for official, equivalents in EQUIVALENTS.items():
        gold = {r["id"] for r in records if official in r["source_tags"]}
        if len(gold) < args.min_support:
            continue
        mine = {r["id"] for r in records if ours(r) & equivalents}
        hit = gold & mine
        rows.append((official, len(gold), len(mine),
                     len(hit) / len(mine) if mine else 0.0,
                     len(hit) / len(gold) if gold else 0.0))

    for official, g, m, p, rc in sorted(rows, key=lambda t: t[4]):
        flag = "  <- missed technique" if rc < 0.6 else ("  <- over-applied" if p < 0.5 else "")
        print(f"{official:26} {g:5} {m:5} {p:5.0%} {rc:6.0%}{flag}")

    if rows:
        print(f"\nmacro precision {sum(r[3] for r in rows) / len(rows):.0%} · "
              f"macro recall {sum(r[4] for r in rows) / len(rows):.0%}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
