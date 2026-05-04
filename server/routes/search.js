const express = require("express");

function createSearchRouter(problems) {
  const router = express.Router();

  router.get("/search", (req, res) => {
    const q = (req.query.q || "").toString();
    const hits = problems.map((problem) => ({ problem }));
    res.json({ query: q, hits });
  });

  return router;
}

module.exports = { createSearchRouter };
