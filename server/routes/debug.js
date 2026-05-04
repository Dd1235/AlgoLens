const express = require("express");

function pickRanker(indexes, defaultRanker, req) {
  const requested = (req.query.ranker || "").toString().toLowerCase();
  if (requested && indexes[requested]) return requested;
  return defaultRanker;
}

function createDebugRouter({ problems, indexes, defaultRanker }) {
  const router = express.Router();

  router.get("/problems", (req, res) => {
    res.json({ count: problems.length, problems });
  });

  router.get("/rankers", (req, res) => {
    res.json({ available: Object.keys(indexes), default: defaultRanker });
  });

  router.get("/index", (req, res) => {
    const ranker = pickRanker(indexes, defaultRanker, req);
    const index = indexes[ranker];
    if (typeof index.dumpInverted !== "function") {
      return res.status(501).json({ error: `${ranker} has no dumpInverted` });
    }
    res.json({ ranker, ...index.dumpInverted() });
  });

  router.get("/explain", (req, res) => {
    const q = (req.query.q || "").toString();
    const ranker = pickRanker(indexes, defaultRanker, req);
    const index = indexes[ranker];
    if (typeof index.explain !== "function") {
      return res.status(501).json({ error: `${ranker} has no explain` });
    }
    res.json({ ranker, ...index.explain(q) });
  });

  return router;
}

module.exports = { createDebugRouter };
