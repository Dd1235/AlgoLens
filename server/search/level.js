// Turn a user's own judge stats into a difficulty selection.
//
// Every judge gets its OWN heuristic against its OWN scale. Nothing here maps
// a Codeforces rating onto AtCoder or LeetCode — that is the cross-judge
// normalization this project keeps refusing to invent, and it would be worse
// here than anywhere else, because a wrong guess about someone's level is a
// page of problems they can't attempt.
//
//   codeforces  rating R -> [R, R+200] on the 100-grid.
//               Codeforces ratings are calibrated so that a contestant rated R
//               solves a problem rated R about half the time under contest
//               conditions. So the band starts AT the user's rating (winnable,
//               not free) and reaches one notch past it. Below R is revision,
//               far above is a wall.
//
//   atcoder     rating R -> [R, R+200] on the 200-grid. The same reasoning
//               applies natively: AtCoder's community difficulty estimates are
//               "the rating at which 50% solve it", and we compare an AtCoder
//               rating against AtCoder difficulties. Same scale, no conversion.
//
//   leetcode    no rating exists, so this is the one real heuristic. LeetCode
//               publishes solved counts per tier, and those counts include the
//               whole problemset — most of which is easier than anything in
//               this corpus. So it is a coarse proxy and is treated as one: it
//               picks a tier, then an acceptance-rate half within that tier,
//               from the corpus's own median rather than invented cut-offs.
//
// Every suggestion carries the count it would produce, so the caller can say
// "214 problems" instead of applying a filter that might select nothing.

const RATED = {
  codeforces: { short: "cf", step: 100, reach: 200 },
  atcoder: { short: "atc", step: 200, reach: 200 },
};

// Rungs are placed where the useful next problem actually changes, not on a
// smooth curve — under ~10 Hards you are still building Medium fluency, 25+
// means Hards are viable, 100+ means the approachable Hards are routine.
const LC_RUNGS = [
  { maxHard: 10, tier: "medium", half: "upper", why: "few hards solved yet" },
  { maxHard: 25, tier: "medium", half: "lower", why: "comfortable with mediums" },
  { maxHard: 100, tier: "hard", half: "upper", why: "hards are working" },
  { maxHard: Infinity, tier: "hard", half: "lower", why: "hards are routine" },
];
const LC_FIRST_RUNG_MEDIUMS = 100;

function snap(value, step, dir) {
  return (dir < 0 ? Math.floor(value / step) : Math.ceil(value / step)) * step;
}

function median(sorted) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function ratedSuggestion(judge, rating, problems) {
  const meta = RATED[judge];
  if (!meta || typeof rating !== "number" || !Number.isFinite(rating)) return null;
  const values = problems
    .filter((p) => p.platform === judge && typeof p.difficulty === "number")
    .map((p) => p.difficulty);
  if (!values.length) return null;

  const floor = snap(Math.min(...values), meta.step, -1);
  const ceil = snap(Math.max(...values), meta.step, 1);
  // Clamp so a 3500-rated user still gets the top of the corpus rather than an
  // empty band above it, and a beginner gets the bottom rather than nothing.
  let min = Math.min(Math.max(snap(rating, meta.step, -1), floor), ceil - meta.reach);
  min = Math.max(min, floor);
  const max = Math.min(min + meta.reach, ceil);

  const count = values.filter((v) => v >= min && v <= max).length;
  return {
    difficulty: `${meta.short}:${min}-${max}`,
    why: `rated ${rating} on ${judge}`,
    count,
  };
}

function leetcodeSuggestion(byDifficulty, problems) {
  if (!byDifficulty || typeof byDifficulty !== "object") return null;
  const hard = Number(byDifficulty.hard) || 0;
  const medium = Number(byDifficulty.medium) || 0;
  if (!hard && !medium) return null;

  let rung = LC_RUNGS.find((r) => hard < r.maxHard) || LC_RUNGS[LC_RUNGS.length - 1];
  // Someone with no hards but hundreds of mediums has clearly outgrown the
  // gentlest rung, even though the hard count alone can't tell.
  if (rung === LC_RUNGS[0] && medium >= LC_FIRST_RUNG_MEDIUMS) rung = LC_RUNGS[1];

  const rates = problems
    .filter(
      (p) =>
        p.platform === "leetcode" &&
        String(p.difficulty || "").toLowerCase() === rung.tier &&
        typeof p.acceptance_rate === "number"
    )
    .map((p) => p.acceptance_rate)
    .sort((a, b) => a - b);
  if (!rates.length) return null;

  const mid = median(rates);
  // Lower acceptance means harder, so the "upper half" by rate is the gentler
  // half of the tier and the lower half is its sharp end.
  const lo = rung.half === "upper" ? mid : rates[0];
  const hi = rung.half === "upper" ? rates[rates.length - 1] : mid;
  const min = snap(lo, 5, -1);
  const max = snap(hi, 5, 1);

  const count = rates.filter((r) => r >= min && r <= max).length;
  return {
    difficulty: `lc-${rung.tier},ac:${min}-${max}`,
    why: `${hard} hard / ${medium} medium solved — ${rung.why}`,
    count,
  };
}

// signals: { codeforces: { rating }, atcoder: { rating }, leetcode: { byDifficulty } }
function suggestLevel(signals, problems) {
  const out = {};
  if (!signals || typeof signals !== "object") return out;
  for (const judge of Object.keys(RATED)) {
    const s = signals[judge];
    const hit = s && ratedSuggestion(judge, s.rating, problems || []);
    if (hit && hit.count > 0) out[judge] = hit;
  }
  const lc = signals.leetcode && leetcodeSuggestion(signals.leetcode.byDifficulty, problems || []);
  if (lc && lc.count > 0) out.leetcode = lc;
  return out;
}

module.exports = { suggestLevel, ratedSuggestion, leetcodeSuggestion, LC_RUNGS };
