# Cosine — Developer Internals

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
| `GET /api/search?q=&k=&offset=&ranker=&filter=&pattern=&platform=&difficulty=&sort=` | Paged hits. Each hit: `{ problem, score, matchedTerms[] }`, decorated with `done` and `bookmarked` for signed-in users. `pattern=` filters post-rank to problems carrying that label slug; `platform=` takes a comma-separated judge list (unknown names dropped; naming all four is the same as naming none). `difficulty=` is a comma-separated per-judge selection — named tiers (`lc-hard`), inclusive rating ranges (`cf:1500-1700`), or a LeetCode acceptance-rate range (`ac:10-30`, which intersects with a tier rather than replacing it); a judge with no selection is unfiltered, never excluded. `sort=difficulty-asc|desc` is honoured only when exactly one judge with a scale is selected, otherwise `sortRefused` explains why; with a query it reorders the top `k` and echoes `sortWindow` (paging is withdrawn), without one it orders the whole set and paging stands. Alias queries are expanded server-side (`expandedQuery` echoed when it differs). |
| `GET /api/problems` | Whole corpus as loaded. |
| `GET /api/rankers` | `{ available: [...], default: "..." }`. |
| `GET /api/index?ranker=` | Inverted-index dump: every term with `df`, `idf`, postings. |
| `GET /api/explain?q=&ranker=` | Scoring breakdown: per-term tf·idf for lexical rankers, per-doc cosine + angle for `dense`, per-leg RRF contributions for `hybrid`. (Async-aware: dense/hybrid explain embeds the query.) |
| `GET /api/similar/:problemId?k=` | "Find similar": doc-to-doc cosine over the stored embeddings, self excluded. 503 if dense isn't registered, 404 for unknown ids. |
| `GET /api/compare?q=&k=&rankers=` | The same query across several rankers in parallel (default all registered; `rankers=bm25,dense` narrows). Powers the side-by-side compare UI. |
| `GET /api/patterns` | Canonical taxonomy grouped by category with per-label problem counts (zero counts included). Powers `/patterns.html`. |
| `GET /api/handles` · `PUT /api/handles` | Signed-in user's LeetCode/Codeforces/CodeChef/AtCoder/GitHub handles. PUT body with any subset; empty string deletes; any change drops the cached stats row. |
| `GET /api/stats` | Public aggregate usage/performance: visitors, searches, per-ranker live latency percentiles, top + zero-hit queries, cold starts. Powers `/stats.html`. |
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
2. **Build index at boot.** Inverted postings (`Map<term, Set<docId>>`) plus per-doc term counts and lengths. ~30–35 ms for the 2,825-doc corpus.
3. **Score.** Both rankers walk the same posting lists.
   - **TF-IDF** ([server/search/tfidf.js](../server/search/tfidf.js)): `score = Σ TF(t,d) · IDF(t)` where `TF = count/doclen`, `IDF = log(N/df)`.
   - **BM25** ([server/search/bm25.js](../server/search/bm25.js)): Robertson–Spärck-Jones IDF + TF saturation (`k1=1.5`) + length normalization (`b=0.75`).
4. **Rank.** Sort by score, return top-k.

The dense path skips all four steps: problems are embedded offline (`npm run embed` → [scripts/embed_corpus.js](../scripts/embed_corpus.js), model identity pinned in [server/search/embedding.js](../server/search/embedding.js)) into a committed vector artifact (4.14 MB at 2,825 docs); at request time **dense** ([server/search/dense.js](../server/search/dense.js)) embeds the query in-process (MiniLM q8 ONNX, ~0.5 ms) and brute-force dot-products the whole corpus (~0.8 ms; vectors are unit-norm so cosine = dot). **hybrid** ([server/search/hybrid.js](../server/search/hybrid.js)) runs BM25 and dense legs, then reciprocal-rank-fuses their top-100s: `score(d) = Σ 1/(60 + rank)`. Each leg goes `max(topN, offset + k)` deep before fusing, so a shallow query keeps exp 05's tuning while the route's filter path — which asks for the whole ranked list — actually gets it. Reading `topN` there instead capped every fused set at 200 rows regardless of `k`, which silently emptied any filtered page past offset 200. Per-slice quality numbers live in [experiments/05](../experiments/05-dense-hybrid-rrf.md).

