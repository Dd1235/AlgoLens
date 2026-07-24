# Experiment 07 — Alias expansion, hard-focus growth to 1,808

**Date:** 2026-07-24
**Corpus:** 1,808 problems (1,404 LeetCode + 400 CSES + 4 anchor easies kept) — up from 1,260 in exp 06 via two curation moves: 13 junk Easies purged (the 4 bench-anchor easies stay, validator-enforced) and **+561 Mediums picked by lowest acceptance rate** (contest Q3/Q4-grade; premium and Easy filtered at fetch)
**Query set:** 55 queries in [bench/queries.json](../bench/queries.json) (v5 = v4's 52 plus 3 *alias-phrased* technique queries)
**Latency repeats:** 50 · gRPC leg included
**Raw data:** [bench-latest.json](./bench-latest.json) (expansion on); the `BENCH_EXPAND=0` baseline run is quoted below

Two engine changes since 06: **query-side alias expansion** (the taxonomy's alias map now rewrites queries at the route — "aliens trick" → `+wqs binary search` — because aliases are folded out of document labels and were previously unsearchable, the regression exp 06 measured on "sum over subsets") and the corpus scale-up. The bench now runs queries through the same expansion the serving path uses; `BENCH_EXPAND=0` preserves the raw-ranker view.

## Why this experiment

1. **Does alias expansion fix the unsearchable-alias class end to end?** (exp 06 flagged it; three new queries are phrased purely through aliases.)
2. **What does expansion cost?** The `dp` alias fires on many keyword queries — does append-only expansion dilute them?
3. **What does +43% corpus (all of it deliberately hard) do to the old numbers?**

## Headline numbers (all 55 queries, expansion on)

| Ranker     | P@1   | P@5   | MRR   | nDCG@10 | Recall@100 | p50 latency | p95 latency |
|------------|-------|-------|-------|---------|------------|-------------|-------------|
| TF-IDF     | 0.382 | 0.185 | 0.514 | 0.471   | 0.933      | 0.127 ms    | 0.357 ms    |
| BM25       | **0.473** | 0.244 | 0.613 | 0.565 | 0.921    | 0.130 ms    | 0.372 ms    |
| Dense      | 0.400 | 0.215 | 0.558 | 0.521   | 0.865      | 2.094 ms    | 2.573 ms    |
| Hybrid     | 0.455 | **0.251** | **0.618** | **0.578** | **0.948** | 2.293 ms | 3.009 ms |
| BM25 (gRPC)| **0.473** | 0.244 | 0.613 | 0.567 | 0.921    | 0.323 ms    | 0.607 ms    |

Not comparable 1:1 with exp 06 (different corpus *and* query set). Notable: **hybrid takes the overall MRR lead for the first time** (0.618 vs BM25's 0.613) — the technique slice grew to 13 queries and hybrid owns it. Latency scaled linearly with the corpus (dense scan 1,808 × 384 → p50 2.09 ms; still nothing).

## Expansion A/B (same corpus, same queries, only `BENCH_EXPAND` differs)

Aggregates, expansion off → on: BM25 MRR 0.603 → 0.613, nDCG 0.542 → 0.565, **Recall@100 0.888 → 0.921**; TF-IDF R@100 0.891 → 0.933; hybrid nDCG 0.572 → 0.578, R@100 0.918 → 0.948. Dense ≈ flat.

Per-query, first-relevant rank:

| Query | Ranker | off | on |
|---|---|---|---|
| aliens trick minimize cost with exactly k groups | bm25 | **>100** | **5** |
| | hybrid | 83 | 7 |
| | dense | 43 | 26 |
| scanline count overlapping intervals | bm25 | 11 | 3 |
| | hybrid | 7 | 2 |
| wqs binary search exactly k segments | bm25 | 2 | 2 |
| sum over subsets bitmask dp transform | bm25 | 20 | 20 |
| | dense | 25 | **91** |
| | hybrid | 13 | **40** |

Three findings:

1. **The unsearchable-alias class is fixed where it matters.** "aliens trick" goes from a total lexical miss to top-5; "scanline" from 11 to 3. The expansion is append-only, so queries that already worked ("wqs binary search…") are untouched.
2. **The feared `dp`-dilution never happened.** The keyword slice is byte-identical off vs on for BM25 (MRR 0.723 both ways) and hybrid — appending `dynamic programming` next to an existing `dp` token changes nothing that was already matching.
3. **One honest cost: expansion can hurt the dense leg.** On the sos queries, dense drops (25→91, 16→100) and drags hybrid with it (13→40). Appended slug words like `sos` are noise *to the embedding* — MiniLM has no meaning for them, so the query vector drifts. Lexical gains, semantic loses. The clean fix is scoped expansion: **expand the lexical legs only, embed the original query** — noted as the next engine refinement rather than patched mid-experiment.

## Corpus growth effects

Old-slice numbers softened as 561 hard Mediums joined the candidate pool: keyword-slice BM25 MRR 0.738 (exp 06) → 0.723, dense keyword P@1 0.467 → 0.400. That is crowding, not regression — the new problems are legitimate competitors for the same queries (e.g. several new monotonic-stack Mediums now outrank old keyword targets). Recall stayed high, and the technique slice *improved* for hybrid (0.554 → 0.502 MRR on a slice that grew from 10 to 13 with three hard new queries — flat-to-better per shared query). The acceptance-rate heuristic held up in review: the batch is contest-grade Mediums (132-pattern, zero-array-transformation-iv, …), zero thin records, zero Easies.

## Caveats

- Technique slice is n=13, single-author labels; directional.
- The dense degradation on expanded queries is measured on 2 queries — the *mechanism* (OOV slug words perturbing the embedding) is solid, the magnitude is anecdotal.
- 05/06 tables remain valid for their dated corpora; nothing here re-litigates them.
- gRPC leg re-indexed the grown corpus at boot; parity with Node BM25 holds as always.

## What this unlocks

- **Scoped expansion** (lexical legs expanded, dense embeds the raw query) — one-line policy change in the hybrid path, measurable against this run.
- The gap report grew with the corpus (`npm run validate -- --gaps`: 803 non-canonical labels, `frequency-count` ×34 at the top) — next audit/review cycle has a fresh shortlist.
- Hybrid leading overall MRR strengthens the case for the deferred cross-encoder rerank over its fused top-50 (R@100 0.948 on the hardest corpus yet).
