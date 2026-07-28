#!/usr/bin/env python3
"""
Store LeetCode's acceptance rate, so difficulty can be finer than three tiers.

LeetCode publishes `acRate` on every problem and we already fetch it — but only
to sort the Medium seed list in scripts/update_problem_urls.py, after which it
is thrown away. The served records carry `difficulty: "Medium"`, and nothing
distinguishes a 15% Medium from a 50% one.

WHAT THE NUMBER IS WORTH, MEASURED

Over the full LeetCode problemset the metric tracks the tier boundary: median
Medium 57.5%, median Hard 47.3%, AUC 0.677 — a random Hard has a 68% chance of a
lower acceptance rate than a random Medium. Real signal, but a proxy and not a
scale.

Over OUR slice the same comparison inverts (AUC 0.426): served Hards look
*easier* than served Mediums. That is not a data error, it is our own selection
— 554 of 661 served Mediums were picked BECAUSE they had the lowest acceptance
rates, while all 743 Hards came in unfiltered. So acceptance rate is only
comparable WITHIN a tier here, which is exactly how the filter and the sort
tiebreaker use it. Ranking a low-acRate Medium above a high-acRate Hard would be
an artifact of how the corpus was built, not a fact about the problems.

Caveats worth keeping in mind before anyone exposes this as a number: acRate is
submissions-based rather than user-based, so a problem people brute-force-retry
looks harder than it is; low-numbered problems attract beginners (Two Sum sits
near 56% despite being trivial); and recent contest problems have small samples.

NO RE-EMBED. `corpusHash` (server/search/embedding.js) hashes id + problemText,
and problemText is title + statement + tags + patterns. `acceptance_rate` is not
in that text, so unlike most corpus edits this one does not invalidate the
committed embeddings.

  python3 scripts/backfill_acceptance_rate.py           # report
  python3 scripts/backfill_acceptance_rate.py --write   # apply
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from update_problem_urls import LEETCODE_GRAPHQL_URL, request_json  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
LEETCODE_DIR = ROOT / "data" / "problemset_llm" / "leetcode"
TIERS = ("EASY", "MEDIUM", "HARD")
PAGE = 100


def fetch_tier(tier: str) -> dict[str, float]:
    """slug -> acceptance rate as a percentage, for one difficulty tier."""
    filters = {
        "filterCombineType": "ALL",
        "difficultyFilter": {"difficulties": [tier], "operator": "IS"},
    }
    query = (
        "query qs($limit: Int, $skip: Int, $filters: QuestionFilterInput) {"
        " problemsetQuestionListV2(limit: $limit, skip: $skip, filters: $filters) {"
        " totalLength questions { titleSlug acRate } } }"
    )
    out: dict[str, float] = {}
    total: int | None = None
    skip = 0
    while total is None or skip < total:
        data = request_json(
            LEETCODE_GRAPHQL_URL,
            {"query": query, "variables": {"skip": skip, "limit": PAGE, "filters": filters}},
        )
        if data.get("errors"):
            raise RuntimeError(data["errors"])
        page = (data.get("data") or {}).get("problemsetQuestionListV2") or {}
        total = int(page.get("totalLength") or 0)
        questions = page.get("questions") or []
        if not questions:
            break
        for q in questions:
            slug = q.get("titleSlug")
            rate = q.get("acRate")
            if not slug or not isinstance(rate, (int, float)):
                continue
            # The V2 schema returns a 0-1 fraction where the older one returned a
            # percentage. Normalise, rather than trusting whichever we got.
            out[slug] = round(float(rate) * 100 if float(rate) <= 1.0 else float(rate), 1)
        skip += PAGE
    if not out:
        raise RuntimeError(f"no acRate returned for {tier}")
    return out


def load_served() -> list[tuple[Path, dict[str, Any]]]:
    return sorted(
        ((p, json.loads(p.read_text())) for p in LEETCODE_DIR.glob("*.json")),
        key=lambda pair: pair[0].name,
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--write", action="store_true", help="write acceptance_rate into the records")
    args = ap.parse_args()

    rates: dict[str, float] = {}
    for tier in TIERS:
        got = fetch_tier(tier)
        print(f"fetched {len(got):5d} {tier.lower()} acceptance rates", file=sys.stderr)
        rates.update(got)

    served = load_served()
    by_tier: dict[str, list[float]] = {}
    changed = 0
    missing: list[str] = []

    for path, problem in served:
        slug = problem.get("slug")
        rate = rates.get(slug)
        if rate is None:
            missing.append(slug or path.name)
            continue
        by_tier.setdefault(str(problem.get("difficulty")), []).append(rate)
        if problem.get("acceptance_rate") == rate:
            continue
        changed += 1
        if args.write:
            # Sit the field next to difficulty rather than appending it, so a
            # record diffs in the order its fields belong.
            ordered: dict[str, Any] = {}
            for key, value in problem.items():
                if key == "acceptance_rate":
                    continue
                ordered[key] = value
                if key == "difficulty":
                    ordered["acceptance_rate"] = rate
            ordered.setdefault("acceptance_rate", rate)
            path.write_text(json.dumps(ordered, indent=2, ensure_ascii=False) + "\n")

    print(f"\n{len(served)} served leetcode problems, {changed} to update, {len(missing)} without a rate")
    if missing:
        print("  missing: " + ", ".join(missing[:10]) + (" …" if len(missing) > 10 else ""))
    for tier, values in sorted(by_tier.items()):
        values.sort()
        q = lambda f: values[int(len(values) * f)]  # noqa: E731
        print(
            f"  {tier:8s} n={len(values):4d}  min {values[0]:5.1f}  p25 {q(.25):5.1f}"
            f"  median {statistics.median(values):5.1f}  p75 {q(.75):5.1f}  max {values[-1]:5.1f}"
        )
    if not args.write:
        print("\n(dry run — pass --write to apply)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
