// The sheet layout, which is the one place a bug would damage something the
// app doesn't own.
//
// The contract under test: the app writes ONLY its own columns, finds them by
// name in row 1, keeps the sheet in one known shape, and never loses a cell of
// yours while doing it. sheets.js is a browser file with no module system, so
// this runs it in a vm with the Google plumbing absent — the layout functions
// are pure, which is exactly why they were split out that way.
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "sheets.js"), "utf8");
const ctx = vm.createContext({
  window: {},
  document: { head: { appendChild() {} }, createElement: () => ({}) },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  setTimeout, clearTimeout, console,
  fetch: async () => { throw new Error("no network in this test"); },
});
vm.runInContext(
  src + "\n;this.t = { readLayout, appRuns, colLetter, appendRow, planLayout, sheetsUserColumns," +
  " APP_HEADER, SHEET_USER_FIELDS, CANONICAL, LEGACY_HEADER," +
  " setLayout: (l) => { sheetLayout = l; } };",
  ctx
);
const t = ctx.t;

// Values cross a vm realm boundary, so their prototypes aren't this realm's
// Array — round-trip through JSON before comparing.
const plain = (v) => JSON.parse(JSON.stringify(v));
const runs = (layout) => { t.setLayout(layout); return plain(t.appRuns().map((r) => [r.start, r.end])); };
const cols = (layout) => { t.setLayout(layout); return plain(t.sheetsUserColumns()).map((c) => c.key); };

const LEGACY = plain(t.LEGACY_HEADER);          // the shape already in the wild
const CANONICAL = plain(t.CANONICAL);           // the shape sync keeps it in

// Applies a plan the way Sheets would, so "nothing is lost" is checked against
// the actual requests rather than trusted.
function apply(grid, plan) {
  const out = grid.map((row) => row.slice());
  for (const req of plan.requests) {
    if (req.deleteDimension) {
      const i = req.deleteDimension.range.startIndex;
      out.forEach((row) => row.splice(i, 1));
    } else if (req.insertDimension) {
      const i = req.insertDimension.range.startIndex;
      out.forEach((row) => row.splice(i, 0, ""));
    } else if (req.moveDimension) {
      const from = req.moveDimension.source.startIndex;
      const to = req.moveDimension.destinationIndex;
      out.forEach((row) => row.splice(to, 0, row.splice(from, 1)[0]));
    }
  }
  out[0] = plan.header.slice();
  return out;
}
const pad = (row, n) => row.concat(Array(Math.max(0, n - row.length)).fill(""));

// ── column letters ───────────────────────────────────────────────────────────
// The sheet is the user's, so it can be wider than Z.
assert.equal(t.colLetter(1), "A");
assert.equal(t.colLetter(9), "I");
assert.equal(t.colLetter(26), "Z");
assert.equal(t.colLetter(27), "AA");
assert.equal(t.colLetter(53), "BA");

// ── the shape itself ─────────────────────────────────────────────────────────
// The app's columns come first, then the suggested ones, and the one you
// actually reread leads them.
assert.deepEqual(CANONICAL.slice(0, t.APP_HEADER.length), plain(t.APP_HEADER));
assert.equal(CANONICAL[t.APP_HEADER.length], "solution_summary");
assert.ok(!CANONICAL.includes("solve_status"), "the site owns done + recall; a status column duplicates them");

// ── reading a sheet made before any of this ──────────────────────────────────
{
  const legacy = t.readLayout([LEGACY]);
  assert.equal(legacy.app.has("recall"), false, "legacy sheet has no recall column");
  assert.equal(legacy.user.get("solve_status"), 8, "a column we stopped suggesting is still yours");
  assert.equal(legacy.derived, false);
  assert.deepEqual(runs(legacy), [[0, 7]], "the app writes A–H and stops");
}

// ── your columns are whatever your sheet has ─────────────────────────────────
// Not a fixed list of six: a column you invented is read and shown too.
{
  const mine = t.readLayout([CANONICAL.concat(["Revision date"])]);
  assert.equal(mine.user.get("revision date"), CANONICAL.length);
  assert.equal(mine.labels.get("revision date"), "Revision date", "your header text, as you wrote it");
  assert.deepEqual(cols(mine), CANONICAL.slice(t.APP_HEADER.length).concat(["revision date"]));
}

