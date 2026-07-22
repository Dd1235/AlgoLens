# Experiment 06 — Niche technique labels, alias normalization, corpus growth

**Date:** 2026-07-22
**Corpus:** 1198 problems (798 LeetCode + 400 CSES) — up from 1185 in exp 05
**Query set:** 52 hand-labeled queries in [bench/queries.json](../bench/queries.json) (v4 = the 42 from v3 plus 10 new *technique* queries)
**Latency repeats:** 50 per query per ranker
**Raw data:** [bench-latest.json](./bench-latest.json) at time of write-up

Three corpus-affecting changes landed between 05 and this run, so this is not a clean A/B against 05's tables:

1. **Alias normalization** — 442 files rewritten so `dp`→`dynamic-programming`, `hash-map-lookup`→`hash-map`, `priority-queue`→`heap`, etc. (16 aliases, one canonical vocabulary in [data/pattern_taxonomy.json](../data/pattern_taxonomy.json), enforced by `npm run validate`).
2. **13 new problems** (the DP-optimization batch: WQS/monotonic-queue/partition-DP mediums plus 2025 contest problems) and **19 hand-relabeled** files carrying new niche pattern slugs: `wqs-binary-search`, `slope-trick`, `monotonic-queue-optimization`, `sos-dp`, `submask-enumeration`.
3. **10 new technique queries** — half *name* the technique ("wqs binary search exactly k segments"), half *describe* it without naming it ("penalty per segment instead of enforcing the segment count").

## Why this experiment

Exp 05 established the vocabulary-gap story between BM25 and dense on generic queries. This one asks the niche-vocabulary questions:

1. **Do curated technique labels function as retrieval vocabulary?** A label like `wqs-binary-search` appears in zero problem statements — if search can't surface it, the label only exists for the UI.
2. **Does normalizing label drift help or hurt?** Merging `dp` into `dynamic-programming` consolidates postings but deletes the literal `dp` token from ~260 label slots.
3. **Which retrieval style owns niche-technique queries** — the mirror image of 05's paraphrase slice, because this time the *query* contains the rare vocabulary.

## Headline numbers (all 52 queries)

| Ranker     | P@1   | P@5   | MRR   | nDCG@10 | Recall@100 | p50 latency | p95 latency |
|------------|-------|-------|-------|---------|------------|-------------|-------------|
| TF-IDF     | 0.442 | 0.204 | 0.576 | 0.544   | 0.949      | 0.072 ms    | 0.208 ms    |
| BM25       | **0.538** | 0.262 | **0.667** | 0.612 | **0.958** | 0.075 ms   | 0.220 ms    |
| Dense      | 0.462 | 0.231 | 0.616 | 0.561   | 0.912      | 1.617 ms    | 2.106 ms    |
| Hybrid     | 0.500 | 0.262 | 0.651 | **0.623** | 0.952    | 1.728 ms    | 2.216 ms    |
| BM25 (gRPC)| **0.538** | 0.262 | **0.667** | 0.612 | **0.958** | 0.267 ms   | 0.435 ms    |

Every aggregate is lower than 05's — **that is the query set, not a regression**: the 10 technique queries are the hardest slice yet (best P@1 on it is 0.400). Same-slice comparisons below are the meaningful ones. Latency is unchanged within noise; the brute-force dense scan grew 1.1% with the corpus.

## The slice table

| Ranker | Slice      | n  | P@1   | P@5   | MRR   | nDCG@10 | Recall@100 |
|--------|------------|----|-------|-------|-------|---------|------------|
| BM25   | keyword    | 30 | **0.633** | 0.293 | **0.738** | **0.622** | 0.961 |
| Dense  | keyword    | 30 | 0.467 | 0.253 | 0.624 | 0.520   | 0.897      |
| Hybrid | keyword    | 30 | 0.500 | **0.300** | 0.665 | 0.587 | **0.967**  |
| BM25   | paraphrase | 12 | 0.500 | 0.183 | 0.638 | 0.678   | 1.000      |
| Dense  | paraphrase | 12 | **0.583** | **0.200** | **0.719** | 0.768 | 1.000 |
| Hybrid | paraphrase | 12 | **0.583** | **0.200** | 0.695 | **0.773** | 1.000  |
| BM25   | technique  | 10 | 0.300 | **0.260** | 0.491 | 0.504   | **0.900**  |
| Dense  | technique  | 10 | 0.300 | 0.200 | 0.467 | 0.434   | 0.850      |
| Hybrid | technique  | 10 | **0.400** | 0.220 | **0.554** | **0.548** | 0.850  |

