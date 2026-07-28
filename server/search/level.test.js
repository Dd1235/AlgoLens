// The "at my level" heuristic. These are judgement calls, not facts, so what's
// tested is that each one stays inside its own judge's scale, never suggests a
// filter that selects nothing, and produces a token the real filter agrees with.
const assert = require("node:assert/strict");
const { suggestLevel } = require("./level");
const { parseSelection, passesDifficulty } = require("./difficulty");

// A corpus shaped like the real one: rated Codeforces and AtCoder, tiered
// LeetCode with acceptance rates, and CSES with no difficulty at all.
const problems = [];
for (let r = 800; r <= 3500; r += 100) {
  for (let i = 0; i < 3; i++) problems.push({ id: `cf-${r}-${i}`, platform: "codeforces", difficulty: r });
}
for (let r = 0; r <= 2400; r += 200) {
  for (let i = 0; i < 3; i++) problems.push({ id: `atc-${r}-${i}`, platform: "atcoder", difficulty: r });
}
for (let i = 0; i < 200; i++) {
  problems.push({
    id: `lc-m-${i}`,
    platform: "leetcode",
    difficulty: "Medium",
    acceptance_rate: 15 + (i % 70),
  });
  problems.push({
    id: `lc-h-${i}`,
    platform: "leetcode",
    difficulty: "Hard",
    acceptance_rate: 14 + (i % 66),
  });
}
for (let i = 0; i < 50; i++) problems.push({ id: `cses-${i}`, platform: "cses" });

// Every suggestion must survive the round trip: parse it with the real filter
// and it has to select the count it promised. Counting is scoped to the judge
// because passesDifficulty deliberately lets OTHER judges through untouched —
// that isolation is asserted on its own below.
function selects(token, platform) {
  const sel = parseSelection(token);
  return problems.filter((p) => (!platform || p.platform === platform) && passesDifficulty(p, sel));
}

// ── Codeforces: the band starts at the user's own rating ─────────────────────
{
  const s = suggestLevel({ codeforces: { rating: 1834 } }, problems);
  assert.equal(s.codeforces.difficulty, "cf:1800-2000", "snapped down to the 100-grid, reaching +200");
  assert.equal(s.atcoder, undefined, "a codeforces rating says nothing about atcoder");
  assert.equal(s.leetcode, undefined, "and nothing about leetcode");
}

// An exact grid rating isn't nudged.
{
  const s = suggestLevel({ codeforces: { rating: 1600 } }, problems);
  assert.equal(s.codeforces.difficulty, "cf:1600-1800");
}

// Above the corpus ceiling it clamps to real problems instead of an empty band
// somewhere past the hardest thing we have.
{
  const s = suggestLevel({ codeforces: { rating: 3600 } }, problems);
  const hits = selects(s.codeforces.difficulty, "codeforces");
  assert.ok(hits.length > 0, "a top-rated user must still get problems");
  assert.equal(hits.length, s.codeforces.count);
}

// ...and below the floor, likewise.
{
  const s = suggestLevel({ codeforces: { rating: 400 } }, problems);
  assert.ok(selects(s.codeforces.difficulty, "codeforces").length > 0, "a beginner must still get problems");
}

// ── AtCoder: its own grid, natively ──────────────────────────────────────────
{
  const s = suggestLevel({ atcoder: { rating: 1100 } }, problems);
  assert.equal(s.atcoder.difficulty, "atc:1000-1200", "atcoder steps by 200, not 100");
  assert.equal(selects(s.atcoder.difficulty, "atcoder").length, s.atcoder.count);
  // The isolation rule: an atcoder band must leave every other judge alone.
  const untouched = selects(s.atcoder.difficulty).filter((p) => p.platform !== "atcoder").length;
  assert.equal(untouched, problems.filter((p) => p.platform !== "atcoder").length,
    "suggesting an atcoder band must not delete other judges' problems");
}

