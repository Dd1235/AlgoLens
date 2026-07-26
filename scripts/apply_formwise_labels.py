#!/usr/bin/env python3
"""
Merge the curated labels from formwise.xlsx into annotated problem records.

The sheet carries two things the LLM can't know: the tab a problem was filed
under ("DP Optimizations") and the human Form label ("Binary Search On Answer").
Those go in as patterns/tags alongside the generated ones, folded through the
taxonomy's alias map so they land on canonical slugs.

Dry run by default; --write applies. Re-run safe (skips labels already present).

  python3 scripts/apply_formwise_labels.py
  python3 scripts/apply_formwise_labels.py --write
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LABELS = ROOT / "data" / "cache" / "formwise_labels.json"
CORPUS = ROOT / "data" / "problemset_llm"
TAXONOMY = ROOT / "data" / "pattern_taxonomy.json"
MAX_PATTERNS = 12

# Sheet tab -> the tag it implies. Tabs are topics, not techniques, so they go
# to tags; only the Form column becomes a pattern.
TOPIC_TAGS = {
    "Binary Search": "binary-search", "Two Pointers": "two-pointers",
    "Recursion Backtracking": "backtracking", "Graph Level-1": "graph",
    "Bit-Manipulation": "bitmask", "DP Level 1": "dynamic-programming",
    "STL": "data-structure", "Math": "math",
    "Contribution Technique & Prefix": "prefix-sum", "Trie": "trie",
    "String": "string", "Segment Trees": "segment-tree", "Trees": "tree",
    "DP Optimizations": "dynamic-programming", "DP Level 2": "dynamic-programming",
    "Greedy And Sweepline": "greedy", "Graph Level 2": "graph",
}


def slugify(s: str) -> str:
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", s.lower())).strip("-")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()

    tax = json.loads(TAXONOMY.read_text())
    aliases = tax.get("aliases", {})
    canonical = set(tax["canonical"])
    labels = json.loads(LABELS.read_text())

    touched = added_patterns = added_tags = missing = 0
    unknown: dict[str, int] = {}

    for pid, meta in labels.items():
        platform = pid.split("-")[0]
        path = CORPUS / platform / f"{pid}.json"
        if not path.exists():
            missing += 1
            continue
        problem = json.loads(path.read_text())
        changed = False

        for raw in meta.get("curated", []):
            slug = aliases.get(slugify(raw), slugify(raw))
            if not slug or slug in problem.get("patterns", []):
                continue
            if len(problem.get("patterns", [])) >= MAX_PATTERNS:
                continue
            if slug not in canonical:
                unknown[slug] = unknown.get(slug, 0) + 1
            problem.setdefault("patterns", []).append(slug)
            problem.setdefault("annotation", {}).setdefault("pattern_confidence", {})[slug] = 0.9
            added_patterns += 1
            changed = True

        # A problem filed under two tabs earns both tags.
        for topic in meta.get("topics") or [meta.get("topic", "")]:
            topic_tag = TOPIC_TAGS.get(topic)
            if topic_tag and topic_tag not in problem.get("tags", []):
                problem.setdefault("tags", []).append(topic_tag)
                added_tags += 1
                changed = True

        if changed:
            touched += 1
            if args.write:
                path.write_text(json.dumps(problem, indent=2, ensure_ascii=False) + "\n")

    verb = "applied" if args.write else "would apply"
    print(f"{verb} {added_patterns} curated pattern(s) + {added_tags} topic tag(s) across {touched} file(s)")
    if missing:
        print(f"  {missing} staged problem(s) not in the corpus yet (not annotated / premium / failed)")
    if unknown:
        top = sorted(unknown.items(), key=lambda kv: -kv[1])[:12]
        print("  non-canonical curated labels (will show as drift):",
              ", ".join(f"{k}({v})" for k, v in top))
    if args.write and touched:
        print("corpus text changed — run: npm run embed && npm run validate")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
