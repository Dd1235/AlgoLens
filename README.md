# AlgoLens

A search and retrieval system for DSA problems with a polyglot Node + Go service split, built to evolve from a classical IR baseline into a multi-stage hybrid retriever.

> **Why it exists.** Existing platforms search by tags or problem text, both of which miss the thing that actually matters when practicing — _the underlying solution pattern_. AlgoLens starts as a serious keyword search engine over 1,185 problems and extends toward pattern-similarity retrieval; today the same BM25 contract is implemented in both Node (in-process) and Go (over gRPC) and graded head-to-head on identical queries.

---

## Headline numbers

Measured on a 1,185-problem corpus (785 LeetCode + 400 CSES) against a hand-labeled query set. Full methodology and per-query results in [experiments/](experiments/).

| Ranker          | P@1       | P@5       | MRR       | nDCG@10   | p50 client   | p95 client | p50 scoring  |
| --------------- | --------- | --------- | --------- | --------- | ------------ | ---------- | ------------ |
| TF-IDF (Node)   | 0.600     | 0.280     | 0.727     | 0.586     | 0.099 ms     | 0.604 ms   | —            |
| **BM25 (Node)** | **0.700** | **0.360** | **0.825** | **0.642** | **0.087 ms** | 0.282 ms   | —            |
| BM25 (Go, gRPC) | 0.700     | 0.360     | 0.825     | 0.642     | 0.355 ms     | 0.971 ms   | **0.095 ms** |

→ BM25 lifts MRR by **+13.5 %** and nDCG@10 by **+9.6 %** over TF-IDF.
→ Go BM25 over gRPC matches Node BM25 on every quality metric (parity check passes); pure scoring time is essentially equal (0.095 vs 0.087 ms), and the ~0.27 ms gap on client-perceived latency is gRPC transport overhead — the price of the polyglot split at this corpus size.

Build time: Go BM25 index in **6 ms**, Node BM25 index in **17 ms**, corpus loaded from disk in **~340 ms** (Node) / **~26 ms** (Go).

> All quality numbers come from a 10-query seed set — directional, not yet publication-grade. Expanding to 30+ labeled queries is the next benchmarking task.

---

## Summary

- Built a search engine over **1,185 DSA problems** (LeetCode + CSES); from-scratch implementations of **TF-IDF** and **BM25** (Robertson–Spärck-Jones IDF, term saturation `k1=1.5`, length normalization `b=0.75`) sharing a single inverted-index data layer.
- Designed a **`SearchIndex` interface boundary** so ranking implementations are interchangeable; HTTP routes are unaware of whether the ranker is in-process JS or a remote gRPC service.
- Implemented a **Go BM25 microservice** behind a `proto/algolens.proto` gRPC contract, drop-in compatible with the in-process Node ranker. Verified bit-exact ranking parity with Node BM25 across the labeled query set; quantified gRPC transport overhead at ~0.27 ms p50 over loopback.
- Authored a **benchmark harness** measuring P@1, P@5, MRR, nDCG@10 (binary relevance) plus p50/p95 query latency over 50 repeats per query, separately reporting server-side scoring vs end-to-end client latency for the gRPC ranker.
- Quantified the TF-IDF → BM25 upgrade: **MRR 0.73 → 0.83**, **nDCG@10 0.59 → 0.64**, latency unchanged.
- Diagnosed and fixed a stopword regression in DSA queries (e.g. _"two sum"_, _"same tree"_) by removing semantically loaded words from the stopword list.

---

## Architecture

```
Browser ──► Express ──► SearchIndex (interface)
                          ├─ TfIdfIndex     (Node, in-memory)
                          ├─ Bm25Index      (Node, in-memory)
                          └─ GrpcSearchIndex (Node client) ──► Go service (BM25 over gRPC)
                                ▲
                                └─ shared tokenizer + inverted-index layer
```

Single Node.js process serves the static frontend and the JSON API. Indexes are built once at boot from per-problem JSON in `data/problemset_llm/{leetcode,cses}/`. The Go service ([go/](go/)) implements the same `proto/algolens.proto` Search contract; the Node app probes its address on boot and registers it as `bm25-grpc` if reachable, falling back gracefully if not. Ranker is selectable per request via `?ranker=tfidf|bm25|bm25-grpc`.

---

## Try it

Node only (in-memory rankers):

```sh
npm install
npm run dev
# open http://localhost:3000/
```

With the Go BM25 microservice as a third ranker:

```sh
# terminal 1
cd go && go build -o algolens_server . && ./algolens_server --addr 127.0.0.1:50051 --corpus ../data/problemset_llm

# terminal 2
GRPC_BM25_ADDR=127.0.0.1:50051 npm run dev
```

See [docs/internals.md](docs/internals.md) for the API, ranker math, debug endpoints, and how the inverted index relates to ranking. See [go/README.md](go/README.md) for the Go service's build/run/regenerate flow.

---

## What's coming next

- **Pagination** — `offset` + `total` plumbed through route, both rankers, gRPC contract, and frontend "load more".
- **Hybrid retrieval** — BM25 candidate generation + dense embedding rerank over top-50.
- **Bench expansion** — query set to ~30, multi-grade relevance labels.
- **Pattern-similarity retrieval** — the original motivation: "given problem X, return problems whose solution _idea_ is the same."
- **Per-user solved/bookmarked state** (SQLite-backed) — schema spec'd in the plan; will plug in as a reranker on top of the existing `SearchIndex` output.

Original problem framing: [system_design/idea-v0.md](system_design/idea-v0.md). Learning notes used along the way: [docs/learning/](docs/learning/). Postmortem on the abandoned C++/gRPC attempt: [experiments/02-cpp-attempt-postmortem.md](experiments/02-cpp-attempt-postmortem.md).
