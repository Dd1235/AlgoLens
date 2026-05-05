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
- **Latency** (each query repeated 50× per run, all samples pooled per ranker):
  - p50_ms, p95_ms, mean_ms

## What's NOT measured (yet)

- Multi-grade relevance (everything is 0/1)
- Cross-evaluator labels — the query set is one author's judgment
- Cold-start build time at the per-doc level
- Concurrent QPS (single-threaded loop, no contention)

These are deliberately deferred until the corpus + query set scale up.

## Caveats for any current numbers

The seed query set has **10 queries**. That's enough to sanity-check the harness and spot ranker-level differences, but every aggregate metric has a wide confidence interval at this size. Treat published numbers as directional until the query set reaches ~30+.
