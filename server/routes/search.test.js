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
    // Some Codeforces problems genuinely carry no rating, which is what makes
    // "where do unrated problems sort?" a real question rather than a hypothetical.
    : platform === "codeforces" ? (i % 40 === 6 ? undefined : 1000 + (i % 5) * 400)
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
  // Acceptance rate exists on LeetCode only, and a few carry none — the case
  // that decides where an unknown lands once it's used as a sort tiebreak.
  if (platform === "leetcode" && i % 40 !== 4) p.acceptance_rate = 10 + ((i * 7) % 80);
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
    const cfOnly = await get("q=graph&k=300&difficulty=cf:1800-2199");
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
    const d = await get("q=graph&k=300&difficulty=cf:1800-2199,lc-hard");
    assert.ok(d.hits.some((h) => h.problem.platform === "cses"), "cses must survive any band");
  }

  // Bands compose with judges, and the echo confirms what was applied.
  {
    const d = await get("q=graph&k=300&platform=codeforces&difficulty=cf:1000-1399");
    assert.deepEqual(d.platform, ["codeforces"]);
    assert.equal(d.difficulty, "cf:1000-1399");
    assert.ok(d.hits.every((h) => h.problem.platform === "codeforces"));
    assert.ok(d.hits.every((h) => h.problem.difficulty >= 1000 && h.problem.difficulty <= 1399));
  }

  // Several bands for one judge are a union, not an intersection.
  {
    const one = await get("q=graph&k=300&platform=codeforces&difficulty=cf:1000-1399");
    const two = await get("q=graph&k=300&platform=codeforces&difficulty=cf:1000-1799");
    assert.ok(two.total > one.total, "adding a band must widen, not narrow");
  }

  // Unknown band ids are ignored rather than 400ing, so a stale link still works.
  {
    const d = await get("q=graph&k=10&difficulty=cf:abc-def,not-a-band");
    assert.equal(d.difficulty, undefined);
    assert.equal(d.total, 300);
  }

  // Browse (empty query) honours bands the same way search does.
  {
    const d = await get("q=&k=300&platform=codeforces&difficulty=cf:2200-3500");
    assert.ok(d.total > 0);
    assert.ok(d.hits.every((h) => h.problem.platform === "codeforces" && h.problem.difficulty >= 2200));
  }

  // An exact rating — the reason ranges replaced fixed bands. Codeforces
  // ratings are multiples of 100, so "only 1500" is a coherent ask that no
  // coarse band could express.
  {
    const d = await get("q=graph&k=300&platform=codeforces&difficulty=cf:1800-1800");
    assert.ok(d.total > 0, "an exact rating should still match something");
    assert.ok(d.hits.every((h) => h.problem.difficulty === 1800), "only that exact rating");
    const wider = await get("q=graph&k=300&platform=codeforces&difficulty=cf:1800-2200");
    assert.ok(wider.total > d.total, "widening the range must add problems");
  }

  // A reversed range is a slip, not an empty-set request.
  {
    const a = await get("q=graph&k=300&platform=codeforces&difficulty=cf:2200-1800");
    const b = await get("q=graph&k=300&platform=codeforces&difficulty=cf:1800-2200");
    assert.equal(a.total, b.total, "min/max order must not matter");
  }

  // Anonymous + done filter degrades to "all" instead of dereferencing a null
  // user state. Also proves the filtered branch never touches Postgres.
  {
    const d = await get("q=graph&k=10&filter=done");
    assert.equal(d.filter, "all");
    assert.equal(d.total, 300);
  }

  // ── Acceptance rate ───────────────────────────────────────────────────────

  // It narrows LeetCode and nothing else, like every other per-judge control.
  {
    const plain = await get("q=graph&k=300");
    const acc = await get("q=graph&k=300&difficulty=ac:10-30");
    const others = (d) => d.hits.filter((h) => h.problem.platform !== "leetcode").length;
    assert.equal(others(acc), others(plain), "an acceptance band must leave other judges alone");
    const lc = acc.hits.filter((h) => h.problem.platform === "leetcode");
    assert.ok(lc.length > 0);
    assert.ok(
      lc.every((h) => h.problem.acceptance_rate >= 10 && h.problem.acceptance_rate <= 30),
      "every leetcode hit must fall inside the band"
    );
  }

  // It INTERSECTS with a tier rather than replacing it — "the hardest Mediums"
  // is the whole point, and it's the only scope where the number compares.
  {
    const d = await get("q=graph&k=300&platform=leetcode&difficulty=lc-medium,ac:10-40");
    assert.ok(d.hits.length > 0);
    assert.ok(
      d.hits.every((h) => h.problem.difficulty === "Medium" && h.problem.acceptance_rate <= 40),
      "both halves of the selection must apply"
    );
    const tierOnly = await get("q=graph&k=300&platform=leetcode&difficulty=lc-medium");
    assert.ok(tierOnly.total > d.total, "adding an acceptance band must narrow the tier");
  }

  // A LeetCode problem with no rate can't satisfy a rate band, the same way an
  // unrated Codeforces problem can't satisfy a rating band.
  {
    const d = await get("q=graph&k=300&platform=leetcode&difficulty=ac:10-90");
    assert.ok(d.hits.every((h) => typeof h.problem.acceptance_rate === "number"));
    const all = await get("q=graph&k=300&platform=leetcode");
    assert.ok(all.total > d.total, "the rate-less problems must be the difference");
  }

  // Reversed and unparseable bands behave like every other stale link.
  {
    const a = await get("q=graph&k=300&platform=leetcode&difficulty=ac:40-20");
    const b = await get("q=graph&k=300&platform=leetcode&difficulty=ac:20-40");
    assert.equal(a.total, b.total, "min/max order must not matter");
    const junk = await get("q=graph&k=10&platform=leetcode&difficulty=ac:x-y");
    assert.equal(junk.difficulty, undefined);
  }

  // ── Sorting by difficulty ─────────────────────────────────────────────────

  // Sorting is refused unless exactly one judge with a scale is in play, for
  // the same reason filtering is per-judge: nothing orders "Medium" against
  // 1600. The refusal is explicit so the client can stop claiming it sorted.
  {
    for (const qs of [
      "q=graph&k=20&sort=difficulty-asc",
      "q=graph&k=20&platform=codeforces,leetcode&sort=difficulty-asc",
      "q=graph&k=20&platform=cses&sort=difficulty-asc",
    ]) {
      const d = await get(qs);
      assert.equal(d.sort, undefined, `sort must be refused for ${qs}`);
      assert.ok(d.sortRefused, "a refused sort must say why, not fail silently");
      assert.equal(d.sortWindow, undefined, "a refused sort must not withdraw paging");
    }
  }

  // With one rated judge it applies, ascending, and says so.
  {
    const d = await get("q=graph&k=20&platform=codeforces&sort=difficulty-asc");
    assert.equal(d.sort, "difficulty-asc");
    assert.equal(d.sortRefused, undefined);
    const rated = d.hits.map((h) => h.problem.difficulty).filter((x) => typeof x === "number");
    assert.deepEqual(rated, [...rated].sort((a, b) => a - b), "ascending means ascending");
  }

  // The point of the design: sorting REORDERS the top N by relevance, it does
  // not re-pick them. Same set, different order — otherwise a sort would
  // quietly throw the ranking away and return the corpus's easiest problems.
  {
    const plain = await get("q=graph&k=20&platform=codeforces");
    const sorted = await get("q=graph&k=20&platform=codeforces&sort=difficulty-asc");
    assert.equal(sorted.sortWindow, 20, "a sorted search reports its window");
    assert.deepEqual(
      new Set(sorted.hits.map((h) => h.problem.id)),
      new Set(plain.hits.map((h) => h.problem.id)),
      "sorting must reorder the top k, not re-select it"
    );
  }

  // A wider window sorts more of the ranking, and still only that much.
  {
    const d = await get("q=graph&k=50&platform=codeforces&sort=difficulty-desc");
    assert.equal(d.sortWindow, 50);
    assert.equal(d.hits.length, 50);
    assert.ok(d.total > 50, "the match set is larger than the sorted window");
    const rated = d.hits.map((h) => h.problem.difficulty).filter((x) => typeof x === "number");
    assert.deepEqual(rated, [...rated].sort((a, b) => b - a), "descending means descending");
  }

  // Paging is withdrawn for a sorted search: page 2 of a re-sorted top-N is not
  // a continuation of anything, so offset is ignored rather than half-honoured.
  {
    const a = await get("q=graph&k=20&platform=codeforces&sort=difficulty-asc");
    const b = await get("q=graph&k=20&offset=20&platform=codeforces&sort=difficulty-asc");
    assert.deepEqual(
      b.hits.map((h) => h.problem.id),
      a.hits.map((h) => h.problem.id),
      "offset must not silently produce a second, incoherent page"
    );
  }

  // Unrated problems sort last in BOTH directions. An unknown difficulty is not
  // "easiest" — claiming it is would put the least-known problems first.
  {
    for (const dir of ["asc", "desc"]) {
      const d = await get(`q=graph&k=300&platform=codeforces&sort=difficulty-${dir}`);
      const keys = d.hits.map((h) => typeof h.problem.difficulty === "number");
      const firstUnrated = keys.indexOf(false);
      assert.ok(firstUnrated > 0, `${dir}: the fixture must contain unrated problems`);
      assert.ok(
        keys.slice(firstUnrated).every((rated) => !rated),
        `${dir}: unrated problems must all sit at the end`
      );
    }
  }

  // Browse has no ranking to protect, so it sorts the whole set AND keeps
  // paging: page 2 continues page 1 rather than restarting it.
  {
    const a = await get("q=&k=40&offset=0&platform=codeforces&sort=difficulty-asc");
    const b = await get("q=&k=40&offset=40&platform=codeforces&sort=difficulty-asc");
    assert.equal(a.sortWindow, undefined, "browse keeps paging, so it has no window");
    assert.equal(a.total, b.total);
    const ids = new Set([...a.hits, ...b.hits].map((h) => h.problem.id));
    assert.equal(ids.size, a.hits.length + b.hits.length, "sorted browse pages must be disjoint");
    const lastOfA = a.hits[a.hits.length - 1].problem.difficulty;
    const firstOfB = b.hits[0].problem.difficulty;
    assert.ok(firstOfB >= lastOfA, "page 2 must continue the order, not restart it");
  }

  // Sort composes with a band rather than fighting it.
  {
    const d = await get("q=&k=300&platform=codeforces&difficulty=cf:1400-2200&sort=difficulty-desc");
    assert.ok(d.hits.length > 0);
    assert.ok(d.hits.every((h) => h.problem.difficulty >= 1400 && h.problem.difficulty <= 2200));
    const vals = d.hits.map((h) => h.problem.difficulty);
    assert.deepEqual(vals, [...vals].sort((a, b) => b - a));
  }

  // Named tiers order too — easy, then medium, then hard.
  {
    const d = await get("q=&k=300&platform=leetcode&sort=difficulty-asc");
    const rank = { easy: 0, medium: 1, hard: 2 };
    const vals = d.hits.map((h) => rank[String(h.problem.difficulty).toLowerCase()]);
    assert.deepEqual(vals, [...vals].sort((a, b) => a - b), "easy < medium < hard");
  }

  // Garbage in the sort parameter is ignored, like every other stale-link case.
  {
    const d = await get("q=graph&k=20&platform=codeforces&sort=popularity");
    assert.equal(d.sort, undefined);
    assert.equal(d.sortRefused, undefined, "an unparseable sort was never requested");
    assert.equal(d.hits.length, 20);
  }

  // Acceptance rate breaks the tie WITHIN a tier — without it, "easiest first"
  // over LeetCode returns one tier in relevance order, which is no order at all.
  // Lower acceptance means harder, so easiest-first runs high-to-low inside a tier.
  {
    const d = await get("q=&k=300&platform=leetcode&sort=difficulty-asc");
    const rank = { easy: 0, medium: 1, hard: 2 };
    const rows = d.hits.map((h) => ({
      tier: rank[String(h.problem.difficulty).toLowerCase()],
      rate: h.problem.acceptance_rate,
    }));
    assert.deepEqual(rows.map((r) => r.tier), [...rows.map((r) => r.tier)].sort((a, b) => a - b), "tier leads");
    for (const tier of [0, 1, 2]) {
      const rates = rows.filter((r) => r.tier === tier && typeof r.rate === "number").map((r) => r.rate);
      assert.deepEqual(rates, [...rates].sort((a, b) => b - a), `tier ${tier}: easiest (highest rate) first`);
    }
  }

  // ...and reversing the sort reverses the tiebreak with it.
  {
    const d = await get("q=&k=300&platform=leetcode&sort=difficulty-desc");
    const hard = d.hits.filter((h) => h.problem.difficulty === "Hard" && typeof h.problem.acceptance_rate === "number");
    const rates = hard.map((h) => h.problem.acceptance_rate);
    assert.deepEqual(rates, [...rates].sort((a, b) => a - b), "hardest first = lowest acceptance first");
  }

  // A problem with no acceptance rate sorts last inside its own tier, both
  // ways — not first, which would claim it's the easiest thing we have.
  {
    for (const dir of ["asc", "desc"]) {
      const d = await get(`q=&k=300&platform=leetcode&sort=difficulty-${dir}`);
      const tiers = ["Easy", "Medium", "Hard"];
      for (const tier of tiers) {
        const inTier = d.hits.filter((h) => h.problem.difficulty === tier);
        const known = inTier.map((h) => typeof h.problem.acceptance_rate === "number");
        const firstUnknown = known.indexOf(false);
        if (firstUnknown === -1) continue;
        assert.ok(
          known.slice(firstUnknown).every((k) => !k),
          `${dir}/${tier}: rate-less problems must sit at the end of their tier`
        );
      }
    }
  }

  console.log("search route tests passed");
  server.close();
})().catch((err) => {
  server.close();
  throw err;
});
