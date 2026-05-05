const express = require("express");

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

function createSearchRouter({ indexes, defaultRanker }) {
  const router = express.Router();

  router.get("/search", async (req, res) => {
    const q = (req.query.q || "").toString();
    const k = Number.parseInt(req.query.k, 10) || 10;
    const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
    const ranker = pickRanker(indexes, defaultRanker, req);
    const index = indexes[ranker];
    try {
      const { hits, total, latencyMs } = await timedSearch(index, q, k, offset);
      res.json({ query: q, ranker, latencyMs, offset, k, total, hits });
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
