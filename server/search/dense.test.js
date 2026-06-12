const assert = require("node:assert/strict");
const { DenseIndex } = require("./dense");

// Synthetic unit vectors, dims=4 — no model involved.
//   a = [1, 0, 0, 0]
//   b = [0.8, 0.6, 0, 0]   (cos(a,b) = 0.8)
//   c = [0, 1, 0, 0]
//   d = [0, 0, 1, 0]
const problems = [
  { id: "a", title: "alpha" },
  { id: "b", title: "beta" },
  { id: "c", title: "gamma" },
  { id: "d", title: "delta" },
];
const matrix = new Float32Array([
  1, 0, 0, 0,
  0.8, 0.6, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
]);
const queryVectors = {
  "like a": new Float32Array([1, 0, 0, 0]),
  "like c": new Float32Array([0, 1, 0, 0]),
};
const fakeEmbed = async (texts) => {
  const v = queryVectors[texts[0]];
  if (!v) throw new Error(`no canned vector for "${texts[0]}"`);
  return v;
};

const index = new DenseIndex(problems, { matrix, dims: 4, embed: fakeEmbed, model: "fake", dtype: "fp32" });

(async () => {
  // similarity ordering: query at a -> a (1.0), b (0.8), then c/d tie at 0 broken by id
  const r = await index.search("like a", 10);
  assert.deepEqual(r.hits.map((h) => h.problem.id), ["a", "b", "c", "d"]);
  assert.ok(Math.abs(r.hits[0].score - 1) < 1e-6);
  assert.ok(Math.abs(r.hits[1].score - 0.8) < 1e-6);

  // every doc has a similarity -> total is the corpus size
  assert.equal(r.total, 4);

  // matchedTerms is always [] — dense has no terms
  for (const h of r.hits) assert.deepEqual(h.matchedTerms, []);

  // offset pages are disjoint and cover the full ranking
  const page1 = await index.search("like a", 2, 0);
  const page2 = await index.search("like a", 2, 2);
  assert.deepEqual(page1.hits.map((h) => h.problem.id), ["a", "b"]);
  assert.deepEqual(page2.hits.map((h) => h.problem.id), ["c", "d"]);
  assert.equal(page1.total, 4);
  assert.equal(page2.total, 4);

  // empty / whitespace query -> no hits, matching the lexical rankers
  assert.deepEqual(await index.search("", 5), { hits: [], total: 0 });
  assert.deepEqual(await index.search("   ", 5), { hits: [], total: 0 });

  // query at c: b scores 0.6, a/d tie at 0 broken by id
  const rc = await index.search("like c", 10);
  assert.deepEqual(rc.hits.map((h) => h.problem.id), ["c", "b", "a", "d"]);

  // similar(): excludes self, nearest first, total = N - 1
  const sim = await index.similar("a", 10);
  assert.equal(sim.source.id, "a");
  assert.deepEqual(sim.hits.map((h) => h.problem.id), ["b", "c", "d"]);
  assert.equal(sim.total, 3);
  assert.ok(!sim.hits.some((h) => h.problem.id === "a"));

  // similar() with unknown id -> null
  assert.equal(index.similar("nope"), null);

  // explain mirrors search ordering and exposes cosine + angle
  const ex = await index.explain("like a");
  assert.deepEqual(ex.docs.map((d) => d.problem.id), ["a", "b", "c", "d"]);
  assert.ok(Math.abs(ex.docs[0].angleDeg - 0) < 1e-3);
  assert.ok(Math.abs(ex.docs[2].angleDeg - 90) < 1e-3);
  assert.equal(ex.count, 4);

  console.log("dense tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
