#!/usr/bin/env bash
# One-command corpus refresh: pull the newest LeetCode problems, annotate the
# ones we don't have, re-embed, validate, smoke the bench — then STOP so a
# human reviews the labels. This script never commits; the resulting dirty
# tree (urls + new corpus files + embeddings) IS the reviewable diff.
#
#   npm run corpus:refresh
#   npm run corpus:refresh -- --recent-count 40 --skip-bench
set -euo pipefail
cd "$(dirname "$0")/.."

RECENT_COUNT=60
SKIP_BENCH=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --recent-count) RECENT_COUNT="$2"; shift 2 ;;
    --skip-bench)   SKIP_BENCH=1; shift ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

# ── Preflight ─────────────────────────────────────────────────────────────────
DATA_PATHS=(Problems/urls.txt data/problemset_llm data/embeddings experiments/bench-latest.json)
if [[ -n "$(git status --porcelain -- "${DATA_PATHS[@]}")" ]]; then
  echo "✗ refresh needs a clean corpus tree (commit or stash first):" >&2
  git status --short -- "${DATA_PATHS[@]}" >&2
  exit 1
fi
if [[ -z "${OPENAI_API_KEY:-}" && -z "${OPEN_AI_API:-}" ]] \
   && ! grep -qE '^(OPENAI_API_KEY|OPEN_AI_API)=' .env 2>/dev/null; then
  echo "✗ OPENAI_API_KEY not found in env or .env — annotation needs it" >&2
  exit 1
fi

# ── 1. Regenerate URL blocks (Recent + Hard + Codeforces) ─────────────────────
echo "→ update url blocks (recent-count $RECENT_COUNT)"
python3 scripts/update_problem_urls.py --recent-count "$RECENT_COUNT"

# ── 2. Annotate anything new (existing records skip before any network) ───────
# Codeforces is deferred (Cloudflare blocks statement fetches), so annotation
# is scoped to the served platforms rather than mutating urls.txt.
echo "→ annotate new problems"
python3 scripts/annotate_problem_urls.py --platform leetcode --platform cses

NEW_COUNT=$(git status --porcelain -- data/problemset_llm | wc -l | tr -d ' ')
if [[ "$NEW_COUNT" == "0" ]]; then
  echo "→ no new corpus files; validating and stopping"
  npm run validate
  git checkout -- Problems/urls.txt 2>/dev/null || true
  echo "✓ corpus already fresh"
  exit 0
fi

# ── 3. Re-embed, then validate (validate hard-errors on a stale corpusHash,
#      so embed must come first) ──────────────────────────────────────────────
echo "→ re-embed corpus"
npm run embed
echo "→ validate"
VALIDATE_LOG=$(mktemp)
npm run validate | tee "$VALIDATE_LOG"

# ── 4. Bench smoke (proves dense+hybrid still boot; results are discarded) ───
if [[ "$SKIP_BENCH" == "0" ]]; then
  echo "→ bench smoke (LATENCY_REPEATS=5)"
  BEFORE=$(mktemp)
  ls experiments > "$BEFORE"
  LATENCY_REPEATS=5 node bench/run.js > /dev/null
  for f in experiments/bench-*.json; do
    grep -qx "$(basename "$f")" "$BEFORE" || rm "$f"
  done
  git checkout -- experiments/bench-latest.json
fi

# ── 5. Summary ────────────────────────────────────────────────────────────────
echo
echo "── refresh summary ──────────────────────────────────────────"
echo "new corpus files: $NEW_COUNT"
git diff --stat -- Problems/urls.txt | tail -1
grep '^warn:' "$VALIDATE_LOG" || true
echo
echo "next: review the new problems' labels in the diff, then commit"
echo "  Problems/urls.txt + data/problemset_llm + data/embeddings together."
echo "  (this script never commits)"
