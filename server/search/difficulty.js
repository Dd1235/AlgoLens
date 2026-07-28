// Per-judge difficulty filtering.
//
// There is no cross-judge difficulty scale and this deliberately does not
// invent one. LeetCode has three named tiers, Codeforces has contest ratings,
// AtCoder has community-estimated ratings on a different distribution (they go
// negative), and CSES publishes nothing at all. Mapping those onto shared
// buckets would mean asserting a CF 1600 is "the same as" a LeetCode Medium,
// which nobody can defend. So a selection belongs to exactly one judge, and the
// UI only offers a judge's control when that judge is selected.
//
// Two kinds of selection, because the two kinds of scale differ in kind:
//
//   named   `lc-medium`      — a tier. LeetCode has three, and that's the whole
//                              vocabulary; a range would be meaningless.
//   range   `cf:1500-1700`   — a rating window, inclusive both ends. Codeforces
//                              ratings are all multiples of 100, so a step-100
//                              range expresses "exactly 1500" as `cf:1500-1500`.
//                              Fixed coarse bands could not.
//
// Both forms live in one `difficulty=` parameter and are self-identifying, so a
// URL needs no separate judge parameter to be interpreted against.

const NAMED = [
  { id: "lc-easy", judge: "leetcode", label: "easy", value: "easy" },
  { id: "lc-medium", judge: "leetcode", label: "medium", value: "medium" },
  { id: "lc-hard", judge: "leetcode", label: "hard", value: "hard" },
];

const BY_ID = new Map(NAMED.map((b) => [b.id, b]));

// Rated judges get a range control. `step` is the granularity the scale can
// honestly support: Codeforces ratings really are multiples of 100, while
// AtCoder's are IRT estimates where 100-wide steps would be false precision.
const RATED = {
  codeforces: { short: "cf", step: 100 },
  atcoder: { short: "atc", step: 200 },
};
const SHORT_TO_JUDGE = new Map(Object.entries(RATED).map(([judge, m]) => [m.short, judge]));

const RANGE_RE = /^([a-z]{2,4}):(-?\d+)-(-?\d+)$/;

function parseSelection(raw) {
  const named = new Set();
  const ranges = new Map(); // judge -> { min, max }
  for (const token of String(raw || "").toLowerCase().split(",")) {
    const t = token.trim();
    if (!t) continue;
    if (BY_ID.has(t)) {
      named.add(t);
      continue;
    }
    const m = RANGE_RE.exec(t);
    if (!m) continue;
    const judge = SHORT_TO_JUDGE.get(m[1]);
    if (!judge) continue;
    const lo = Number(m[2]);
    const hi = Number(m[3]);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
    ranges.set(judge, { min: Math.min(lo, hi), max: Math.max(lo, hi) });
  }
  return { named, ranges, size: named.size + ranges.size };
}

// A problem passes when its own judge's selection accepts it. A judge with no
// selection is unfiltered, never excluded — without that rule, narrowing
// Codeforces to 1500 would silently delete every LeetCode result on screen.
function passesDifficulty(problem, selection) {
  if (!selection || !selection.size) return true;

  const range = selection.ranges.get(problem.platform);
  if (range) {
    const d = problem.difficulty;
    return typeof d === "number" && d >= range.min && d <= range.max;
  }

  let judgeHasNamed = false;
  for (const id of selection.named) {
    const band = BY_ID.get(id);
    if (!band || band.judge !== problem.platform) continue;
    judgeHasNamed = true;
    const d = problem.difficulty;
    if (typeof d === "string" && d.toLowerCase() === band.value) return true;
  }
  return !judgeHasNamed;
}

