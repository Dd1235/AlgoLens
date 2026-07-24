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
| `GET /api/search?q=&k=&offset=&ranker=&filter=&pattern=` | Paged hits. Each hit: `{ problem, score, matchedTerms[] }`, decorated with `done` and `bookmarked` for signed-in users. `pattern=` filters post-rank to problems carrying that label slug. Alias queries are expanded server-side (`expandedQuery` echoed when it differs). |
| `GET /api/problems` | Whole corpus as loaded. |
| `GET /api/rankers` | `{ available: [...], default: "..." }`. |
| `GET /api/index?ranker=` | Inverted-index dump: every term with `df`, `idf`, postings. |
| `GET /api/explain?q=&ranker=` | Scoring breakdown: per-term tf·idf for lexical rankers, per-doc cosine + angle for `dense`, per-leg RRF contributions for `hybrid`. (Async-aware: dense/hybrid explain embeds the query.) |
| `GET /api/similar/:problemId?k=` | "Find similar": doc-to-doc cosine over the stored embeddings, self excluded. 503 if dense isn't registered, 404 for unknown ids. |
| `GET /api/compare?q=&k=&rankers=` | The same query across several rankers in parallel (default all registered; `rankers=bm25,dense` narrows). Powers the side-by-side compare UI. |
| `GET /api/patterns` | Canonical taxonomy grouped by category with per-label problem counts (zero counts included). Powers `/patterns.html`. |
| `GET /api/handles` · `PUT /api/handles` | Signed-in user's LeetCode/Codeforces/CodeChef/GitHub handles. PUT body with any subset; empty string deletes; any change drops the cached stats row. |
| `GET /api/profile?refresh=1` | Combined external stats: per-platform payloads (12h server-side cache; `refresh=1` floors it at 10min; stale-if-error). `combined` carries `totalSolved`, `algolensDone`, a platform→category map (`dsa`/`dev`), and the AlgoLens done-marks calendar — the client composes the dsa/dev/overall heatmap views from the per-source calendars, so tab switches cost zero network. Powers `/profile.html`. |
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
2. **Build index at boot.** Inverted postings (`Map<term, Set<docId>>`) plus per-doc term counts and lengths. ~15–20 ms for the 1808-doc corpus.
3. **Score.** Both rankers walk the same posting lists.
   - **TF-IDF** ([server/search/tfidf.js](../server/search/tfidf.js)): `score = Σ TF(t,d) · IDF(t)` where `TF = count/doclen`, `IDF = log(N/df)`.
   - **BM25** ([server/search/bm25.js](../server/search/bm25.js)): Robertson–Spärck-Jones IDF + TF saturation (`k1=1.5`) + length normalization (`b=0.75`).
4. **Rank.** Sort by score, return top-k.

The dense path skips all four steps: problems are embedded offline (`npm run embed` → [scripts/embed_corpus.js](../scripts/embed_corpus.js), model identity pinned in [server/search/embedding.js](../server/search/embedding.js)) into a committed vector artifact (2.65 MB at 1,808 docs); at request time **dense** ([server/search/dense.js](../server/search/dense.js)) embeds the query in-process (MiniLM q8 ONNX, ~0.5 ms) and brute-force dot-products the whole corpus (~0.8 ms; vectors are unit-norm so cosine = dot). **hybrid** ([server/search/hybrid.js](../server/search/hybrid.js)) runs BM25 and dense legs, then reciprocal-rank-fuses their top-100s: `score(d) = Σ 1/(60 + rank)`. Per-slice quality numbers live in [experiments/05](../experiments/05-dense-hybrid-rrf.md).

The HTTP layer ([server/routes/search.js](../server/routes/search.js)) only knows the `{ search(q, k, offset) -> { hits, total } }` interface. That's the seam every implementation sits behind: TF-IDF, BM25, the Go/gRPC client, dense, and hybrid — five registrations, zero route changes. One semantic note: for `dense`, `total` is always the corpus size (every doc has a similarity to every query); for `hybrid` it's the size of the fused candidate union (≤ 200).

### Where the inverted index ends and ranking begins

