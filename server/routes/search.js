const express = require("express");

function pickRanker(indexes, defaultRanker, req) {
  const requested = (req.query.ranker || "").toString().toLowerCase();
  if (requested && indexes[requested]) return requested;
  return defaultRanker;
}

async function timedSearch(index, q, k) {
  const t = process.hrtime.bigint();
  const hits = await Promise.resolve(index.search(q, k));
  const latencyMs = Number(process.hrtime.bigint() - t) / 1e6;
  return { hits, latencyMs: +latencyMs.toFixed(3) };
}

function createSearchRouter({ indexes, defaultRanker }) {
  const router = express.Router();

  router.get("/search", async (req, res) => {
    const q = (req.query.q || "").toString();
    const k = Number.parseInt(req.query.k, 10) || 10;
    const ranker = pickRanker(indexes, defaultRanker, req);
    const index = indexes[ranker];
    try {
      const { hits, latencyMs } = await timedSearch(index, q, k);
      res.json({ query: q, ranker, latencyMs, hits });
    } catch (err) {
      res.status(502).json({ query: q, ranker, error: err.message || "search failed" });
    }
  });

  router.get("/compare", async (req, res) => {
    const q = (req.query.q || "").toString();
    const k = Number.parseInt(req.query.k, 10) || 10;
    const entries = Object.entries(indexes);
    const settled = await Promise.all(
      entries.map(async ([name, index]) => {
        try {
          const { hits, latencyMs } = await timedSearch(index, q, k);
          return { ranker: name, latencyMs, hits };
        } catch (err) {
          return { ranker: name, latencyMs: null, error: err.message || "failed", hits: [] };
        }
      })
    );
    res.json({ query: q, k, results: settled });
  });

  return router;
}

module.exports = { createSearchRouter };