// Describes the controls the client should render, derived from the corpus so
// the bounds always match the data rather than a hardcoded guess.
function buildDifficultyPayload(problems) {
  const counts = new Map(NAMED.map((b) => [b.id, 0]));
  const ratings = new Map(Object.keys(RATED).map((j) => [j, []]));

  for (const p of problems || []) {
    for (const band of NAMED) {
      if (p.platform === band.judge && typeof p.difficulty === "string"
          && p.difficulty.toLowerCase() === band.value) {
        counts.set(band.id, counts.get(band.id) + 1);
      }
    }
    const bucket = ratings.get(p.platform);
    if (bucket && typeof p.difficulty === "number") bucket.push(p.difficulty);
  }

  const named = NAMED.map(({ id, judge, label }) => ({ id, judge, label, count: counts.get(id) }));

  const rated = [];
  for (const [judge, meta] of Object.entries(RATED)) {
    const values = ratings.get(judge);
    if (!values.length) continue;
    const step = meta.step;
    const min = Math.floor(Math.min(...values) / step) * step;
    const max = Math.ceil(Math.max(...values) / step) * step;
    const stops = [];
    for (let v = min; v <= max; v += step) stops.push(v);
    // Per-stop counts so the client can show how many problems sit in each
    // step, and grey out a stop that would return nothing.
    const histogram = stops.map((v) => values.filter((x) => x >= v && x < v + step).length);
    rated.push({ judge, short: meta.short, step, min, max, stops, histogram, count: values.length });
  }

  return { named, rated };
}

// ── Sorting ──────────────────────────────────────────────────────────────────
//
// Sorting by difficulty is only coherent inside ONE judge, for the same reason
// filtering is: there is no ordering between "Medium" and 1600. So the server
// refuses to sort unless exactly one judge is in play and that judge has a
// scale — the caller is told why rather than silently getting relevance order
// back.
//
// The harder question is what sorting does to paging, and the answer differs by
// view because it depends on whether there is any relevance to protect:
//
//   search (a query)  ranking IS the answer, so sorting the whole match set
//                     would throw it away. Sort the top N by relevance instead
//                     — "the easiest of the best matches" — and drop paging,
//                     because page 2 of a re-sorted top-N is meaningless.
//   browse / library  no query, so nothing is ranked and corpus order carries
//                     no meaning. Sort everything; paging stays coherent.

const TIER_ORDER = { easy: 0, medium: 1, hard: 2 };

function sortableJudge(platforms, payloadJudges) {
  if (platforms.size !== 1) return null;
  const [judge] = platforms;
  return payloadJudges.has(judge) ? judge : null;
}

// Unrated problems sort last in both directions. They are not "easiest"; we
// simply don't know, and putting an unknown at the top of an easiest-first list
// would be a claim we can't support.
function difficultyKey(problem) {
  const d = problem.difficulty;
  if (typeof d === "number") return d;
  if (typeof d === "string") {
    const t = TIER_ORDER[d.toLowerCase()];
    if (t !== undefined) return t;
  }
  return null;
}

function sortByDifficulty(items, dir, get = (x) => x) {
  const sign = dir === "desc" ? -1 : 1;
  return items
    .map((item, i) => ({ item, i, key: difficultyKey(get(item)) }))
    .sort((a, b) => {
      if (a.key === null && b.key === null) return a.i - b.i;
      if (a.key === null) return 1;
      if (b.key === null) return -1;
      if (a.key !== b.key) return sign * (a.key - b.key);
      return a.i - b.i; // stable: equal difficulty keeps relevance order
    })
    .map((x) => x.item);
}

function parseSort(raw) {
  const v = String(raw || "").toLowerCase().trim();
  if (v === "difficulty" || v === "difficulty-asc") return "asc";
  if (v === "difficulty-desc" || v === "-difficulty") return "desc";
  return null;
}

// Which judges can be sorted at all — named tiers or a rating scale.
const SORTABLE_JUDGES = new Set([...NAMED.map((b) => b.judge), ...Object.keys(RATED)]);

module.exports = { NAMED, RATED, parseSelection, passesDifficulty, buildDifficultyPayload,
  parseSort, sortByDifficulty, sortableJudge, SORTABLE_JUDGES, difficultyKey };
