# 11 — a technique name is one phrase, not three words

A tester reported three technique names that don't resolve, and correctly
diagnosed the shape of it: *"some sort of grouping like square root
decomposition is one single topic and not 2 topics."*

All three reproduced on production, and all three turned out to be the same
defect at different depths.

## What was wrong

**No benchmark covered any of it.** Zero of the 63 bench queries mentioned
sqrt, z-algorithm, dsu-on-tree or small-to-large, so there was no way to tell
whether a fix helped. Eight queries were added to the `technique` slice first
(63 → 71), including two typos, and the baseline recorded before anything
changed.

| query | bm25 P@5 before |
|---|---|
| `square root decomposition` | **0.00** |
| `sqrt decomposition` | **1.00** |

That pair is the whole story. Same technique, same 21 problems, and the
difference is entirely vocabulary: the documents carry the token `sqrt`, which
the spelled-out phrase never contains, while `square` (idf 4.11) and `root`
(idf 4.65) both fire on problems about arithmetic square roots.

**Two techniques were split across two labels each.** `dsu-on-tree` was not in
the taxonomy at all — a drift label on 3 problems — while
`small-to-large-merging` was canonical on a *different* problem. The two names
indexed **disjoint document sets**, which is why the tester got different
results from each, and why which one "worked" depended on the ranker. Same for
`z-algorithm` (drift, 2 problems) against canonical `z-function` (3).

**A short alias fired inside a long one.** `dsu on trees` matched `dsu →
union-find`, adding `union` (df 132) and `find` (df 1151), dragging BM25 onto
the 105 generic union-find problems. The expander had no consumption: the
working string was never mutated, so every matching rule fired and nothing
suppressed an overlap.

## What was tried

**(A) Fold the labels, add the missing aliases, keep expansion append-only.**
`dsu-on-tree` becomes canonical (the name people actually search), the others
fold into it. Technique slice nDCG@10 **0.433 → 0.517**, no slice regressed.

**(B) Consume the matched span for every multi-word alias.** Better precision —
`square root decomposition` reached 1.00 — but **Recall@100 fell 0.014** on
bm25, tfidf and hybrid. All of it came from two queries:

```
sum over subsets dp bitmask            Recall@100 1.000 -> 0.500
sum over subsets bitmask dp transform  Recall@100 1.000 -> 0.500
```

Consuming that span drops `subsets`, and the relevant problems genuinely
contain that word. So blanket consumption trades real signal for noise
reduction.

**(C) Consumption as an opt-in list.** The distinction is not "how many words"
but *whether the alias's own words point somewhere else*. `square`, `root` and
`large` lead to arithmetic and sample-size problems; `subsets` leads to the
right ones. Nine aliases are marked `consumingAliases` in the taxonomy;
everything else stays append-only.

## Result — variant C shipped

Against the 71-query benchmark, versus baseline. Spelling correction (below)
is included.

| ranker | P@1 | P@5 | nDCG@10 | Recall@100 |
|---|---|---|---|---|
| bm25 | 0.507 → **0.563** | 0.237 → **0.293** | 0.576 → **0.630** | 0.883 → **0.918** |
| dense | 0.366 → **0.394** | 0.211 → **0.231** | 0.506 → **0.532** | 0.801 → **0.827** |
| tfidf | 0.423 → **0.479** | 0.189 → **0.231** | 0.477 → **0.528** | 0.879 → **0.910** |
| hybrid | 0.549 → **0.577** | 0.239 → **0.279** | 0.585 → **0.629** | 0.908 → **0.942** |

Technique slice, bm25: nDCG@10 **0.433 → 0.616 (+0.183)**, Recall@100 **0.805 →
0.925 (+0.120)**. **Worst movement on any slice, any metric, any ranker:
+0.000.**

| query | bm25 P@5 |
|---|---|
| square root decomposition | 0.00 → **1.00** |
| dsu on trees | 0.20 → **0.80** |
| small to large merging | 0.20 → **0.80** |
| z algorithm | 0.40 → 0.60 |
| djikstra | 0.00 → **0.80** |
| segment tre | 0.40 → **1.00** |

`dsu on trees` and `small to large merging` now expand to the *same* string and
return the *same* problems, which was the point.

## Spelling correction

`djikstra` and `kruskals` returned literally nothing — the vocabulary guard
correctly identified them as words no problem contains, then said so, which is
honest and useless.

`server/search/spellfix.js` corrects only terms **already absent** from the
corpus vocabulary, and only by appending. A token the corpus has never seen
scores zero in BM25, so appending its nearest real neighbour cannot displace a
match that exists — no working query can regress by construction.

Two thresholds were set by measurement, not taste:

- **2 edits only at length ≥ 8** (not 6). At 6, `deepya` corrects to `deep` via
  two deletions — and "a person's name returns nothing" is a property an
  earlier round deliberately bought.
- **The target must have df ≥ 3.** 59% of the vocabulary appears in fewer than
  3 problems. Without this floor, `how much rainwater collects` corrected
  `much` → `muh` (df 2) and cost the paraphrase slice 0.069 nDCG on that query.
  A correction toward a term used twice is a coincidence, not a correction.

`bench/run.js` applies the same correction the route does — otherwise the
benchmark scores `djikstra` as a zero it isn't in production.

## Not done

- **Lexical-only expansion.** Consumption reduces the pollution at source,
  which is the cheaper half. Scoping expansion per-leg still needs a real seam:
  `HybridIndex.search` takes no `opts` and `dense.js` drops its 4th argument.
- **Phrase/proximity scoring.** Postings are `Set<docId>` with no positions, so
  bigrams mean restructuring the index. Consumption gets the same outcome for
  *known* technique names at a fraction of the cost.
- **Stemming.** Would fix `tree`/`trees` and `merge`/`merging` generally, but it
  rewrites every document and query and invalidates the committed embeddings.
  Nine aliases handle the names that actually came up.
