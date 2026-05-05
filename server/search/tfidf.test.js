const assert = require("node:assert/strict");
const { TfIdfIndex } = require("./tfidf");

const corpus = [
  { id: "a", title: "graph cycle", statement: "detect cycle in directed graph", tags: [], patterns: [] },
  { id: "b", title: "graph traversal", statement: "bfs over graph", tags: [], patterns: [] },
  { id: "c", title: "string parsing", statement: "parse a string with stack", tags: [], patterns: [] },
];

const index = new TfIdfIndex(corpus);

// "graph" appears in 2 of 3 docs -> idf > 0
assert.ok(index.idf.get("graph") > 0, "graph idf should be positive");

// A token in every doc -> idf 0 (none here, but synthesize one)
const allDocsCorpus = [
  { id: "a", title: "shared", statement: "", tags: [], patterns: [] },
  { id: "b", title: "shared", statement: "", tags: [], patterns: [] },
];
const idx2 = new TfIdfIndex(allDocsCorpus);
assert.equal(idx2.idf.get("shared"), 0, "term in every doc should have idf 0");

// "cycle" only in doc a -> top hit for "cycle" must be doc a
const { hits, total } = index.search("cycle", 5);
assert.ok(hits.length >= 1, "cycle should match something");
assert.equal(hits[0].problem.id, "a", "doc a should rank first for 'cycle'");

// rare term beats common term: "parsing" only in doc c, "graph" in 2 docs
// for query "graph parsing", doc c should beat doc b (parsing has higher idf)
const result2 = index.search("graph parsing", 5);
const idsByRank = result2.hits.map((h) => h.problem.id);
assert.equal(idsByRank[0], "c", "rare 'parsing' should pull doc c above pure-graph docs");

// stopword-only query returns empty
const emptyResult = index.search("the and of", 5);
assert.equal(emptyResult.hits.length, 0);
assert.equal(emptyResult.total, 0);

// offset + total test
const offsetResult = index.search("graph", 10, 1);
assert.ok(offsetResult.total >= 1, "should have at least 1 result for 'graph'");
assert.equal(offsetResult.hits.length, Math.min(10, offsetResult.total - 1), "offset=1 should skip first");

console.log("tfidf tests passed");