The inverted index answers *"which docs contain term X?"* and nothing else. It produces the **candidate set**. Ranking is everything that comes after — TF-IDF and BM25 are first-stage rankers that sit on top of the inverted index. Dense retrieval replaces the candidate set entirely (every doc is a candidate); hybrid RRF is *fusion* of two first-stage rankers, not a reranker. A "reranker" specifically means a *second pass* over the top-k candidates with a more expensive model (e.g. a cross-encoder) — too costly to apply to all 1808 docs, cheap on a top-50 cut. We still don't have one, but hybrid's 0.984 Recall@100 makes its fused list the natural candidate feed when we do.

## Tests

```sh
npm run test:search   # tfidf + bm25 + dense + hybrid
```

Bare `node:assert` — no framework. Lexical tests use synthetic 3-doc corpora; dense/hybrid tests use hand-built 4-dim unit vectors and a fake embed function, so no test ever loads the ONNX model or the real data.

## Benchmarks

```sh
npm run bench          # full run (50 latency repeats per query)
npm run bench:fast     # LATENCY_REPEATS=5
BENCH_EXPAND=0 npm run bench   # raw rankers, no alias expansion (A/B baseline)
```

Queries run through the same alias expansion as the serving path by default. Writes timestamped JSON + `experiments/bench-latest.json`. See [experiments/README.md](../experiments/README.md) for what's measured and [experiments/01-tfidf-vs-bm25-seed.md](../experiments/01-tfidf-vs-bm25-seed.md) for the current write-up.

## Corpus workflows

**Refresh (new problems):** `npm run corpus:refresh` — regenerates the URL blocks (the `LeetCode Recent` block is the newest N problems by frontend id, a practical proxy for recent contest problems), annotates anything new (existing records skip before any network call), re-embeds, validates, smoke-runs the bench, then stops with a dirty tree for review. The script never commits; the reviewable diff is urls + new corpus files + embeddings, committed together.

**Labels (niche algorithms):** the vocabulary lives in [data/pattern_taxonomy.json](../data/pattern_taxonomy.json) (canonical slugs + aliases; single source of truth for the annotator, validator, and normalizer). Three tools keep it honest:

- `npm run validate -- --gaps` ranks non-canonical labels by usage × the LLM's own confidence — recurring high-confidence drift is a promotion candidate.
- `python3 scripts/audit_patterns.py --ids …` asks the LLM specifically whether a problem admits a well-known *named* algorithm (Booth, Duval/Lyndon, WQS, …) that its labels miss, writing candidates to `data/review_queue/`.
- `node scripts/apply_review.js --write` merges only what a human left in the queue (deleting a candidate = rejecting it), then `npm run embed && npm run validate`.

Labels are load-bearing (search text, `pattern=` filter, patterns page), so LLM-asserted niche claims never land unreviewed.

**Codeforces is deferred on purpose:** CF statement pages sit behind Cloudflare, so annotation would be metadata-only (title + tags, no statement) — weak lexical matching and weak embeddings. The 7 dormant files under `data/problemset_llm/codeforces/` also predate the current id scheme (`cf-279b-books` vs `codeforces-279-b`). Enabling CF is a data-quality problem, not a flag flip.

## Data organization

Deliberately file-first: the problem corpus is JSON in git, and git is the database. That buys reviewable label diffs in PRs, bit-identical corpora across environments, and the `corpusHash` contract that binds the committed embeddings to the exact served text. Postgres stores only mutable per-user state (`users`, `user_problem_state`; `problem_id` is a free-form string, no FK). The review queue is files for the same reason the corpus is. A `problems` table would earn its keep only with multi-writer/online label edits, a corpus too big to boot-load and brute-force scan (~50k+ docs), or query-time joins into ranking — none of which apply at this scale.

## Profile feature

`/profile.html` (gated: redirects anonymous visitors to `/login.html` — the one page that does; the search page still degrades gracefully instead). Handles live in `user_platform_handles`; external stats are cached in `user_platform_stats` (JSONB) with a 12h TTL, 10min floor on manual refresh, and stale-if-error fallback. Fetchers ([server/profile/](../server/profile/)) never throw past the orchestrator — each platform degrades to `{unavailable, error}` independently. Sources: LeetCode public GraphQL (solved by difficulty + submission calendar), Codeforces official API (rating + submissions; the two calls are sequential per CF rate guidance; >5000 submissions truncated), CodeChef best-effort page scrape (rating/solved only — no official API, no heatmap), and GitHub contributions — via the GraphQL API when `GITHUB_TOKEN` is set (any no-scope PAT; exact calendar, reliable from datacenter IPs) with a silent fallback to scraping the public contributions fragment (counts, degrading to 0–4 intensity levels flagged `approximate`). Every source carries a category (`dsa` = judges + done marks, `dev` = github); the profile page renders overall/dsa/dev heatmap tabs composed client-side. Calendars are bucketed by UTC day and rendered as a hand-rolled 53-week grid (no chart lib); the server ships each source's calendar once and the client sums whichever sources the active tab selects.

