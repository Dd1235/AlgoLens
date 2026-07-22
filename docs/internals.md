# AlgoLens — Developer Internals

For users / recruiters: see [README.md](../README.md). This doc is for working in the codebase.

## Run it

```sh
npm install
npm run dev
```

Open `http://localhost:3000/`. Search box on the main page; [/debug.html](../web/debug.html) exposes the inverted index and per-query scoring math.

Switch ranker per request with `?ranker=tfidf|bm25|bm25-grpc|dense|hybrid`. Set the default for the whole process with `RANKER=bm25 npm run dev`. The `bm25-grpc` ranker is registered only if `GRPC_BM25_ADDR` is set and the address responds within 600 ms on boot — see [go/README.md](../go/README.md) for how to start the backing service. The `dense` + `hybrid` rankers register only if the committed embeddings artifact ([data/embeddings/](../data/embeddings/)) matches the corpus (id set + content hash) and the ONNX model loads; on mismatch boot warns "run `npm run embed`" and serves the lexical rankers only. `DENSE_DISABLED=1` skips them explicitly.

## API

| Method · path | Purpose |
|---|---|
| `GET /api/search?q=&k=&offset=&ranker=&filter=` | Paged hits. Each hit: `{ problem, score, matchedTerms[] }`, decorated with `done` and `bookmarked` for signed-in users. |
| `GET /api/problems` | Whole corpus as loaded. |
| `GET /api/rankers` | `{ available: [...], default: "..." }`. |
| `GET /api/index?ranker=` | Inverted-index dump: every term with `df`, `idf`, postings. |
| `GET /api/explain?q=&ranker=` | Scoring breakdown: per-term tf·idf for lexical rankers, per-doc cosine + angle for `dense`, per-leg RRF contributions for `hybrid`. (Async-aware: dense/hybrid explain embeds the query.) |
| `GET /api/similar/:problemId?k=` | "Find similar": doc-to-doc cosine over the stored embeddings, self excluded. 503 if dense isn't registered, 404 for unknown ids. |
| `POST /api/auth/signup` | Create user, bcrypt password, set httpOnly JWT cookie. |
| `POST /api/auth/login` | Verify password, set httpOnly JWT cookie. |
| `POST /api/auth/logout` | Clear session cookie. |
| `GET /api/auth/me` | Current signed-in user. |
| `POST/DELETE /api/done/:problemId` | Mark or unmark a problem as done. |
| `POST/DELETE /api/bookmark/:problemId` | Bookmark or unbookmark a problem. |
| `GET /api/library?type=bookmarked|done|all` | Hydrated saved-problem list for the signed-in user. |
| `GET /api/user-state` | `{ done: [...], bookmarked: [...] }` for first-paint UI decoration. |

The last three power [/debug.html](../web/debug.html) and exist for learning, not production.

`filter=done|notdone|all` is applied in the route after ranking. Anonymous users always get `all`.

## How search works

1. **Tokenize.** `title + statement + tags + patterns` for each problem; lowercase, strip non-alphanumeric, split on whitespace, drop a small stopword list ([server/search/tokenize.js](../server/search/tokenize.js)). Stopword list deliberately keeps DSA-relevant words like `two`, `one`, `all`, `same`.
2. **Build index at boot.** Inverted postings (`Map<term, Set<docId>>`) plus per-doc term counts and lengths. ~15–20 ms for the 1198-doc corpus.
3. **Score.** Both rankers walk the same posting lists.
   - **TF-IDF** ([server/search/tfidf.js](../server/search/tfidf.js)): `score = Σ TF(t,d) · IDF(t)` where `TF = count/doclen`, `IDF = log(N/df)`.
   - **BM25** ([server/search/bm25.js](../server/search/bm25.js)): Robertson–Spärck-Jones IDF + TF saturation (`k1=1.5`) + length normalization (`b=0.75`).
4. **Rank.** Sort by score, return top-k.

The dense path skips all four steps: problems are embedded offline (`npm run embed` → [scripts/embed_corpus.js](../scripts/embed_corpus.js), model identity pinned in [server/search/embedding.js](../server/search/embedding.js)) into a committed 1.74 MB artifact; at request time **dense** ([server/search/dense.js](../server/search/dense.js)) embeds the query in-process (MiniLM q8 ONNX, ~0.5 ms) and brute-force dot-products the whole corpus (~0.8 ms; vectors are unit-norm so cosine = dot). **hybrid** ([server/search/hybrid.js](../server/search/hybrid.js)) runs BM25 and dense legs, then reciprocal-rank-fuses their top-100s: `score(d) = Σ 1/(60 + rank)`. Per-slice quality numbers live in [experiments/05](../experiments/05-dense-hybrid-rrf.md).

