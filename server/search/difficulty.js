// Per-judge difficulty bands.
//
// There is no cross-judge difficulty scale and this deliberately does not
// invent one. LeetCode has three named tiers, Codeforces has contest ratings,
// AtCoder has community-estimated ratings on a different distribution (they go
// negative), and CSES publishes nothing at all — 400 problems, 16% of the
// corpus, with no difficulty field. Mapping those onto shared buckets would
// mean asserting that a CF 1600 is "the same as" a LeetCode Medium, which
// nobody can defend.
//
// So a band belongs to exactly one judge, and the UI only offers a judge's
// bands when that judge is selected. That turns an unsolvable normalization
// problem into a solvable filtering one.
//
// Band ids are stable and self-identifying (`cf-1800`), so a URL survives
// without a separate judge parameter to interpret it against.

const BANDS = [
  // LeetCode: named tiers, matched case-insensitively because the stored value
  // is capitalized ("Medium") while a URL will carry lowercase.
  { id: "lc-easy", judge: "leetcode", label: "easy" },
  { id: "lc-medium", judge: "leetcode", label: "medium" },
  { id: "lc-hard", judge: "leetcode", label: "hard" },

  // Codeforces contest ratings, 400 wide — the same granularity contestants
  // think in (div2 A/B, C, D, E+).
  { id: "cf-1000", judge: "codeforces", label: "1000–1399", min: 1000, max: 1399 },
  { id: "cf-1400", judge: "codeforces", label: "1400–1799", min: 1400, max: 1799 },
  { id: "cf-1800", judge: "codeforces", label: "1800–2199", min: 1800, max: 2199 },
  { id: "cf-2200", judge: "codeforces", label: "2200–2599", min: 2200, max: 2599 },
  { id: "cf-2600", judge: "codeforces", label: "2600+", min: 2600, max: Infinity },

  // AtCoder difficulties are kenkoooo's IRT estimates, not contest ratings, and
  // the corpus slice is small (112 rated), so three coarse bands rather than
  // five thin ones. The floor is -Infinity because one problem is rated -52.
  { id: "atc-0", judge: "atcoder", label: "under 1200", min: -Infinity, max: 1199 },
  { id: "atc-1200", judge: "atcoder", label: "1200–1999", min: 1200, max: 1999 },
  { id: "atc-2000", judge: "atcoder", label: "2000+", min: 2000, max: Infinity },
];

const BY_ID = new Map(BANDS.map((b) => [b.id, b]));

function bandMatches(band, problem) {
  if (problem.platform !== band.judge) return false;
  const d = problem.difficulty;
  if (band.min === undefined) {
    return typeof d === "string" && d.toLowerCase() === band.label;
  }
  return typeof d === "number" && d >= band.min && d <= band.max;
}

function parseBands(raw) {
  return new Set(
    String(raw || "")
      .toLowerCase()
      .split(",")
      .map((s) => s.trim())
      .filter((s) => BY_ID.has(s))
  );
}

// A problem passes when it satisfies one of the selected bands for its own
// judge, and is unaffected by bands belonging to other judges. Without that
// last rule, selecting "cf 1800+" while LeetCode is also active would silently
// delete every LeetCode result — a judge with no band selected is unfiltered,
// not excluded.
function passesDifficulty(problem, selected) {
  if (!selected || selected.size === 0) return true;
  let judgeHasSelection = false;
  for (const id of selected) {
    const band = BY_ID.get(id);
    if (!band || band.judge !== problem.platform) continue;
    judgeHasSelection = true;
    if (bandMatches(band, problem)) return true;
  }
  return !judgeHasSelection;
}

// Serializable shape for the client, with live counts so a band that would
// return nothing can be rendered as such instead of looking broken.
function buildDifficultyPayload(problems) {
  const counts = new Map(BANDS.map((b) => [b.id, 0]));
  for (const p of problems || []) {
    for (const band of BANDS) {
      if (bandMatches(band, p)) counts.set(band.id, counts.get(band.id) + 1);
    }
  }
  return BANDS.map(({ id, judge, label }) => ({ id, judge, label, count: counts.get(id) }));
}

module.exports = { BANDS, parseBands, passesDifficulty, buildDifficultyPayload };
