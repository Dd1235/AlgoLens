# 10 — An easier Codeforces band, and filters that read your profile

Two changes that both touch difficulty: 217 Codeforces problems rated 800–1000,
and a "my level" control that sets a judge's band from that judge's own stats.

## Growing the corpus downward

The corpus was built hard-focused on purpose, and the 1000–1299 enrichment in
[08](08-multi-judge-corpus.md) was already a step down from that. This adds the
800–1000 band: 80 at 800, 80 at 900, 57 at 1000, stratified and staged by
`scripts/fetch_codeforces.py --min-rating 800 --max-rating 1000`.

The question a corpus change has to answer is whether it dilutes ranking.
`scripts/bench_diff.py` against the pre-growth run, 63 queries:

| ranker | P@1 | P@5 | MRR | nDCG@10 | Recall@100 |
|---|---|---|---|---|---|
| **bm25** (default) | 0.524 → 0.524 | 0.229 → 0.229 | 0.648 → 0.648 | 0.599 → **0.602** | 0.914 → 0.914 |
| dense | 0.381 → 0.381 | 0.210 → 0.210 | 0.558 → 0.558 | 0.544 → 0.544 | 0.847 → 0.847 |
| tfidf | 0.429 → 0.429 | 0.178 → 0.178 | 0.548 → 0.547 | 0.501 → 0.501 | 0.909 → 0.909 |

Flat, which is the good outcome. Displacement — the share of top-5 slots taken
by problems that didn't exist in the baseline — is 2.5% for bm25 and under 3.2%
everywhere. Recall@100 is unchanged on every ranker, so nothing judged-relevant
got crowded out. That combination (flat recall, low displacement) is what
distinguishes "the corpus grew" from "the corpus got worse": easy problems are
being indexed without competing for the queries the benchmark asks.

Four Codeforces problems from the curated sheet stay unreachable and are
recorded in [data/skipped_problems.json](../data/skipped_problems.json) rather
than dropped: contests 2132, 2042 and 2093 postdate the `open-r1/codeforces`
statement dataset, and contest 700 carries only A and B there. Codeforces itself
is Cloudflare-blocked, so there is no second source. Sheet coverage is 230/234.

## "My level", and why it is four heuristics rather than one

With handles saved, the difficulty row offers a chip that fills in a band. The
temptation is one shared scale across judges. That is the same normalization
this project keeps refusing to invent, and it is worse here than in filtering:
a wrong guess about someone's level is a page of problems they can't attempt.

So each judge is read on its own terms, and never used to infer another:

| judge | signal | band |
|---|---|---|
| Codeforces | rating | `[R, R+200]` on the 100-grid |
| AtCoder | rating | `[R, R+200]` on the 200-grid |
| LeetCode | solved counts per tier | a tier, plus an acceptance-rate half |

The rated judges are the easy case, and they're easy for a specific reason:
both scales are *calibrated the same way*. A Codeforces problem rated R is one a
contestant rated R solves about half the time under contest conditions, and
AtCoder's community difficulty estimates carry the same definition. So `[R,
R+200]` means the same thing on both — winnable but not free — without any
conversion between them. Both bands are clamped to what the corpus actually
holds, so a 3500-rated user gets the top of the corpus rather than an empty
window above it.

LeetCode is the real heuristic, because LeetCode publishes no rating. What it
does publish is solved counts per tier, and those cover the whole problemset —
most of which is easier than anything here. That makes the signal coarse, so it
is used coarsely: a four-rung ladder on the Hard count picks a tier, then an
acceptance-rate half within that tier, split at the corpus's own median rather
than an invented cut-off. Volume of Mediums promotes off the gentlest rung,
because someone with 400 Mediums and no Hards is not a beginner even though the
Hard count alone can't tell.

Two constraints make the whole thing safe to ship:

- **Every suggestion carries the count it would produce, and is dropped if that
  count is zero.** A "my level" button that silently empties the page is worse
  than no button. This is asserted for every Codeforces rating on the grid and
  every Hard count from 0 to 400.
- **The suggestion is a `difficulty=` token, parsed by the same filter a human
  click produces.** The tests round-trip it: the token goes through
  `parseSelection` / `passesDifficulty` and has to select exactly the count it
  promised, inside the claimed judge, leaving the others untouched.

`GET /api/level` serves the suggestions and reads **only** the
`user_platform_stats` cache — it never calls a judge. The search page loads on
every visit, and a filter button isn't worth five external round-trips; if the
numbers were never fetched, the chip simply doesn't appear.
