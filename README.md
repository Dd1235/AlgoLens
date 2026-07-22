# AlgoLens

Wanted real keyword search over DSA problems. Sites filter by tags or matches problem text literally, and neither surfaces problems by the underlying solution pattern. 1,260 problems from LeetCode and CSES, indexed locally, and the search box is the whole product. (Codeforces is deferred on purpose — Cloudflare blocks statement fetches, and metadata-only records search badly; see [docs/internals.md](docs/internals.md).)

Who it's for:

- **Upsolving after a contest** — open the problem that beat you, hit "find similar", get its neighbors by stored-vector cosine.
- **Searching by the idea, not the words** — "check if brackets open and close in the right order" finds `valid-parentheses` even though the corpus says "parentheses" (that's the dense ranker; the paraphrase slice in [experiments/05](experiments/05-dense-hybrid-rrf.md) is the receipt).
- **Drilling a niche technique** — the [patterns page](web/patterns.html) lists the curated taxonomy (wqs-binary-search, slope-trick, booth-algorithm, …) with per-label counts; one click filters search to it. Fresh contest problems come in via `npm run corpus:refresh`.

Live demo: _coming — deploy runbook in docs/internals.md_

![search](demo/01-search.png)

I started with TF-IDF because it's the obvious first move. Tokenizer, postings, IDF, length-normalized TF. The first version worked but had a stopword bug: queries like "two sum" and "same tree" returned nothing because "two" and "same" were on the default stopword list. They're content words in DSA. Cut them.

Then built BM25 next to it. The problem TF-IDF has on this corpus is that CSES statements are long and chatty while LeetCode titles are short — so a long doc that says "graph" ten times outranks a short doc literally titled "Graph Cycle". BM25's `k1=1.5` saturates that, and `b=0.75` normalizes by document length. Same inverted index, different scoring math. MRR went from 0.73 to 0.83.

![explain](demo/03-debug-explain.png)

There's a debug page that opens up the math: type a query, see the per-term `tf · idf · contribution` for every matching doc. For BM25 the `tf` shown is the saturated form `(k1+1)·count / (count + k1·norm)` — capped at ~`k1+1` regardless of how often the term appears, which is the whole point.

Got numbers over a small bench— 10 hand-labeled queries, P@1, P@5, MRR, nDCG@10 (binary relevance), p50/p95 latency over 50 repeats per query.

We know the whole JS event loop thing is designed for great async IO, and for a typical backend service, IO heavy tasks, such as network and api calls. Building inverted index, and running algos like TF-IDF and BM25 is CPU-bound so thought of having a microservice for this part. TLDR, actually its better to stick to monolithic! For just 1200 odd problems, JS does a great job, and overall latency only increases because of the network overhead between the two services!

Tried to add a C++ gRPC scoring service to learn cross-language RPC. CMake, protobuf, abseil, generated header conflicts — got nowhere useful. Postmortem'd it and rewrote in Go in a fraction of the time. Same `proto/algolens.proto`, same `SearchIndex` contract. Node probes it on boot and registers it as a third ranker if reachable; routes don't know which one they're calling. Verified bit-exact parity on quality metrics. gRPC adds ~200µs of transport at this scale; server-side scoring is roughly equal to the in-memory Node ranker.

Pagination came next. Threaded `offset` and `total` through both Node rankers, the proto contract, the Go server, the gRPC client, the route, and the frontend's "load more". The interesting bit was making `total` correct after filtering, which mattered for the next thing.

Expanded the bench from 10 to 30 queries — pre-validating every relevance ID against the corpus before committing — and BM25 still wins on every metric. Gap on MRR widened from +0.10 to +0.13 once the test set got harder. Two queries flipped TF-IDF's way; the rest were BM25 wins, sometimes big ones (+0.37 on "edit distance levenshtein").

Added Postgres for users. Email + password (bcrypt + JWT in an httpOnly cookie), anonymous browsing untouched, signed-in users get bookmark and mark-as-done buttons on every result and a filter dropdown for done / not-done / all. The filter happens at the route layer post-rank, not in the index — so the Go ranker stays completely user-blind and the BM25 contract doesn't care about humans. Problem IDs are plain strings (`leetcode-two-sum`, `cses-1640`) with no FK to a problems table, which means adding Codeforces later is one config line and zero migrations. Dockerized; `render.yaml` deploys it as a single Node service pointing at a Neon-hosted Postgres via `DATABASE_URL`.

![library](demo/02-library-done.png)

For the library view, leaned into the shell aesthetic the rest of the UI already had: type `:bookmarks` or `:done` (or click a chip on the prompt bar) and the search input becomes a command, listing your saved problems with relative timestamps instead of BM25 scores. Tab cycles between views. The path indicator (`~`, `~/done`, `~/search "graph"`) updates as you navigate.

Then hit BM25's wall. Ask "check if brackets open and close in the right order" and it returns problems about opening water taps — the corpus says "parentheses", the query says "brackets", and no tf·idf math bridges that. So: dense retrieval. Every problem gets embedded offline with a quantized MiniLM sentence-transformer (384-dim ONNX running in-process via transformers.js — no Python, no API keys), and the 1260 unit vectors are a 1.85 MB file committed to the repo. At query time the only new work is embedding the query (~0.5 ms on CPU); scoring is a brute-force dot product over one contiguous Float32Array — 0.8 ms for the whole corpus, which is the measured argument for why this project does not need a vector database. A `hybrid` ranker fuses BM25 and dense top-100s with reciprocal rank fusion, same `search(q, k, offset)` seam, fourth and fifth entries in the ranker registry.

To measure it honestly, the bench grew a dimension: 12 new paraphrase queries (natural-language descriptions with deliberately low word overlap with their targets) tagged separately from the 30 keyword queries, plus Recall@100. The result is a clean split, not a coronation. BM25 still owns keyword queries (P@1 0.667 vs dense's 0.533 — when you type "fenwick tree binary indexed", exact terms win). Dense owns paraphrase queries (nDCG@10 0.784 vs 0.676; the brackets query goes from rank ~77 to rank 1). Hybrid posts the best overall nDCG@10 and finds 98.4% of all relevant docs in its top-100 — the right candidate generator for a future cross-encoder rerank — but its blended MRR stays below pure BM25, so BM25 keeps the default and dense/hybrid ride behind `?ranker=`. Numbers and the where-it-wins/where-it-loses tables in `experiments/05`.

The embeddings also bought a feature for free: every result card has "find similar problems" — doc-to-doc cosine over the stored vectors, no model in the loop, ~1 ms. And the debug page learned the new math: pick a ranker and explain shows per-doc cosine + angle for dense, or each leg's rank and `1/(60+rank)` contribution for hybrid, next to the per-term tf·idf tables it already had.

To run it: copy `.env.example` to `.env` and fill in a Neon pooled `DATABASE_URL` plus a generated `JWT_SECRET`, then `npm install`, `npm run db:migrate`, `npm run dev`, open `http://localhost:3000`. The corpus embeddings ship in the repo; the first boot downloads the ~25 MB embedding model into `.model-cache/` (one time), and `npm run embed` only matters if the corpus changes. Neon keeps the schema across runs, so signups/bookmarks persist. Offline fallback: `npm run services:start` boots a local Postgres in docker on :5433 — point `DATABASE_URL` at it and run the migration the same way (`npm run services:stop` / `services:status` / `services:reset` round it out). Implementation notes that go deeper live in `docs/implementation/`.
