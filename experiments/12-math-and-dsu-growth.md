# 12 — 33 math / combinatorics / DSU problems, and the family-label rule

**Date:** 2026-08-02
**Corpus:** 3397 → 3430 (AtCoder 124 → 140, Codeforces 1384 → 1401)

## What went in

A hand-written list of ~56 problem names, mostly number theory and
combinatorics with a short DSU tail. Names, not links, for most of them — so
the first job was resolving them, and the second was not adding what was
already there.

| outcome | n | |
| --- | --- | --- |
| added | 33 | 16 AtCoder, 17 Codeforces |
| already in the corpus | 17 | found by URL, not by title |
| unsupported judge | 4 | HackerRank ×3, CodeChef ×1 |
| unresolved | 2 | "Crushed Slimes" (AtCoder), "Choose and Calculate" (Codeforces) |

Resolution used the two indexes the repo already keeps: the cached Codeforces
`problemset.problems` response, and kenkoooo's AtCoder task list. Both are
title → id maps, which is exactly the shape a list of names needs. Dedupe ran
against **normalised source URLs**, not titles — `Chocolate` is three
different Codeforces problems and `Slimes` is four AtCoder ones, so a
title-keyed check would have been wrong in both directions.

Two names were ambiguous enough to be worth stating:

- **Chocolate** → 617B, not 31D or 490D. 617B is tagged `combinatorics` and
  the list it arrived in was combinatorics; the others are DFS and
  meet-in-the-middle.
- **Rectangles** → 844B (`combinatorics`, `math`), not 1028C (geometry).

`Coprime 2` and `Sum of Maximum Weights` resolve, in kenkoooo's data, to
mirror contests (`adt_medium_20231227_2`) rather than the ABC they came from;
the canonical `abc215` URL is used instead.

## The interesting part: the family label

The annotations from `gpt-4.1` were good and specific — `stars-and-bars`,
`euler-totient`, `divisor-enumeration`, `binomial-coefficient`. Specific is
right, and specific alone is unsearchable: **nobody types "stars and bars"
while they are still looking for the trick.** They type "combinatorics".

So `with_families()` (added in v56 for `dp-with-state` → `dynamic-programming`)
gained three rules:

```
stars-and-bars | binomial | permutation-counting | catalan
  | pigeonhole | inclusion-exclusion            → combinatorics
gcd | lcm | divisor | prime | sieve | modular
  | totient | coprime | factorization | euclid   → number-theory
disjoint-set | dsu                               → union-find
```

24 of the 33 new records gained a family label. Applied to the new records
only — re-labelling 3,400 problems is a different change with its own
benchmark, and this isn't it.

The patterns page also gained a `combinatorics` umbrella group, the same fix
`range queries` got: the group only feeds `/api/patterns`, not the ranker, so
it costs nothing and answers a word people type that will never be a label.

## Benchmark

71 queries, four rankers, per-slice. **No regression anywhere**; the movement
is noise plus a little paraphrase gain.

| ranker | P@1 | P@5 | MRR | nDCG@10 | Recall@100 |
| --- | --- | --- | --- | --- | --- |
| tfidf | ±0 | ±0 | ±0 | ±0 | ±0 |
| bm25 | ±0 | ±0 | +0.003 | +0.003 | ±0 |
| dense | ±0 | ±0 | +0.001 | +0.001 | +0.003 |
| hybrid | ±0 | ±0 | +0.001 | +0.004 | ±0 |

Best single slice: hybrid paraphrase nDCG@10 +0.024. Worst: tfidf keyword MRR
−0.001. Growth without dilution, same as experiment 10.

Spot checks after the reindex — each new problem ranks for the technique it
was added for:

| query | top hits |
| --- | --- |
| `stars and bars` | Factorization (atc), Chocolate (cf), Duodecim Ferra (atc) |
| `divisor counting` | Sum of Divisors (atc), Not Divisible (atc), Odd Divisor (cf) |
| `union find offline` | Network Breakdown (cses), Decayed Bridges (atc), Destroying Array (cf) |
| `staircase sequences` | Staircase Sequences (atc) at rank 1 |

## Notes for next time

- The two standalone Codeforces fetchers (`fetch_codeforces.py`,
  `fetch_codeforces_named.py`) both **truncate** `codeforces_statements.json`.
  A partial top-up has to go through `ingest_contest.py`'s `merge_statements`,
  which is what this used. All 17 wanted statements were in the open-r1
  dataset — no pending queue this time.
- AtCoder rate-limits a scrape at roughly one problem per second; two runs hit
  `429` and completed on a retry a minute later.
- AtCoder difficulty comes from `backfill_atcoder_difficulty.py` (kenkoooo's
  IRT model) and has to be run after any AtCoder ingest — the annotator leaves
  `difficulty: null`. 16/16 got one here.
