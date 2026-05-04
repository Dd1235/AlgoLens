const express = require("express");

function createSearchRouter(problems) {
  const router = express.Router();

  router.get("/search", (req, res) => {
    const q = (req.query.q || "").toString();
    const needle = q.trim().toLowerCase();
    const matches = needle
      ? problems.filter((p) => p.title.toLowerCase().includes(needle))
      : problems;
    const hits = matches.map((problem) => ({ problem }));
    res.json({ query: q, hits });
  });

  return router;
}

module.exports = { createSearchRouter };
