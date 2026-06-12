# Experiments

This directory holds **all numerical results** from AlgoLens benchmarks. Code lives in [bench/](../bench/); only outputs and write-ups belong here.

## Layout

- `bench-<timestamp>.json` — raw output from one run of `node bench/run.js`
- `bench-latest.json` — most recent run (overwritten each time, for quick `cat` / `jq`)
- `<topic>.md` — narrative write-ups summarizing what the numbers show

## Reproducing

```sh
node bench/run.js
```

Writes one timestamped JSON + overwrites `bench-latest.json`. No other side effects.

## What's measured

- **Quality** (binary relevance, against hand-labeled `bench/queries.json`):
  - **P@1** — is the top hit relevant?
  - **P@5** — fraction of top-5 that are relevant
  - **MRR** — mean reciprocal rank of the first relevant hit
  - **nDCG@10** — discounted cumulative gain over top-10, normalized by ideal ordering
  - **Recall@100** — fraction of relevant docs in the top-100 (justifies the hybrid ranker's top-100 fusion window)
- **Per-slice breakdowns** — every query carries a `slice` tag (`keyword` | `paraphrase`); aggregates are reported overall and per slice, which is where the dense-vs-lexical story lives (see [05](./05-dense-hybrid-rrf.md))
- **Latency** (each query repeated 50× per run — `LATENCY_REPEATS=5` env for quick iterations — all samples pooled per ranker):
  - p50_ms, p95_ms, mean_ms

## What's NOT measured (yet)

- Multi-grade relevance (everything is 0/1)
- Cross-evaluator labels — the query set is one author's judgment
- Cold-start build time at the per-doc level
- Concurrent QPS (single-threaded loop, no contention)

These are deliberately deferred until the corpus + query set scale up.

## Caveats for any current numbers

The query set is **42 queries** (30 keyword + 12 paraphrase), all one author's judgment. Aggregate metrics are solid enough for ranker-level comparisons; per-slice numbers (especially the 12-query paraphrase slice) are directional. Treat sub-0.05 metric differences as noise.
