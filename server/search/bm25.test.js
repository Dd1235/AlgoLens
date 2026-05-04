const assert = require("node:assert/strict");
const { Bm25Index } = require("./bm25");

const corpus = [
  { id: "a", title: "graph cycle", statement: "detect cycle in directed graph", tags: [], patterns: [] },
  { id: "b", title: "graph traversal", statement: "bfs over graph", tags: [], patterns: [] },
  { id: "c", title: "string parsing", statement: "parse a string with stack", tags: [], patterns: [] },
];

const index = new Bm25Index(corpus);

// idf for any term in this 3-doc corpus is positive (BM25 idf is never negative with smoothing)
for (const term of ["graph", "cycle", "string"]) {
  assert.ok(index.idf.get(term) > 0, `${term} idf should be positive`);
}

// "cycle" only in doc a -> top hit must be doc a
const hits = index.search("cycle", 5);
assert.equal(hits[0].problem.id, "a");

// 'graph parsing' should rank doc c above doc b — like tf-idf, rare 'parsing' wins
const hits2 = index.search("graph parsing", 5);
assert.equal(hits2[0].problem.id, "c");

// stopword-only -> empty
assert.deepEqual(index.search("the and of", 5), []);

// term saturation test: a doc with the same term repeated 100x should not score 100x as much
const satCorpus = [
  { id: "x", title: "alpha", statement: "alpha ".repeat(1) + "filler".repeat(10), tags: [], patterns: [] },
  { id: "y", title: "alpha", statement: "alpha ".repeat(100) + "filler".repeat(10), tags: [], patterns: [] },
];
const idx = new Bm25Index(satCorpus);
const r = idx.search("alpha", 5);
const sx = r.find((h) => h.problem.id === "x").score;
const sy = r.find((h) => h.problem.id === "y").score;
assert.ok(sy / sx < 5, `bm25 should saturate, but ratio was ${sy / sx}`);

console.log("bm25 tests passed");
