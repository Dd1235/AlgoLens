const express = require("express");

const MOCK_HITS = [
  {
    problem: {
      id: "mock-1",
      title: "Two Sum",
      difficulty: "easy",
      tags: ["array", "hash-map"],
    },
  },
  {
    problem: {
      id: "mock-2",
      title: "Valid Parentheses",
      difficulty: "easy",
      tags: ["stack", "string"],
    },
  },
  {
    problem: {
      id: "mock-3",
      title: "Course Schedule",
      difficulty: "medium",
      tags: ["graph", "topological-sort"],
    },
  },
];

const router = express.Router();

router.get("/search", (req, res) => {
  const q = (req.query.q || "").toString();
  res.json({ query: q, hits: MOCK_HITS });
});

module.exports = router;
