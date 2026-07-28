// Route-level tests for /api/search: the filter/slice logic that lives above
// the rankers. These run against a real Express server on an ephemeral port
// with stub rankers — no corpus, no ONNX, no Postgres. Anonymous requests never
// reach the DB (the pool is lazy and telemetry swallows its own errors), so the
// route is testable exactly as it ships.
const assert = require("node:assert/strict");
const express = require("express");
const { createSearchRouter } = require("./search");
const { HybridIndex } = require("../search/hybrid");

const PLATFORMS = ["leetcode", "cses", "codeforces", "atcoder"];

// 300 problems, deliberately more than hybrid's 200-row fused ceiling.
const problems = Array.from({ length: 300 }, (_, i) => {
  const platform = PLATFORMS[i % 4];
  // Difficulties in each judge's own shape: LeetCode names tiers, Codeforces
  // and AtCoder use ratings, CSES publishes none.
  const difficulty =
    platform === "leetcode" ? (i % 8 === 0 ? "Easy" : i % 3 === 0 ? "Medium" : "Hard")
    : platform === "codeforces" ? 1000 + (i % 5) * 400
    : platform === "atcoder" ? 800 + (i % 3) * 700
    : undefined;
  const p = {
    id: `${platform}-${i}`,
    title: `Problem ${i}`,
    platform,
    statement: "graph problem",
    tags: ["graph"],
    patterns: i % 3 === 0 ? ["dfs"] : ["greedy"],
  };
  if (difficulty !== undefined) p.difficulty = difficulty;
  return p;
});

const hit = (p, score) => ({ problem: p, score, matchedTerms: ["graph"] });

// Honors k/offset the way the real rankers do: rank everything, then slice.
// Also mirrors their empty-query guard — tfidf/bm25/dense all return nothing
// for "", which is exactly why a filter with no query needs its own path.
function stubRanker(order = problems) {
  return {
    search(q, k = 10, offset = 0) {
      if (!q.trim()) return { hits: [], total: 0 };
      const ranked = order.map((p, i) => hit(p, 1000 - i));
      return { hits: ranked.slice(offset, offset + k), total: ranked.length };
    },
  };
}

// Two legs that both respect the depth they're handed — so if HybridIndex ever
// goes back to passing its own topN instead of the caller's k, the fused set
// silently caps at 200 again and the pagination test below fails.
const lexicalLeg = stubRanker();
const denseLeg = {
  async search(q, k = 10, offset = 0) {
    if (!q.trim()) return { hits: [], total: 0 };
    const ranked = [...problems].reverse().map((p, i) => hit(p, 1 - i / 1000));
    return { hits: ranked.slice(offset, offset + k), total: ranked.length };
  },
};

const indexes = {
  bm25: stubRanker(),
  hybrid: new HybridIndex({ lexical: lexicalLeg, dense: denseLeg }),
};

const app = express();
app.use("/api", createSearchRouter({ indexes, defaultRanker: "bm25", problems }));

const server = app.listen(0);
const base = () => `http://127.0.0.1:${server.address().port}/api/search`;
const get = async (qs) => (await fetch(`${base()}?${qs}`)).json();
const platformsOf = (d) => [...new Set(d.hits.map((h) => h.problem.platform))].sort();

