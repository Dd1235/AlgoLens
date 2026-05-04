const express = require("express");
const { tokenize } = require("../search/tokenize");

function problemText(p) {
  return [p.title, p.statement, ...(p.tags || [])].join(" ");
}

function createSearchRouter(problems) {
  const docTokens = problems.map((p) => new Set(tokenize(problemText(p))));

  const router = express.Router();

  router.get("/search", (req, res) => {
    const q = (req.query.q || "").toString();
    const queryTokens = tokenize(q);

    if (queryTokens.length === 0) {
      return res.json({ query: q, hits: [] });
    }

    const hits = [];
    problems.forEach((problem, i) => {
      const tokens = docTokens[i];
      const matched = queryTokens.filter((t) => tokens.has(t));
      if (matched.length > 0) {
        hits.push({ problem, matchedTerms: matched });
      }
    });

    res.json({ query: q, hits });
  });

  return router;
}

module.exports = { createSearchRouter };
