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
# Every judge the server actually loads (server/data.js DEFAULT_PLATFORMS).
# This used to read ["leetcode", "cses"] and was also the argparse `choices`,
# so the 741 Codeforces and AtCoder records could not be audited at all — not
# even by explicit --ids, since iter_problems filtered them back out.
SERVED_PLATFORMS = ["leetcode", "cses", "codeforces", "atcoder"]

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


# Open-ended discovery is good at niche NAMED algorithms and bad at broad
# techniques: asked "what's missing?", the model reaches for booth-algorithm,
# never line-sweep. So --technique swaps in a single yes/no question about one
# label. That is the only way to close a gap like sweep-line, where the term
# appears in 0 of 2,575 statements and the label is the sole carrier.
# The yes-criterion has to describe the technique being ASKED about. This was a
# single hardcoded sweep-line sentence, which meant `--technique sparse-table`
# asked the model whether the problem "sorts events or endpoints" — so every
# gap other than sweep-line was unclosable with this tool. Criteria are per
# technique now; anything not listed falls back to a generic phrasing.
#
# The line-sweep wording is unchanged and should stay that way: it was tuned
# against a hand-labeled probe (6/8, all 3 true sweeps caught, 2 false
# positives) and a stricter earlier version scored 0 false positives but missed
# a genuine sweep. Since every candidate lands in a queue a human reads, a false
# positive costs one deletion and a false negative is invisible forever.
# Measure changes against that probe before shipping them.
CRITERIA = {
    "line-sweep":
        "a strong solution actually sorts events or endpoints and processes them in order "
        "while maintaining running state. A greedy that merely sorts is not.",
    "sqrt-decomposition":
        "a strong solution splits the data into roughly sqrt(n) blocks and answers each query "
        "by combining whole blocks plus a partial remainder. Offline query reordering is "
        "Mo's algorithm, not this; a segment tree or Fenwick solution is not this.",
    "sparse-table":
        "a strong solution precomputes power-of-two ranges over a STATIC array to answer "
        "idempotent range queries (min, max, gcd) in constant time. If the array is updated "
        "between queries, the answer is no.",
    "bridges":
        "a strong solution must find edges whose removal disconnects the graph, typically via "
        "DFS low-link times. Merely being a connectivity problem is not enough.",
    "prim":
        "a strong solution builds a minimum spanning tree by repeatedly attaching the cheapest "
        "edge leaving the built set. Kruskal via sorting and DSU is a different label.",
    "rabin-karp":
        "a strong solution uses a rolling polynomial hash to locate or compare substrings. "
        "KMP or Z-function solutions are different labels.",
    "chinese-remainder-theorem":
        "a strong solution combines congruences with different moduli into one. Plain modular "
        "arithmetic is not enough.",
    "li-chao-tree":
        "a strong solution maintains a set of lines or segments and queries the min/max at a "
        "point, using a Li Chao tree specifically rather than a monotonic convex hull trick.",
    "rotating-calipers":
        "a strong solution walks antipodal pairs around a convex hull, for example to find the "
        "diameter or widest gap.",
    "profile-dp":
        "a strong solution does dp over a broken profile or column mask, cell by cell, typically "
        "for tiling or grid packing.",
    "branch-and-bound":
        "a strong solution searches exhaustively but prunes whole subtrees using a bound on the "
        "best achievable answer. Plain backtracking without a bound is not this.",
    "rectangle-union-area":
        "a strong solution computes the area or perimeter of a union of axis-aligned rectangles.",
    "tin-tout-ancestor-check":
        "a strong solution uses DFS entry and exit times to answer 'is u an ancestor of v' in "
        "constant time.",
    "persistent-segment-tree":
        "a strong solution keeps earlier VERSIONS of a segment tree queryable, for example to "
        "answer k-th order statistics on a range.",
    "convex-hull-trick":
        "a strong solution speeds up a dp recurrence by maintaining a lower or upper hull of "
        "lines and querying the optimum at a point.",
    "sos-dp":
        "a strong solution aggregates over all subsets or supersets of each mask, dimension by "
        "dimension (sum over subsets / zeta transform).",
    "monotonic-queue-optimization":
        "a strong solution speeds up a dp recurrence whose transition is a min or max over a "
        "SLIDING WINDOW of previous states, by maintaining a monotonic deque. Using a deque as "
        "a plain data structure is not this; the deque must be optimising a dp transition.",
    "mo-algorithm":
        "a strong solution answers range queries OFFLINE by sorting them into blocks and moving "
        "two pointers between consecutive queries.",
}

