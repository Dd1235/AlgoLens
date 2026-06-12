# Experiment 05 — Dense retrieval + hybrid RRF vs BM25

**Date:** 2026-06-12
**Corpus:** 1185 problems (785 LeetCode + 400 CSES) from `data/problemset_llm/{leetcode,cses}/`
**Query set:** 42 hand-labeled queries in [bench/queries.json](../bench/queries.json) (v3 — the 30 keyword queries from v2 plus 12 new *paraphrase* queries, each tagged with a `slice`)
**Latency repeats:** 50 per query per ranker
**Raw data:** [bench-latest.json](./bench-latest.json) at time of write-up

## Why this experiment

BM25 matches tokens. Ask it *"check if brackets open and close in the right order"* and it returns problems about opening water taps — the corpus never says "brackets", it says "parentheses", and no amount of tf·idf math can bridge that vocabulary gap. That's the class of failure dense retrieval exists for.

Setup: every problem's `title + statement + tags + patterns` is embedded offline with a quantized MiniLM sentence-transformer (`Xenova/all-MiniLM-L6-v2`, 384d, q8 ONNX, running in-process in Node via transformers.js — no Python, no API). The 1185 unit vectors (1.74 MB) are committed under `data/embeddings/` so every environment scores against bit-identical doc vectors; only the query is embedded at request time. The `dense` ranker is a brute-force dot product over a contiguous `Float32Array`; `hybrid` fuses the BM25 and dense top-100 lists with reciprocal rank fusion (`score = Σ 1/(60 + rank)`).

Two questions:

1. **Does dense retrieval actually win on paraphrase queries** — and what does it give up on the keyword queries the corpus was built for? The 12 new queries are natural-language problem descriptions with deliberately low lexical overlap with their targets ("how much rainwater collects between the bars" → `trapping-rain-water`).
2. **Is rank fusion a free lunch?** RRF is the standard zero-tuning baseline; the per-slice numbers say where blending helps and where it dilutes.

## Headline numbers (all 42 queries)

| Ranker     | P@1   | P@5   | MRR   | nDCG@10 | Recall@100 | p50 latency | p95 latency |
|------------|-------|-------|-------|---------|------------|-------------|-------------|
| TF-IDF     | 0.500 | 0.229 | 0.633 | 0.581   | 0.937      | 0.063 ms    | 0.179 ms    |
| BM25       | 0.619 | 0.257 | 0.719 | 0.640   | 0.944      | 0.066 ms    | 0.195 ms    |
| Dense      | 0.548 | 0.248 | 0.678 | 0.616   | 0.913      | 1.564 ms    | 1.939 ms    |
| Hybrid     | 0.548 | **0.271** | 0.687 | **0.647** | **0.984** | 1.663 ms    | 2.046 ms    |
| BM25 (gRPC)| 0.619 | 0.257 | 0.719 | 0.640   | 0.944      | 0.260 ms    | 0.431 ms    |

No single winner — which is the finding. BM25 keeps the best MRR and P@1 overall; hybrid takes nDCG@10, P@5, and (by a wide margin) Recall@100. The slice table explains why.

## The slice table (the actual story)

| Ranker | Slice      | n  | P@1   | P@5   | MRR   | nDCG@10 | Recall@100 |
|--------|------------|----|-------|-------|-------|---------|------------|
| BM25   | keyword    | 30 | **0.667** | 0.287 | **0.751** | **0.626** | 0.922 |
| Dense  | keyword    | 30 | 0.533 | 0.273 | 0.666 | 0.549   | 0.878      |
| Hybrid | keyword    | 30 | 0.533 | **0.300** | 0.684 | 0.597 | **0.978** |
| BM25   | paraphrase | 12 | 0.500 | 0.183 | 0.638 | 0.676   | 1.000      |
| Dense  | paraphrase | 12 | **0.583** | 0.183 | **0.708** | **0.784** | 1.000 |
| Hybrid | paraphrase | 12 | **0.583** | 0.200 | 0.695 | 0.773   | 1.000      |

Each retrieval style wins its home turf:

- **Keyword queries: BM25 by a lot** (+0.134 P@1, +0.085 MRR over dense). When the query *is* the vocabulary — "fenwick tree binary indexed inversion" — exact term matching plus idf is unbeatable, and dense's soft similarity only blurs it.
- **Paraphrase queries: dense by a lot** (+0.083 P@1, +0.070 MRR, +0.108 nDCG@10 over BM25). When the query shares meaning but not words, BM25 has nothing to anchor on.

## Where dense wins biggest

Sorted by reciprocal-rank gain over BM25:

| Δ RR | Query | What's happening |
|------|-------|------------------|
| +0.987 | "check if brackets open and close in the right order" | The poster child. Corpus says "parentheses", query says "brackets". BM25's first relevant hit is at rank ~77 (RR 0.013), led astray by "open" and "order"; dense puts `valid-parentheses` at #1. |
| +0.889 | "interval scheduling greedy non-overlapping" | A *keyword* query dense wins: the relevant set is a semantic family (meeting rooms, course scheduling) that shares concept, not phrasing. |
| +0.500 | "longest stretch of characters with no repeats" | "stretch"/"no repeats" vs "substring"/"without repeating" — pure synonymy. |
| +0.500 | "count separate land regions in a grid of land and water" | "land regions" vs "islands". |
| +0.302 | "minimum number of changes to turn one word into another" | `edit-distance`, described without saying "edit" or "distance". |

