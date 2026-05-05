const express = require("express");

function pickRanker(indexes, defaultRanker, req) {
  const requested = (req.query.ranker || "").toString().toLowerCase();
  if (requested && indexes[requested]) return requested;
  return defaultRanker;
}

function createSearchRouter({ indexes, defaultRanker }) {
  const router = express.Router();

  router.get("/search", (req, res) => {
    const q = (req.query.q || "").toString();
    const k = Number.parseInt(req.query.k, 10) || 10;
    const ranker = pickRanker(indexes, defaultRanker, req);
    const index = indexes[ranker];
    const t = process.hrtime.bigint();
    const hits = index.search(q, k);
    const latencyMs = Number(process.hrtime.bigint() - t) / 1e6;
    res.json({ query: q, ranker, latencyMs: +latencyMs.toFixed(3), hits });
  });

  router.get("/compare", (req, res) => {
    const q = (req.query.q || "").toString();
    const k = Number.parseInt(req.query.k, 10) || 10;
    const results = [];
    for (const [name, index] of Object.entries(indexes)) {
      const t = process.hrtime.bigint();
      const hits = index.search(q, k);
      const latencyMs = Number(process.hrtime.bigint() - t) / 1e6;
      results.push({ ranker: name, latencyMs: +latencyMs.toFixed(3), hits });
    }
    res.json({ query: q, k, results });
  });

  return router;
}

module.exports = { createSearchRouter };
