# Cosine

Search 2,500+ competitive-programming problems the way you actually think about them — by keyword, by describing the idea, or by technique.

**Live at [onebysec.com](https://onebysec.com/)** · [live stats](https://onebysec.com/stats.html) — first load after idle takes ~a minute (free tier waking up); it's fast after that.

![Cosine walkthrough in dark mode](demo/deliverables/walkthrough-dark.gif#gh-dark-mode-only)
![Cosine walkthrough in light mode](demo/deliverables/walkthrough-light.gif#gh-light-mode-only)

## Why this exists

Google "cses euler path" and you get the CSES homepage, a blog post, and Wikipedia — not the actual Euler-path problems. "knapsack leetcode" is no better at surfacing the good knapsack DPs. Site tags help but stop at their site's border and at coarse labels: LeetCode has `dynamic-programming`, but nothing for `digit-dp`, `wqs-binary-search`, or `slope-trick`. And nothing anywhere answers _"I remember the story — a thief robbing houses — what was that problem?"_

Cosine is one search box over LeetCode, CSES, Codeforces and AtCoder that handles all three.

## Finding problems

- **Three search modes, one box.** **keyword** matches words in the title, statement *and* our technique labels — a problem that opens "Alice and Bob play a game…" never says "dp", but its label does, so `game theory dp` still finds it. **meaning** takes plain english: `thief robbing houses` finds House Robber. **both** blends them. Pick one next to the search button; the status line says which answered, and how fast.
- **Technique labels deeper than "dp".** Every problem carries curated pattern labels from a ~165-slug taxonomy — `digit-dp`, `wqs-binary-search`, `slope-trick`, `booth-algorithm`. Click any label to filter results to it; browse the whole taxonomy with per-label counts on the patterns page.
- **Community names just work.** Type "aliens trick" and the query quietly expands to `wqs-binary-search` — the status line shows `+wqs binary search`, so you also learn the canonical name.
- **Find similar.** One click on any result lists its nearest neighbors by meaning (cosine over precomputed vectors, ~1 ms). Built for post-contest upsolving: open the problem that beat you, see its family.
- **Compare rankers.** A toggle runs the same query on bm25 and dense side by side — watch keyword search find nothing for "thief" while semantic nails it.
- **A deliberately hard corpus.** 2,574 problems across four judges: every LeetCode Hard and the lowest-acceptance-rate Mediums (contest Q3/Q4 grade), all of CSES, and Codeforces + AtCoder sampled across rating bands from 1300 up. No Easy filler — the best hard problems beat 4,000 padded ones. Fresh problems flow in through one refresh command, with niche labels human-reviewed before they ship.

## Tracking the grind

- **One profile, every judge.** Save LeetCode / Codeforces / CodeChef / AtCoder / GitHub handles: solved counts and ratings per platform, plus one combined activity heatmap with `dsa` / `dev` / `overall` tabs — because grinding contests and shipping code are both progress.
- **Bookmarks and done-marks** on every result, with a shell-style library (`:bookmarks`, `:done`, Tab cycles views). Done-marks feed the heatmap too.

## Small things that make it nice to use

- **It's a terminal.** Monospace everything, a prompt-style path that follows you (`~/search "graph cycle"`, `~/done`, `~/profile`), a typewriter status line, light/dark themes. Type `:help` and a man page types itself out.
- **Fast on purpose.** Keyword search answers in ~0.1 ms and semantic in ~2 ms; profile revisits paint instantly from a local snapshot and refresh in the background; every view is a shareable deep link (`/?pattern=wqs-binary-search&ranker=dense`).
- **It shows its work.** Latency and ranker on every result set, query expansions made visible, a debug page exposing per-term scoring math, and a public stats page with real usage and live latency percentiles — including cold-start counts, because the free-tier instance sleeps and honesty beats mystery.

## Feedback → fix

A running log of what real users hit, and what changed. Most entries are labeling
or wording, not ranking — that turned out to be the pattern.

| Feedback | Fix |
|---|---|
| "aliens trick" found nothing | Query-side alias expansion — community names now expand to the canonical label |
| The blinking bar under the box looked like the input | Search box takes focus on load; the cursor only shows while the status line types |
| Four ranker names (tfidf/bm25/dense/hybrid) meant nothing | Three modes: **keyword** / **meaning** / **both**, explained in `:help` |
| Stats looked stale on the new domain | Per-origin HTTP cache — window cut to 30s and an "as of" stamp added |
| "mcm dp", "mex" returned nothing | Statements are summaries, so missing terms are missing *labels*; added the vocabulary + an LLM audit loop |
| "flows" returned nothing | No stemmer — added flow aliases and folded 9 scattered flow labels into the canonical set |
| Similarity scores were confusing | Numeric scores are debug-only now; results keep the relative bar |
| Didn't know bookmarks / done / filters existed | `:help` gained a SAVING section and a real explanation of "find similar" |
| A cleared filter came back on refresh | Clearing the pill now drops `?pattern=` from the URL too |
| "LeetCode-only is limiting" | Codeforces and AtCoder added — rating-stratified from 1300 up, no easies |

## Measured

Every ranking decision traces to a 55-query labeled benchmark (P@k, MRR, nDCG@10, Recall@100) with keyword / paraphrase / technique slices — it's why BM25 stays the default and the fancier rankers are opt-in. The numbers and their write-ups live in [experiments/](experiments/).

## Run it

```sh
cp .env.example .env   # fill DATABASE_URL (Neon or local docker) + JWT_SECRET
npm install
npm run db:migrate
npm run dev            # http://localhost:3000
```

Corpus embeddings ship in the repo; the first boot downloads the ~25 MB embedding model once into `.model-cache/`. No database? The app still boots and searches — only accounts/bookmarks need Postgres (`npm run services:start` brings up a local one on :5433).
