#!/usr/bin/env python3
"""
Fold judge-assigned tags into the searchable text, via the taxonomy.

Codeforces and LeetCode label their own problems, and those labels are stored
verbatim in `source_tags` — but `source_tags` is not part of the indexed
document (server/search/bm25.js and scripts/embed_corpus.js both build text from
title + statement + tags + patterns). So a judge saying "ordered-set" reached
nobody: 48 problems carry that judge tag and only 20 carried a matching label.

The tempting one-line fix is to index `source_tags` raw. That's wrong: the 106
distinct judge tags are dominated by "implementation", "brute force" and
"data structures", which would flood the vocabulary with words that don't
discriminate. Mapping through the taxonomy first keeps only the tags that name
something the vocabulary already recognises.

Judge tags land in `tags` (topics), never `patterns` (techniques). Patterns
drive the pattern filter and the counts on /patterns.html, and those should stay
the human-reviewed set — a judge's coarse "dp" is not the same claim as our
"digit-dp".

  python3 scripts/apply_source_tags.py           # report
  python3 scripts/apply_source_tags.py --write   # apply
"""

from __future__ import annotations

import argparse
import collections
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CORPUS = ROOT / "data" / "problemset_llm"
TAXONOMY = ROOT / "data" / "pattern_taxonomy.json"
MAX_TAGS = 12  # validate_corpus.js caps labels per field

# Judge tags that name a genre rather than a topic. Adding these would put a
# word on hundreds of problems that tells a searcher nothing about which one
# they want — the opposite of what the labels are for.
TOO_GENERIC = {
    "implementation", "brute-force", "constructive-algorithm", "data-structure",
    "simulation", "math", "greedy", "sorting", "two-pointers", "binary-search",
    "dynamic-programming", "dfs", "bfs", "divide-and-conquer", "bit-manipulation",
    "counting", "string", "array", "graph", "tree", "hash-map", "heap", "stack",
    "queue", "matrix", "recursion", "memoization", "number-theory", "combinatorics",
    "geometry", "probability", "game-theory", "interactive", "shortest-path",
}


def slugify(s: str) -> str:
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", str(s).lower())).strip("-")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()

    tax = json.loads(TAXONOMY.read_text())
    canonical = set(tax["canonical"])
    aliases = tax.get("aliases", {})

    def canon(tag: str) -> str | None:
        s = slugify(tag)
        target = s if s in canonical else aliases.get(s)
        if not target or target in TOO_GENERIC:
            return None
        return target

    added = collections.Counter()
    touched = 0
    capped = 0

    for path in sorted(CORPUS.glob("*/*.json")):
        problem = json.loads(path.read_text())
        source_tags = problem.get("source_tags") or []
        if not source_tags:
            continue
        have = set(problem.get("tags") or []) | set(problem.get("patterns") or [])
        new = []
        for raw in source_tags:
            target = canon(raw)
            if target and target not in have and target not in new:
                new.append(target)
        if not new:
            continue
        tags = list(problem.get("tags") or [])
        room = MAX_TAGS - len(tags)
        if room <= 0:
            capped += 1
            continue
        if len(new) > room:
            capped += 1
            new = new[:room]
        problem["tags"] = tags + new
        for t in new:
            added[t] += 1
        touched += 1
        if args.write:
            path.write_text(json.dumps(problem, indent=2, ensure_ascii=False) + "\n")

    verb = "added" if args.write else "would add"
    print(f"{verb} {sum(added.values())} judge tag(s) across {touched} problem(s)")
    if capped:
        print(f"  {capped} problem(s) hit the {MAX_TAGS}-label cap and were trimmed or skipped")
    print("  most recovered:")
    for tag, n in added.most_common(15):
        print(f"    {tag:28} +{n}")
    if args.write and touched:
        print("\ncorpus text changed — run: npm run embed && npm run validate")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
