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
CURATED_PROBLEMS = ROOT / "data" / "problems"
CACHE_DIR = ROOT / "data" / "cache"
CODEFORCES_CACHE = CACHE_DIR / "codeforces_problemset.problems.json"
CODEFORCES_STATEMENTS = CACHE_DIR / "codeforces_statements.json"
OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions"
CODEFORCES_PROBLEMS_URL = "https://codeforces.com/api/problemset.problems"
LEETCODE_GRAPHQL_URL = "https://leetcode.com/graphql"

ANNOTATION_VERSION = "problem-patterns-v1"
SSL_CONTEXT = None
PATTERN_TAXONOMY = ROOT / "data" / "pattern_taxonomy.json"


def _load_taxonomy() -> tuple[list[str], dict[str, str]]:
    data = json.loads(PATTERN_TAXONOMY.read_text())
    return list(data["canonical"].keys()), dict(data.get("aliases", {}))


# Canonical pattern vocabulary + alias map shared with the Node validator and
# normalizer (data/pattern_taxonomy.json is the single source of truth).
CANONICAL_PATTERNS, PATTERN_ALIASES = _load_taxonomy()

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
            "patterns": ["hash-map", "complement search"],
            "pattern_confidence": {
                "hash-map": 0.98,
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
    },
    {
        "input": {
            "title": "Subtree Queries",
            "platform": "cses",
            "source_topic": "CSES / Tree Algorithms",
            "source_text": "Given a rooted tree with values on nodes, support updates to a node value and queries asking for the sum of values in a node's subtree.",
        },
        "output": {
            "statement": "Maintain node values on a rooted tree under point updates and answer subtree sum queries.",
            "tags": ["tree", "range-query", "data-structure"],
            "patterns": ["euler-tour", "tree-flattening", "fenwick-tree", "subtree-query"],
            "pattern_confidence": {
                "euler-tour": 0.97,
                "tree-flattening": 0.96,
                "fenwick-tree": 0.88,
                "subtree-query": 0.93
            }
        }
    },
    {
        "input": {
            "title": "Hamiltonian Flights",
            "platform": "cses",
            "source_topic": "CSES / Graph Algorithms",
            "source_text": "Count routes from city 1 to city n that visit every city exactly once in a directed graph.",
        },
        "output": {
            "statement": "Count directed paths from the first city to the last city that visit every city exactly once.",
            "tags": ["graph", "dynamic-programming", "bitmask"],
            "patterns": ["bitmask-dp", "hamiltonian-dp", "state-compression"],
            "pattern_confidence": {
                "bitmask-dp": 0.98,
                "hamiltonian-dp": 0.96,
                "state-compression": 0.9
            }
        }
    },
    {
        "input": {
            "title": "Sum of Subarray Minimums",
            "platform": "leetcode",
            "source_tags": ["array", "stack", "monotonic-stack"],
            "source_text": "Given an array, return the sum of the minimum value of every contiguous subarray.",
        },
        "output": {
            "statement": "For every contiguous subarray, add its minimum value and return the total.",
            "tags": ["array", "stack"],
            "patterns": ["monotonic-stack", "contribution-technique", "nearest-smaller-element"],
            "pattern_confidence": {
                "monotonic-stack": 0.97,
                "contribution-technique": 0.95,
                "nearest-smaller-element": 0.92
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


def request_json(
    url: str,
    payload: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    timeout: int = 60,
) -> Any:
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
    with urlopen(req, timeout=timeout, context=SSL_CONTEXT) as res:
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
    if "atcoder.jp" in host:
        return "atcoder"
    return host.replace("www.", "")


def base_from_url(item: UrlItem, cf_cache: dict[tuple[int, str], dict[str, Any]]) -> dict[str, Any]:
    platform_from_source = platform_from_url(item.url)
    if platform_from_source == "codeforces":
        base = codeforces_metadata(item, cf_cache)
        # The hand-written seeds in data/problems/ predate both the staged
        # dataset and the current id scheme, so they are a statement fallback
        # and nothing more. Letting them supply the id resurrected
        # cf-510c-fox-and-names on a re-run and failed validation.
        if not base.get("source_text"):
            curated = curated_problem_by_url(item.url)
            if curated:
                base["source_text"] = curated.get("statement", "")
                base["source_tags"] = base["source_tags"] or curated.get("source_tags") or curated.get("tags", [])
                base["title"] = base["title"] or curated.get("title") or item.url
                if base.get("rating") is None:
                    base["rating"] = base["difficulty"] = curated.get("rating")
        return base

    platform = platform_from_source
    if platform == "leetcode":
        return leetcode_metadata(item)
    if platform == "codeforces":
        return codeforces_metadata(item, cf_cache)
    if platform == "cses":
        return cses_metadata(item)
    if platform == "atcoder":
        return atcoder_metadata(item)
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


def curated_problem_by_url(url: str) -> dict[str, Any] | None:
    if not CURATED_PROBLEMS.exists():
        return None
    for path in CURATED_PROBLEMS.glob("*.json"):
        try:
            data = json.loads(path.read_text())
        except json.JSONDecodeError:
            continue
        if data.get("source_url") == url:
            return data
    return None


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
    if CODEFORCES_CACHE.exists():
        data = json.loads(CODEFORCES_CACHE.read_text())
    else:
        data = request_json(CODEFORCES_PROBLEMS_URL, timeout=120)
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        CODEFORCES_CACHE.write_text(json.dumps(data, ensure_ascii=False) + "\n")
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
    pid = f"codeforces-{contest_id}-{str(index).lower()}"

    # codeforces.com answers scripts with a Cloudflare challenge, so statements
    # come from the staged open dataset (scripts/fetch_codeforces.py). Official
    # tags and rating ride along with it.
    staged = {}
    if CODEFORCES_STATEMENTS.exists():
        staged = json.loads(CODEFORCES_STATEMENTS.read_text()).get(pid, {})

    title = staged.get("title") or (p.get("name") if p else f"{contest_id}{index}")
    tags = staged.get("tags") or (p.get("tags", []) if p else [])
    rating = staged.get("rating") or (p.get("rating") if p else None)
    return {
        "id": pid,
        "title": title,
        "slug": slugify(f"{contest_id}-{index}-{title}"),
        "platform": "codeforces",
        "source_url": item.url,
        "source_topic": item.source_topic,
        "difficulty": rating,
        "rating": rating,
        "source_tags": tags,
        "source_text": staged.get("statement", ""),
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


def atcoder_task_id(url: str) -> str | None:
    m = re.search(r"/tasks/([A-Za-z0-9_]+)", url)
    return m.group(1).lower() if m else None


def atcoder_metadata(item: UrlItem) -> dict[str, Any]:
    task = atcoder_task_id(item.url) or slugify(item.url)
    contest = re.search(r"/contests/([A-Za-z0-9_-]+)", item.url)
    title = task
    source_text = ""
    try:
        page = request_text(item.url + "?lang=en")
        m = re.search(r"<title>(.*?)</title>", page, re.S | re.I)
        if m:
            # AtCoder titles read "D - Pond"; keep the name, drop the index.
            raw = html_to_text(m.group(1)).strip()
            raw = re.sub(r"\s*[-|]\s*AtCoder.*$", "", raw).strip()
            part = re.match(r"^[A-Za-z]\d?\s+-\s+(.+)$", raw)
            title = (part.group(1) if part else raw) or task
        # English statement lives in a span with lang-en; fall back to the page
        en = re.search(r'<span class="lang-en">(.*?)</span>\s*</div>', page, re.S)
        source_text = trim_problem_page_text(en.group(1) if en else page)
    except (HTTPError, URLError, TimeoutError):
        pass
    return {
        "id": f"atcoder-{task.replace('_', '-')}",
        "title": title,
        "slug": task.replace("_", "-"),
        "platform": "atcoder",
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


def has_usable_source_text(base: dict[str, Any]) -> bool:
    text = (base.get("source_text") or "").strip()
    if len(text) < 40:
        return False
    blocked_markers = [
        "just a moment",
        "enable javascript and cookies",
        "cloudflare",
        "attention required",
    ]
    lowered = text.lower()
    return not any(marker in lowered for marker in blocked_markers)


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
            "tags must be lowercase strings such as array, graph, dynamic-programming, string, geometry, tree, math.",
            "patterns must be lowercase algorithmic techniques or concise searchable phrases.",
            "Use advanced patterns when applicable: contribution-technique, euler-tour, tree-flattening, bitmask-dp, heavy-light-decomposition, dsu-rollback, convex-hull-trick, wqs-binary-search, slope-trick, line-sweep, max-flow, two-sat, suffix-automaton, etc.",
            "Prefer the most discriminative technique over generic labels. For example, use contribution-technique with monotonic-stack instead of only array/stack.",
            "Do not force advanced patterns when the statement does not justify them.",
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
        # Placeholders, not sample values. Real slugs here leak: when this field
        # read ["binary-search-answer", "prefix-sum"], the model emitted
        # binary-search-answer first on 66% of the Codeforces batch and scored
        # 45% precision against Codeforces' own binary-search tag.
        "output_schema": {
            "statement": "<1-3 sentence original summary>",
            "tags": ["<broad domain or data structure>", "..."],
            "patterns": ["<algorithmic technique slug>", "..."],
            "pattern_confidence": {"<same slugs as patterns>": "<number 0-1>"},
        },
    }
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": json.dumps(user, ensure_ascii=False)},
    ]


def call_openai(base: dict[str, Any], model: str) -> dict[str, Any]:
    key = os.environ.get("OPENAI_API_KEY") or os.environ.get("OPEN_AI_API")
    if not key:
        raise RuntimeError("OPENAI_API_KEY or OPEN_AI_API is required unless --no-llm is used")
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
        "patterns": with_families(clean_list(parsed.get("patterns", []), 12), 12),
        "pattern_confidence": clean_confidence(parsed.get("pattern_confidence", {})),
    }


def canonical_label(raw: str) -> str:
    slug = slugify(raw)
    return PATTERN_ALIASES.get(slug, slug)


# A specific label implies its family. The model is encouraged to invent precise
# searchable phrases ("dp-with-multiple-resources", "bitmask-dp"), and those are
# more useful than a bare "dynamic-programming" — but a search for "dynamic
# programming" has to still find the problem. Without this, a correctly
# annotated DP problem was invisible to the most obvious query for it.
#
# Same lesson as the umbrella groups in the taxonomy: the specific name and the
# family name are both real queries, and only one of them was being indexed.
FAMILY_PATTERNS: list[tuple[Any, str]] = [
    (re.compile(r"(^|-)dp($|-)|dynamic-programming|memoi[sz]ation"), "dynamic-programming"),
    (re.compile(r"(^|-)bfs($|-)|breadth-first"), "bfs"),
    (re.compile(r"(^|-)dfs($|-)|depth-first"), "dfs"),
    (re.compile(r"binary-search"), "binary-search"),
    (re.compile(r"(^|-)(segment-tree|fenwick-tree)($|-)"), "segment-tree"),
    (re.compile(r"two-pointer"), "two-pointers"),
]


def with_families(labels: list[str], limit: int) -> list[str]:
    """Append the canonical family for any specific label that implies one."""
    out = list(labels)
    have = set(out)
    for label in labels:
        for pattern, family in FAMILY_PATTERNS:
            if family in have or not pattern.search(label):
                continue
            if len(out) >= limit:
                return out
            out.append(family)
            have.add(family)
    return out


def clean_list(value: Any, limit: int) -> list[str]:
    if not isinstance(value, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in value:
        text = canonical_label(str(item))
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
        pattern = canonical_label(str(key))
        if not pattern:
            continue
        try:
            score = float(raw_score)
        except (TypeError, ValueError):
            continue
        # Aliases can collapse two keys onto one canonical label; keep the max.
        out[pattern] = max(out.get(pattern, 0.0), max(0.0, min(1.0, score)))
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


def predicted_output_path(out_dir: Path, item: UrlItem) -> Path | None:
    # Predicts output_path() from the URL alone (no fetch, no LLM) so existing
    # records can be skipped before any network spend. Mirrors the id
    # construction in leetcode_metadata / cses_metadata / codeforces_metadata;
    # curated overrides can diverge, so the post-build exists check stays as a
    # safety net.
    platform = platform_from_url(item.url)
    if platform == "leetcode":
        m = re.search(r"/problems/([^/]+)/?", item.url)
        return out_dir / platform / f"leetcode-{m.group(1)}.json" if m else None
    if platform == "cses":
        m = re.search(r"/task/(\d+)", item.url)
        return out_dir / platform / f"cses-{m.group(1)}.json" if m else None
    if platform == "codeforces":
        key = codeforces_problem_key(item.url)
        if key:
            return out_dir / platform / f"codeforces-{key[0]}-{str(key[1]).lower()}.json"
    if platform == "atcoder":
        task = atcoder_task_id(item.url)
        if task:
            return out_dir / platform / f"atcoder-{task.replace('_', '-')}.json"
    return None


def display_path(path: Path) -> str:
    resolved = path.resolve()
    try:
        return str(resolved.relative_to(ROOT))
    except ValueError:
        return str(path)


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
    ap.add_argument(
        "--platform",
        action="append",
        choices=["leetcode", "codeforces", "cses"],
        help="Filter URLs by platform. Can be repeated.",
    )
    ap.add_argument(
        "--allow-metadata-only",
        action="store_true",
        help="Allow LLM annotation when no usable problem statement was fetched",
    )
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
    if not args.out.is_absolute():
        args.out = ROOT / args.out

    items = read_url_items(args.urls)
    if args.platform:
        platforms = set(args.platform)
        items = [item for item in items if platform_from_url(item.url) in platforms]
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
    needs_cf_api = any(
        platform_from_url(i.url) == "codeforces" and curated_problem_by_url(i.url) is None
        for i in items
    )
    if needs_cf_api:
        try:
            cf_cache = load_codeforces_cache()
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
            print(f"warning: Codeforces API unavailable: {exc}", file=sys.stderr)

    args.out.mkdir(parents=True, exist_ok=True)
    written = 0
    skipped = 0
    for i, item in enumerate(items, start=1):
        try:
            # Skip before any network call — a full urls.txt run must be cheap.
            if not args.overwrite:
                predicted = predicted_output_path(args.out, item)
                if predicted is not None and predicted.exists():
                    skipped += 1
                    continue
            base = base_from_url(item, cf_cache)
            annotation = {"statement": "", "tags": [], "patterns": []}
            if not args.no_llm:
                if not args.allow_metadata_only and not has_usable_source_text(base):
                    raise RuntimeError("missing usable source_text; skipping to avoid metadata-only annotation")
                annotation = call_openai(base, args.model)
            record = build_record(base, annotation, None if args.no_llm else args.model)
            path = output_path(args.out, record)
            if path.exists() and not args.overwrite:
                print(f"skip existing {path.relative_to(ROOT)}")
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n")
            written += 1
            print(f"[{i}/{len(items)}] wrote {display_path(path)}")
        except Exception as exc:  # keep long batch runs moving
            print(f"[{i}/{len(items)}] failed {item.url}: {exc}", file=sys.stderr)
    print(f"done: wrote {written} records, skipped {skipped} existing")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
