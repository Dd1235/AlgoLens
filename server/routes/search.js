const express = require("express");
const db = require("../db");

const VALID_FILTERS = new Set(["all", "done", "notdone"]);
// Sentinel for "give me everything you have" — bigger than the corpus.
const FULL_PAGE_SIZE = 100000;

function pickRanker(indexes, defaultRanker, req) {
  const requested = (req.query.ranker || "").toString().toLowerCase();
  if (requested && indexes[requested]) return requested;
  return defaultRanker;
}

async function timedSearch(index, q, k, offset = 0) {
  const t = process.hrtime.bigint();
  const result = await Promise.resolve(index.search(q, k, offset));
  const latencyMs = Number(process.hrtime.bigint() - t) / 1e6;
  // Handle both old (array) and new ({ hits, total }) return shapes for backwards compat
  if (Array.isArray(result)) {
    return { hits: result, total: result.length, latencyMs: +latencyMs.toFixed(3) };
  }
  return { hits: result.hits, total: result.total, latencyMs: +latencyMs.toFixed(3) };
}

async function loadUserState(userId) {
  const result = await db.query(
    `SELECT problem_id, done, bookmarked
       FROM user_problem_state
      WHERE user_id = $1 AND (done OR bookmarked)`,
    [userId]
  );
  const done = new Set();
  const bookmarked = new Set();
  for (const row of result.rows) {
    if (row.done) done.add(row.problem_id);
    if (row.bookmarked) bookmarked.add(row.problem_id);
  }
  return { done, bookmarked };
}

function createSearchRouter({ indexes, defaultRanker }) {
  const router = express.Router();

  router.get("/search", async (req, res) => {
    const q = (req.query.q || "").toString();
    const k = Number.parseInt(req.query.k, 10) || 10;
    const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
    const filterRaw = (req.query.filter || "all").toString().toLowerCase();
    const filter = VALID_FILTERS.has(filterRaw) ? filterRaw : "all";
    const ranker = pickRanker(indexes, defaultRanker, req);
    const index = indexes[ranker];

    try {
      // Load the user's done/bookmarked sets once. Anonymous users skip this
      // and the filter degrades silently to "all".
      const userState = req.user ? await loadUserState(req.user.id) : null;
      const effectiveFilter = userState ? filter : "all";

      let hits, total, latencyMs;
      if (effectiveFilter === "all") {
        ({ hits, total, latencyMs } = await timedSearch(index, q, k, offset));
      } else {
        // Need the full ranked list so the filter + slice produces a stable
        // total and disjoint pages. The ranker materializes everything before
        // slicing internally, so this costs no extra scoring work.
        const full = await timedSearch(index, q, FULL_PAGE_SIZE, 0);
        latencyMs = full.latencyMs;
        const filtered = full.hits.filter((h) => {
          const isDone = userState.done.has(h.problem.id);
          return effectiveFilter === "done" ? isDone : !isDone;
        });
        total = filtered.length;
        hits = filtered.slice(offset, offset + k);
      }

      // Decorate hits for signed-in users so the UI can badge done/bookmarked.
      if (userState) {
        hits = hits.map((h) => ({
          ...h,
          done: userState.done.has(h.problem.id),
          bookmarked: userState.bookmarked.has(h.problem.id),
        }));
      }

      res.json({ query: q, ranker, latencyMs, offset, k, total, filter: effectiveFilter, hits });
    } catch (err) {
      res.status(502).json({ query: q, ranker, error: err.message || "search failed" });
    }
  });

  // COMPARE_MODE_DISABLED: re-enable together with the UI in web/index.html
  // and web/app.js.
  // router.get("/compare", async (req, res) => {
  //   const q = (req.query.q || "").toString();
  //   const k = Number.parseInt(req.query.k, 10) || 10;
  //   const entries = Object.entries(indexes);
  //   const settled = await Promise.all(
  //     entries.map(async ([name, index]) => {
  //       try {
  //         const { hits, latencyMs } = await timedSearch(index, q, k);
  //         return { ranker: name, latencyMs, hits };
  //       } catch (err) {
  //         return { ranker: name, latencyMs: null, error: err.message || "failed", hits: [] };
  //       }
  //     })
  //   );
  //   res.json({ query: q, k, results: settled });
  // });

  return router;
}

module.exports = { createSearchRouter };