The HTTP layer ([server/routes/search.js](../server/routes/search.js)) only knows the `{ search(q, k, offset) -> { hits, total } }` interface. That's the seam every implementation sits behind: TF-IDF, BM25, the Go/gRPC client, dense, and hybrid — five registrations, zero route changes. One semantic note: for `dense`, `total` is always the corpus size (every doc has a similarity to every query); for `hybrid` it's the size of the fused candidate union (≤ 200).

### Where the inverted index ends and ranking begins

The inverted index answers *"which docs contain term X?"* and nothing else. It produces the **candidate set**. Ranking is everything that comes after — TF-IDF and BM25 are first-stage rankers that sit on top of the inverted index. Dense retrieval replaces the candidate set entirely (every doc is a candidate); hybrid RRF is *fusion* of two first-stage rankers, not a reranker. A "reranker" specifically means a *second pass* over the top-k candidates with a more expensive model (e.g. a cross-encoder) — too costly to apply to all 1198 docs, cheap on a top-50 cut. We still don't have one, but hybrid's 0.984 Recall@100 makes its fused list the natural candidate feed when we do.

## Tests

```sh
npm run test:search   # tfidf + bm25 + dense + hybrid
```

Bare `node:assert` — no framework. Lexical tests use synthetic 3-doc corpora; dense/hybrid tests use hand-built 4-dim unit vectors and a fake embed function, so no test ever loads the ONNX model or the real data.

## Benchmarks

```sh
node bench/run.js
```

Writes timestamped JSON + `experiments/bench-latest.json`. See [experiments/README.md](../experiments/README.md) for what's measured and [experiments/01-tfidf-vs-bm25-seed.md](../experiments/01-tfidf-vs-bm25-seed.md) for the current write-up.

## Layout

```
/server          Express app + ranker implementations
  /search        tokenize / inverted / tfidf / bm25 / embedding / dense / hybrid (+ tests)
  /routes        search + similar + debug + auth + user-state endpoints
  /auth          JWT cookie helpers + auth middleware
  data.js        loads data/problemset_llm/{leetcode,cses}/*.json at boot
/db              Postgres migrations
/web             plain HTML/CSS/JS, no build step
/data
  /problemset_llm/{leetcode,cses,codeforces}/   LLM-annotated problem records
  /embeddings    committed corpus vectors (corpus.f32 + manifest.json); rebuild with `npm run embed`
/scripts         embed_corpus.js + app start/stop helpers
/bench           benchmark harness (queries.json + run.js)
/experiments     numerical results + per-experiment write-ups
/docs            this file + learning notes
```

## Roadmap (high-level)

- Go/gRPC BM25 microservice — **shipped** ([go/](../go/), [experiments/03](../experiments/03-go-vs-node-bm25.md))
- Pagination (`offset` + `total` through route, rankers, proto, UI) — **shipped**
- Postgres auth + bookmarks + done state — **shipped**
- Architecture and interview docs — **shipped** ([docs/implementation/13](implementation/13-architecture-diagrams.md), [14](implementation/14-interview-talk-tracks.md), [15](implementation/15-database-auth-and-user-state.md))
- Expand bench to ~30 labeled queries — **shipped** (v3 is 42: 30 keyword + 12 paraphrase, sliced; [experiments/04](../experiments/04-bench-30q.md), [05](../experiments/05-dense-hybrid-rrf.md))
- Dense retrieval (offline-embedded corpus, in-process MiniLM, brute-force cosine) — **shipped** ([experiments/05](../experiments/05-dense-hybrid-rrf.md))
- Hybrid RRF retrieval + "find similar to this problem" route — **shipped** ([experiments/05](../experiments/05-dense-hybrid-rrf.md))
- Cross-encoder rerank over hybrid's top-50 (candidate recall floor: 0.984 Recall@100)
- Recommendation layer over solved/bookmarked state
- Real scraper for a standard sheet (Striver / NeetCode)
