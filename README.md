# AlgoLens

A DSA problem search engine. Phase 1: Node.js + plain HTML, in-memory TF-IDF over a small hand-curated corpus.

## Run it

```sh
npm install
npm run dev
```

Open `http://localhost:3000/` and search for things like `graph cycle`, `monotonic`, or `knapsack`.

## What's in here right now

- 12 hand-picked DSA problems in [data/problems.json](data/problems.json), each with title, statement, tags, and `patterns[]` (editorial truth — what idea the problem actually tests).
- Express server in [server/](server/) that loads the corpus once at boot, builds a TF-IDF index, and serves both the static frontend and `GET /api/search?q=&k=`.
- Plain HTML/CSS/JS frontend in [web/](web/): debounced input, score and matched-terms shown per result, click to expand the statement.

## How search works

`title + statement + tags + patterns` is tokenized (lowercase, strip punctuation, split on whitespace + hyphens, drop a small stopword list — see [server/search/tokenize.js](server/search/tokenize.js)). The [TfIdfIndex](server/search/tfidf.js) computes `TF(t,d) = count/doclen` and `IDF(t) = log(N/df)` once at boot. Each query is tokenized and scored as the sum of `TF*IDF` per matching term, then top-`k` returned.

The route ([server/routes/search.js](server/routes/search.js)) only knows about the `{ search(q, k) -> hits }` shape — that's the seam BM25, dense vector, and gRPC implementations will all sit behind in later phases.

Sanity tests for the math: `node server/search/tfidf.test.js`.

## What's coming (and where it slots in)

- **BM25** — drop-in `Bm25Index` next to `TfIdfIndex`; CLI flag to switch. Will fix the "short doc with one match outranks longer multi-match doc" behavior you can already see with TF-IDF on `dp string`.
- **Benchmark harness** — fixed query set with expected top-1, measure P@1 + median latency per ranker.
- **Persistence + scraper** — SQLite for the corpus, then a real scraper for a standard sheet (NeetCode 150 / Striver).
- **Dense vector search** — offline-embed each problem's statement+patterns, brute-force cosine, then HNSW.
- **Hybrid + recommendations** — BM25 recall → dense re-rank, "find similar to this problem" route, solved-history-aware ordering.
- **C++ scoring microservice** — port the scoring loop, expose over gRPC, benchmark Node vs. C++ on the same corpus.

See [system_design/idea-v0.md](system_design/idea-v0.md) for the original problem framing and the learning notes in [docs/learning/search/](docs/learning/search/).
