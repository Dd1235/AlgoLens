# Experiment 03 — Go BM25 microservice vs Node BM25, identical contract

**Date:** 2026-05-05
**Corpus:** 1185 problems (785 LeetCode + 400 CSES)
**Query set:** 10 hand-labeled queries in [bench/queries.json](../bench/queries.json) (v1 seed)
**Latency repeats:** 50 per query per ranker
**Raw data:** [bench-latest.json](./bench-latest.json) at time of write-up

## Setup

The [Go service](../go/) implements BM25 behind the same `proto/algolens.proto` Search contract that the Node `SearchIndex` interface already exposed. The Node server registers the gRPC ranker as `bm25-grpc` when `GRPC_BM25_ADDR` is set; absent that env var the wiring is dormant.

Implementations should be functionally identical:

- Same tokenizer behavior (lowercase + non-alphanumeric→space + whitespace split + stopword filter), with the same DSA-aware stopword list.
- Same BM25 params: `k1 = 1.5`, `b = 0.75`, Robertson–Spärck-Jones IDF.
- Same `problemText = title + " " + statement + " " + tags + " " + patterns`.
- Same corpus loaded in the same sorted-per-platform order.

## Headline numbers

| Ranker         | P@1   | P@5   | MRR   | nDCG@10 | p50 client | p95 client | p50 server scoring |
|----------------|-------|-------|-------|---------|------------|------------|---------------------|
| tfidf (Node)   | 0.600 | 0.280 | 0.727 | 0.586   | 0.099 ms   | 0.604 ms   | —                   |
| bm25 (Node)    | 0.700 | 0.360 | 0.825 | 0.642   | **0.087 ms** | 0.282 ms | —                   |
| bm25-grpc (Go) | 0.700 | 0.360 | 0.825 | 0.642   | 0.355 ms   | 0.971 ms   | **0.095 ms**        |

## What the parity check tells us

Go BM25 and Node BM25 produce **identical** P@1 / P@5 / MRR / nDCG@10 on the seed query set. Spot-checking the per-query top-3 by problem id and float scores: they match to 3 decimal places. That's strong evidence the two implementations agree on tokenization and scoring math; any later latency diff is genuinely about runtime, not about ranker drift.

## What the latency split tells us

- **Scoring time alone (Go server-side):** 0.095 ms p50. **Node BM25 in-process:** 0.087 ms p50. Same order of magnitude; the difference is within noise on a 10-query, 50-repeat sample.
- **End-to-end client-perceived latency over gRPC:** 0.355 ms p50, 0.971 ms p95. The ~0.26 ms gap between server-scoring and client-end-to-end is **transport overhead**: TCP loopback, HTTP/2 framing, protobuf encode + decode on each side, and the Node gRPC client's own scheduling.

So at 1185 docs, the polyglot service split *costs* about 0.3 ms in steady state — Go scoring is so cheap that the network round-trip dominates total latency.

## Honest framing

This is the result you should actually want for a learning project. The architecture wins: same contract, two interchangeable implementations, switchable via one env var. The runtime story is *not* "Go is dramatically faster than Node" — at this corpus size, both are sub-millisecond and the language barely matters. The interesting story is:

- The gRPC layer adds a fixed ~0.3 ms; that's the price of the polyglot split.
- That price is fine when scoring becomes expensive enough to dominate (bigger corpus, denser ranker, hybrid pipelines).
- It's *not* fine if you're optimizing for in-memory retrieval at this scale.

That's a defensible engineering takeaway, and it generalizes: microservice splits are about isolation, scaling, and language fit, not about per-call latency wins for already-cheap operations.

## Where it would tip

A back-of-envelope crossover: the gap closes when scoring time approaches the gRPC overhead (~0.3 ms). For BM25, scoring time scales with the size of the union of posting lists for query terms, which grows roughly linearly with corpus size for stable query distributions. So somewhere between 5,000–20,000 docs (depending on query verbosity), in-process Node and gRPC-Go would be at parity in steady-state latency. Past that, the Go service has plenty of headroom because Go's GC and goroutine concurrency hold up better under contention.

That's a back-of-envelope claim, not a measurement. A `bench/run.js` corpus-size sweep is the way to actually find the crossover; deferred until the corpus grows organically (scraper).

## Caveats

- **n = 10 queries.** Same sanity-check size as Experiment 01. Quality numbers don't change between Node and Go BM25 because they *should* be identical, but expanding to ~30 queries before quoting any of these in absolutes.
- **Single-threaded.** No concurrent QPS measurement; this is one query at a time. Goroutines vs Node's event loop under load is a different experiment.
- **Loopback only.** All traffic on `127.0.0.1`. A real cross-host deploy would add real network latency on top of the gRPC overhead.
- **Cold start excluded.** The first query through gRPC is much slower (HTTP/2 handshake + TLS-not-here + connection setup); we're measuring warm steady-state only.

## What this unlocks

- A defensible "polyglot backend" line on the resume — Node front-end plus Go scoring service, interchangeable behind one interface, with real latency numbers on identical corpus and queries.
- Bench infrastructure that scales: any future ranker (dense vector, hybrid, C++ if we revisit) plugs in via `GRPC_BM25_ADDR` (or a new env var) and gets graded against the same query set.
- Concrete numbers to point at when explaining IR/system design tradeoffs.
