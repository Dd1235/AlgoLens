const express = require("express");
const { tokenize } = require("../search/tokenize");
const { buildInvertedIndex } = require("../search/inverted");

function createSearchRouter(problems) {
  const { lookup } = buildInvertedIndex(problems);

  const router = express.Router();

  router.get("/search", (req, res) => {
    const q = (req.query.q || "").toString();
    const queryTokens = tokenize(q);

    if (queryTokens.length === 0) {
      return res.json({ query: q, hits: [] });
    }

    const matchedByDoc = new Map();
    for (const term of queryTokens) {
      const docs = lookup(term);
      if (!docs) continue;
      for (const docId of docs) {
        let arr = matchedByDoc.get(docId);
        if (!arr) {
          arr = [];
          matchedByDoc.set(docId, arr);
        }
        arr.push(term);
      }
    }

    const hits = [];
    for (const [docId, matchedTerms] of matchedByDoc) {
      hits.push({ problem: problems[docId], matchedTerms });
    }

    res.json({ query: q, hits });
  });

  return router;
}

module.exports = { createSearchRouter };
