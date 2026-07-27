# Experiment 09 — Known-item search, and a benchmark that couldn't see the bug

Run: `experiments/bench-latest.json` (2,575 docs, 63 queries, expansion on)
Baseline: same corpus, same queries, no title bonus

## What prompted it

Two users, independently: *"I searched for 2-sum which is classical, but it was not present at the very first, it was like 10-11th."* And earlier, `difference array` ranking its own difference-array problems past 22.

Measured, it was worse than reported: `two sum` put **Two Sum at rank 28** on BM25. Dense ranked it **#2**, so the corpus was fine and the lexical ranker was not.

Cause: `problemText` concatenated title + statement + tags + patterns into one bag, so a title match counted exactly as much as a word buried in a statement. `Sum of Two Values` shares both query terms in a longer title and won.

## The benchmark was blind to it

Before fixing anything, the metric said there was nothing wrong. `two sum` scored **P@1 = 1.000** — because its relevance list was `[leetcode-two-sum, cses-1640, leetcode-3sum]`, and `cses-1640` ("Sum of Two Values") ranked first. Any of three answers counted, so the metric couldn't distinguish "found the family" from "found the problem".

Typing a problem's exact name is a different intent — **known-item search** — and nothing in the 55 queries tested it. So a **`title` slice** was added first: 8 queries, each a problem's exact name, each with a **single-id** relevant set. Queries file version 5 → 6.

That ordering matters. Optimising against a metric that can't see the failure is how you ship a fix that measures worse than the bug.

## What was tried and rejected

**Title term repetition** — repeat the title N times in the indexed document, the cheap form of BM25F. Swept N ∈ {2, 3, 5} over all 63 queries:

| N | title MRR | keyword MRR | paraphrase MRR | technique MRR |
|---|---|---|---|---|
| 1 (base) | 0.817 | 0.725 | **0.504** | 0.372 |
| 2 | 0.833 | 0.756 | 0.394 | 0.414 |
| 3 | 0.854 | 0.774 | 0.361 | 0.392 |
| 5 | 0.875 | 0.774 | 0.348 | 0.347 |

Title and keyword improve monotonically — and **paraphrase collapses**, P@1 0.250 → 0.083. The per-query diff shows why: the losses are `find two numbers that add up to a target value` (RR 1.000 → 0.333) and `count the ways to reach the top taking one or two steps` (1.000 → 0.500). A paraphrase avoids the title's words *by construction*, so boosting titles helps a problem's competitors more than the problem itself.

Also rejected for TF-IDF specifically, where `TF = count/doclen`: repetition inflates the denominator for every term, and Recall@100 fell 0.914 → 0.798 at N=5.

**Rejected.** It taxes every query to serve one intent.

## What shipped

An **exact-title bonus**: `Bm25Index` keeps `Map<normalized title, docIds>`, and when the *entire* tokenized query equals a title, those documents get a bonus large enough to win outright. It fires only for known-item queries and is invisible to everything else.

| slice | P@1 | MRR | nDCG@10 | Recall@100 |
|---|---|---|---|---|
| **all** | 0.492 → **0.508** | 0.622 → **0.637** | 0.573 → **0.594** | 0.918 → 0.918 |
| title | 0.750 → **0.875** | 0.817 → **0.938** | 0.829 → **0.954** | 1.000 → 1.000 |
| keyword | 0.633 → 0.633 | 0.725 → 0.725 | 0.589 → **0.599** | 0.911 → 0.911 |
| paraphrase | 0.250 → 0.250 | 0.504 → 0.504 | 0.555 → 0.555 | 0.917 → 0.917 |
| technique | 0.231 → 0.231 | 0.372 → 0.372 | 0.396 → 0.396 | 0.885 → 0.885 |

**No slice regresses on any metric.** Exactly **one** query moved: `two sum`, RR 0.036 → 1.000. The other seven title queries already ranked first; `two sum` was the pathological case, because it is short, common-worded, and competing with longer titles containing the same two words.

## Caveats

- **This does not fix `difference array`.** That query is not a title, so the bonus never fires. It is a phrase-vs-bag-of-words problem — BM25 scores "difference" and "array" independently, and ~1,300 problems use the word "difference". A real fix needs bigram indexing or field-weighted scoring done properly, not term repetition.
- **`2 sum` still fails**, for a different reason: "2" and "two" are different tokens. Handled separately by a query-expansion alias.
- **The Go BM25 leg (`go/bm25.go`) does not have this bonus**, so `bm25-grpc` now ranks differently from in-process `bm25` for exact-title queries. It is not registered by default (`GRPC_BM25_ADDR` unset) and exists for the exp-03 latency comparison; noted rather than ported.
- **TF-IDF deliberately keeps the plain formula** — it is the textbook baseline the other rankers are measured against, and special-casing it would defeat that.
- The title slice is n=8, single-author, and every entry is a LeetCode problem. It tests known-item retrieval, not general quality.
