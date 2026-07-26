# Experiment 08 — Four judges, 42% more corpus, flat metrics

Run: `experiments/bench-2026-07-26T07-01-07-333Z.json` (2,574 docs, expansion on)
Baseline: `experiments/bench-2026-07-24T16-27-26-667Z.json` (1,808 docs, expansion on)

## What changed

The corpus went from two judges to four: **+607 Codeforces** (rating-stratified
1300+, statements from the `open-r1/codeforces` dataset because codeforces.com
403s any script) and **+124 AtCoder**, plus 35 LeetCode/CSES problems from a
curated sheet. 2,574 docs, +766 (+42%).

Alongside it, eight labels were promoted out of the gaps report into the
taxonomy (`bit-manipulation`, `connected-components`, `subset-sum`,
`modular-exponentiation`, `string-matching`, `grid-traversal`, `palindrome`,
`brute-force`) and 332 files were normalized onto canonical slugs.

## Questions

1. A 42% corpus increase crowded the answer set before (exp 07 lost 0.146 P@1
   on a +623 growth). How much does this one cost?
2. Do problems from judges the benchmark never mentions displace judged answers?
3. The annotator has never been scored against ground truth. Codeforces
   publishes official tags — how good are our labels really?

## Aggregate

| ranker | P@1 | P@5 | MRR | nDCG@10 | Recall@100 |
|---|---|---|---|---|---|
| bm25 | 0.473 → **0.473** | 0.244 → 0.222 | 0.613 → 0.601 | 0.565 → 0.537 | 0.921 → 0.906 |
| hybrid | 0.455 → **0.473** | 0.251 → 0.229 | 0.618 → 0.616 | 0.578 → 0.555 | 0.948 → 0.924 |
| dense | 0.400 → 0.364 | 0.215 → 0.207 | 0.558 → 0.533 | 0.521 → 0.505 | 0.865 → 0.830 |
| tfidf | 0.382 → **0.382** | 0.185 → 0.182 | 0.514 → 0.504 | 0.471 → 0.453 | 0.933 → 0.902 |

## By slice — where it actually moved

| ranker | slice | P@1 | MRR |
|---|---|---|---|
| bm25 | keyword | 0.633 → **0.667** | 0.723 → **0.742** |
| bm25 | paraphrase | 0.333 → 0.250 | 0.547 → 0.490 |
| bm25 | technique | 0.231 → 0.231 | 0.419 → 0.377 |
| hybrid | keyword | 0.500 → **0.567** | 0.654 → **0.692** |
| hybrid | paraphrase | 0.500 → 0.500 | 0.652 → 0.635 |
| hybrid | technique | 0.308 → 0.231 | 0.502 → 0.424 |
| dense | paraphrase | 0.583 → 0.583 | 0.710 → 0.704 |
| dense | technique | 0.231 → 0.154 | 0.367 → 0.296 |

## Findings

1. **Growth was nearly free this time — and the keyword slice improved.** BM25
   and TF-IDF P@1 are identical to the baseline, hybrid's is up. BM25's keyword
   slice *gained* (P@1 0.633 → 0.667, MRR 0.723 → 0.742) and hybrid's gained
   more (0.500 → 0.567). Exp 07 lost 0.146 P@1 on a smaller growth. The
   difference is that this batch shipped with taxonomy work: promoting eight
   recurring labels and normalizing 332 files added matchable text to problems
   the queries were already about, and that outweighed the crowding.

2. **New judges don't compete for old answers.** `scripts/bench_diff.py` puts
   displacement at **14–19%** of top-5 slots, *below* exp 07's 23% on a smaller
   absolute growth. Codeforces statements read differently from LeetCode ones
   ("Bear and Different Names", not "Maximum Subarray Sum"), so they rank for
   different queries instead of crowding the judged ones. Recall@100 slipping
   1.5–3.5 points is the whole cost.

3. **The technique slice is the one real regression** (hybrid MRR 0.502 → 0.424,
   dense 0.367 → 0.296). Technique queries name a label and rely on labels being
   scarce and precise; 766 new problems carrying LLM labels dilute exactly that.
   This is a *precision* cost of over-labeling, and finding 3 confirms it.

