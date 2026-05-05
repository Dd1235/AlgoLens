# AlgoLens — Developer Internals

For users / recruiters: see [README.md](../README.md). This doc is for working in the codebase.

## Run it

```sh
npm install
npm run dev
```

Open `http://localhost:3000/`. Search box on the main page; [/debug.html](../web/debug.html) exposes the inverted index and per-query scoring math.

Switch ranker per request with `?ranker=tfidf|bm25|bm25-grpc`. Set the default for the whole process with `RANKER=bm25 npm run dev`. The `bm25-grpc` ranker is registered only if `GRPC_BM25_ADDR` is set and the address responds within 600 ms on boot — see [go/README.md](../go/README.md) for how to start the backing service.

## API

| Method · path | Purpose |
|---|---|
| `GET /api/search?q=&k=&ranker=` | Top-`k` hits. Each hit: `{ problem, score, matchedTerms[] }`. |
| `GET /api/problems` | Whole corpus as loaded. |
| `GET /api/rankers` | `{ available: [...], default: "..." }`. |
| `GET /api/index?ranker=` | Inverted-index dump: every term with `df`, `idf`, postings. |
| `GET /api/explain?q=&ranker=` | Per-term breakdown for every doc that matched the query. |

The last three power [/debug.html](../web/debug.html) and exist for learning, not production.

## How search works

1. **Tokenize.** `title + statement + tags + patterns` for each problem; lowercase, strip non-alphanumeric, split on whitespace, drop a small stopword list ([server/search/tokenize.js](../server/search/tokenize.js)). Stopword list deliberately keeps DSA-relevant words like `two`, `one`, `all`, `same`.
2. **Build index at boot.** Inverted postings (`Map<term, Set<docId>>`) plus per-doc term counts and lengths. ~15–20 ms for the 1185-doc corpus.
3. **Score.** Both rankers walk the same posting lists.
   - **TF-IDF** ([server/search/tfidf.js](../server/search/tfidf.js)): `score = Σ TF(t,d) · IDF(t)` where `TF = count/doclen`, `IDF = log(N/df)`.
   - **BM25** ([server/search/bm25.js](../server/search/bm25.js)): Robertson–Spärck-Jones IDF + TF saturation (`k1=1.5`) + length normalization (`b=0.75`).
4. **Rank.** Sort by score, return top-k.

The HTTP layer ([server/routes/search.js](../server/routes/search.js)) only knows the `{ search(q, k) -> hits }` interface. That's the seam future implementations sit behind: BM25 already does, the C++/gRPC client will, dense rerankers will.

### Where the inverted index ends and ranking begins

The inverted index answers *"which docs contain term X?"* and nothing else. It produces the **candidate set**. Ranking is everything that comes after — TF-IDF and BM25 are first-stage rankers that sit on top of the inverted index. A "reranker" specifically means a *second pass* over the top-k candidates with a more expensive model (e.g. dense embedding cosine sim, cross-encoder) — too costly to apply to all 1185 docs, cheap on a top-50 cut. We don't have a reranker yet; that's the hybrid retrieval story for later.

## Tests

```sh
node server/search/tfidf.test.js
node server/search/bm25.test.js
```

Bare `node:assert` — no framework. Tests use synthetic 3-doc corpora so they don't depend on the real data.

## Benchmarks

```sh
node bench/run.js
```

Writes timestamped JSON + `experiments/bench-latest.json`. See [experiments/README.md](../experiments/README.md) for what's measured and [experiments/01-tfidf-vs-bm25-seed.md](../experiments/01-tfidf-vs-bm25-seed.md) for the current write-up.

## Layout

```
/server          Express app + ranker implementations
  /search        tokenize / inverted / tfidf / bm25 (+ tests)
  /routes        search + debug endpoints
  data.js        loads data/problemset_llm/{leetcode,cses}/*.json at boot
/web             plain HTML/CSS/JS, no build step
/data
  /problemset_llm/{leetcode,cses,codeforces}/   LLM-annotated problem records
/bench           benchmark harness (queries.json + run.js)
/experiments     numerical results + per-experiment write-ups
/docs            this file + learning notes
```

## Roadmap (high-level)

- Go/gRPC BM25 microservice — **shipped** ([go/](../go/), [experiments/03](../experiments/03-go-vs-node-bm25.md))
- Pagination (`offset` + `total` through route, rankers, proto, UI)
- Expand bench to ~30 labeled queries
- Dense vector rerank (offline-embed problems, cosine over top-50 BM25)
- Hybrid retrieval + "find similar to this problem" route
- Per-user solved-state + recommendation (schema in [the plan](../../../.claude/plans/go-over-system-design-squishy-scott.md))
- Real scraper for a standard sheet (Striver / NeetCode)
