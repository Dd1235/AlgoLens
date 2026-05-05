# AlgoLens

A search and retrieval system for DSA problems, built to evolve from a classical IR baseline into a multi-stage hybrid retriever with a polyglot service architecture.

> **Why it exists.** Existing platforms search by tags or problem text, both of which miss the thing that actually matters when practicing — *the underlying solution pattern*. AlgoLens starts as a serious keyword search engine over 1,185 problems and is being extended toward pattern-similarity retrieval and a Node ↔ C++/gRPC scoring split.

---

## Headline numbers

Measured on a 1,185-problem corpus (785 LeetCode + 400 CSES) against a hand-labeled query set. Full methodology and per-query results in [experiments/](experiments/).

| Ranker | P@1 | P@5 | MRR | nDCG@10 | p50 latency | p95 latency |
|---|---|---|---|---|---|---|
| TF-IDF | 0.600 | 0.280 | 0.727 | 0.586 | 0.077 ms | 0.249 ms |
| **BM25** | **0.700** | **0.360** | **0.825** | **0.642** | 0.081 ms | 0.237 ms |

→ BM25 lifts MRR by **+13.5 %** and nDCG@10 by **+9.6 %** over TF-IDF, with no measurable latency cost on this corpus size.

Build time (one-shot, in-memory): TF-IDF index in **18 ms**, BM25 index in **17 ms**, full corpus loaded from disk in **~340 ms**.

> Numbers above come from a 10-query seed set — directional, not yet publication-grade. Expanding to 30+ labeled queries is the next benchmarking task.

---

## Resume bullets (claims this codebase backs up *today*)

- Built a search engine over **1,185 DSA problems** (LeetCode + CSES); from-scratch implementations of **TF-IDF** and **BM25** (Robertson–Spärck-Jones IDF, term saturation `k1=1.5`, length normalization `b=0.75`) sharing a single inverted-index data layer.
- Designed a **`SearchIndex` interface boundary** so ranking implementations are interchangeable; HTTP routes are unaware of which ranker they hold.
- Authored a **benchmark harness** measuring P@1, P@5, MRR, nDCG@10 (binary relevance) plus p50/p95 query latency over 50 repeats, with timestamped result archival.
- Quantified the TF-IDF → BM25 upgrade: **MRR 0.73 → 0.83**, **nDCG@10 0.59 → 0.64**, latency unchanged.
- Diagnosed and fixed a stopword regression in DSA queries (e.g. *"two sum"*, *"same tree"*) by removing semantically loaded words from the stopword list.

Bullets get added here as features ship and produce numbers — no claims for unfinished work.

---

## Architecture (current)

```
Browser ──► Express ──► SearchIndex (interface)
                          ├─ TfIdfIndex   (in-memory)
                          └─ Bm25Index    (in-memory)
                                ▲
                                └─ shared tokenizer + inverted-index layer
```

Single Node.js process serves both the static frontend and the JSON API. Indexes are built once at boot from per-problem JSON in `data/problemset_llm/{leetcode,cses}/`. Ranker is selectable per request via `?ranker=tfidf|bm25`.

Architecture under construction (next phase): a **C++ BM25 scoring microservice over gRPC** drops in behind the same `SearchIndex` interface, enabling head-to-head Node-vs-C++ latency comparison on identical queries and corpus.

---

## Try it

```sh
npm install
npm run dev
# open http://localhost:3000/
```

See [docs/internals.md](docs/internals.md) for the API, ranker math, debug endpoints, and how the inverted index relates to ranking.

---

## What's coming next

- **C++/gRPC BM25 microservice** — same interface, different runtime; benchmark Node vs. C++ on identical workload.
- **Hybrid retrieval** — BM25 candidate generation + dense embedding rerank over top-50.
- **Bench expansion** — query set to ~30, multi-grade relevance labels.
- **Pattern-similarity retrieval** — the original motivation: "given problem X, return problems whose solution *idea* is the same."
- **Per-user solved-history-aware recommendations.**

Original problem framing: [system_design/idea-v0.md](system_design/idea-v0.md). Learning notes used along the way: [docs/learning/](docs/learning/).