(async () => {
  // Baseline: no filter, ranker slices, total is the whole ranked set.
  {
    const d = await get("q=graph&k=10");
    assert.equal(d.total, 300);
    assert.equal(d.hits.length, 10);
    assert.equal(d.platform, undefined);
  }

  // A single judge narrows both the hits and the total.
  {
    const d = await get("q=graph&k=10&platform=codeforces");
    assert.deepEqual(platformsOf(d), ["codeforces"]);
    assert.equal(d.total, 75);
    assert.deepEqual(d.platform, ["codeforces"]);
  }

  // Several judges union rather than intersect.
  {
    const d = await get("q=graph&k=200&platform=codeforces,atcoder");
    assert.deepEqual(platformsOf(d), ["atcoder", "codeforces"]);
    assert.equal(d.total, 150);
  }

  // Unknown judges are dropped, not errors — a stale bookmark shouldn't 400.
  {
    const d = await get("q=graph&k=10&platform=topcoder");
    assert.equal(d.total, 300);
    assert.equal(d.platform, undefined);

    const mixed = await get("q=graph&k=10&platform=topcoder,atcoder");
    assert.deepEqual(mixed.platform, ["atcoder"]);
    assert.equal(mixed.total, 75);
  }

  // Selecting every judge means the same thing as selecting none.
  {
    const d = await get("q=graph&k=10&platform=leetcode,cses,codeforces,atcoder");
    assert.equal(d.total, 300);
    assert.equal(d.platform, undefined);
  }

  // Platform and pattern compose in one pass.
  {
    const d = await get("q=graph&k=200&platform=codeforces&pattern=dfs");
    assert.deepEqual(platformsOf(d), ["codeforces"]);
    assert.ok(d.hits.every((h) => h.problem.patterns.includes("dfs")));
    assert.equal(d.total, 25);
  }

  // Pages stay disjoint and cover the filtered set exactly.
  {
    const a = await get("q=graph&k=40&offset=0&platform=codeforces");
    const b = await get("q=graph&k=40&offset=40&platform=codeforces");
    const ids = new Set([...a.hits, ...b.hits].map((h) => h.problem.id));
    assert.equal(ids.size, 75, "two pages of a 75-hit set must not overlap");
  }

  // REGRESSION: hybrid used to fuse only its own topN (100) per leg no matter
  // what k the route asked for, so the fused set capped at 200 rows and any
  // filtered page past offset 200 came back empty. Three judges = 225 matches,
  // which only exists if both legs went deeper than 100.
  {
    const d = await get("q=graph&ranker=hybrid&k=20&offset=200&platform=leetcode,cses,codeforces");
    assert.equal(d.ranker, "hybrid");
    assert.equal(d.total, 225, `fused set should reach 225, got ${d.total}`);
    assert.equal(d.hits.length, 20, "hybrid page at offset 200 must not be empty");
  }

  // ...and the page past the old ceiling holds real, distinct results.
  {
    const early = await get("q=graph&ranker=hybrid&k=20&offset=0&pattern=greedy");
    const late = await get("q=graph&ranker=hybrid&k=20&offset=150&pattern=greedy");
    assert.equal(late.hits.length, 20, "page at offset 150 of a 200-hit set must be full");
    const overlap = new Set(early.hits.map((h) => h.problem.id));
    assert.ok(late.hits.every((h) => !overlap.has(h.problem.id)), "pages must be disjoint");
  }

  // A selective platform under hybrid must still fill a page — atcoder is 25%
  // here and under 5% of the real corpus.
  {
    const d = await get("q=graph&ranker=hybrid&k=20&platform=atcoder");
    assert.equal(d.total, 75);
    assert.deepEqual(platformsOf(d), ["atcoder"]);
  }

  // An empty query with a filter is a browse, not an empty result. Every ranker
  // returns nothing for "", so this used to report 0 hits for a label carrying
  // hundreds of problems.
  {
    const d = await get("q=&k=10&pattern=dfs");
    assert.equal(d.total, 100, "browsing a label must find every problem carrying it");
    assert.ok(d.hits.every((h) => h.problem.patterns.includes("dfs")));
  }

  // Browse composes the same facets search does.
  {
    const d = await get("q=&k=10&platform=atcoder");
    assert.equal(d.total, 75);

    const both = await get("q=&k=10&platform=atcoder&pattern=dfs");
    assert.equal(both.total, 25);
    assert.ok(both.hits.every((h) => h.problem.platform === "atcoder" && h.problem.patterns.includes("dfs")));
  }

  // Browse pages disjointly, like search.
  {
    const a = await get("q=&k=40&offset=0&pattern=greedy");
    const b = await get("q=&k=40&offset=40&pattern=greedy");
    const ids = new Set([...a.hits, ...b.hits].map((h) => h.problem.id));
    assert.equal(ids.size, 80, "browse pages must not overlap");
  }

  // No query and no filter is still nothing — browse needs something to browse.
  {
    const d = await get("q=&k=10");
    assert.equal(d.total, 0);
    assert.equal(d.hits.length, 0);
  }

  // Difficulty is per-judge. The rule that matters: selecting a Codeforces band
  // must NOT delete LeetCode results — a judge with no band selected is
  // unfiltered, not excluded. Getting this backwards silently empties the page.
  {
    const all = await get("q=graph&k=300");
    const cfOnly = await get("q=graph&k=300&difficulty=cf-1800");
    const lcInAll = all.hits.filter((h) => h.problem.platform === "leetcode").length;
    const lcAfter = cfOnly.hits.filter((h) => h.problem.platform === "leetcode").length;
    assert.equal(lcAfter, lcInAll, "a cf band must leave leetcode untouched");
    const cfAfter = cfOnly.hits.filter((h) => h.problem.platform === "codeforces");
    assert.ok(cfAfter.length > 0, "the cf band should still match some codeforces problems");
    assert.ok(
      cfAfter.every((h) => h.problem.difficulty >= 1800 && h.problem.difficulty <= 2199),
      "every codeforces hit must fall inside the selected band"
    );
  }

  // CSES has no difficulty at all; a band must never exclude it.
  {
    const d = await get("q=graph&k=300&difficulty=cf-1800,lc-hard");
    assert.ok(d.hits.some((h) => h.problem.platform === "cses"), "cses must survive any band");
  }

  // Bands compose with judges, and the echo confirms what was applied.
  {
    const d = await get("q=graph&k=300&platform=codeforces&difficulty=cf-1000");
    assert.deepEqual(d.platform, ["codeforces"]);
    assert.deepEqual(d.difficulty, ["cf-1000"]);
    assert.ok(d.hits.every((h) => h.problem.platform === "codeforces"));
    assert.ok(d.hits.every((h) => h.problem.difficulty >= 1000 && h.problem.difficulty <= 1399));
  }

  // Several bands for one judge are a union, not an intersection.
  {
    const one = await get("q=graph&k=300&platform=codeforces&difficulty=cf-1000");
    const two = await get("q=graph&k=300&platform=codeforces&difficulty=cf-1000,cf-1400");
    assert.ok(two.total > one.total, "adding a band must widen, not narrow");
  }

  // Unknown band ids are ignored rather than 400ing, so a stale link still works.
  {
    const d = await get("q=graph&k=10&difficulty=cf-9999,not-a-band");
    assert.equal(d.difficulty, undefined);
    assert.equal(d.total, 300);
  }

  // Browse (empty query) honours bands the same way search does.
  {
    const d = await get("q=&k=300&platform=codeforces&difficulty=cf-2200");
    assert.ok(d.total > 0);
    assert.ok(d.hits.every((h) => h.problem.platform === "codeforces" && h.problem.difficulty >= 2200));
  }

  // Anonymous + done filter degrades to "all" instead of dereferencing a null
  // user state. Also proves the filtered branch never touches Postgres.
  {
    const d = await get("q=graph&k=10&filter=done");
    assert.equal(d.filter, "all");
    assert.equal(d.total, 300);
  }

  console.log("search route tests passed");
  server.close();
})().catch((err) => {
  server.close();
  throw err;
});