The HTTP layer ([server/routes/search.js](../server/routes/search.js)) only knows the `{ search(q, k, offset) -> { hits, total } }` interface. That's the seam every implementation sits behind: TF-IDF, BM25, the Go/gRPC client, dense, and hybrid — five registrations, zero route changes. One semantic note: for `dense`, `total` is always the corpus size (every doc has a similarity to every query); for `hybrid` it's the size of the fused candidate union (≤ 200).

### Where the inverted index ends and ranking begins

The inverted index answers *"which docs contain term X?"* and nothing else. It produces the **candidate set**. Ranking is everything that comes after — TF-IDF and BM25 are first-stage rankers that sit on top of the inverted index. Dense retrieval replaces the candidate set entirely (every doc is a candidate); hybrid RRF is *fusion* of two first-stage rankers, not a reranker. A "reranker" specifically means a *second pass* over the top-k candidates with a more expensive model (e.g. a cross-encoder) — too costly to apply to all 2,825 docs, cheap on a top-50 cut. We still don't have one, but hybrid's 0.924 Recall@100 makes its fused list the natural candidate feed when we do.

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

**Scoring the annotator.** Codeforces is the only judge in the corpus that publishes per-problem tags, which makes its slice the one place with ground truth. `python3 scripts/label_agreement.py` scores our labels against it — currently **macro precision 76%, macro recall 84%** over 617 records. Recall is the number that matters: a missed technique is an unfindable problem, and nothing scores below 69%. Low precision usually means we labeled something Codeforces didn't bother to, which helps search — except where it dilutes a specific label. This harness is what caught the annotator's `output_schema` leaking two example slugs into every answer: `binary-search-answer` landed on twice as many problems as Codeforces tags, and replacing the sample values with placeholders took it from 44% to 84% precision without costing recall (see [experiments/08](../experiments/08-multi-judge-corpus.md)). Prompt shape is a corpus-quality bug, and this is how you see it.

**Reading a bench run after the corpus grows.** Relevance judgments are fixed id lists, so a bigger corpus mechanically depresses precision: new problems that are genuinely good answers were never judged, and count as misses. `python3 scripts/bench_diff.py <old.json> <new.json>` separates the two by reporting what share of top-5 slots went to problems that didn't exist in the baseline. High displacement with flat Recall@100 is crowding; falling Recall@100 is regression.

**Judge tags reach the index only through the taxonomy.** Codeforces and LeetCode label their own problems and those labels sit in `source_tags`, which is *not* part of the indexed document — so a judge saying `ordered-set` reached nobody. `scripts/apply_source_tags.py` maps them through the vocabulary into `tags`, recovering 166 specific labels across 145 problems (`ordered-set` +24, `segment-tree` +20, `suffix-array` +17). Two deliberate constraints: generic judge tags (`implementation`, `brute force`, `data structures`, and ~30 others) are dropped, since a word on hundreds of problems doesn't help anyone choose; and they land in `tags`, never `patterns`, because patterns drive the filter and the counts on /patterns.html and should stay the human-reviewed set.

**Why label quality *is* recall.** A problem's search text is `title + statement + tags + patterns`, and the statement is an LLM *summary* — when the summary drops a term, only a label can carry it. That's why `mcm dp` matched nothing until `matrix-chain-multiplication` existed as a label (those words appear in no statement), and why only 1 of 4 mex problems was findable. A recall complaint is usually a labeling gap, not a ranking bug: check `npm run validate -- --gaps` and the audit loop before touching a ranker.

**GeeksforGeeks is deliberately absent** from the profile: its user pages are client-rendered with no usable JSON endpoint, so any integration would be a scrape even more fragile than CodeChef's, breaking silently. Revisit if they ship an API.