4. **First ground-truth score of the annotator.** Codeforces publishes per-problem
   tags, so `scripts/label_agreement.py` scores our labels against them on 364
   records: **macro precision 67%, macro recall 83%**. Read carefully:

   | official tag | CF | ours | precision | recall |
   |---|---|---|---|---|
   | binary search | 54 | 109 | **45%** | 91% |
   | geometry | 12 | 32 | **31%** | 83% |
   | strings | 29 | 58 | **45%** | 90% |
   | constructive algorithms | 66 | 57 | 91% | 79% |
   | number theory | 36 | 40 | 85% | 94% |
   | dfs and similar | 29 | 25 | 80% | 69% |

   No label falls below 69% recall — the annotator isn't *missing* techniques,
   which is the failure mode that makes problems unfindable. It over-applies:
   `binary-search-answer` lands on twice as many problems as Codeforces
   considers binary search, and `geometry` on nearly three times as many. That
   is the same dilution finding 3 measured, now with a number attached.

5. **Latency scales as designed.** Lexical is unmoved (bm25 median 0.203 ms —
   inverted-index lookups don't care about corpus size). Dense went 2.0 → 2.699 ms
   median: brute-force cosine over every doc is O(N), and N grew 42%. Boot is
   203 ms load + 134 ms dense index. The 3.77 MB embeddings artifact still ships
   in git.

## Caveats

- The 55 benchmark queries and their relevance lists were written against a
  LeetCode+CSES corpus. **No query targets a Codeforces or AtCoder problem**, so
  this run measures what the new problems *cost*, never what they add. The
  friend-reported query `flows` — 0 hits before — now returns 50 with two CSES
  and one Codeforces problem in the top 3, and none of that shows up here.
- Judged-relevant losses are concentrated in DP-optimization queries
  (`partition array into k groups dp optimization`, `monotonic queue
  optimization dp`), where the new CF problems are genuinely plausible answers
  that no one labeled.
- `bm25-grpc` didn't register this run (`GRPC_BM25_ADDR` unset); its parity with
  Node BM25 is established in exp 03 and unaffected by corpus contents.
- Label agreement is measured only on Codeforces, the one judge with public
  tags. Whether the same precision holds on LeetCode is untested.

## Follow-up — the over-labeling was a prompt bug, not the model

Findings 3 and 4 blamed dilution on LLM labeling in general. That was wrong, and
the ground-truth harness built for finding 4 is what caught it.

The annotator's request included an `output_schema` field meant to show the
*shape* of the expected JSON. It contained real values:

```python
"patterns": ["binary-search-answer", "prefix-sum"],
"pattern_confidence": {"binary-search-answer": 0.92, "prefix-sum": 0.84},
```

The model read them as suggested answers. The giveaway is ordering, not
frequency: `binary-search-answer` was emitted in **slot 0 on 113 of 170**
records and `prefix-sum` in slot 1 — the example array's exact order.

**A/B, same 80 Codeforces problems, scored against official tags.** On the 38
all three arms completed, where Codeforces tags 5 as binary search:

| arm | labels as binary search | precision |
|---|---|---|
| gpt-4.1-mini, leaked schema | 10 | 50% |
| gpt-4.1-mini, placeholders | 5 | 80% |
| gpt-4.1, placeholders | 3 | 100% (misses 2 of 5) |

**Re-annotating all 611 with placeholders**, scored on the identical id set
(n=616, Codeforces tags 87 as binary search):

| | labels as binary search | slot 0 | precision | recall | prefix-sum |
|---|---|---|---|---|---|
| before | 174 | 113 | 44% | 87% | 117 |
| after | **87** | 40 | **84%** | 84% | 41 |

Macro precision 72% → 76%, macro recall 80% → 84% — both directions improved,
which a genuine precision/recall tradeoff would not do. Search metrics moved
within noise (hybrid P@1 +0.018, MRR +0.009, Recall@100 +0.006), as expected
from a benchmark with no Codeforces queries.

**A bigger model was the wrong fix.** gpt-4.1 buys precision by labeling less
(3 where the truth is 5) — the wrong trade for a corpus where a missing label
makes a problem unfindable. It also costs ~8× and is far more rate-limited: it
completed 38 of 80 against 140 HTTP 429s while mini finished all 80. One line
of prompt beat the model upgrade outright.

Second-order finding: **all six few-shot examples are LeetCode or CSES**. The
annotator has never been shown a Codeforces statement mapped to labels, which
is an independent and still-unfixed reason its Codeforces labels are weaker.

## What this unlocks

- **The over-labeling was measured, then fixed** (see the follow-up above):
  `binary-search-answer` went 44% → 84% precision. `scripts/label_agreement.py`
  is now the regression test for any future prompt or model change.
- **Give the annotator a Codeforces few-shot example.** All six are LeetCode/CSES.
  Worth measuring with the same harness before shipping.
- **Benchmark queries for the new judges.** Until the query set covers Codeforces
  and AtCoder, every future corpus run will look like pure cost.
- Dense at 2.7 ms is still far from needing an ANN index, but the O(N) slope is
  now visible; ~10k docs is where brute force stops being free.
