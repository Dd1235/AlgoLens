# Experiment 01 — TF-IDF vs BM25, seed query set

**Date:** 2026-05-05
**Corpus:** 1185 problems (785 LeetCode + 400 CSES) loaded from `data/problemset_llm/{leetcode,cses}/`
**Query set:** 10 hand-labeled queries in [bench/queries.json](../bench/queries.json) (v1 seed)
**Latency repeats:** 50 per query per ranker
**Raw data:** [bench-latest.json](./bench-latest.json) at time of write-up

## Headline numbers

| Ranker | P@1   | P@5   | MRR   | nDCG@10 | p50 latency | p95 latency |
|--------|-------|-------|-------|---------|-------------|-------------|
| TF-IDF | 0.600 | 0.280 | 0.727 | 0.586   | 0.077 ms    | 0.249 ms    |
| BM25   | 0.700 | 0.360 | 0.825 | 0.642   | 0.081 ms    | 0.237 ms    |

BM25 wins on every quality metric. Latency is statistically indistinguishable — both rankers walk the same posting lists, the only difference is the per-term arithmetic, and at 1185 docs that's noise.

## Where BM25 actually wins (per-query diffs)

- **"binary tree level order traversal"** — BM25 nDCG@10 = 1.000, TF-IDF = 0.877. BM25 puts the close variant `vertical-order-traversal-of-a-binary-tree` at rank 2; TF-IDF buries it at rank 4 behind unrelated tree problems.
- **"union find connected components"** — BM25 P@1 = 1, TF-IDF P@1 = 0. BM25's top hit is the corpus's actual DSU-tagged problem (`count-connected-components-in-lcm-graph`); TF-IDF leads with a CSES problem (`cses-1676`) that just has more bag-of-words overlap.
- **"trie prefix word search"** — BM25 surfaces `word-search-ii` at rank 4; TF-IDF doesn't have it in the top 5 at all.
- **"topological sort course schedule"** — both rankers nail `course-schedule` at #1, but BM25's top-5 is cleaner: it gets `course-schedule-iii` in; TF-IDF doesn't.

## Where they tie

`two sum`, `monotonic stack next greater element`, `shortest path graph`, `longest increasing subsequence`, `sliding window maximum`, `knapsack coin change dp` — same P@1 on each. Differences in deeper ranks but small in nDCG terms.

## Why BM25 wins (mechanically)

Two effects, both visible in our debug output:

1. **TF saturation.** TF-IDF's score is linear in TF, so a doc that mentions a term 10 times scores ~10× a doc that mentions it once. BM25 saturates with `k1=1.5`, so the 10th occurrence contributes far less than the 1st. Long, repetitive CSES statements stop unfairly outranking short, on-topic LeetCode titles.
2. **Length normalization.** BM25 with `b=0.75` divides TF by a smoothed `dl/avgdl` ratio. CSES problems run long; without normalization they hoard every common token. With it, a tight title-level match can beat a long doc that just happens to mention the term more often.

The "union find connected components" diff is the cleanest example of (1) + (2) compounding.

## Caveats

- **n = 10.** The aggregate gap (BM25 +0.10 P@1, +0.10 MRR) is real on this set but the confidence interval is wide. Need ≥30 queries before claiming a number with a straight face.
- **Author-labeled.** I picked the relevant docs from manual eyeballing. Different reasonable judges would shift labels by ~10–20%.
- **Stopword choice matters.** This run is post-stopword fix (`two`, `one`, `all`, `any`, `more`, `most`, `same`, `only`, `other` removed from the stopword list). Pre-fix runs would show TF-IDF doing markedly worse on `"two sum"`-style queries.

## What this unlocks

- A defensible "TF-IDF → BM25" upgrade story with numbers, not vibes.
- The same harness will benchmark the upcoming **C++/gRPC scoring service** against the Node BM25 baseline on identical queries.
- Adds a measurement substrate for tuning `k1` and `b`, and for evaluating future hybrid retrieval (BM25 + dense rerank).
