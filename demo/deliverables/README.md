# AlgoLens / Cosine screenshot set

Captured from `https://algolens-pp2m.onrender.com/` on 2026-07-25 at
1440 × 1050. The live deployment identified itself as **cosine v0.4** during
the final capture, while the supplied repository is still named AlgoLens.

Every state is available in both dark and light themes:

| # | State | What it demonstrates |
|---|---|---|
| 01 | home | Signed-in terminal-style landing state |
| 02 | bm25-eulerian | BM25 keyword ranking for `eulerian path`, with the top result expanded |
| 03 | dense-thief-semantic | Dense semantic search maps `thief` to House Robber |
| 04 | hybrid-fire-maze | Hybrid retrieval for a concept-plus-story query |
| 05 | compare-rankers-thief | BM25 has no hits while dense finds House Robber |
| 06 | bookmarks | Staged signed-in bookmarks library |
| 07 | done | Staged signed-in completed-problems library |
| 08 | patterns | Pattern taxonomy overview |
| 09 | patterns-full | Full-page pattern taxonomy |
| 10 | debug-bm25-explain | Per-term BM25 scoring explanation |
| 11 | stats | Full live usage, funnel, latency, and query statistics |
| 12 | profile-overall | Combined DSA + development heatmap |
| 13 | profile-dsa | LeetCode + Codeforces + local done-marks heatmap |
| 14 | profile-dev | GitHub contribution heatmap |

`contact-sheet-dark.png` and `contact-sheet-light.png` provide quick reviews.
The `walkthrough-*.gif` files loop automatically; equivalent compact MP4 files
are included.

Public search, patterns, debug, and stats content came directly from the live
deployment. Authenticated-only profile/bookmark/done screens use the live
frontend in an isolated browser session with intercepted demo-account
responses, avoiding a permanent database account. Profile calendars use public
LeetCode and Codeforces data for `tourist` and public GitHub activity for
`Dd1235`; deterministic representative data is used only if a source times out.
