#!/usr/bin/env python3
"""
Build AlgoLens problem JSON from Problems/urls.txt.

The URL file is the source of truth for source_url and source_topic. The LLM is
used only for normalized summaries, tags, and algorithmic patterns.

Examples:
  python3 scripts/annotate_problem_urls.py --limit 5 --no-llm
  OPENAI_API_KEY=... OPENAI_MODEL=gpt-4.1-mini \
    python3 scripts/annotate_problem_urls.py --limit 20
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import ssl
import sys
import time
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_URLS = ROOT / "Problems" / "urls.txt"
DEFAULT_OUT = ROOT / "data" / "problemset_llm"
OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions"
CODEFORCES_PROBLEMS_URL = "https://codeforces.com/api/problemset.problems"
LEETCODE_GRAPHQL_URL = "https://leetcode.com/graphql"

ANNOTATION_VERSION = "problem-patterns-v1"
SSL_CONTEXT = None

CANONICAL_PATTERNS = [
    "two-pointers",
    "sliding-window",
    "prefix-sum",
    "difference-array",
    "binary-search",
    "binary-search-answer",
    "sorting",
    "greedy",
    "heap",
    "stack",
    "monotonic-stack",
    "queue",
    "hash-map lookup",
    "dfs",
    "bfs",
    "flood-fill",
    "union-find",
    "topological-sort",
    "cycle-detection",
    "shortest-path",
    "dijkstra",
    "bellman-ford",
    "floyd-warshall",
    "minimum-spanning-tree",
    "strongly-connected-components",
    "max-flow",
    "bipartite-matching",
    "tree-dp",
    "rerooting-dp",
    "digit-dp",
    "bitmask-dp",
    "interval-dp",
    "knapsack",
    "longest-increasing-subsequence",
    "segment-tree",
    "fenwick-tree",
    "lazy-propagation",
    "sparse-table",
    "binary-lifting",
    "lca",
    "euler-tour",
    "trie",
    "kmp",
    "z-function",
    "rolling-hash",
    "suffix-array",
    "line-sweep",
    "coordinate-compression",
    "geometry",
    "combinatorics",
    "number-theory",
    "modular-arithmetic",
    "game-theory",
    "meet-in-the-middle",
]

PROMPT_EXAMPLES = [
    {
        "input": {
            "title": "Two Sum",
            "platform": "leetcode",
            "source_tags": ["array", "hash-table"],
            "source_text": "Given an array of integers and a target, find two distinct indices whose values add up to the target.",
        },
        "output": {
            "statement": "Given an array and a target value, find two distinct positions whose values sum to the target.",
            "tags": ["array", "hash-map"],
            "patterns": ["hash-map lookup", "complement search"],
            "pattern_confidence": {
                "hash-map lookup": 0.98,
                "complement search": 0.96
            }
        }
    },
    {
        "input": {
            "title": "Course Schedule",
            "platform": "leetcode",
            "source_tags": ["graph", "topological-sort", "depth-first-search"],
            "source_text": "Given prerequisite pairs between courses, decide if all courses can be finished.",
        },
        "output": {
            "statement": "Given directed prerequisite constraints between courses, determine whether every course can be completed without violating dependencies.",
            "tags": ["graph", "dfs", "bfs"],
            "patterns": ["topological-sort", "cycle-detection", "directed graph"],
            "pattern_confidence": {
                "topological-sort": 0.95,
                "cycle-detection": 0.93,
                "directed graph": 0.9
            }
        }
    },
    {
        "input": {
            "title": "Books",
            "platform": "codeforces",
            "rating": 1600,
            "source_tags": ["binary search", "two pointers"],
            "source_text": "Given reading times in order and a time limit, maximize how many consecutive books can be read.",
        },
        "output": {
            "statement": "Given ordered book reading times and a total time budget, find the longest contiguous block that fits within the budget.",
            "tags": ["array", "two-pointers", "prefix-sum"],
            "patterns": ["sliding-window", "two-pointers", "longest subarray under sum limit"],
            "pattern_confidence": {
                "sliding-window": 0.96,
                "two-pointers": 0.92,
                "longest subarray under sum limit": 0.9
            }
        }
    }
]


@dataclass(frozen=True)
class UrlItem:
    url: str
    source_topic: str | None


class TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
        self.skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style"}:
            self.skip_depth += 1
        if tag in {"p", "br", "li", "h1", "h2", "h3", "div"}:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style"} and self.skip_depth:
            self.skip_depth -= 1
        if tag in {"p", "li", "h1", "h2", "h3", "div"}:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self.skip_depth:
            self.parts.append(data)

    def text(self) -> str:
        raw = html.unescape(" ".join(self.parts))
        return re.sub(r"\s+", " ", raw).strip()


def request_json(url: str, payload: dict[str, Any] | None = None, headers: dict[str, str] | None = None) -> Any:
    body = json.dumps(payload).encode("utf8") if payload is not None else None
    req = Request(
        url,
        data=body,
        headers={
            "content-type": "application/json",
            "user-agent": "AlgoLens dataset builder",
            **(headers or {}),
        },
    )
    with urlopen(req, timeout=30, context=SSL_CONTEXT) as res:
        return json.loads(res.read().decode("utf8"))


def request_text(url: str) -> str:
    req = Request(url, headers={"user-agent": "AlgoLens dataset builder"})
    with urlopen(req, timeout=30, context=SSL_CONTEXT) as res:
        return res.read().decode("utf8", errors="replace")


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def slugify(s: str) -> str:
    s = s.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return re.sub(r"-+", "-", s).strip("-")


def read_url_items(path: Path) -> list[UrlItem]:
    items: list[UrlItem] = []
    topic: str | None = None
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#"):
            heading = line.lstrip("#").strip()
            if "/" in heading and not heading.lower().startswith(("algolens", "comments", "format", "the ")):
                topic = heading
            continue
        items.append(UrlItem(url=line, source_topic=topic))
    return items


def platform_from_url(url: str) -> str:
    host = urlparse(url).netloc.lower()
    if "leetcode.com" in host:
        return "leetcode"
    if "codeforces.com" in host:
        return "codeforces"
    if "cses.fi" in host:
        return "cses"
    return host.replace("www.", "")


def base_from_url(item: UrlItem, cf_cache: dict[tuple[int, str], dict[str, Any]]) -> dict[str, Any]:
    platform = platform_from_url(item.url)
    if platform == "leetcode":
        return leetcode_metadata(item)
    if platform == "codeforces":
        return codeforces_metadata(item, cf_cache)
    if platform == "cses":
        return cses_metadata(item)
    title = urlparse(item.url).path.strip("/").split("/")[-1] or item.url
    return {
        "id": slugify(f"{platform}-{title}"),
        "title": title.replace("-", " ").title(),
        "slug": slugify(title),
        "platform": platform,
        "source_url": item.url,
        "source_topic": item.source_topic,
        "difficulty": None,
        "rating": None,
        "source_tags": [],
        "source_text": "",
    }


def leetcode_metadata(item: UrlItem) -> dict[str, Any]:
    slug_match = re.search(r"/problems/([^/]+)/?", item.url)
    slug = slug_match.group(1) if slug_match else slugify(item.url)
    fallback_title = slug.replace("-", " ").title()
    payload = {
        "query": """
        query questionData($titleSlug: String!) {
          question(titleSlug: $titleSlug) {
            questionId
            title
            titleSlug
            difficulty
            content
            topicTags { name slug }
          }
        }
        """,
        "variables": {"titleSlug": slug},
    }
    try:
        data = request_json(LEETCODE_GRAPHQL_URL, payload)
        q = (data.get("data") or {}).get("question") or {}
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError):
        q = {}

    content = q.get("content") or ""
    source_text = html_to_text(content) if content else ""
    tags = [t.get("slug") or slugify(t.get("name", "")) for t in q.get("topicTags", []) if t.get("name")]
    title = q.get("title") or fallback_title
    return {
        "id": f"leetcode-{slug}",
        "title": title,
        "slug": slug,
        "platform": "leetcode",
        "source_url": item.url,
        "source_topic": item.source_topic,
        "difficulty": q.get("difficulty"),
        "rating": None,
        "source_tags": tags,
        "source_text": source_text,
    }


def codeforces_problem_key(url: str) -> tuple[int, str] | None:
    m = re.search(r"/problemset/problem/(\d+)/([A-Za-z0-9]+)", url)
    if not m:
        return None
    return int(m.group(1)), m.group(2)


def load_codeforces_cache() -> dict[tuple[int, str], dict[str, Any]]:
    data = request_json(CODEFORCES_PROBLEMS_URL)
    problems = (data.get("result") or {}).get("problems") or []
    cache: dict[tuple[int, str], dict[str, Any]] = {}
    for p in problems:
        contest_id = p.get("contestId")
        index = p.get("index")
        if contest_id is not None and index:
            cache[(int(contest_id), str(index))] = p
    return cache


def codeforces_metadata(item: UrlItem, cf_cache: dict[tuple[int, str], dict[str, Any]]) -> dict[str, Any]:
    key = codeforces_problem_key(item.url)
    p = cf_cache.get(key) if key else None
    contest_id, index = key if key else (None, None)
    title = p.get("name") if p else f"{contest_id}{index}"
    slug = slugify(f"{contest_id}-{index}-{title}")
    source_text = ""
    try:
        page = request_text(item.url)
        source_text = trim_problem_page_text(page)
    except (HTTPError, URLError, TimeoutError):
        pass
    return {
        "id": f"codeforces-{contest_id}-{str(index).lower()}",
        "title": title,
        "slug": slug,
        "platform": "codeforces",
        "source_url": item.url,
        "source_topic": item.source_topic,
        "difficulty": p.get("rating") if p else None,
        "rating": p.get("rating") if p else None,
        "source_tags": p.get("tags", []) if p else [],
        "source_text": source_text,
    }


def cses_metadata(item: UrlItem) -> dict[str, Any]:
    task_id = re.search(r"/task/(\d+)", item.url)
    task = task_id.group(1) if task_id else slugify(item.url)
    title = f"CSES {task}"
    source_text = ""
    try:
        page = request_text(item.url)
        title_match = re.search(r"<h1>(.*?)</h1>", page, re.S | re.I)
        if title_match:
            title = html_to_text(title_match.group(1))
        source_text = trim_problem_page_text(page)
    except (HTTPError, URLError, TimeoutError):
        pass
    return {
        "id": f"cses-{task}",
        "title": title,
        "slug": slugify(title),
        "platform": "cses",
        "source_url": item.url,
        "source_topic": item.source_topic,
        "difficulty": None,
        "rating": None,
        "source_tags": [],
        "source_text": source_text,
    }


def html_to_text(markup: str) -> str:
    parser = TextExtractor()
    parser.feed(markup)
    return parser.text()


def trim_problem_page_text(markup: str) -> str:
    text = html_to_text(markup)
    markers = ["Input", "Output", "Constraints", "Example"]
    for marker in markers:
        text = text.replace(f" # {marker} ", f" {marker}: ")
    return text[:6000]


def annotation_prompt(base: dict[str, Any]) -> list[dict[str, str]]:
    system = (
        "You annotate competitive programming problems for pattern-based search. "
        "Return valid JSON only. Do not solve the problem. Do not include similar_to. "
        "Do not invent source_url, platform, difficulty, or rating; those are provided by the caller. "
        "Write a concise original statement summary, not a copied full statement. "
        "Tags should be broad domains/data structures. Patterns should be algorithmic techniques. "
        "Prefer canonical hyphenated names where they fit, but include a specific phrase when it improves retrieval. "
        "Prefer 3-7 tags and 3-7 patterns. "
        "If the input is too thin to identify a subtle pattern, use source tags and title conservatively with lower confidence."
    )
    user = {
        "task": "Generate normalized tags and patterns for this problem.",
        "rules": [
            "Output JSON with exactly: statement, tags, patterns, pattern_confidence.",
            "tags must be lowercase strings such as array, graph, dp, string, geometry, tree, math.",
            "patterns must be lowercase algorithmic techniques or concise searchable phrases.",
            "pattern_confidence must map every pattern string to a number from 0 to 1.",
            "Do not output source_url, platform, difficulty, rating, or similar_to.",
            "Do not include full copied problem text.",
        ],
        "allowed_pattern_examples": CANONICAL_PATTERNS,
        "examples": PROMPT_EXAMPLES,
        "input": {
            "title": base["title"],
            "platform": base["platform"],
            "source_topic": base.get("source_topic"),
            "source_tags": base.get("source_tags", []),
            "difficulty": base.get("difficulty"),
            "rating": base.get("rating"),
            "source_text": base.get("source_text", ""),
        },
        "output_schema": {
            "statement": "1-3 sentence original summary",
            "tags": ["array", "graph", "dp"],
            "patterns": ["binary-search-answer", "prefix-sum"],
            "pattern_confidence": {"binary-search-answer": 0.92, "prefix-sum": 0.84},
        },
    }
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": json.dumps(user, ensure_ascii=False)},
    ]


def call_openai(base: dict[str, Any], model: str) -> dict[str, Any]:
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        raise RuntimeError("OPENAI_API_KEY is required unless --no-llm is used")
    payload = {
        "model": model,
        "messages": annotation_prompt(base),
        "temperature": 0.1,
        "response_format": {"type": "json_object"},
    }
    data = request_json(
        OPENAI_CHAT_COMPLETIONS_URL,
        payload,
        headers={"authorization": f"Bearer {key}"},
    )
    content = data["choices"][0]["message"]["content"]
    parsed = json.loads(content)
    if "similar_to" in parsed:
        parsed.pop("similar_to", None)
    return {
        "statement": str(parsed.get("statement", "")).strip(),
        "tags": clean_list(parsed.get("tags", []), 12),
        "patterns": clean_list(parsed.get("patterns", []), 12),
        "pattern_confidence": clean_confidence(parsed.get("pattern_confidence", {})),
    }


def clean_list(value: Any, limit: int) -> list[str]:
    if not isinstance(value, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in value:
        text = slugify(str(item))
        if text and text not in seen:
            seen.add(text)
            out.append(text)
        if len(out) >= limit:
            break
    return out


def clean_confidence(value: Any) -> dict[str, float]:
    if not isinstance(value, dict):
        return {}
    out: dict[str, float] = {}
    for key, raw_score in value.items():
        pattern = slugify(str(key))
        if not pattern:
            continue
        try:
            score = float(raw_score)
        except (TypeError, ValueError):
            continue
        out[pattern] = max(0.0, min(1.0, score))
    return out


def build_record(base: dict[str, Any], annotation: dict[str, Any], model: str | None) -> dict[str, Any]:
    record = {
        "id": base["id"],
        "title": base["title"],
        "slug": base["slug"],
        "platform": base["platform"],
        "source_url": base["source_url"],
        "source_topic": base.get("source_topic"),
        "difficulty": base.get("difficulty"),
        "rating": base.get("rating"),
        "source_tags": base.get("source_tags", []),
        "statement": annotation.get("statement") or fallback_summary(base),
        "tags": annotation.get("tags", []),
        "patterns": annotation.get("patterns", []),
        "annotation": {
            "version": ANNOTATION_VERSION,
            "model": model,
            "generated_at_unix": int(time.time()),
            "pattern_confidence": annotation.get("pattern_confidence", {}),
        },
    }
    return {k: v for k, v in record.items() if v is not None}


def fallback_summary(base: dict[str, Any]) -> str:
    text = base.get("source_text", "")
    if text:
        return text[:500]
    topic = base.get("source_topic") or base["platform"]
    return f"{base['title']} from {topic}."


def output_path(out_dir: Path, record: dict[str, Any]) -> Path:
    return out_dir / record["platform"] / f"{record['id']}.json"


def main() -> int:
    load_env_file(ROOT / ".env")

    ap = argparse.ArgumentParser()
    ap.add_argument("--urls", type=Path, default=DEFAULT_URLS)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--model", default=os.environ.get("OPENAI_MODEL", "gpt-4.1-mini"))
    ap.add_argument("--limit", type=int)
    ap.add_argument("--offset", type=int, default=0)
    ap.add_argument("--no-llm", action="store_true", help="Write metadata-only records without OpenAI calls")
    ap.add_argument("--overwrite", action="store_true")
    ap.add_argument("--sample-one-per-platform", action="store_true", help="Select first leetcode, codeforces, and cses URL")
    ap.add_argument(
        "--insecure-ssl",
        action="store_true",
        help="Disable TLS certificate verification for local dataset fetching",
    )
    args = ap.parse_args()

    global SSL_CONTEXT
    if args.insecure_ssl:
        SSL_CONTEXT = ssl._create_unverified_context()

    items = read_url_items(args.urls)
    if args.sample_one_per_platform:
        selected: list[UrlItem] = []
        seen_platforms: set[str] = set()
        for item in items:
            platform = platform_from_url(item.url)
            if platform in {"leetcode", "codeforces", "cses"} and platform not in seen_platforms:
                selected.append(item)
                seen_platforms.add(platform)
            if len(seen_platforms) == 3:
                break
        items = selected
    if args.offset:
        items = items[args.offset :]
    if args.limit is not None:
        items = items[: args.limit]

    cf_cache: dict[tuple[int, str], dict[str, Any]] = {}
    if any(platform_from_url(i.url) == "codeforces" for i in items):
        try:
            cf_cache = load_codeforces_cache()
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
            print(f"warning: Codeforces API unavailable: {exc}", file=sys.stderr)

    args.out.mkdir(parents=True, exist_ok=True)
    written = 0
    for i, item in enumerate(items, start=1):
        try:
            base = base_from_url(item, cf_cache)
            annotation = {"statement": "", "tags": [], "patterns": []}
            if not args.no_llm:
                annotation = call_openai(base, args.model)
            record = build_record(base, annotation, None if args.no_llm else args.model)
            path = output_path(args.out, record)
            if path.exists() and not args.overwrite:
                print(f"skip existing {path.relative_to(ROOT)}")
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n")
            written += 1
            print(f"[{i}/{len(items)}] wrote {path.relative_to(ROOT)}")
        except Exception as exc:  # keep long batch runs moving
            print(f"[{i}/{len(items)}] failed {item.url}: {exc}", file=sys.stderr)
    print(f"done: wrote {written} records")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
