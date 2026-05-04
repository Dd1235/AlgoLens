const express = require("express");

function createSearchRouter(index) {
  const router = express.Router();

  router.get("/search", (req, res) => {
    const q = (req.query.q || "").toString();
    const k = Number.parseInt(req.query.k, 10) || 10;
    const hits = index.search(q, k);
    res.json({ query: q, hits });
  });

  return router;
}

module.exports = { createSearchRouter };