05's per-slice conclusions survive the corpus growth: BM25 owns keyword, dense owns paraphrase. The new technique slice splits down the middle — and **hybrid wins it** precisely because it's a mix of both query styles.

## The technique slice, query by query

**Naming the technique → lexical wins.** The labels work: `?pattern=wqs-binary-search` filtering aside, plain BM25 puts label-bearing problems at #1–3 for "wqs binary search" (compare mode makes this a two-column demo). Dense is hopeless here — MiniLM has no representation for "wqs": on *"wqs binary search exactly k segments"* BM25's first relevant is #2 while dense's is **#48**, and the dense leg's noise even drags hybrid to #10. This is the brackets query from 05 with the roles reversed: now the *query* holds vocabulary only the labels contain.

**Describing the technique → dense/hybrid win.** On *"divide and conquer dp optimization monotonic split points"* BM25 ranks the first relevant #11 (the words are individually common); dense and hybrid both put `allocate-mailboxes` at **#1**. On *"max score path jumping at most k indexes forward"* hybrid is #1 vs BM25's #2. Fresh-corpus descriptions work too: *"buy one fruit get the next several free minimum total cost"* → `minimum-number-of-coins-for-fruits` at #1 for all three rankers.

**Both styles can fail.** *"penalty per segment instead of enforcing the segment count"* — the purest WQS description — lands **zero relevant docs in any ranker's top 100**. The technique isn't in the statements, the phrasing isn't in the labels, and MiniLM can't bridge that far. Labels only pay when the query names them; deep paraphrase of an *idea* stays open (see unlocks).

Per-query ΔRR (generated by `npm run bench:diff -- --base bm25 --cand dense --slice technique`):

| Δ RR | Query | bm25 rank | dense rank |
|------|-------|------|------|
| +0.909 | divide and conquer dp optimization monotonic split points | 11 | 1 |
| +0.250 | slope trick make array non decreasing minimum increments | 4 | 2 |
| −0.667 | monotonic queue optimization dp sliding window maximum of dp values | 1 | 3 |
| −0.479 | wqs binary search exactly k segments | 2 | 48 |
| −0.250 | max score path jumping at most k indexes forward | 2 | 4 |

## Alias normalization: mostly free, not entirely

Re-running the v3 42-query set immediately before/after the 442-file normalization (same corpus size, quality metrics only):

| Ranker | MRR | nDCG@10 | Recall@100 |
|--------|-----------|-----------|------------|
| TF-IDF | 0.633 → 0.647 | 0.581 → 0.593 | 0.937 → **0.972** |
| BM25   | 0.719 → 0.710 | 0.640 → 0.640 | 0.944 → **0.972** |
| Dense  | 0.678 → 0.687 | 0.616 → 0.625 | 0.913 → 0.925 |
| Hybrid | 0.687 → **0.708** | 0.647 → 0.659 | 0.984 → 0.976 |

Consolidating split vocabulary (`dp` + `dynamic-programming` postings becoming one) lifts lexical recall ~3 points and helps every ranker's nDCG except BM25's, which pays a small precision tax where queries leaned on the literal `dp` token (P@1 0.619 → 0.595).

One normalization backfired visibly: `sum-over-subsets` → `sos-dp` *removed* the descriptive tokens from the labels, and the query *"sum over subsets dp bitmask"* now ranks its first relevant #15 (BM25). Lesson: when the canonical form and the query vocabulary disagree, canonicalize toward the form people type — or expand aliases query-side from the same taxonomy file. Kept as-is here so the cost stays measured and visible.

## Caveats

- **n=10 on the technique slice** — directional. One query flipping #1↔#2 moves P@1 by 0.1.
- Labels and queries are the same author's judgment, and the author knows which problems carry which labels; the technique-naming queries are close to a best case for lexical.
- Aggregates are **not comparable to 05** (different corpus and query set). 05's tables remain valid for its dated 1185-doc corpus.
- The gRPC leg re-indexed the grown corpus at its own boot; quality identical to Node BM25 as always (same math, same tokens).

## What this unlocks

- **Labels are now load-bearing**: `?pattern=<slug>` filters search server-side, pattern chips in the UI drive it, and `npm run validate` gates label vocabulary + bench ids + embedding freshness in one command.
- **Compare mode is back** (`/api/compare`, UI toggle): "wqs binary search" side-by-side is the fastest demo of why the default stays BM25 and dense is a per-request opt-in.
- The *"penalty per segment"* failure is the sharpest argument yet for the roadmap cross-encoder — but note it's a **candidate-generation** failure (0 relevant in any top-100), so reranking alone won't fix it; statement enrichment or taxonomy-driven query expansion has to come first.
