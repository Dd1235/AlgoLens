// The sheet layout, which is the one place a bug would damage something the
// app doesn't own.
//
// The contract under test: the app writes ONLY its own columns, finds them by
// name in row 1, and never lands on a cell of the user's. sheets.js is a
// browser file with no module system, so this runs it in a vm with the Google
// plumbing absent — the layout functions are pure, which is exactly why they
// were split out that way.
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
  src + "\n;this.t = { readLayout, appRuns, colLetter, appendRow, APP_HEADER, SHEET_USER_FIELDS," +
  " setLayout: (l) => { sheetLayout = l; } };",
  ctx
);
const t = ctx.t;

const USER = t.SHEET_USER_FIELDS.map((f) => f.key);
const LEGACY_HEADER = t.APP_HEADER.filter((n) => n !== "recall").concat(USER);
const FRESH_HEADER = t.APP_HEADER.concat(USER);
// Values cross a vm realm boundary, so their prototypes aren't this realm's
// Array — round-trip through JSON before comparing.
const plain = (v) => JSON.parse(JSON.stringify(v));
const runs = (layout) => { t.setLayout(layout); return plain(t.appRuns().map((r) => [r.start, r.end])); };

// ── column letters ───────────────────────────────────────────────────────────
// The sheet is the user's, so it can be wider than Z.
assert.equal(t.colLetter(1), "A");
assert.equal(t.colLetter(9), "I");
assert.equal(t.colLetter(26), "Z");
assert.equal(t.colLetter(27), "AA");
assert.equal(t.colLetter(53), "BA");

// ── a sheet made before `recall` existed ─────────────────────────────────────
// This is the shape already in the wild: eight app columns, then the user's
// notes from I. Writing the ninth app column by POSITION would land on
// solve_status — someone's actual writing.
{
  const legacy = t.readLayout([LEGACY_HEADER]);
  assert.equal(legacy.app.has("recall"), false, "legacy sheet has no recall column");
  assert.equal(legacy.user.get("solve_status"), 8, "the user's first column is still at I");
  assert.equal(legacy.derived, false);
  assert.deepEqual(runs(legacy), [[0, 7]], "the app writes A–H and stops");
}

// ── a sheet this version created ─────────────────────────────────────────────
{
  const fresh = t.readLayout([FRESH_HEADER]);
  assert.equal(fresh.app.get("recall"), 8);
  assert.equal(fresh.user.get("solve_status"), 9, "the user's columns moved right by one");
  assert.deepEqual(runs(fresh), [[0, 8]]);
  assert.deepEqual(
    plain(t.appendRow({
      problem: { id: "p1", title: "T", source_url: "u", platform: "leetcode", difficulty: 3 },
      done: true, bookmarked: false, doneAt: "2026-08-01T00:00:00Z", recall: "hard",
    })),
    ["p1", "T", "u", "leetcode", "3", "", "yes", "2026-08-01", "hard", "", "", "", "", "", ""],
    "a new row fills the app columns and leaves the user's empty"
  );
}

// ── someone reordered their columns ──────────────────────────────────────────
// Dragging `notes` to the front is a thing people do. Position-based writes
// would then overwrite it with a problem id.
{
  const shuffled = t.readLayout([["notes", ...LEGACY_HEADER.filter((n) => n !== "notes"), "recall"]]);
  assert.equal(shuffled.user.get("notes"), 0, "notes is column A now");
  assert.equal(shuffled.app.get("problem_id"), 1);
  assert.deepEqual(runs(shuffled), [[1, 8], [14, 14]], "app columns are written in pieces, not one range");
  assert.ok(!runs(shuffled).some(([s, e]) => s <= 0 && e >= 0), "and never over column A");
}

// ── width is the widest ROW ──────────────────────────────────────────────────
// A backfilled app column is placed at `width`, so this number is what keeps
// it off a cell that has data under a blank header.
{
  const wide = t.readLayout([
    LEGACY_HEADER.slice(0, 9),
    ["p1", "T", "u", "lc", "3", "", "yes", "2026-01-01", "wip", "", "", "", "", "unheadered but written"],
  ]);
  assert.equal(wide.width, 14, "width follows the widest row, not the header");
}

// ── row 1 isn't a header at all ──────────────────────────────────────────────
// Deleting the header row must not make the app invent columns in someone
// else's spreadsheet; it falls back to the original fixed layout and is
// marked derived so no backfill runs.
{
  const none = t.readLayout([[]]);
  assert.equal(none.derived, true);
  assert.equal(none.app.has("recall"), false, "a derived layout never claims a new column");
  assert.equal(none.user.get("notes"), 13);
}

console.log("sheet layout tests passed");
