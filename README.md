# Cosine

Search 2,500+ competitive-programming problems the way you actually think about them — by keyword, by describing the idea, or by technique.

**Live at [onebysec.com](https://onebysec.com/)** · [live stats](https://onebysec.com/stats.html) — first load after idle takes ~a minute (free tier waking up); it's fast after that.

(The walkthrough maybe stale, please do check out the live deployment)

![Cosine walkthrough in dark mode](demo/deliverables/walkthrough-dark.gif#gh-dark-mode-only)
![Cosine walkthrough in light mode](demo/deliverables/walkthrough-light.gif#gh-light-mode-only)

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

The pattern: **keyword wins when you know the vocabulary** — a technique name, a title fragment, a community nickname. **Meaning wins when you only remember what the problem was about.** `both` fuses the two rankings when you're not sure which you are.

## Finding problems

- **Three search modes, one box.** **keyword** matches words in the title, statement _and_ our technique labels — a problem that opens "Alice and Bob play a game…" never says "dp", but its label does, so `game theory dp` still finds it. **meaning** takes plain english: `thief robbing houses` finds House Robber. **both** blends them. Pick one next to the search button; the status line says which answered, and how fast.
- **Technique labels deeper than "dp".** Every problem carries curated pattern labels from a ~165-slug taxonomy — `digit-dp`, `wqs-binary-search`, `slope-trick`, `booth-algorithm`. Click any label to filter results to it; browse the whole taxonomy with per-label counts on the patterns page.
- **Community names just work.** Type "aliens trick" and the query quietly expands to `wqs-binary-search` — the status line shows `+wqs binary search`, so you also learn the canonical name.
- **Filters that stack.** Judges are a set, not a choice — toggle `lc` `cses` `cf` `atc` above the results, or click the tag on any card. They compose with technique labels, with done/not-done, and with your saved lists: `:bookmarks` + `cf`+`atc` + not-done is your unfinished Codeforces and AtCoder saves. Judges persist across searches; a technique label doesn't, because it's a drill-down into what you were reading and the median label covers a single problem. Shareable as `?platform=codeforces,atcoder`.
- **Find similar.** One click on any result lists its nearest neighbors by meaning (cosine over precomputed vectors, ~1 ms). Built for post-contest upsolving: open the problem that beat you, see its family.
- **Compare rankers.** `:compare thief robbing houses` runs the query on bm25 and dense side by side with rank deltas — watch keyword search find nothing for "cheese" while semantic nails it. A command rather than permanent chrome, since it's an engine-tuning tool.
- **A deliberately hard corpus.** 2,575 problems across four judges: every LeetCode Hard and the lowest-acceptance-rate Mediums (contest Q3/Q4 grade), all of CSES, and Codeforces + AtCoder sampled across rating bands from 1300 up. No Easy filler — the best hard problems beat 4,000 padded ones. Fresh problems flow in through one refresh command, with niche labels human-reviewed before they ship.

## Tracking the grind

- **One profile, every judge.** Save LeetCode / Codeforces / CodeChef / AtCoder / GitHub handles: solved counts and ratings per platform, plus one combined activity heatmap with `dsa` / `dev` / `overall` tabs — because grinding contests and shipping code are both progress.
- **Your handles are encrypted, and the claim stops where the truth does.** Linked usernames and the stats fetched with them are AES-256-GCM ciphertext; the key lives in the app environment, never in the database, so a database copy is unreadable on its own. No other user can see them — there's no public profile and no leaderboard. The judges themselves necessarily receive the username when your stats are fetched, and I won't claim "not even the admin can see it", because I run the server and that would be false. It isn't stored readably, deleting is immediate, and the code is here to check.
- **Bookmarks and done-marks** on every result, with a shell-style library (`:bookmarks`, `:done`, Tab cycles views). Done-marks feed the heatmap too.

## Small things that make it nice to use

- **The URL is the state.** Query, judges, pattern, ranker and filter all live in the address bar, so refresh keeps your place, back leaves in one step, and copying the URL shares exactly what you're looking at (`/?q=knapsack&platform=codeforces,atcoder&ranker=dense`).
- **It's a terminal.** Monospace everything, a prompt-style path that follows you (`~/search "graph cycle"`, `~/done`, `~/profile`), a typewriter status line, light/dark themes. Type `:help` and a man page types itself out.
- **Fast on purpose.** Keyword search answers in ~0.1 ms and semantic in ~2 ms; profile revisits paint instantly from a local snapshot and refresh in the background.
- **It shows its work.** Latency and ranker on every result set, query expansions made visible, a debug page exposing per-term scoring math, and a public stats page with real usage and live latency percentiles — including cold-start counts, because the free-tier instance sleeps and honesty beats mystery.

## Feedback → fix

A running log of what real users hit, and what changed. Most entries are labeling
or wording, not ranking — that turned out to be the pattern.

| Feedback                                                            | Fix                                                                                                                                     |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| "aliens trick" found nothing                                        | Query-side alias expansion — community names now expand to the canonical label                                                          |
| The blinking bar under the box looked like the input                | Search box takes focus on load; the cursor only shows while the status line types                                                       |
| Four ranker names (tfidf/bm25/dense/hybrid) meant nothing           | Three modes: **keyword** / **meaning** / **both**, explained in `:help`                                                                 |
| Stats looked stale on the new domain                                | Per-origin HTTP cache — window cut to 30s and an "as of" stamp added                                                                    |
| "mcm dp", "mex" returned nothing                                    | Statements are summaries, so missing terms are missing _labels_; added the vocabulary + an LLM audit loop                               |
| "flows" returned nothing                                            | No stemmer — added flow aliases and folded 9 scattered flow labels into the canonical set                                               |
| Similarity scores were confusing                                    | Numeric scores are debug-only now; results keep the relative bar                                                                        |
| Didn't know bookmarks / done / filters existed                      | `:help` gained a SAVING section and a real explanation of "find similar"                                                                |
| A cleared filter came back on refresh                               | Clearing the pill now drops `?pattern=` from the URL too                                                                                |
| "LeetCode-only is limiting"                                         | Codeforces and AtCoder added — rating-stratified from 1300 up, no easies                                                                |
| "sweep line finds nothing, and CF tags don't have that keyword"     | Correct — Codeforces has no sweepline tag at all. Fixed by auditing the corpus for the technique directly; 17 problems gained the label |
| "can I see only Codeforces problems?"                               | Click the judge tag on any result; combine several, clear with the pill                                                                 |
| The "searching" line was distracting while typing                   | It animated one character at a time while the answer was already back — now it only appears if a search actually takes over 400ms       |
| "where is filter by judge?"                                         | It shipped as clickable result tags only, which nobody could see — added a plain dropdown next to the search box                        |
| Judge filter was one-at-a-time, and saved lists ignored it entirely | Judges are now a multi-select chip set, and `:bookmarks` / `:done` / `:all` respect judge + done filters                                |
| The compare checkbox was clutter for anyone not tuning the engine   | Moved to a `:compare <query>` command                                                                                                   |
| Refreshing threw away the search | The address bar now mirrors query + judges + pattern + ranker + filter, so refresh and bookmarking keep the view |
| Clicking a pattern chip could show 0 results | A filter with no query now browses that label instead of searching within your last one — `line-sweep` shows all 40, not the 0 that matched "cycle" |
| Should a pattern filter survive a new query? | No — measured it: carrying a label into a new query dead-ends in 9 of 25 cases, a judge in 0 of 20. Labels drop when you type, judges stay |
| "no section on what patterns even exist — I only know Striver's sheet" | Searches now name the technique family above the results, and the patterns page is filterable and out of the dev-tools nav |
| "pick topics + difficulty, get 3 random problems" | Shipped the half the data supports: shuffle on any browse. The difficulty half can't work — 16% of the corpus has no difficulty and a band leaves 1-3 candidates per topic |

## Measured

Every ranking decision traces to a 55-query labeled benchmark (P@k, MRR, nDCG@10, Recall@100) with keyword / paraphrase / technique slices — it's why BM25 stays the default and the fancier rankers are opt-in. The numbers and their write-ups live in [experiments/](experiments/).

## Ideas

Things worth building, and the honest reason they aren't built yet.

- **Filter or sort by difficulty.** Blocked on data, not code. CSES's 400 problems (15% of the corpus) carry no difficulty at all, LeetCode has three buckets rather than a scale, and AtCoder's community-estimated ratings aren't Codeforces ratings — they go negative. Ordering four judges together needs a normalization decision first; picking one badly is worse than not having the feature.
- **Sort by difficulty instead of relevance.** As a re-sort of the top N, not the whole match set — sorting everything throws away the ranking you searched for.
- **Difficulty relative to you, not absolute.** "Show me problems a bit above my level" is the version that's actually useful. Closer than it looks: your Codeforces and AtCoder ratings are already fetched and cached for the profile page, and they're already on the same scale as the problems' own ratings. It would work today for the 741 rated problems and needs a mapping for the rest.
- **Recommendations from what you've solved.** Done-marks plus ratings are enough for a rule-based "next problem" heuristic before anything fancier is warranted.

**On feasibility:** latency isn't the obstacle for any of these. Sorting or banding an already-ranked result list costs well under a millisecond at this corpus size — the same place the judge filter does its work, after ranking and before paging. The obstacles are a common difficulty scale across four judges, and the fact that ordering by anything other than relevance is a different product decision than it first appears.

## Run it

```sh
cp .env.example .env   # fill DATABASE_URL (Neon or local docker) + JWT_SECRET
npm install
npm run db:migrate
npm run dev            # http://localhost:3000
```

Corpus embeddings ship in the repo; the first boot downloads the ~25 MB embedding model once into `.model-cache/`. No database? The app still boots and searches — only accounts/bookmarks need Postgres (`npm run services:start` brings up a local one on :5433).
