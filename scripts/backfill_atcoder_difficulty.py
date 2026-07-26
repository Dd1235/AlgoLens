#!/usr/bin/env python3
"""
Give AtCoder records a difficulty.

AtCoder publishes no difficulty of its own — the community standard is
kenkoooo's IRT-estimated rating (`problem-models.json`), the same number the
AtCoder Problems site colours its tables by. Records get it as a plain integer
so it sorts and filters next to a Codeforces rating.

Problems below --min-rating are reported, not deleted: some arrive from the
curated sheet, where a human already decided they were worth solving.

  python3 scripts/backfill_atcoder_difficulty.py
  python3 scripts/backfill_atcoder_difficulty.py --write
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
CORPUS = ROOT / "data" / "problemset_llm" / "atcoder"
CACHE = ROOT / "data" / "cache" / "atcoder_models.json"
MODELS_URL = "https://kenkoooo.com/atcoder/resources/problem-models.json"


def load_models(refresh: bool) -> dict:
    if CACHE.exists() and not refresh:
        return json.loads(CACHE.read_text())
    req = Request(MODELS_URL, headers={"user-agent": "cosine corpus builder"})
    with urlopen(req, timeout=90) as res:
        models = json.loads(res.read().decode("utf8"))
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_text(json.dumps(models, ensure_ascii=False) + "\n")
    return models


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--refresh", action="store_true", help="re-fetch the model file")
    ap.add_argument("--min-rating", type=int, default=1300)
    args = ap.parse_args()

    models = load_models(args.refresh)
    # Corpus ids hyphenate the underscore in AtCoder task ids (validator slug rule).
    by_id = {k.replace("_", "-"): v for k, v in models.items()}

    filled = below = unknown = 0
    low: list[tuple[str, int]] = []
    for path in sorted(CORPUS.glob("atcoder-*.json")):
        problem = json.loads(path.read_text())
        model = by_id.get(problem["id"].removeprefix("atcoder-"))
        rating = model.get("difficulty") if model else None
        if not isinstance(rating, (int, float)):
            unknown += 1
            continue
        rating = int(round(rating))
        if rating < args.min_rating:
            below += 1
            low.append((problem["id"], rating))
        if str(problem.get("difficulty") or "") == str(rating):
            continue
        problem["difficulty"] = rating
        filled += 1
        if args.write:
            path.write_text(json.dumps(problem, indent=2, ensure_ascii=False) + "\n")

    verb = "set" if args.write else "would set"
    print(f"{verb} difficulty on {filled} atcoder record(s); {unknown} have no model")
    print(f"  {below} below {args.min_rating} (kept — most came from the curated sheet)")
    for pid, r in sorted(low, key=lambda kv: kv[1])[:10]:
        print(f"    {pid} {r}")
    if args.write and filled:
        print("corpus text changed — run: npm run embed && npm run validate")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