**Three statement sources, one annotator.** Every problem — whatever the judge — ends up as the same record shape through `scripts/annotate_problem_urls.py`; only *where the statement comes from* differs, and each staging script writes a cache the annotator reads instead of fetching:

| Judge | Statement from | Staged by | Why not the obvious way |
| --- | --- | --- | --- |
| LeetCode | official GraphQL | `corpus:refresh` | — |
| CSES | task page | `corpus:refresh` | — |
| Codeforces | `open-r1/codeforces` on HF datasets-server | `scripts/fetch_codeforces.py` | codeforces.com returns 403 to any script (Cloudflare). The dataset ships statement + official tags + rating unauthenticated, which is strictly more than a scrape would get. |
| AtCoder | atcoder.jp task page | `scripts/fetch_atcoder.py` | kenkoooo's API has difficulty but no statement text. |

CF is stratified across rating bands (1300-1500 / 1600-1900 / 2000-2400 / 2500+) rather than taken in id order, so the batch isn't all 1300s — the band with by far the most problems. Ids are `codeforces-<contest>-<index>` and `atcoder-<task_id>` with underscores hyphenated (the validator's slug rule).

**The curated sheet.** `data/formwise.xlsx` is 17 topic tabs with a human `Form` column ("Binary Search On Answer"). `scripts/fetch_formwise.py` parses it with stdlib zipfile+ElementTree (hyperlink targets live in `xl/worksheets/_rels/*.rels`, not the cell text), and `scripts/apply_formwise_labels.py` merges the human labels *after* annotation — tab name → tag, `Form` → pattern, both folded through the alias map. Curriculum-only Forms (`Mixed`, `Form-N`, `Kth Form`, `Level-N`) are dropped: they label a worksheet position, not a technique, and the LLM's own labels cover those problems.

**Skipped problems are recorded, not dropped.** Anything on a judge with no fetchable statement lands in [data/skipped_problems.json](../data/skipped_problems.json) with a name, link, and reason. A curated list that silently loses 8% of its entries is worse than one that says which 8% — and the file is the worklist if a judge later becomes reachable.

## Data organization

Deliberately file-first: the problem corpus is JSON in git, and git is the database. That buys reviewable label diffs in PRs, bit-identical corpora across environments, and the `corpusHash` contract that binds the committed embeddings to the exact served text. Postgres stores only mutable per-user state (`users`, `user_problem_state`; `problem_id` is a free-form string, no FK). The review queue is files for the same reason the corpus is. A `problems` table would earn its keep only with multi-writer/online label edits, a corpus too big to boot-load and brute-force scan (~50k+ docs), or query-time joins into ranking — none of which apply at this scale.

## Profile feature

`/profile.html` (gated: redirects anonymous visitors to `/login.html` — the one page that does; the search page still degrades gracefully instead). Handles live in `user_platform_handles`; external stats are cached in `user_platform_stats` (JSONB) with a 12h TTL, 10min floor on manual refresh, and stale-if-error fallback. Fetchers ([server/profile/](../server/profile/)) never throw past the orchestrator — each platform degrades to `{unavailable, error}` independently. Sources: LeetCode public GraphQL (solved by difficulty + submission calendar), Codeforces official API (rating + submissions; the two calls are sequential per CF rate guidance; >5000 submissions truncated), CodeChef best-effort page scrape (rating/solved only — no official API, no heatmap), and GitHub contributions — via the GraphQL API when `GITHUB_TOKEN` is set (any no-scope PAT; exact calendar, reliable from datacenter IPs) with a silent fallback to scraping the public contributions fragment (counts, degrading to 0–4 intensity levels flagged `approximate`). Every source carries a category (`dsa` = judges + done marks, `dev` = github); the profile page renders overall/dsa/dev heatmap tabs composed client-side. Calendars are bucketed by UTC day and rendered as a hand-rolled 53-week grid (no chart lib); the server ships each source's calendar once and the client sums whichever sources the active tab selects.

**Load latency is three stacked caches:** the route's independent Neon reads run in one parallel round-trip (not a waterfall); responses carry `Cache-Control: private, max-age=60`; and the page paints instantly from a per-user localStorage snapshot while revalidating in the background (stale-while-revalidate — the profile fetch also starts in parallel with the auth gate). Warm API call ~0.25s; perceived revisit load ~0ms.

