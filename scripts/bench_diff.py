#!/usr/bin/env python3
"""
Compare two bench runs and say how much of the movement is crowding.

When the corpus grows, precision can fall without search getting worse: new
problems are legitimate answers the fixed relevance lists never judged, so a
correct new result scores as a miss. This separates the two by asking, of the
top-5 slots that changed, how many went to problems that did not exist in the
baseline run.

High displacement + flat Recall@100 = crowding. Falling Recall@100 = regression.

  python3 scripts/bench_diff.py experiments/bench-<old>.json experiments/bench-latest.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

METRICS = ["P@1", "P@5", "MRR", "nDCG@10", "Recall@100"]


def by_ranker(run: dict) -> dict:
    return {r["ranker"]: r for r in run["results"]}


def ids_in_run(run: dict) -> set[str]:
    seen: set[str] = set()
    for r in run["results"]:
        for q in r["perQuery"]:
            seen.update(h["id"] for h in q.get("top5", []))
    return seen


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("before")
    ap.add_argument("after")
    args = ap.parse_args()

    old = json.loads(Path(args.before).read_text())
    new = json.loads(Path(args.after).read_text())
    oldr, newr = by_ranker(old), by_ranker(new)

    print(f"corpus {old['corpus']['docs']} -> {new['corpus']['docs']} docs "
          f"(+{new['corpus']['docs'] - old['corpus']['docs']})\n")

    header = f"{'ranker':12} " + " ".join(f"{m:>22}" for m in METRICS)
    print(header)
    print("-" * len(header))
    for name in sorted(set(oldr) & set(newr)):
        cells = []
        for m in METRICS:
            a, b = oldr[name]["aggregate"].get(m), newr[name]["aggregate"].get(m)
            if a is None or b is None:
                cells.append(f"{'-':>22}")
                continue
            cells.append(f"{a:.3f}->{b:.3f} {b - a:+.3f}".rjust(22))
        print(f"{name:12} " + " ".join(cells))

    # Anything in the new run's top-5 that the old run never surfaced anywhere.
    baseline_ids = ids_in_run(old)
    print("\ndisplacement — new-corpus problems entering top-5")
    for name in sorted(set(oldr) & set(newr)):
        oldq = {q["query"]: q for q in oldr[name]["perQuery"]}
        entered = slots = 0
        for q in newr[name]["perQuery"]:
            prev = oldq.get(q["query"])
            if not prev:
                continue
            before = {h["id"] for h in prev.get("top5", [])}
            for h in q.get("top5", []):
                slots += 1
                if h["id"] not in before and h["id"] not in baseline_ids:
                    entered += 1
        pct = (100 * entered / slots) if slots else 0
        print(f"  {name:12} {entered:4}/{slots:<5} slots ({pct:.1f}%) are problems new since the baseline")

    print("\nqueries whose top-5 lost a judged-relevant hit")
    for name in sorted(set(oldr) & set(newr)):
        oldq = {q["query"]: q for q in oldr[name]["perQuery"]}
        hurt = []
        for q in newr[name]["perQuery"]:
            prev = oldq.get(q["query"])
            if not prev:
                continue
            rel = set(q.get("relevant", []))
            lost = (rel & {h["id"] for h in prev.get("top5", [])}) - {h["id"] for h in q.get("top5", [])}
            if lost:
                hurt.append((q["query"], sorted(lost)))
        if hurt:
            print(f"  {name}:")
            for query, lost in hurt[:8]:
                print(f"    {query!r} lost {', '.join(lost)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
