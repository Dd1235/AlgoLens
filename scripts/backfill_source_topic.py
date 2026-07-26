#!/usr/bin/env python3
"""
Fill in source_topic on Codeforces records ingested before the stager grouped
its URL file by rating band.

source_topic is the annotator's record of where a problem came from, and the
validator warns when it's blank. A bulk-sampled Codeforces problem has no
curated topic, so the honest answer is its rating band; problems that came from
formwise.xlsx get the sheet tab instead, which is strictly better information.

Idempotent — records that already carry a topic are left alone.

  python3 scripts/backfill_source_topic.py
  python3 scripts/backfill_source_topic.py --write
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CORPUS = ROOT / "data" / "problemset_llm" / "codeforces"
STAGED = ROOT / "data" / "cache" / "codeforces_statements.json"
LABELS = ROOT / "data" / "cache" / "formwise_labels.json"
BANDS = [(1300, 1500), (1600, 1900), (2000, 2400), (2500, 3500)]


def band_for(rating: int) -> str:
    for lo, hi in BANDS:
        if lo <= rating <= hi:
            return f"Codeforces / rating {lo}-{hi}"
    return "Codeforces / unrated"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()

    staged = json.loads(STAGED.read_text()) if STAGED.exists() else {}
    sheet = json.loads(LABELS.read_text()) if LABELS.exists() else {}

    filled = skipped = unknown = 0
    for path in sorted(CORPUS.glob("*.json")):
        problem = json.loads(path.read_text())
        if problem.get("source_topic"):
            skipped += 1
            continue
        pid = problem["id"]
        if pid in sheet:
            topic = f"Formwise / {sheet[pid]['topic']}"
        else:
            rating = problem.get("difficulty") or (staged.get(pid) or {}).get("rating")
            if not isinstance(rating, int):
                unknown += 1
                continue
            topic = band_for(rating)
        problem["source_topic"] = topic
        filled += 1
        if args.write:
            path.write_text(json.dumps(problem, indent=2, ensure_ascii=False) + "\n")

    verb = "set" if args.write else "would set"
    print(f"{verb} source_topic on {filled} record(s); {skipped} already had one, {unknown} unresolvable")
    if args.write and filled:
        print("corpus text changed — run: npm run embed && npm run validate")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