## Handles are encrypted at rest

`user_platform_handles.handle` and `user_platform_stats.payload` are AES-256-GCM ciphertext (`server/crypto/secrets.js`), format `v1:<iv>:<tag>:<ct>`. The key comes from `HANDLE_KEY` in the **app environment** — Render's generated value — and deliberately never goes near Neon. That split is the whole property: `DATABASE_URL` on its own decrypts nothing.

Three decisions worth knowing:

- **Reversible, not hashed.** The server has to send the handle to leetcode.com, codeforces.com and the rest to fetch stats, so a one-way function is impossible. Those five judges receive the username on every cache miss regardless of anything done here.
- **The key is derived, not required verbatim.** `HKDF-SHA256` over whatever `HANDLE_KEY` holds, so any high-entropy secret works. Demanding exactly 32 base64 bytes would have turned Render's `generateValue` into a boot crash.
- **The stats payload is encrypted too.** A 371-day submission calendar plus a rating fingerprints the linked account as well as the handle does; encrypting one and not the other would be theatre.

Boot calls `assertKeyPresent()` and throws without it — a server that started keyless would silently write plaintext, and nobody would notice until they looked in the database. Rows written before migration 0006 have no `v1:` prefix, decrypt to themselves, and get re-encrypted on next write; `node scripts/encrypt_handles.js --write` converts them in bulk. **Rotating `HANDLE_KEY` orphans every existing row** — there is no key-id in the format, so a rotation needs a decrypt-with-old, re-encrypt-with-new pass before the swap.

What this does not do: put the data beyond whoever runs the server. Any operator can read what their own process handles, so the user-facing wording on `/profile.html` says that outright rather than claiming otherwise.

## Versioning and releases

`main` is production (Render autoDeploy). Feature milestones happen on a branch (`v2`, …) and merge with `--no-ff` so one revert rolls the release back. Release order is fixed: (1) green gate (`npm run validate && npm run test:search && npm run test:profile && npm run bench:fast`), (2) **migrate Neon first** (`DATABASE_URL='…' bash db/run-migrations.sh` — migrations are additive-only, so running code ignores new tables and the migration is zero-downtime), (3) merge + push = deploy, (4) live checks. Rollback: Render → redeploy the previous deploy, or `git revert -m 1 <merge>`; additive migrations are left in place. Tags mark releases (`v1.0.0`, …).

## Observability

Hand-rolled, Postgres-backed (the free instance sleeps and its filesystem is wiped on deploy, so Neon is the only durable store): an append-only `events` table (0004) receives fire-and-forget writes — page visits (anonymous cookie id, no IPs), searches (query, ranker, latency, hit count), signups, and boots (cold-start counter with boot time). `/api/stats` aggregates it in one parallel query batch (latency percentiles via `percentile_cont`), cached 5 min; `/stats.html` renders it. Zero-hit queries double as the labeling backlog. v6 adds **outcome events**: every search gets a `searchId`; the client beacons `result_open` (expand/external, with position), `pattern_selected`, `ranker_changed`, `load_more`, and `search_feedback` (useful y/n + optional reason) to an allowlisted `/api/track`; bookmark/done sets are logged server-side. The stats page turns these into a searches→opens→saves funnel, click-through rate per ranker, and recent not-useful reasons.

## Deploy (card-free)

The app is one Docker image: the MiniLM model is baked at build time and the corpus vectors are committed, so a container boots with zero network beyond Postgres (verified with `docker run --network none`). Two free-tier accounts, neither needs a card:

