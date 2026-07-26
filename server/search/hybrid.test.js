const assert = require("node:assert/strict");
const { HybridIndex } = require("./hybrid");

const P = { a: { id: "a", title: "A" }, b: { id: "b", title: "B" }, c: { id: "c", title: "C" }, d: { id: "d", title: "D" } };
const hit = (p, score, terms = []) => ({ problem: p, score, matchedTerms: terms });

// fake lexical leg: sync, ranks [a, b, c]; empty for the stopword-only query
const lexical = {
  search(query) {
    if (query === "the and of") return { hits: [], total: 0 };
    return { hits: [hit(P.a, 9, ["graph"]), hit(P.b, 5, ["tree"]), hit(P.c, 2, ["graph"])], total: 3 };
  },
};
// fake dense leg: async, ranks [c, d, a]
const dense = {
  async search() {
    return { hits: [hit(P.c, 0.9), hit(P.d, 0.7), hit(P.a, 0.5)], total: 4 };
  },
};

const index = new HybridIndex({ lexical, dense });

(async () => {
  const { hits, total } = await index.search("anything", 10);

  // hand-computed RRF (k=60):
  //   a: lex rank 1 + dense rank 3 -> 1/61 + 1/63
  //   c: lex rank 3 + dense rank 1 -> 1/63 + 1/61   (ties a; lexRank 1 < 3 puts a first)
  //   b: lex rank 2 -> 1/62
  //   d: dense rank 2 -> 1/62                        (ties b; b has a lexical rank, wins)
  assert.deepEqual(hits.map((h) => h.problem.id), ["a", "c", "b", "d"]);
  assert.ok(Math.abs(hits[0].score - (1 / 61 + 1 / 63)) < 1e-12);
  assert.ok(Math.abs(hits[1].score - (1 / 63 + 1 / 61)) < 1e-12);
  assert.ok(Math.abs(hits[2].score - 1 / 62) < 1e-12);
  assert.ok(Math.abs(hits[3].score - 1 / 62) < 1e-12);

  // total = |union of both legs|
  assert.equal(total, 4);

  // matchedTerms pass through from the lexical leg; dense-only docs get []
  assert.deepEqual(hits[0].matchedTerms, ["graph"]);
  assert.deepEqual(hits[2].matchedTerms, ["tree"]);
  assert.deepEqual(hits[3].matchedTerms, []);

  // offset slicing over the fused ranking
  const page2 = await index.search("anything", 2, 2);
  assert.deepEqual(page2.hits.map((h) => h.problem.id), ["b", "d"]);
  assert.equal(page2.total, 4);

  // lexical leg empty (stopword-only query) -> fusion degrades to the dense leg
  const denseOnly = await index.search("the and of", 10);
  assert.deepEqual(denseOnly.hits.map((h) => h.problem.id), ["c", "d", "a"]);
  assert.ok(Math.abs(denseOnly.hits[0].score - 1 / 61) < 1e-12);
  assert.equal(denseOnly.total, 3);

  // explain: contributions sum to the fused score
  const ex = await index.explain("anything");
  assert.equal(ex.params.kRrf, 60);
  assert.deepEqual(ex.legs.lexical.map((l) => l.id), ["a", "b", "c"]);
  assert.deepEqual(ex.legs.dense.map((l) => l.id), ["c", "d", "a"]);
  for (const d of ex.docs) {
    assert.ok(Math.abs(d.lexContribution + d.denseContribution - d.total) < 1e-12);
  }
  assert.deepEqual(ex.docs.map((d) => d.problem.id), ["a", "c", "b", "d"]);

  // Leg depth: floors at topN so an ordinary shallow query costs exactly what
  // it always did, and widens only when the caller asks for more than that.
  // The route relies on the widening to filter and page over the whole ranked
  // list; the floor is what keeps the common path off the slow road.
  {
    const seen = [];
    const spy = { search(_q, k) { seen.push(k); return { hits: [], total: 0 }; } };
    const spied = new HybridIndex({
      lexical: spy,
      dense: { async search(_q, k) { seen.push(k); return { hits: [], total: 0 }; } },
    });
    await spied.search("q", 20, 0);
    assert.deepEqual(seen, [100, 100], "a k=20 query must not widen the legs past topN");

    seen.length = 0;
    await spied.search("q", 20, 300);
    assert.deepEqual(seen, [320, 320], "paging past topN must widen the legs to reach it");

    seen.length = 0;
    await spied.search("q", 5000, 0);
    assert.deepEqual(seen, [5000, 5000], "the route's full-corpus fetch must reach every leg");
  }

  console.log("hybrid tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
