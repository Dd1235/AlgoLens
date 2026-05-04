const express = require("express");

function createDebugRouter({ problems, index }) {
  const router = express.Router();

  router.get("/problems", (req, res) => {
    res.json({ count: problems.length, problems });
  });

  router.get("/index", (req, res) => {
    if (typeof index.dumpInverted !== "function") {
      return res.status(501).json({ error: "active index has no dumpInverted" });
    }
    res.json(index.dumpInverted());
  });

  router.get("/explain", (req, res) => {
    const q = (req.query.q || "").toString();
    if (typeof index.explain !== "function") {
      return res.status(501).json({ error: "active index has no explain" });
    }
    res.json(index.explain(q));
  });

  return router;
}

module.exports = { createDebugRouter };
