#!/usr/bin/env python3
"""
Fetch and merge generated URL groups into Problems/urls.txt.

Generated blocks are idempotent:
  - LeetCode / Hard uses the LeetCode GraphQL problem list.
  - Codeforces / Rated 1600-1900 uses Codeforces problemset.problems.

The script treats existing non-generated URLs as hand-curated and will not add
duplicate URLs inside generated blocks.

Usage:
  python3 scripts/update_problem_urls.py
"""

from __future__ import annotations

import argparse
import json
import re
import ssl
import sys
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_URLS = ROOT / "Problems" / "urls.txt"
LEETCODE_GRAPHQL_URL = "https://leetcode.com/graphql"
CODEFORCES_PROBLEMS_URL = "https://codeforces.com/api/problemset.problems"

LC_BLOCK = "LeetCode Hard"
CF_BLOCK = "Codeforces Rated 1600-1900"
SSL_CONTEXT = None


def request_json(url: str, payload: dict[str, Any] | None = None) -> Any:
    body = json.dumps(payload).encode("utf8") if payload is not None else None
    req = Request(
        url,
        data=body,
        headers={
            "content-type": "application/json",
            "user-agent": "AlgoLens URL seed updater",
        },
    )
    with urlopen(req, timeout=60, context=SSL_CONTEXT) as res:
        return json.loads(res.read().decode("utf8"))


def remove_generated_block(text: str, name: str) -> str:
    pattern = re.compile(
        rf"\n?# BEGIN GENERATED: {re.escape(name)}\n.*?# END GENERATED: {re.escape(name)}\n?",
        re.S,
    )
    return pattern.sub("\n", text)


def strip_generated_blocks(text: str) -> str:
    text = remove_generated_block(text, LC_BLOCK)
    text = remove_generated_block(text, CF_BLOCK)
    return normalize_blank_lines(text)


def normalize_blank_lines(text: str) -> str:
    lines: list[str] = []
    previous_blank = False
    for raw in text.splitlines():
        if raw.strip() == "":
            if not previous_blank:
                lines.append("")
            previous_blank = True
            continue
        lines.append(raw.rstrip())
        previous_blank = False
    while lines and lines[-1] == "":
        lines.pop()
    return "\n".join(lines) + "\n"


def existing_urls(text: str) -> set[str]:
    return {
        line.strip()
        for line in text.splitlines()
        if line.strip().startswith(("http://", "https://"))
    }


def fetch_leetcode_hard_urls() -> list[str]:
    query = """
    query problemsetQuestionList($limit: Int, $skip: Int, $filters: QuestionFilterInput) {
      problemsetQuestionListV2(limit: $limit, skip: $skip, filters: $filters) {
        totalLength
        hasMore
        questions {
          titleSlug
          difficulty
        }
      }
    }
    """
    urls: list[str] = []
    total: int | None = None
    skip = 0
    limit = 100

    while total is None or skip < total:
        data = request_json(
            LEETCODE_GRAPHQL_URL,
            {
                "query": query,
                "variables": {
                    "skip": skip,
                    "limit": limit,
                    "filters": {
                        "filterCombineType": "ALL",
                        "difficultyFilter": {
                            "difficulties": ["HARD"],
                            "operator": "IS",
                        },
                    },
                },
            },
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
            if slug and q.get("difficulty") == "HARD":
                urls.append(f"https://leetcode.com/problems/{slug}/")
        skip += limit

    return sorted(set(urls))


def fetch_codeforces_rated_urls(min_rating: int, max_rating: int) -> dict[int, list[str]]:
    data = request_json(CODEFORCES_PROBLEMS_URL)
    if data.get("status") != "OK":
        raise RuntimeError(data)

    grouped: dict[int, list[str]] = {}
    for p in (data.get("result") or {}).get("problems", []):
        rating = p.get("rating")
        contest_id = p.get("contestId")
        index = p.get("index")
        if not isinstance(rating, int) or contest_id is None or not index:
            continue
        if min_rating <= rating <= max_rating:
            grouped.setdefault(rating, []).append(
                f"https://codeforces.com/problemset/problem/{contest_id}/{index}"
            )

    return {rating: sorted(set(urls)) for rating, urls in sorted(grouped.items())}


def make_leetcode_block(urls: list[str], already_present: set[str]) -> tuple[str, int, int]:
    added = [u for u in urls if u not in already_present]
    lines = [
        f"# BEGIN GENERATED: {LC_BLOCK}",
        "# LeetCode / Hard (generated)",
        f"# Total hard URLs discovered: {len(urls)}",
        f"# URLs already present elsewhere: {len(urls) - len(added)}",
    ]
    lines.extend(added)
    lines.append(f"# END GENERATED: {LC_BLOCK}")
    return "\n".join(lines) + "\n", len(added), len(urls)


def make_codeforces_block(grouped: dict[int, list[str]], already_present: set[str]) -> tuple[str, int, int]:
    total = sum(len(urls) for urls in grouped.values())
    added_count = 0
    lines = [
        f"# BEGIN GENERATED: {CF_BLOCK}",
        "# Codeforces / Rated 1600-1900 (generated)",
        f"# Total rated URLs discovered: {total}",
    ]
    for rating, urls in grouped.items():
        added = [u for u in urls if u not in already_present]
        added_count += len(added)
        lines.append("")
        lines.append(f"# Codeforces / Rated {rating}")
        lines.extend(added)
    lines.append(f"# END GENERATED: {CF_BLOCK}")
    return "\n".join(lines) + "\n", added_count, total


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--urls", type=Path, default=DEFAULT_URLS)
    ap.add_argument("--min-rating", type=int, default=1600)
    ap.add_argument("--max-rating", type=int, default=1900)
    ap.add_argument("--skip-leetcode", action="store_true")
    ap.add_argument("--skip-codeforces", action="store_true")
    ap.add_argument(
        "--insecure-ssl",
        action="store_true",
        help="Disable TLS certificate verification for local dataset fetching",
    )
    args = ap.parse_args()

    global SSL_CONTEXT
    if args.insecure_ssl:
        SSL_CONTEXT = ssl._create_unverified_context()

    base_text = strip_generated_blocks(args.urls.read_text())
    present = existing_urls(base_text)
    blocks: list[str] = []

    if not args.skip_leetcode:
        lc_urls = fetch_leetcode_hard_urls()
        block, added, total = make_leetcode_block(lc_urls, present)
        blocks.append(block)
        present.update(lc_urls)
        print(f"LeetCode Hard: discovered {total}, generated added {added}")

    if not args.skip_codeforces:
        cf_grouped = fetch_codeforces_rated_urls(args.min_rating, args.max_rating)
        block, added, total = make_codeforces_block(cf_grouped, present)
        blocks.append(block)
        print(f"Codeforces {args.min_rating}-{args.max_rating}: discovered {total}, generated added {added}")

    next_text = normalize_blank_lines(base_text + "\n" + "\n".join(blocks))
    args.urls.write_text(next_text)
    print(f"updated {args.urls}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (HTTPError, URLError, TimeoutError) as exc:
        print(f"network error: {exc}", file=sys.stderr)
        raise SystemExit(1)
