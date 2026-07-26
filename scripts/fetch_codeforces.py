#!/usr/bin/env python3
"""
Stage Codeforces problems for annotation.

Codeforces' own pages sit behind Cloudflare (403 for any script), so statements
come from the public `open-r1/codeforces` dataset via HuggingFace's
datasets-server — full statement, official tags, and rating, no auth needed.
Output is a cache file the annotator reads instead of scraping.

  python3 scripts/fetch_codeforces.py --min-rating 1300 --count 400
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "data" / "cache" / "codeforces_statements.json"
ROWS_URL = (
    "https://datasets-server.huggingface.co/rows"
    "?dataset=open-r1%2Fcodeforces&config=default&split=train&offset={offset}&length={length}"
)
# Rating bands so the batch isn't all 1300s (the band with the most problems).
BANDS = [(1300, 1500), (1600, 1900), (2000, 2400), (2500, 3500)]


def get_json(url: str, tries: int = 3) -> dict:
    for attempt in range(tries):
        try:
            req = Request(url, headers={"user-agent": "cosine corpus builder"})
            with urlopen(req, timeout=60) as res:
                return json.loads(res.read().decode("utf8"))
        except (HTTPError, URLError, TimeoutError) as exc:
            if attempt == tries - 1:
                raise
            time.sleep(2 * (attempt + 1))
            print(f"  retry {attempt + 1}: {exc}", file=sys.stderr)
    return {}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-rating", type=int, default=1300)
    ap.add_argument("--count", type=int, default=400)
    ap.add_argument("--page", type=int, default=100)
    args = ap.parse_args()

    first = get_json(ROWS_URL.format(offset=0, length=1))
    total = int(first.get("num_rows_total") or 0)
    print(f"dataset rows: {total}")

    pool: list[dict] = []
    for offset in range(0, total, args.page):
        data = get_json(ROWS_URL.format(offset=offset, length=args.page))
        for entry in data.get("rows", []):
            r = entry.get("row") or {}
            rating = r.get("rating")
            statement = (r.get("description") or "").strip()
            if not isinstance(rating, int) or rating < args.min_rating or len(statement) < 80:
                continue
            contest, index = r.get("contest_id"), (r.get("index") or "")
            if not contest or not index:
                continue
            pool.append({
                "id": f"codeforces-{contest}-{str(index).lower()}",
                "contest_id": contest,
                "index": index,
                "title": r.get("title") or f"{contest}{index}",
                "rating": rating,
                "tags": r.get("tags") or [],
                "statement": statement[:6000],
                "url": f"https://codeforces.com/problemset/problem/{contest}/{index}",
            })
        if offset % (args.page * 10) == 0:
            print(f"  scanned {offset + args.page}/{total}, kept {len(pool)}")

    # Anything the curated sheet asked for is staged regardless of the sample —
    # those problems are already chosen by a human.
    wanted: set[str] = set()
    labels_path = ROOT / "data" / "cache" / "formwise_labels.json"
    if labels_path.exists():
        wanted = {k for k in json.loads(labels_path.read_text()) if k.startswith("codeforces-")}
    curated = [p for p in pool if p["id"] in wanted]
    print(f"  curated from formwise: {len(curated)}/{len(wanted)} found in the dataset")

    # Even split across bands; deterministic order so reruns are reproducible.
    random.seed(7)
    per_band = max(1, args.count // len(BANDS))
    picked: list[dict] = []
    for lo, hi in BANDS:
        band = sorted([p for p in pool if lo <= p["rating"] <= hi], key=lambda p: p["id"])
        random.shuffle(band)
        picked.extend(band[:per_band])
        print(f"  band {lo}-{hi}: {len(band)} available, took {min(per_band, len(band))}")
    picked = picked[: args.count]
    have = {p["id"] for p in picked}
    picked.extend(p for p in curated if p["id"] not in have)

    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_text(json.dumps({p["id"]: p for p in picked}, ensure_ascii=False, indent=1) + "\n")
    print(f"staged {len(picked)} codeforces problems -> {CACHE.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
