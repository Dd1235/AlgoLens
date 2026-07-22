#!/usr/bin/env python3
"""
LLM audit for MISSING well-known named algorithms on served problems.

Writes candidates to data/review_queue/<problem-id>.json for HUMAN review —
nothing touches the corpus until scripts/apply_review.js --write merges what
the reviewer left in the queue (deleting a candidate = rejecting it).

The run must be scoped (--ids / --limit / --all) because every audited problem
is one LLM call; the whole corpus is ~1,200 calls.

Examples:
  python3 scripts/audit_patterns.py --ids cses-1110 --ids leetcode-shortest-palindrome
  python3 scripts/audit_patterns.py --platform cses --limit 40
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from annotate_problem_urls import (  # noqa: E402
    CANONICAL_PATTERNS,
    OPENAI_CHAT_COMPLETIONS_URL,
    ROOT,
    canonical_label,
    load_env_file,
    request_json,
)
import annotate_problem_urls as annotate  # noqa: E402  (for the API key lookup)

CORPUS_ROOT = ROOT / "data" / "problemset_llm"
DEFAULT_OUT = ROOT / "data" / "review_queue"
SERVED_PLATFORMS = ["leetcode", "cses"]

AUDIT_SYSTEM = (
    "You audit competitive programming problems for MISSING well-known NAMED "
    "algorithms or techniques. Given a problem's title, statement summary, and "
    "current pattern labels, name specific named algorithms that solve the "
    "problem or are central to its intended solution and are absent from the "
    "current labels (examples of the kind of name wanted: booth-algorithm, "
    "lyndon-factorization, z-function, kmp-automaton, wqs-binary-search, "
    "slope-trick, kirchhoff-theorem). "
    "STRICT rules: prefer an EMPTY list over speculation; never restate a "
    "label the problem already has; only name a technique you are confident "
    "is genuinely applicable; each candidate needs a confidence from 0 to 1 "
    "and a one-line reasoning. "
    'Return JSON only: {"candidates": [{"pattern": "slug", "confidence": 0.9, '
    '"reasoning": "..."}]} — pattern must be a lowercase hyphenated slug.'
)


def iter_problems(platforms: list[str]) -> list[dict[str, Any]]:
    out = []
    for platform in platforms:
        directory = CORPUS_ROOT / platform
        if not directory.exists():
            continue
        for path in sorted(directory.glob("*.json")):
            out.append(json.loads(path.read_text()))
    return out


def call_audit(problem: dict[str, Any], model: str) -> list[dict[str, Any]]:
    key = annotate.os.environ.get("OPENAI_API_KEY") or annotate.os.environ.get("OPEN_AI_API")
    if not key:
        raise RuntimeError("OPENAI_API_KEY or OPEN_AI_API is required")
    user = {
        "title": problem["title"],
        "platform": problem["platform"],
        "statement": problem.get("statement", ""),
        "current_patterns": problem.get("patterns", []),
        "canonical_patterns": CANONICAL_PATTERNS,
    }
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": AUDIT_SYSTEM},
            {"role": "user", "content": json.dumps(user, ensure_ascii=False)},
        ],
        "temperature": 0.1,
        "response_format": {"type": "json_object"},
    }
    data = request_json(OPENAI_CHAT_COMPLETIONS_URL, payload, headers={"authorization": f"Bearer {key}"})
    parsed = json.loads(data["choices"][0]["message"]["content"])

    existing = {canonical_label(p) for p in problem.get("patterns", [])}
    canonical_set = set(CANONICAL_PATTERNS)
    candidates = []
    for c in parsed.get("candidates", []) or []:
        pattern = canonical_label(str(c.get("pattern", "")))
        if not pattern or pattern in existing:
            continue
        try:
            confidence = max(0.0, min(1.0, float(c.get("confidence", 0))))
        except (TypeError, ValueError):
            confidence = 0.0
        candidates.append(
            {
                "pattern": pattern,
                "confidence": confidence,
                "reasoning": str(c.get("reasoning", "")).strip(),
                "in_taxonomy": pattern in canonical_set,
            }
        )
    return candidates


def main() -> int:
    load_env_file(ROOT / ".env")
    ap = argparse.ArgumentParser()
    ap.add_argument("--platform", action="append", choices=SERVED_PLATFORMS)
    ap.add_argument("--ids", action="append", help="Audit specific problem ids. Can be repeated.")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--offset", type=int, default=0)
    ap.add_argument("--difficulty", action="append", choices=["Easy", "Medium", "Hard"])
    ap.add_argument("--model", default=annotate.os.environ.get("OPENAI_MODEL", "gpt-4.1-mini"))
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--overwrite", action="store_true")
    ap.add_argument("--all", action="store_true", help="Audit the whole selection without --ids/--limit")
    args = ap.parse_args()

    if not args.ids and args.limit is None and not args.all:
        print(
            "scope the run (--ids / --limit N / --all): every audited problem is one "
            "LLM call, and the full corpus is ~1,200 calls on gpt-4.1-mini",
            file=sys.stderr,
        )
        return 2

    problems = iter_problems(args.platform or SERVED_PLATFORMS)
    if args.ids:
        wanted = set(args.ids)
        problems = [p for p in problems if p["id"] in wanted]
        missing = wanted - {p["id"] for p in problems}
        for m in sorted(missing):
            print(f"warning: id not in served corpus: {m}", file=sys.stderr)
    if args.difficulty:
        allowed = set(args.difficulty)
        problems = [p for p in problems if p.get("difficulty") in allowed]
    if args.offset:
        problems = problems[args.offset :]
    if args.limit is not None:
        problems = problems[: args.limit]

    args.out.mkdir(parents=True, exist_ok=True)
    written = 0
    skipped = 0
    found = 0
    for i, problem in enumerate(problems, start=1):
        queue_path = args.out / f"{problem['id']}.json"
        if queue_path.exists() and not args.overwrite:
            skipped += 1
            continue
        try:
            candidates = call_audit(problem, args.model)
        except Exception as exc:  # keep the batch moving
            print(f"[{i}/{len(problems)}] failed {problem['id']}: {exc}", file=sys.stderr)
            continue
        record = {
            "id": problem["id"],
            "title": problem["title"],
            "current_patterns": problem.get("patterns", []),
            "candidates": candidates,
            "model": args.model,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        queue_path.write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n")
        written += 1
        found += len(candidates)
        tag = ", ".join(c["pattern"] for c in candidates) or "nothing"
        print(f"[{i}/{len(problems)}] {problem['id']}: {tag}")
    print(f"done: audited {written}, skipped {skipped} already-queued, {found} candidate label(s)")
    print(f"review {args.out.relative_to(ROOT)}/ (delete candidates you reject), then: node scripts/apply_review.js")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
