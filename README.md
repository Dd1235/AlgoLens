# AlgoLens

A DSA problem search engine. Phase 1: Node.js + plain HTML, in-memory TF-IDF over a small hand-curated corpus.

## Run it

```sh
npm install
npm run dev
```

Open `http://localhost:3000/` and search for things like `graph cycle`, `monotonic`, or `knapsack`. The `/debug.html` page exposes the inverted index and per-query scoring math — useful when reasoning about why something ranked where it did.

## What's in here right now

- 12 hand-picked DSA problems, one file per problem in [data/problems/](data/problems/), each with `id`, `title`, `slug`, `difficulty`, `source_url` (LeetCode), `tags`, `statement`, and `patterns[]` (editorial truth — what idea the problem actually tests).
- Express server in [server/](server/) that loads the corpus once at boot, builds a TF-IDF index, and serves both the static frontend and the API.
- Plain HTML/CSS/JS frontend in [web/](web/): debounced input, score and matched-terms shown per result, click to expand the statement.

## API

| Method · path | Purpose |
|---|---|
| `GET /api/search?q=&k=` | Top-`k` hits, ranked by TF-IDF. Each hit has `score` and `matchedTerms`. |
| `GET /api/problems` | Whole corpus as loaded. |
| `GET /api/index` | Inverted-index dump: every term with `df`, `idf`, and postings. |
| `GET /api/explain?q=` | Per-term TF/IDF/contribution breakdown for every doc that matched. |

The last three power [/debug.html](web/debug.html) and exist for learning, not for production.

## How search works

`title + statement + tags + patterns` is tokenized (lowercase, strip non-alphanumeric, split on whitespace, drop a small stopword list — see [server/search/tokenize.js](server/search/tokenize.js)). The [TfIdfIndex](server/search/tfidf.js) computes `TF(t,d) = count/doclen` and `IDF(t) = log(N/df)` once at boot. Each query is tokenized and scored as the sum of `TF*IDF` per matching term, then top-`k` returned.

The route ([server/routes/search.js](server/routes/search.js)) only knows about the `{ search(q, k) -> hits }` shape — that's the seam BM25, dense vector, and gRPC implementations will all sit behind in later phases.

Sanity tests for the math: `node server/search/tfidf.test.js`.

## Where TF-IDF struggles (queries to track for BM25 comparison)

Honest weak spots in the current ranker. Once `Bm25Index` lands, these are the queries to re-run for the comparison column.

| Query | TF-IDF top result | Issue | Why BM25 should help |
|---|---|---|---|
| `dp string` | Valid Parentheses (only matches "string") | Short single-match doc beats Edit Distance, which matches **both** terms. TF-by-length normalization is too aggressive. | Term saturation (`k1`) damps repeated-term boost; length normalization (`b`) is gentler. |
| `binary search` | Longest Increasing Subsequence (correct) | But Binary Tree Level Order and Two Sum show up high too, just because they incidentally contain "binary" or "search" once each. | BM25 favors docs matching **both** query terms more strongly via per-term saturation + IDF interaction. |
| `two pointers` | Trapping Rain Water (correct, only hit) | "two" is a stopword, so only "pointers" matches. | Same in BM25. Real fix is keeping numeric/positional words out of stopwords, or using bigrams. |
| `reverse linked list` | (no results) | The corpus doesn't have a linked-list problem yet. | Same in BM25 — this is a corpus gap, not a ranker problem. Adds the test case for the scraper phase. |

When the BM25 commit lands, this table grows a "BM25 top result" column and a verdict column. The benchmark harness (Phase 2) will turn this into actual P@1 and nDCG numbers, not vibes.

You can poke at the math behind any of these queries via `/debug.html` → Explain.

## What's coming (and where it slots in)

- **BM25** — drop-in `Bm25Index` next to `TfIdfIndex`; CLI flag to switch. Targets the weak queries above.
- **Benchmark harness** — fixed query set with expected top-1, measure P@1 + median latency per ranker. Turns the table above into a tracked regression suite.
- **Persistence + scraper** — SQLite for the corpus, then a real scraper that follows `source_url` for a standard sheet (NeetCode 150 / Striver).
- **Dense vector search** — offline-embed each problem's statement+patterns, brute-force cosine, then HNSW.
- **Hybrid + recommendations** — BM25 recall → dense re-rank, "find similar to this problem" route, solved-history-aware ordering.
- **C++ scoring microservice** — port the scoring loop, expose over gRPC, benchmark Node vs. C++ on the same corpus.

See [system_design/idea-v0.md](system_design/idea-v0.md) for the original problem framing and the learning notes in [docs/learning/search/](docs/learning/search/).
