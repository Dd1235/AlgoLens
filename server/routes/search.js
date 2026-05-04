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
    const hits = index.search(q, k);
    res.json({ query: q, ranker, hits });
  });

  return router;
}

module.exports = { createSearchRouter };
