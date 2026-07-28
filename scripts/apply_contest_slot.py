#!/usr/bin/env python3
"""
Stamp the Div 2 contest slot onto curated Codeforces records.

A problem's position in a Div 2 round is how competitive programmers actually
talk about difficulty — "I can solve Div2 C" is a sentence people say, and "I
solve 1400-rated problems" is not. It is also a *different* signal from rating:
slot is set by the setters' intent for that round, rating is measured after the
fact from who solved it, and the two disagree often enough to be worth carrying
separately.

Slot is NOT the Codeforces index. A Div1+Div2 combined round stores its Div2 C
as index A of the Div1 contest, so `codeforces-1943-a` is genuinely a Div2 C.
Reading it off the id would be wrong for exactly the problems where it matters.

Only problems named in the curated list get a slot. Bulk-sampled problems have
no honest slot to claim — a rating band says nothing about round position — and
guessing one from the index would be wrong for every combined round.

  python3 scripts/apply_contest_slot.py           # report
  python3 scripts/apply_contest_slot.py --write   # apply
"""

from __future__ import annotations

import argparse
import collections
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
CORPUS = ROOT / "data" / "problemset_llm" / "codeforces"
LADDER = ROOT / "data" / "div2_ladder.json"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--list", type=Path, default=LADDER)
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()

    slots = {p["id"]: p["slot"] for p in json.loads(args.list.read_text())["problems"]}
    changed = 0
    absent = []
    by_slot: collections.Counter[str] = collections.Counter()

    for pid, slot in sorted(slots.items()):
        path = CORPUS / f"{pid}.json"
        if not path.exists():
            absent.append(pid)
            continue
        problem: dict[str, Any] = json.loads(path.read_text())
        by_slot[slot] += 1
        if problem.get("contest_slot") == slot:
            continue
        changed += 1
        if args.write:
            ordered: dict[str, Any] = {}
            for key, value in problem.items():
                if key == "contest_slot":
                    continue
                ordered[key] = value
                if key == "difficulty":
                    ordered["contest_slot"] = slot
            ordered.setdefault("contest_slot", slot)
            path.write_text(json.dumps(ordered, indent=2, ensure_ascii=False) + "\n")

    print(f"{len(slots)} curated, {len(slots) - len(absent)} present in the corpus, {changed} to stamp")
    for slot, n in sorted(by_slot.items()):
        print(f"  {slot}: {n}")
    if absent:
        print(f"  {len(absent)} not in the corpus (never staged): {absent[:8]}")
    if not args.write:
        print("\n(dry run — pass --write to apply)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