// ── a sheet this version created ─────────────────────────────────────────────
{
  const fresh = t.readLayout([CANONICAL]);
  assert.equal(fresh.app.get("recall"), 8);
  assert.deepEqual(runs(fresh), [[0, 8]]);
  assert.deepEqual(
    plain(t.appendRow({
      problem: { id: "p1", title: "T", source_url: "u", platform: "leetcode", difficulty: 3 },
      done: true, bookmarked: false, doneAt: "2026-08-01T00:00:00Z", recall: "hard",
    })),
    ["p1", "T", "u", "leetcode", "3", "", "yes", "2026-08-01", "hard"].concat(Array(5).fill("")),
    "a new row fills the app columns and leaves yours empty"
  );
}

// ── normalising a legacy sheet loses nothing ─────────────────────────────────
{
  const grid = [
    LEGACY,
    pad(["p1", "Two Sum", "u", "lc", "Easy", "yes", "yes", "2026-01-01", "revisit", "20m", "hashing", "one pass", "map of complements", "worth redoing"], LEGACY.length),
  ];
  const plan = plain(t.planLayout(grid));
  assert.equal(plan.changed, true, "a legacy sheet needs reshaping");
  const after = apply(grid, plan);

  // Every value that was in the sheet is still in the sheet, under the same
  // header as before. This is the assertion the whole feature rests on.
  LEGACY.forEach((name, i) => {
    const value = grid[1][i];
    const moved = after[0].indexOf(name);
    assert.notEqual(moved, -1, `column "${name}" survived`);
    assert.equal(after[1][moved], value, `"${name}" kept its value`);
  });
  assert.equal(after[0].indexOf("recall") !== -1, true, "and the missing column was added");
  assert.equal(after[1][after[0].indexOf("recall")], "", "the added column starts empty");
  assert.deepEqual(after[0].slice(0, CANONICAL.length), CANONICAL, "the canonical columns lead");
  assert.deepEqual(after[0].slice(CANONICAL.length), ["solve_status"], "yours keep their order after");
}

// ── data past the end of the header ──────────────────────────────────────────
// A column with values under a blank header is still someone's writing. It is
// kept, and it is not given a name we made up.
{
  const grid = [
    LEGACY,
    pad(["p1"], LEGACY.length).concat(["scribbled here"]),
  ];
  const after = apply(grid, plain(t.planLayout(grid)));
  assert.equal(after[1][after[0].length - 1], "scribbled here", "the unheaded column survived");
  assert.equal(after[0][after[0].length - 1], "", "and was not given an invented header");
}

// ── it is idempotent ─────────────────────────────────────────────────────────
// A second sync must not shuffle a sheet that is already in shape, or every
// sync would be a write.
{
  const grid = [CANONICAL.concat(["Revision date"]), pad(["p1"], CANONICAL.length + 1)];
  assert.equal(plain(t.planLayout(grid)).changed, false, "an in-shape sheet is left alone");
}

// ── duplicates ───────────────────────────────────────────────────────────────
// An empty duplicate is the accident (a re-sync that wrote a second header);
// a duplicate with data in it is somebody's work and is kept.
{
  const grid = [
    CANONICAL.concat(["done"]),
    pad(["p1"], CANONICAL.length).concat([""]),
  ];
  const plan = plain(t.planLayout(grid));
  assert.equal(plan.requests.length, 1);
  assert.ok(plan.requests[0].deleteDimension, "the empty duplicate goes");
  assert.deepEqual(plan.header, CANONICAL);
}
{
  const grid = [
    CANONICAL.concat(["done"]),
    pad(["p1"], CANONICAL.length).concat(["yes, really"]),
  ];
  const after = apply(grid, plain(t.planLayout(grid)));
  assert.equal(after[1][after[0].length - 1], "yes, really", "a duplicate with data is kept");
}

// ── row 1 isn't a header at all ──────────────────────────────────────────────
// Deleting the header row must not make the app reshape someone else's
// spreadsheet; it falls back to the legacy layout and is marked derived, and
// normalizeLayout refuses to run on a derived layout.
{
  const none = t.readLayout([[]]);
  assert.equal(none.derived, true);
  assert.equal(none.app.has("recall"), false, "a derived layout never claims a new column");
  assert.equal(none.user.get("notes"), 13);
}

console.log("sheet layout tests passed");