GENERIC_CRITERION = (
    "a strong solution genuinely relies on this technique as the central idea, not merely that "
    "the statement mentions related words."
)


# Two different questions, and the distinction is the whole reason sparse-table
# and sqrt-decomposition stayed at zero problems through a full audit.
#
# CENTRALITY (default) asks "is this THE intended solution?" — right for a named
# algorithm like Manacher or Dinic, where using it is the point of the problem.
#
# APPLICABILITY asks "is this a standard, correct way to solve it?" — right for
# techniques that are alternative IMPLEMENTATIONS rather than distinct problem
# types. Sqrt decomposition and sparse tables are never "the intended solution"
# because a segment tree also works, so centrality answers no every single time
# and the label can never be earned. That is a property of the question, not of
# the corpus.
def technique_system(technique: str, applicability: bool = False) -> str:
    criterion = CRITERIA.get(technique, GENERIC_CRITERION)
    if applicability:
        return (
            f"You decide ONE question: is '{technique}' a standard and correct way to solve "
            "this competitive programming problem, whether or not it is the most common "
            f"choice? Answer yes only if {criterion} "
            "Answer no if it would be the wrong tool or would not meet the constraints. "
            'Return JSON only: {"applies": true|false, "confidence": 0.0-1.0, '
            '"reasoning": "one line"}'
        )
    return (
        f"You decide ONE question: is '{technique}' genuinely central to the "
        "intended solution of this competitive programming problem? "
        f"Answer yes only if {criterion} "
        "Prefer NO when uncertain. "
        'Return JSON only: {"applies": true|false, "confidence": 0.0-1.0, '
        '"reasoning": "one line"}'
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


def call_audit(problem: dict[str, Any], model: str, technique: str | None = None,
               applicability: bool = False) -> list[dict[str, Any]]:
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
    if technique:
        # Asking "is it a sweep?" while showing the labels it already has makes
        # the model defend them: Iron Man (CF 704E) flips from YES 0.90 to no
        # 0.90 purely because "event-simulation" is in the payload, and it
        # answers "this is simulation, not a sweep". The whole point of an audit
        # is to find what the current labels miss, so it must not see them.
        # Deduping against existing labels still happens below, in code.
        user = {k: v for k, v in user.items() if k not in ("current_patterns", "canonical_patterns")}
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": technique_system(technique, applicability) if technique else AUDIT_SYSTEM},
            {"role": "user", "content": json.dumps(user, ensure_ascii=False)},
        ],
        "temperature": 0.1,
        "response_format": {"type": "json_object"},
    }
    data = request_json(OPENAI_CHAT_COMPLETIONS_URL, payload, headers={"authorization": f"Bearer {key}"})
    parsed = json.loads(data["choices"][0]["message"]["content"])
    if technique:
        # Normalize the yes/no answer into the same candidate shape the rest of
        # the pipeline (and apply_review.js) already understands.
        parsed = {
            "candidates": [{
                "pattern": technique,
                "confidence": parsed.get("confidence", 0),
                "reasoning": parsed.get("reasoning", ""),
            }] if parsed.get("applies") else []
        }

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
    ap.add_argument("--technique", help="Ask only whether this one label applies, instead of open discovery")
    ap.add_argument("--ids-file", type=Path, help="File of problem ids, one per line (composes with --ids)")
    ap.add_argument("--applicability", action="store_true",
                    help="Ask whether the technique WOULD work, not whether it is the intended solution")
    args = ap.parse_args()

    if not args.ids and not args.ids_file and args.limit is None and not args.all:
        print(
            "scope the run (--ids / --limit N / --all): every audited problem is one "
            "LLM call, and the full corpus is ~1,200 calls on gpt-4.1-mini",
            file=sys.stderr,
        )
        return 2

    problems = iter_problems(args.platform or SERVED_PLATFORMS)
    ids = list(args.ids or [])
    if args.ids_file:
        ids += [ln.strip() for ln in args.ids_file.read_text().splitlines() if ln.strip()]
    if ids:
        wanted = set(ids)
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
            candidates = call_audit(problem, args.model, args.technique, args.applicability)
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
        # Only queue problems that actually produced a candidate. Writing a file
        # per audited problem buried the handful worth reading under hundreds of
        # empty ones, and the queue is a human worklist — its length should mean
        # "this much to review".
        if candidates:
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
