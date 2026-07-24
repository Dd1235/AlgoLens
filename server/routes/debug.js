const express = require("express");
const { expandQuery } = require("../search/query_expand");

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

  router.get("/explain", async (req, res) => {
    const q = (req.query.q || "").toString();
    // Explain is the debug lens for what search actually ran, so it expands too.
    const exp = expandQuery(q);
    const ranker = pickRanker(indexes, defaultRanker, req);
    const index = indexes[ranker];
    if (typeof index.explain !== "function") {
      return res.status(501).json({ error: `${ranker} has no explain` });
    }
    try {
      // dense/hybrid explain is async (query embedding); lexical stays sync.
      // Spreading a bare Promise here would silently produce { ranker } only.
      const payload = await Promise.resolve(index.explain(exp.query));
      res.json({ ranker, expandedQuery: exp.expanded ? exp.query : undefined, ...payload });
    } catch (err) {
      res.status(502).json({ ranker, error: err.message || "explain failed" });
    }
  });

  return router;
}

module.exports = { createDebugRouter };
