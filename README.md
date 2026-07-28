# Cosine

Search 3,300+ competitive-programming problems the way you actually think about them — by keyword, by describing the idea, or by technique.

**Live at [onebysec.com](https://onebysec.com/)** · [live stats](https://onebysec.com/stats.html) — first load after idle takes ~a minute (free tier waking up); it's fast after that.

(The walkthrough maybe stale, please do check out the live deployment)

![Cosine walkthrough in dark mode](demo/deliverables/walkthrough-dark.gif#gh-dark-mode-only)
![Cosine walkthrough in light mode](demo/deliverables/walkthrough-light.gif#gh-light-mode-only)

## What I'd like feedback on

Four open problems. Each one I've already measured, and each is stuck on a judgement call rather than on code — so an opinion is worth more here than a patch.

**1. Difficulty doesn't cross judges. Should it?**
Filtering and sorting by difficulty work _inside one judge_ and are refused across two, because I can't defend a shared scale. Codeforces ratings are calibrated so a problem rated R is roughly a coin flip for a contestant rated R; AtCoder's community estimates use the same definition but a different population; LeetCode has three buckets and no rating. I tried acceptance rate as the bridge and measured it: it separates LeetCode's tiers on the full problemset (AUC 0.677) but **inverts on this corpus** (0.426), because most Mediums here were selected _for_ low acceptance while every Hard came in unfiltered. So the honest options look like (a) anchor on people who compete on several judges and fit a mapping from their ratings, (b) infer difficulty from solve counts and accept the population bias, or (c) stay per-judge forever and make that legible in the UI. **Which would you actually trust a recommendation from?**

**2. CSES publishes no difficulty at all — 400 problems, 12.5% of the corpus.**
They're invisible to every difficulty filter and every sort, which is bad because they're some of the best problems here. The CSES book is _roughly_ ordered within each section, so a section-relative signal ("hard for a Range Queries problem") is derivable. **Is that useful, or is a relative-only number more misleading than none?** The alternative is inferring difficulty from done-marks once there's enough traffic, which needs users I don't have yet.

**3. Are the "my level" heuristics right?** Details in [Tracking the grind](#how-my-level-picks-a-band) below. Specifically:

- **Codeforces / AtCoder:** the band is `[your rating, +200]`. Is that the right window, or should it start below you (`R-100`) so there's warm-up in it? Standard practice advice says solve _above_ your rating; the band takes that literally.
- **AtCoder:** I compare your AtCoder rating against AtCoder problem difficulties, which is scale-consistent — but is it _true_ in practice, or does the AtCoder rating distribution sit differently against its own difficulty estimates than Codeforces does?
- **LeetCode:** there's no rating, so it reads solved counts and picks a tier plus an acceptance-rate half. The rungs are at 10 / 25 / 100 Hards. Those numbers are a guess. Worse, LeetCode's counts cover the whole problemset, most of which is far easier than anything here — so someone with 300 Mediums solved may have solved 300 easy Mediums. **Is there a better signal LeetCode actually exposes?**

**4. Umbrella terms, and the one label I still can't fill.**
Searching the technique directory for "range queries" used to return nothing — the vocabulary is all leaves (`segment-tree`, `sparse-table`, `mo-algorithm`) with no node above them. There are 11 umbrella groups now; **which ones are still missing?** Separately: `sparse-table` sits on exactly 1 problem (CSES's _Static Range Minimum Queries_) and `prim` on none. Three LLM audit passes over ~180 candidates — static-RMQ problems, LCA problems, every segment-tree problem — produced zero more, and neither judge tags "sparse table" so I can't go fetch them either. The likely truth is that both are _implementations_ rather than problem types: a sparse table is a subroutine inside an LCA solution, and MST problems get solved with Kruskal. **If you know a problem here where a sparse table is genuinely the point, that's the most useful bug report I could get.**

Open an issue, or mail me or send me a text on wa or linkedin — see [Feedback → fix](#feedback--fix) for what previous rounds changed.

## Why this exists

Google "cses euler path" and you get the CSES homepage, a blog post, and Wikipedia — not the actual Euler-path problems. "knapsack leetcode" is no better at surfacing the good knapsack DPs. Site tags help but stop at their site's border and at coarse labels: LeetCode has `dynamic-programming`, but nothing for `digit-dp`, `wqs-binary-search`, or `slope-trick`. And nothing anywhere answers _"I remember the story — a thief robbing houses — what was that problem?"_

Cosine is one search box over LeetCode, CSES, Codeforces and AtCoder that handles all three.

## What that looks like

Real output from the live corpus, same query run both ways. **keyword** is BM25 over titles, statements and technique labels; **meaning** is cosine over sentence embeddings. Neither wins everywhere, which is why you can switch.

| query                  | keyword (bm25)                                                                                         | meaning (dense)                                                                                               |                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cat and mouse`        | Cat and Mouse · Cat and Mouse II · Mice and Cheese — **4 hits, all of them the ones you meant**        | Cat and Mouse II · Cat and Mouse · Mice and Cheese · Design a Text Editor · Food Buckets to Feed the Hamsters | exact words → exact answers; semantic drifts into "small animal" territory                                                                             |
| `cheese`               | Mice and Cheese. That's it — **one hit**                                                               | Giant Pizza · Hamburgers · Mice and Cheese · Pizza With 3n Slices · Banquet Preparations                      | no problem is _about_ cheese, so keyword has nothing to match. Meaning finds the food cluster anyway                                                   |
| `thief robbing houses` | House Robber · House Robber II · Count the Number of Houses at a Certain Distance II                   | House Robber · House Robber II · **Diamond Theft** · Profitable Schemes                                       | you remember the story, not the title. Keyword rides the word "house" into unrelated house problems; meaning finds the heist that never says "rob"     |
| `aliens trick`         | Best Time to Buy and Sell Stock IV · Minimum Partition Score · Min Total Space Wasted With K Resizings | Design Tutorial: Increase the Constraints · Qpwoeirut and Vertices · Planets Queries I                        | **the reversal.** "aliens trick" expands to `wqs-binary-search` and keyword nails it; the embedding model has never heard the phrase and returns noise |
| `string dp graph`      | **Longest Palindromic Path in Graph** — tagged `graph` + `dynamic-programming` + `string`, all three   | Interleaving String · Strange Printer                                                                         | stack technique words and the top hit is the problem that carries all of them                                                                          |
| `mex set`              | Sliding Window Mex · MEX Queries · Maximize Mex                                                        | MEX Queries · Mex Grid Construction · Sliding Window Mex                                                      | niche vocabulary. No judge tags `mex`, so this search doesn't exist anywhere else                                                                      |
| `sweep line`           | Intersection Points · Perfect Rectangle · Area of Rectangles                                           | Lines and Queries II · Line Segments Trace I · Erect the Fence                                                | the word "sweep" appears in **zero** problem statements — only the labels carry it                                                                     |

The pattern: **keyword wins when you know the vocabulary** — a technique name, a title fragment, a community nickname. **Meaning wins when you only remember what the problem was about.** Typing a problem's exact name always puts that problem first, whichever mode you're in.

## Finding problems

- **Two search modes, one box.** **keyword** matches words in the title, statement _and_ our technique labels — a problem that opens "Alice and Bob play a game…" never says "dp", but its label does, so `game theory dp` still finds it. **meaning** takes plain english: `thief robbing houses` finds House Robber. Pick one next to the search button; the status line says which answered, and how fast. (A third mode, `hybrid`, was retired: fusing the two inherited semantic search's inability to return zero results, so nonsense queries came back confident.)
- **Technique labels deeper than "dp".** Every problem carries curated pattern labels from a ~165-slug taxonomy — `digit-dp`, `wqs-binary-search`, `slope-trick`, `booth-algorithm`. Click any label to filter results to it; browse the whole taxonomy with per-label counts on the patterns page.
- **Umbrella terms, because the taxonomy is all leaves.** Looking up "range queries" used to return nothing: the vocabulary has `segment-tree`, `sparse-table`, `sqrt-decomposition` and `mo-algorithm`, but nothing said what they had in common. Groups now sit above the labels — and only fill silence, so typing "tree" still lists every label containing "tree" rather than being swapped for a curated family. The same pass fixed a plainer bug: the filter compared prose to slugs, so "segment tree" never matched `segment-tree`.
- **A page for what exists.** You can't search for a technique you've never heard of, and most people's exposure stops at one sheet. The patterns page lists all 165 labels with counts and a filter: type `dp` and get the whole family — `digit-dp`, `tree-dp`, `slope-trick`, `state-compression` — each clickable into the problems carrying it. It's a directory, not a tutorial, and it stays out of the search page.
- **Community names just work.** Type "aliens trick" and the query quietly expands to `wqs-binary-search` — the status line shows `+wqs binary search`, so you also learn the canonical name.
- **Difficulty, on each judge's own terms.** Select a judge and its native scale appears: Easy/Medium/Hard for LeetCode, a from/to rating range for Codeforces and AtCoder — set both ends the same and you get exactly 1500-rated problems, which fixed bands couldn't express. There is deliberately no shared scale — a CF 1600 is not "the same as" a LeetCode Medium and pretending otherwise would be a lie — so a band filters only its own judge and leaves the others alone. CSES publishes no difficulty, so it simply offers none. Pick a LeetCode tier and an **acceptance-rate range** appears under it, because three buckets are too coarse for 661 Mediums — `hard` + `10-30%` is the hardest Hards. It's offered only _after_ a tier is chosen, and that restriction is the interesting part: across tiers the number lies in this corpus. The same rule governs **sorting**: pick one judge and you can order easiest- or hardest-first; pick two and the option isn't offered, because nothing places a Medium against a 1600. While searching, sorting reorders the top 20/50/100 by relevance rather than re-picking from the whole match set — otherwise "sort by difficulty" silently discards the ranking you searched for and hands back the corpus's easiest problems.
- **Filters that stack.** Judges are a set, not a choice — toggle `lc` `cses` `cf` `atc` above the results, or click the tag on any card. They compose with technique labels, with done/not-done, and with your saved lists: `:bookmarks` + `cf`+`atc` + not-done is your unfinished Codeforces and AtCoder saves. Judges persist across searches; a technique label doesn't, because it's a drill-down into what you were reading and the median label covers a single problem. Shareable as `?platform=codeforces,atcoder`.
- **Find similar.** One click on any result lists its nearest neighbors by meaning (cosine over precomputed vectors, ~1 ms). Built for post-contest upsolving: open the problem that beat you, see its family.
- **Compare rankers.** `:compare thief robbing houses` runs the query on bm25 and dense side by side with rank deltas — watch keyword search find nothing for "cheese" while semantic nails it. A command rather than permanent chrome, since it's an engine-tuning tool.
- **Where a proxy metric stops being honest.** Acceptance rate looks like a free difficulty scale, and on the full LeetCode problemset it is one — median Medium 57.5%, Hard 47.3%, AUC 0.677. Measured on _my_ slice it inverts to 0.426: served Hards look easier than served Mediums. Not a data bug — 554 of 661 Mediums were selected _because_ they had the lowest acceptance rates, while every Hard came in unfiltered. So it ships as a within-tier filter and a within-tier sort tiebreak, never a scale. Inside one tier the selection bias is gone and the number is just the number.
- **A deliberately hard corpus.** 3,384 problems across four judges: every LeetCode Hard and the lowest-acceptance-rate Mediums (contest Q3/Q4 grade), all of CSES, and Codeforces sampled across rating bands from 800 up and AtCoder from its own scale. The 800–1000 band exists so a filter set to a beginner's rating has something to return; it was added and benchmarked, and moved nothing — bm25 flat on every metric, Recall@100 unchanged, 2.5% of top-5 slots displaced ([experiments/10](experiments/10-easy-band-and-level-filters.md)). No Easy filler — the best hard problems beat 4,000 padded ones. Fresh problems flow in through one refresh command, with niche labels human-reviewed before they ship.

## Tracking the grind

- **Filters that know your level.** With handles saved, a `my level` chip sets each selected judge's band from _that judge's own_ numbers — never a shared scale. Hover it to see the reasoning and how many problems it selects; press it again to drop it. Exactly how it decides is below.
- **One profile, every judge.** Save LeetCode / Codeforces / CodeChef / AtCoder / GitHub handles: solved counts and ratings per platform, plus one combined activity heatmap with `dsa` / `dev` / `overall` tabs — because grinding contests and shipping code are both progress.
- **Your handles are encrypted, and the claim stops where the truth does.** Linked usernames and the stats fetched with them are AES-256-GCM ciphertext; the key lives in the app environment, never in the database, so a database copy is unreadable on its own. No other user can see them — there's no public profile and no leaderboard. The judges themselves necessarily receive the username when your stats are fetched, and I won't claim "not even the admin can see it", because I run the server and that would be false. It isn't stored readably, deleting is immediate, and the code is here to check.
- **Bookmarks and done-marks** on every result, with a shell-style library (`:bookmarks`, `:done`, Tab cycles views). Done-marks feed the heatmap too.

### How "my level" picks a band

Three heuristics, one per judge, and **no judge is ever used to infer another** — that's the cross-judge normalization I don't have (see [feedback](#what-id-like-feedback-on) #1). A wrong guess about someone's level is a page of problems they can't attempt, so each judge is read only on its own scale.

| judge      | signal it reads        | band it sets                                 |
| ---------- | ---------------------- | -------------------------------------------- |
| Codeforces | your rating            | `[R, R+200]`, snapped to the 100-grid        |
| AtCoder    | your rating            | `[R, R+200]`, snapped to the 200-grid        |
| LeetCode   | solved counts per tier | one tier + an acceptance-rate half within it |

**Why the rated judges are the easy case.** Both scales are calibrated the same way: a problem rated R is one a contestant rated R solves about half the time under contest conditions, and AtCoder's community difficulty estimates carry that same definition. So `[R, R+200]` means the same thing on both — winnable but not free — with no conversion between them. Both ends are clamped to what the corpus actually holds, so a 3500-rated user gets the top of the corpus instead of an empty window above it, and a beginner gets the bottom.

**LeetCode is the real heuristic**, because LeetCode publishes no rating. What it does publish is solved counts per tier, so a four-rung ladder on the Hard count picks a tier, then which half of that tier's acceptance-rate range to use — split at the corpus's own median rather than an invented cut-off. Lower acceptance means harder, so the "gentler half" is the higher-acceptance one.

| hards solved | tier   | half of the tier | reading                       |
| ------------ | ------ | ---------------- | ----------------------------- |
| under 10     | Medium | gentler          | still building Medium fluency |
| 10–24        | Medium | sharper          | comfortable with Mediums      |
| 25–99        | Hard   | gentler          | Hards are working             |
| 100+         | Hard   | sharper          | Hards are routine             |

Volume of Mediums promotes off the gentlest rung: 100+ Mediums with no Hards is not a beginner, even though the Hard count alone can't tell. **Treat this one as coarse** — LeetCode's counts cover the whole problemset, most of which is easier than anything in this corpus, so 300 Mediums solved may be 300 easy Mediums.

Two rules keep it safe rather than clever: every suggestion **carries the count it would produce and is dropped if that count is zero** (a button that silently empties the page is worse than no button), and the suggestion is a plain `difficulty=` token parsed by the same filter a human click produces — the tests round-trip it and assert the promised count is the real one. `GET /api/level` reads only the cached profile stats and never calls a judge, so the search page never waits on leetcode.com; if the numbers were never fetched, the chip just doesn't appear.

## Small things that make it nice to use

- **The URL is the state.** Query, judges, difficulty, sort, pattern, ranker and filter all live in the address bar, so refresh keeps your place, back leaves in one step, and copying the URL shares exactly what you're looking at (`/?q=knapsack&platform=codeforces,atcoder&ranker=dense`).
- **It's a terminal.** Monospace everything, a prompt-style path that follows you (`~/search "graph cycle"`, `~/done`, `~/profile`), a typewriter status line, light/dark themes. Type `:help` and a man page types itself out.
- **Fast on purpose.** Keyword search answers in ~0.1 ms and semantic in ~2 ms; profile revisits paint instantly from a local snapshot and refresh in the background.
- **It shows its work.** Latency and ranker on every result set, query expansions made visible, a debug page exposing per-term scoring math, and a public stats page with real usage and live latency percentiles — including cold-start counts, because the free-tier instance sleeps and honesty beats mystery.

## Feedback → fix

A running log of what real users hit, and what changed. Most entries are labeling
or wording, not ranking — that turned out to be the pattern.

| Feedback                                                               | Fix                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "aliens trick" found nothing                                           | Query-side alias expansion — community names now expand to the canonical label                                                                                                                                                                                         |
| The blinking bar under the box looked like the input                   | Search box takes focus on load; the cursor only shows while the status line types                                                                                                                                                                                      |
| Four ranker names (tfidf/bm25/dense/hybrid) meant nothing              | Three modes: **keyword** / **meaning** / **both**, explained in `:help`                                                                                                                                                                                                |
| Stats looked stale on the new domain                                   | Per-origin HTTP cache — window cut to 30s and an "as of" stamp added                                                                                                                                                                                                   |
| "mcm dp", "mex" returned nothing                                       | Statements are summaries, so missing terms are missing _labels_; added the vocabulary + an LLM audit loop                                                                                                                                                              |
| "flows" returned nothing                                               | No stemmer — added flow aliases and folded 9 scattered flow labels into the canonical set                                                                                                                                                                              |
| Similarity scores were confusing                                       | Numeric scores are debug-only now; results keep the relative bar                                                                                                                                                                                                       |
| Didn't know bookmarks / done / filters existed                         | `:help` gained a SAVING section and a real explanation of "find similar"                                                                                                                                                                                               |
| A cleared filter came back on refresh                                  | Clearing the pill now drops `?pattern=` from the URL too                                                                                                                                                                                                               |
| "LeetCode-only is limiting"                                            | Codeforces and AtCoder added — rating-stratified from 1300 up, no easies                                                                                                                                                                                               |
| "sweep line finds nothing, and CF tags don't have that keyword"        | Correct — Codeforces has no sweepline tag at all. Fixed by auditing the corpus for the technique directly; 17 problems gained the label                                                                                                                                |
| "can I see only Codeforces problems?"                                  | Click the judge tag on any result; combine several, clear with the pill                                                                                                                                                                                                |
| The "searching" line was distracting while typing                      | It animated one character at a time while the answer was already back — now it only appears if a search actually takes over 400ms                                                                                                                                      |
| "where is filter by judge?"                                            | It shipped as clickable result tags only, which nobody could see — added a plain dropdown next to the search box                                                                                                                                                       |
| Judge filter was one-at-a-time, and saved lists ignored it entirely    | Judges are now a multi-select chip set, and `:bookmarks` / `:done` / `:all` respect judge + done filters                                                                                                                                                               |
| The compare checkbox was clutter for anyone not tuning the engine      | Moved to a `:compare <query>` command                                                                                                                                                                                                                                  |
| Refreshing threw away the search                                       | The address bar now mirrors query + judges + pattern + ranker + filter, so refresh and bookmarking keep the view                                                                                                                                                       |
| Clicking a pattern chip could show 0 results                           | A filter with no query now browses that label instead of searching within your last one — `line-sweep` shows all 40, not the 0 that matched "cycle"                                                                                                                    |
| Should a pattern filter survive a new query?                           | No — measured it: carrying a label into a new query dead-ends in 9 of 25 cases, a judge in 0 of 20. Labels drop when you type, judges stay                                                                                                                             |
| "no section on what patterns even exist — I only know Striver's sheet" | Searches now name the technique family above the results, and the patterns page is filterable and out of the dev-tools nav                                                                                                                                             |
| "pick topics + difficulty, get 3 random problems"                      | Not shipped. The difficulty half can't work — 16% of the corpus has no difficulty and a band leaves 1-3 candidates per topic. A shuffle was tried and reverted: one label at a time is too narrow to be worth the chrome                                               |
| "2-sum was 10-11th, not first"                                         | Worse than reported — rank 28. Typing a problem's exact name now puts that problem first; `two sum`, `2 sum` and `3 sum` all work                                                                                                                                      |
| "hybrid returns results for a random name"                             | Semantic search gives every problem some similarity, so it can never return zero. Hybrid retired; a query whose words appear nowhere in the corpus now says so                                                                                                         |
| "UI for phone wasn't as good as desktop"                               | The search bar overflowed by ~200px and was being hidden rather than fixed. Full mobile pass: form restacks, inputs no longer trigger iOS zoom, heatmap and stats table scroll, tap targets from ~16px to 34px                                                         |
| "AVL tree and niche techniques missing"                                | AVL is a textbook structure, not a contest technique — `avl tree` now routes to the ordered-set problems the corpus actually has                                                                                                                                       |
| "can I filter by difficulty?"                                          | Per judge, on its own scale — LeetCode tiers, Codeforces and AtCoder rating bands. A band never filters a judge you didn't pick. Codeforces also grew 250 problems in the 1000–1299 range so the easier band has content                                               |
| "sort/filter by acceptance rate within Hards and Mediums"              | Shipped, scoped to one tier. Backfilled `acceptance_rate` onto all 1,434 LeetCode problems — and because `corpusHash` covers only the indexed text, it needed no re-embed                                                                                              |
| "can I sort by difficulty? load more gets tricky"                      | It does. A sorted search is one fixed window of the best matches, so paging is withdrawn rather than left to produce an incoherent page 2 — you pick the window instead (top 20/50/100). Browsing has no ranking to protect, so it sorts everything and pages normally |

## Measured

Every ranking decision traces to a 55-query labeled benchmark (P@k, MRR, nDCG@10, Recall@100) with keyword / paraphrase / technique slices — it's why BM25 stays the default and the fancier rankers are opt-in. The numbers and their write-ups live in [experiments/](experiments/).

## Ideas

Things worth building, and the honest reason they aren't built yet.

- **One difficulty scale across all four judges.** The biggest missing piece, and the first thing I'd like an opinion on — the constraints and the measurements are written out in [What I'd like feedback on](#what-id-like-feedback-on). Short version: filtering and sorting shipped _per judge_, which sidesteps the hard part rather than solving it, and CSES's 400 problems (12.5% of the corpus) carry no difficulty at all.
- **Difficulty relative to you** — shipped as the `my level` chip, per judge ([how it works](#how-my-level-picks-a-band)). It covers the 1,350 rated Codeforces and AtCoder problems directly and LeetCode through a coarser proxy; CSES still has nothing to go on.
- **Multi-technique queries, and the practice set they'd unlock.** `fenwick graph` doesn't return problems that need both — BM25 scores one bag of words, so the rarer term wins and you get mostly Fenwick problems. Running each technique as its own query and drawing a stratified sample across them would fix that, and it's also the shape a "give me N problems for OA prep" feature needs. Both want the same missing piece — a difficulty scale that works across four judges — which is why that scale is the highest-value next thing rather than another judge.
- **Recommendations from what you've solved.** Done-marks plus ratings are enough for a rule-based "next problem" heuristic before anything fancier is warranted.

**On feasibility:** latency isn't the obstacle for any of these. Sorting or banding an already-ranked result list costs well under a millisecond at this corpus size — the same place the judge filter does its work, after ranking and before paging. The obstacle is a common difficulty scale across four judges. The second obstacle turned out to be a product decision rather than an engineering one — ordering by anything other than relevance has to say what happens to the ranking, and to paging, before it can be built; per-judge sort ships because answering that for one judge is honest, and answering it for four isn't.

## What gets logged

Search counts, latency percentiles and a click-through funnel go to a Postgres `events` table and surface on [/stats.html](https://onebysec.com/stats.html). No IPs, no user agents — an anonymous cookie id, plus your user id if you're signed in.

Two things learned the hard way and now fixed in code:

- **Only the deployed app writes events** (`NODE_ENV=production`). Local development points `DATABASE_URL` at the same database, so without that gate every dev restart and test query lands in the public stats — which is exactly what happened: two thirds of recorded "visitors" turned out to be a curl loop, and the top-queries list was a load test. Numbers you publish have to come from real usage or they're not numbers.
- **The search counter counts keystrokes, not questions.** Typing is debounced, so `graph` logs `g`, `gr`, `gra`… Measured at 38% of search events being a prefix of the next one typed within 5 seconds. Worth knowing before reading any total on that page.

## Run it

```sh
cp .env.example .env   # fill DATABASE_URL (Neon or local docker) + JWT_SECRET
npm install
npm run db:migrate
npm run dev            # http://localhost:3000
```

Corpus embeddings ship in the repo; the first boot downloads the ~25 MB embedding model once into `.model-cache/`. No database? The app still boots and searches — only accounts/bookmarks need Postgres (`npm run services:start` brings up a local one on :5433).
