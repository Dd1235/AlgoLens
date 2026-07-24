const assert = require("node:assert/strict");
const { expandQuery } = require("./query_expand");

// Alias phrase → canonical words appended (the original tokens stay).
{
  const r = expandQuery("aliens trick minimize cost");
  assert.equal(r.expanded, true);
  assert.equal(r.query, "aliens trick minimize cost wqs binary search");
  assert.deepEqual(r.added, ["wqs", "binary", "search"]);
}

// Single-word alias.
{
  const r = expandQuery("cht dp optimization");
  assert.equal(r.expanded, true);
  assert.ok(r.query.includes("convex hull trick"));
}

// The exp-06 regression case: "sum over subsets" now reaches the sos-dp label.
{
  const r = expandQuery("sum over subsets bitmask");
  assert.equal(r.expanded, true);
  assert.deepEqual(r.added, ["sos", "dp"]);
}

// Words already present are not re-added — and independent aliases compose:
// "sum over subsets dp" gets "sos" (dp already present) plus the dp alias's
// "dynamic programming".
{
  const r = expandQuery("sum over subsets dp");
  assert.deepEqual(r.added, ["sos", "dynamic", "programming"]);
}

// No-op when canonical words already cover the query ("sweep line" matches the
// line-sweep label tokens lexically already).
{
  const r = expandQuery("sweep line intervals");
  assert.equal(r.expanded, false);
  assert.equal(r.query, "sweep line intervals");
}

// Hyphenated query form matches too.
{
  const r = expandQuery("scanline algorithm");
  assert.equal(r.expanded, true);
  assert.ok(r.added.includes("sweep"));
}

// Word boundaries: no firing inside other words.
{
  const r = expandQuery("alien dictionary topological order");
  assert.equal(r.expanded, false);
}

// dp expands (append-only), keeping the literal token.
{
  const r = expandQuery("knapsack dp");
  assert.equal(r.expanded, true);
  assert.ok(r.query.startsWith("knapsack dp"));
  assert.deepEqual(r.added, ["dynamic", "programming"]);
}

// Cap on appended words.
{
  const r = expandQuery("aliens cht bit sum over subsets scanline priority queue lca");
  assert.ok(r.added.length <= 8);
}

// Guards: empty and overlong queries pass through untouched.
assert.equal(expandQuery("").expanded, false);
assert.equal(expandQuery("x".repeat(400)).expanded, false);

console.log("query_expand tests passed");
