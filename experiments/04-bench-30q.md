# Experiment 04 — Bench expansion: 10 → 30 queries

**Date:** 2026-05-06
**Corpus:** 1185 problems (785 LeetCode + 400 CSES) from `data/problemset_llm/{leetcode,cses}/`
**Query set:** 30 hand-labeled queries in [bench/queries.json](../bench/queries.json) (v2 — added 20 to the v1 seed)
**Latency repeats:** 50 per query per ranker
**Raw data:** [bench-latest.json](./bench-latest.json) at time of write-up

## Why this experiment

Experiment 01 reported a clean BM25 win at n=10 but flagged the obvious caveat: the gap (BM25 +0.10 P@1, +0.10 MRR) is real on that set, but the confidence interval is wide. This run triples the sample and asks two questions:

1. **Does the BM25 > TF-IDF result hold?** Or did the seed set happen to favor it?
2. **Does the bm25 / bm25-grpc parity hold?** Experiment 03 confirmed it on the 10-query set; same JSON corpus, same scoring math, but different language runtime.

## Headline numbers

| Ranker     | P@1   | P@5   | MRR   | nDCG@10 | p50 latency | p95 latency | server scoring p50 |
|------------|-------|-------|-------|---------|-------------|-------------|--------------------|
| TF-IDF     | 0.500 | 0.247 | 0.623 | 0.544   | 0.071 ms    | 0.145 ms    | —                  |
| BM25       | 0.667 | 0.287 | 0.748 | 0.626   | 0.071 ms    | 0.150 ms    | —                  |
| BM25 (gRPC)| 0.667 | 0.287 | 0.748 | 0.626   | 0.275 ms    | 0.499 ms    | 0.086 ms           |

**Both questions answered yes.** BM25 wins on every quality metric (+0.167 P@1, +0.040 P@5, +0.125 MRR, +0.082 nDCG@10), and the Go gRPC ranker reproduces the in-memory Node BM25 to three decimal places on every metric.

## How the seed and new subsets compare

|              | TF-IDF P@1 | TF-IDF MRR | BM25 P@1 | BM25 MRR |
|--------------|------------|------------|----------|----------|
| Seed 10      | 0.600      | 0.727      | 0.700    | 0.825    |
| New 20       | 0.450      | 0.571      | 0.650    | 0.710    |

The new queries are noticeably harder for both rankers, which is expected — the seed set was hand-picked to be tractable while exercising the harness. The BM25 advantage *narrows* on the new subset (+0.10 P@1 vs the seed's +0.10 P@1, but +0.139 MRR vs +0.098 — actually wider on MRR), so the improvement is not a seed-selection artifact.

## Where BM25 wins biggest (new queries)

Sorted by `nDCG@10(bm25) − nDCG@10(tfidf)`:

| Δ nDCG@10 | Query                                              | What's happening |
|-----------|----------------------------------------------------|------------------|
| +0.369    | "edit distance levenshtein two strings"            | BM25 lands `edit-distance` at #1; TF-IDF buries it because "two" and "strings" are common terms that drag many docs above. |
| +0.349    | "constrained subsequence maximum sum subarray"     | BM25 surfaces `constrained-subsequence-sum` at #1; TF-IDF leads with longer DP problems whose statements happen to contain "maximum sum". |
| +0.328    | "palindrome string pairs"                          | BM25 puts `palindrome-pairs` and `count-palindromic-subsequences` in the top 5; TF-IDF's top is dominated by long DP problems that mention "string". |
| +0.296    | "bfs jump game reachable shortest"                 | BM25 finds the `jump-game-iv`/`bus-routes` cluster; TF-IDF leans on "shortest" which over-weights long graph problems. |
| +0.269    | "directed graph cycle detection topological"       | BM25 anchors on `course-schedule` family; TF-IDF over-favors docs that mention "graph" many times. |
| +0.209    | "fenwick tree binary indexed inversion"            | BM25 finds the actual Fenwick problems; TF-IDF leans on "tree" frequency. |
| +0.206    | "merge sort inversion count smaller after self"    | BM25 surfaces `count-of-smaller-numbers-after-self` at the top. |

The pattern is consistent with experiment 01's mechanical explanation: TF-IDF's linear-in-TF score lets long, repetitive CSES/DP statements outrank short, on-topic LeetCode titles. BM25's `k1=1.5` saturation plus `b=0.75` length normalization corrects for both.

## Where BM25 loses

Two new queries flipped the other direction:

- `"two pointers container water trapping rain"` — TF-IDF wins by **+0.142 nDCG@10**. The query is essentially a bag of three problem titles smashed together; TF-IDF's higher TF reward favors docs that hit multiple terms, while BM25's TF saturation flattens the multi-hit signal.
- `"binary search on answer capacity threshold"` — TF-IDF wins by **+0.129**. "Binary search" is a high-DF term in this corpus; TF-IDF's `log(N/df)` IDF damps it more aggressively than BM25's RSJ form, which on this query happens to be the right behavior.

Two losses out of 30 is consistent with the well-known result that BM25 and TF-IDF are not strictly ordered — they're optimizing slightly different objectives, and there are query distributions where TF-IDF's flatter IDF wins. At the aggregate level the BM25 advantage is large enough that these don't move the headline.

## What changed vs experiment 01 numbers

| Metric  | n=10 (exp 01) | n=30 (exp 04) | Δ      |
|---------|---------------|----------------|--------|
| TF-IDF P@1   | 0.600         | 0.500         | −0.100 |
| BM25 P@1     | 0.700         | 0.667         | −0.033 |
| TF-IDF MRR   | 0.727         | 0.623         | −0.104 |
| BM25 MRR     | 0.825         | 0.748         | −0.077 |
| TF-IDF nDCG  | 0.586         | 0.544         | −0.042 |
| BM25 nDCG    | 0.642         | 0.626         | −0.016 |

Both rankers' numbers come down on the larger set (the new queries are harder, as designed), but BM25 degrades less. The gap on every metric is *wider* at n=30 than at n=10. The bench is now a more honest signal.

## gRPC parity at n=30

Identical to three decimals on every quality metric — same as experiment 03 reported on the 10-query set. The Go BM25 implementation tokenizes, scores, sorts, and slices identically to the Node reference. End-to-end gRPC latency adds ~200 µs of transport over in-memory (0.275 ms vs 0.071 ms p50), but server-side scoring is in the same ballpark (0.086 ms vs 0.071 ms). At a corpus of 1185 documents the wire overhead dominates; the Go side has plenty of headroom for a much larger index before scoring becomes the bottleneck.

## Caveats

- **Still author-labeled.** All relevance judgments come from the same eyeballing process as v1. A second labeler would shift individual labels but the aggregate gap is large enough that I'd expect the headline to survive.
- **n=30 is better, not great.** With 30 queries the standard error on P@1 is roughly √(p(1−p)/n) ≈ 0.09 for p=0.5, so the 0.167 BM25 advantage on P@1 is ~1.8σ — directional but not five-nines. Want n≈100 before publishing.
- **Latency conditions.** All runs on the same MacBook with no other significant load; cold-cache effects ignored after the first warm-up call per query. Numbers are not representative of cloud latency.

## What this unlocks

- The "TF-IDF → BM25" upgrade story now has 3× the evidence.
- The 30-query set is the new default for any future ranker change (dense rerank, hybrid retrieval, learned-to-rank). Adding/removing queries is the cheapest way to keep extending the test surface.
- gRPC parity at n=30 means future Go-side optimizations (concurrent scoring, SIMD-tokenization, etc.) can be evaluated against the same labeled set without worrying that a metric drop is a correctness regression.