// ── LeetCode: a ladder, because there is no rating to read ───────────────────
{
  const rungs = [
    [{ easy: 80, medium: 40, hard: 2 }, "lc-medium", "gentle"],
    [{ easy: 200, medium: 300, hard: 5 }, "lc-medium", "sharp"],
    [{ easy: 200, medium: 400, hard: 60 }, "lc-hard", "gentle"],
    [{ easy: 300, medium: 700, hard: 250 }, "lc-hard", "sharp"],
  ];
  const seen = [];
  for (const [byDifficulty, tier, _half] of rungs) {
    const s = suggestLevel({ leetcode: { byDifficulty } }, problems);
    assert.ok(s.leetcode, `expected a suggestion for ${JSON.stringify(byDifficulty)}`);
    assert.ok(s.leetcode.difficulty.startsWith(tier), `${JSON.stringify(byDifficulty)} -> ${tier}`);
    const hits = selects(s.leetcode.difficulty, "leetcode");
    assert.equal(hits.length, s.leetcode.count, "the promised count must be the real count");
    assert.ok(
      selects(s.leetcode.difficulty).some((p) => p.platform === "cses"),
      "cses has no difficulty and must survive any leetcode band"
    );
    seen.push(s.leetcode.difficulty);
  }
  assert.equal(new Set(seen).size, 4, "each rung must land somewhere different");

  // The two Hard rungs must actually differ in where they sit: more experience
  // means a lower acceptance rate, which means harder.
  const gentleHard = suggestLevel({ leetcode: { byDifficulty: { medium: 400, hard: 60 } } }, problems);
  const sharpHard = suggestLevel({ leetcode: { byDifficulty: { medium: 700, hard: 250 } } }, problems);
  const rateOf = (d) => Number(/ac:(-?\d+)-/.exec(d)[1]);
  assert.ok(
    rateOf(sharpHard.leetcode.difficulty) < rateOf(gentleHard.leetcode.difficulty),
    "the experienced rung must reach lower-acceptance (harder) problems"
  );
}

// Hundreds of Mediums with no Hards is not a beginner, even though the hard
// count alone can't tell them apart.
{
  const raw = suggestLevel({ leetcode: { byDifficulty: { medium: 20, hard: 1 } } }, problems);
  const seasoned = suggestLevel({ leetcode: { byDifficulty: { medium: 400, hard: 1 } } }, problems);
  assert.notEqual(raw.leetcode.difficulty, seasoned.leetcode.difficulty, "medium volume must count for something");
}

// ── Nothing invented from nothing ────────────────────────────────────────────
{
  assert.deepEqual(suggestLevel({}, problems), {});
  assert.deepEqual(suggestLevel(null, problems), {});
  assert.deepEqual(suggestLevel({ codeforces: {} }, problems), {}, "a handle with no rating yet suggests nothing");
  assert.deepEqual(suggestLevel({ codeforces: { rating: "1600" } }, problems), {}, "a string rating is not a rating");
  assert.deepEqual(suggestLevel({ leetcode: { byDifficulty: { easy: 5 } } }, problems), {}, "easies alone say nothing");
  assert.deepEqual(suggestLevel({ codechef: { rating: 1900 } }, problems), {}, "codechef isn't in the corpus");
}

// A judge in the signals but absent from the corpus can't be suggested.
{
  const onlyLeetcode = problems.filter((p) => p.platform === "leetcode");
  assert.deepEqual(suggestLevel({ codeforces: { rating: 1600 } }, onlyLeetcode), {});
}

// Every suggestion, for every plausible input, must select something.
{
  for (let r = 800; r <= 3500; r += 100) {
    const s = suggestLevel({ codeforces: { rating: r } }, problems);
    assert.ok(s.codeforces && s.codeforces.count > 0, `cf ${r} must suggest a non-empty band`);
    assert.equal(selects(s.codeforces.difficulty, "codeforces").length, s.codeforces.count, `cf ${r} count must be honest`);
  }
  for (let hard = 0; hard <= 400; hard += 20) {
    const s = suggestLevel({ leetcode: { byDifficulty: { medium: 150, hard } } }, problems);
    assert.ok(s.leetcode && s.leetcode.count > 0, `lc hard=${hard} must suggest a non-empty band`);
  }
}

console.log("level heuristic tests passed");