## Where dense loses

| Δ RR | Query | What's happening |
|------|-------|------------------|
| +0.857 (bm25) | "union find connected components" | "union-find" is literally a pattern tag on the relevant docs. Exact vocabulary match; dense smears it across all graph-connectivity problems. |
| +0.800 (bm25) | "constrained subsequence maximum sum subarray" | Title-fragment query; BM25 anchors on the rare term "constrained". |
| +0.667 (bm25) | "cheapest way to make an amount from coin denominations" | A *paraphrase* query BM25 wins: the coin-change statement happens to contain "coin" and "amount", so the paraphrase isn't actually lexically disjoint. Paraphrase ≠ automatic dense win. |

## Hybrid: what fusion buys and what it costs

RRF with k=60 over each leg's top-100, no tuning. Three observations:

1. **Recall@100 = 0.984** — the fused candidate set contains nearly every relevant doc, vs 0.944 (BM25) / 0.913 (dense) alone. The union genuinely covers each leg's blind spots, and ≈1.0 recall at the fusion window is the empirical justification for `topN=100`. This makes hybrid the right *candidate generator* for any future second-stage reranker (cross-encoder over top-50 — the seam is already there).
2. **Best blended quality** — top nDCG@10 (0.647) and P@5 (0.271) overall, and near-dense performance on paraphrase (0.583 P@1) while staying well above dense on keyword MRR (0.684 vs 0.666).
3. **It is not a free lunch** — overall MRR (0.687) stays below pure BM25 (0.719). Rank-blending dilutes BM25's precise #1s on keyword queries: a doc BM25 nails at rank 1 but dense ranks 40th gets dragged below a doc both legs rank 5th. On the brackets query, hybrid lands RR 0.167 — better than BM25's 0.013, worse than dense's 1.0 — because BM25's noisy leg votes against the right answer. **The default ranker therefore stays `bm25`**; dense and hybrid are registered and selectable per-request (`?ranker=`).

## Latency decomposition

Dense p50 is 1.56 ms vs BM25's 0.066 ms — ~24× slower, and the cost is almost entirely the *query*, not the corpus:

| Stage | p50 (steady state) |
|-------|--------------------|
| Embed query (MiniLM q8, CPU, in-process) | 0.548 ms |
| Dot product over all 1185 × 384 vectors + full argsort | 0.824 ms |

This is the "do you need a vector database" math: the entire corpus is a 1.74 MB `Float32Array` that brute-force scans in under a millisecond. ANN indexes (HNSW & friends) buy sub-linear scan at the price of build time, memory overhead, and approximate recall — at 1185 docs (or 100× that) there is nothing to buy. The committed artifact also means boot costs 251 ms of model load and zero re-embedding; re-embedding the full corpus (`npm run embed`) takes ~4 s on a laptop.

Deploy notes: the ONNX runtime needs glibc, so the Docker base image moved from `node:20-alpine` to `node:20-bookworm-slim`, and the model (~25 MB) is baked into the image at build time (`node server/search/embedding.js --warm`) — verified by booting the container with `--network none` (dense still registers; container RSS ~101 MiB).

## Caveats

- **Single-author labels, and the paraphrase queries were written by the same person who knows the corpus.** A neutral writer would produce harder paraphrases; the dense-vs-BM25 gap on that slice is probably *understated* if anything, but the absolute numbers shouldn't be quoted past the first decimal.
- **n=12 on the paraphrase slice is small** — directional, not definitive. Standard error on P@1 at p≈0.55, n=12 is ~0.14.
- **q8 quantization** trades a little embedding fidelity for a 4× smaller model; not ablated against fp32.
- **RRF is untuned by design.** k and topN were fixed at the literature defaults *before* running the bench; tuning them on these 42 queries would just overfit the eval set.
- **Corpus vectors are frozen in the committed artifact** — bit-identical across dev/CI/prod. Query embeddings are computed live, so cross-platform float drift (~1e-6) exists in principle; rank-stable in practice.

## What this unlocks

- **"Find similar problems"** ships from the same artifact: doc-to-doc cosine over the stored vectors (`GET /api/similar/:problemId`), sync and model-free, ~1 ms.
- The explain surface now covers all three scoring styles: per-term tf·idf tables, per-doc cosine + angle for dense, and per-leg `1/(k+rank)` contributions for hybrid (`/debug.html`).
- The slice mechanism generalizes: future query sets can tag difficulty, platform, or intent and get per-slice metrics for free.
- Hybrid's 0.984 Recall@100 is the candidate-generation floor for the obvious next experiment: a cross-encoder rerank over the fused top-50.