## Versioning and releases

`main` is production (Render autoDeploy). Feature milestones happen on a branch (`v2`, …) and merge with `--no-ff` so one revert rolls the release back. Release order is fixed: (1) green gate (`npm run validate && npm run test:search && npm run test:profile && npm run bench:fast`), (2) **migrate Neon first** (`DATABASE_URL='…' bash db/run-migrations.sh` — migrations are additive-only, so running code ignores new tables and the migration is zero-downtime), (3) merge + push = deploy, (4) live checks. Rollback: Render → redeploy the previous deploy, or `git revert -m 1 <merge>`; additive migrations are left in place. Tags mark releases (`v1.0.0`, …).

## Deploy (card-free)

The app is one Docker image: the MiniLM model is baked at build time and the corpus vectors are committed, so a container boots with zero network beyond Postgres (verified with `docker run --network none`). Two free-tier accounts, neither needs a card:

1. **Neon (Postgres):** create a project, copy the **pooled** connection string, append `sslmode=require`. Run migrations once from your machine: `DATABASE_URL='…' bash db/run-migrations.sh`.
2. **Optional `GITHUB_TOKEN`** (Render env + local `.env`): a personal access token with zero scopes — enables exact GitHub contribution data via GraphQL instead of the scrape fallback.
3. **Render (app):** *skip Blueprints — applying one requires a payment method on file.* Instead: Dashboard → New → **Web Service** → pick this GitHub repo (the Dockerfile is auto-detected) → Instance type **Free** → env vars `DATABASE_URL` (from Neon) and `JWT_SECRET` (any long random string, e.g. `openssl rand -hex 32`). Optional: health check path `/`. Render injects `PORT` and the app binds it. [render.yaml](../render.yaml) is the reference for these settings.
4. **Verify live:** `/api/rankers` lists `dense` + `hybrid`, `/patterns.html` renders, and a signup → bookmark round-trip works.

Free-tier realities: the instance spins down after ~15 min idle, so the first request after a quiet spell waits ~30–60 s on the platform cold start (the app itself boots in ~1 s — baked model, committed vectors). Memory is fine: ~101 MiB RSS against the 512 MB cap; `DENSE_DISABLED=1` is the escape hatch if that ever changes.

Fallback if Render asks for a card anyway: **Hugging Face Spaces** runs Dockerfiles card-free — create a Docker Space, push this repo to it, set `app_port: 3000` in the Space README front matter, and add `DATABASE_URL` + `JWT_SECRET` as Space secrets.

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
  /review_queue  audit candidates awaiting human review (apply_review.js consumes)
  pattern_taxonomy.json   canonical pattern vocabulary + aliases (single source of truth)
/scripts         corpus tooling: update_problem_urls / annotate_problem_urls / refresh_corpus /
                 embed_corpus / validate_corpus / normalize_patterns / audit_patterns / apply_review
                 + app start/stop helpers
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
- Pattern taxonomy + validation gate + niche labels + technique bench slice — **shipped** ([experiments/06](../experiments/06-technique-slice-and-corpus-growth.md))
- Pattern filter + clickable chips, ranker compare mode, patterns directory page — **shipped**
- Corpus refresh pipeline (LeetCode Recent block) + niche-label audit/review queue — **shipped** (see Corpus workflows above)
- Query-side alias expansion + `:help` + hard-focus corpus (easies purged, +561 lowest-acRate mediums) + profile/heatmap — **shipped** ([experiments/07](../experiments/07-medium-hardest-growth.md))
- Scoped expansion (lexical legs only; dense embeds the raw query) — measured need in exp 07
- Cross-encoder rerank over hybrid's top-50 (candidate floor measured in exp 06)
- Recommendation layer over solved/bookmarked state
- Real scraper for a standard sheet (Striver / NeetCode)