1. **Neon (Postgres):** create a project, copy the **pooled** connection string, append `sslmode=require`. Run migrations once from your machine: `DATABASE_URL='…' bash db/run-migrations.sh`.
2. **Optional `GITHUB_TOKEN`** (Render env + local `.env`): a personal access token with zero scopes — enables exact GitHub contribution data via GraphQL instead of the scrape fallback.
3. **Render (app):** *skip Blueprints — applying one requires a payment method on file.* Instead: Dashboard → New → **Web Service** → pick this GitHub repo (the Dockerfile is auto-detected) → Instance type **Free** → env vars `DATABASE_URL` (from Neon), `JWT_SECRET` and `HANDLE_KEY` (each any long random string, e.g. `openssl rand -base64 32`). **`HANDLE_KEY` must be set before the first deploy that includes it — the app refuses to boot without it**, deliberately, so it can never silently store handles in the clear. Keep it in Render only; putting it anywhere near the database defeats the point of encrypting these columns at all. Optional: health check path `/`. Render injects `PORT` and the app binds it. [render.yaml](../render.yaml) is the reference for these settings.
4. **Verify live:** `/api/rankers` lists `dense` + `hybrid`, `/patterns.html` renders, and a signup → bookmark round-trip works.

Free-tier realities: the instance spins down after ~15 min idle, so the first request after a quiet spell waits ~30–60 s on the platform cold start (the app itself boots in ~1 s — baked model, committed vectors). Memory is fine: ~101 MiB RSS against the 512 MB cap; `DENSE_DISABLED=1` is the escape hatch if that ever changes.

### Custom domain

1. Render → service → Settings → Custom Domains → add `onebysec.com` **and** `www.onebysec.com`; Render prints the DNS values.
2. GoDaddy → DNS: delete the parking `A @` / `CNAME www` records, then add `A @ → <IP Render shows>` (GoDaddy has no ALIAS, so the apex must be an A record) and `CNAME www → <service>.onrender.com`. TLS is issued automatically once DNS resolves.
3. Set `CANONICAL_HOST=onebysec.com` in the Render env — subdomains 301 to the bare host so session cookies (host-only) live on one origin. The `.onrender.com` hostname is deliberately *not* redirected: old links keep working and the health check can't be broken by a 3xx.

Fallback if Render asks for a card anyway: **Hugging Face Spaces** runs Dockerfiles card-free — create a Docker Space, push this repo to it, set `app_port: 3000` in the Space README front matter, and add `DATABASE_URL` + `JWT_SECRET` as Space secrets.

## Layout

```
/server          Express app + ranker implementations
  /search        tokenize / inverted / tfidf / bm25 / embedding / dense / hybrid (+ tests)
  /routes        search + similar + debug + auth + user-state endpoints
  /auth          JWT cookie helpers + auth middleware
  data.js        loads data/problemset_llm/{leetcode,cses,codeforces,atcoder}/*.json at boot
/db              Postgres migrations
/web             plain HTML/CSS/JS, no build step
/data
  /problemset_llm/{leetcode,cses,codeforces,atcoder}/  LLM-annotated problem records
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
- Multi-judge corpus: Codeforces + AtCoder ingest, rating-stratified from 1300 — **shipped** ([experiments/08](../experiments/08-multi-judge-corpus.md))
- Judge filter (`platform=`, clickable result badges) + route-level tests — **shipped**
- Scoped expansion (lexical legs only; dense embeds the raw query) — measured need in exp 07
- Cross-encoder rerank over hybrid's top-50 (candidate floor measured in exp 06)
- Recommendation layer over solved/bookmarked state
- Real scraper for a standard sheet (Striver / NeetCode)
- Per-judge difficulty filter and sort — **shipped** (`server/search/difficulty.js`)
- LeetCode acceptance rate as a within-tier filter and sort tiebreak — **shipped**. Deliberately not a scale: on the full problemset it separates the tiers (AUC 0.677) but on our slice it inverts (0.426), because the Mediums were selected for low acceptance and the Hards weren't. `scripts/backfill_acceptance_rate.py` writes the field; it does not change `corpusHash`, so no re-embed.
- Cross-judge difficulty scale, so difficulty works across judges at once (blocked: CSES has no difficulty, LeetCode has buckets not a scale — see the README's Ideas section)
- Difficulty relative to the signed-in user's rating (the profile already caches CF/AtCoder ratings on the corpus's own scale)
