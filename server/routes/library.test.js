// /api/library — hydration-time filters and, above all, timestamp semantics.
//
// Unlike user_state.test.js (a full round-trip that needs DATABASE_URL and
// truncates tables), this runs with the `db` module stubbed through the
// require cache: the library logic is all post-SQL, so a canned row set
// exercises everything except Postgres itself — which makes this file part of
// `npm run test:search` instead of a test that silently never runs.
const assert = require("node:assert/strict");
const path = require("node:path");

// Stub ../db BEFORE the router pulls it in. The stub records the SQL so the
// ordering assertion can look at what would have been sent.
const dbPath = require.resolve(path.join(__dirname, "..", "db"));
const calls = [];
let ROWS = [];
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM user_problem_state/.test(sql) && /SELECT problem_id/.test(sql)) {
        let rows = ROWS;
        if (/AND done\b/.test(sql)) rows = rows.filter((r) => r.done);
        if (/AND bookmarked\b/.test(sql)) rows = rows.filter((r) => r.bookmarked);
        return { rows };
      }
      return { rows: [] };
    },
  },
};
// telemetry also imports db; keep it inert the same way
const telePath = require.resolve(path.join(__dirname, "..", "telemetry"));
require.cache[telePath] = {
  id: telePath, filename: telePath, loaded: true,
  exports: { logEvent: () => {} },
};

const express = require("express");
const { createUserStateRouter } = require("./user_state");

const DAY = 86400000;
const daysAgo = (n) => new Date(Date.now() - n * DAY);

const problems = [
  { id: "p-old", title: "Old Done", platform: "codeforces", difficulty: 1500 },
  { id: "p-new", title: "New Done", platform: "codeforces", difficulty: 1600 },
  { id: "p-both", title: "Both Flags", platform: "leetcode", difficulty: "Hard" },
  { id: "p-book", title: "Bookmark Only", platform: "cses" },
];

ROWS = [
  // done four months ago — the revision case
  { problem_id: "p-old", done: true, bookmarked: false, done_at: daysAgo(120), bookmarked_at: null, updated_at: daysAgo(120) },
  // done yesterday
  { problem_id: "p-new", done: true, bookmarked: false, done_at: daysAgo(1), bookmarked_at: null, updated_at: daysAgo(1) },
  // bookmarked long ago, done recently — the row that exposed the markedAt bug
  { problem_id: "p-both", done: true, bookmarked: true, done_at: daysAgo(2), bookmarked_at: daysAgo(200), updated_at: daysAgo(2) },
  // bookmark only, no done_at at all
  { problem_id: "p-book", done: false, bookmarked: true, done_at: null, bookmarked_at: daysAgo(150), updated_at: daysAgo(150) },
];

const app = express();
app.use((req, _res, next) => { req.user = { id: "u1", email: "t@example.com" }; next(); });
app.use("/api", createUserStateRouter({ problems }));
const server = app.listen(0);
const get = async (qs) => (await fetch(`http://127.0.0.1:${server.address().port}/api/library?${qs}`)).json();
const ids = (d) => d.items.map((it) => it.problem.id);

(async () => {
  // markedAt is the time THIS view is about. p-both was bookmarked 200 days
  // ago and done 2 days ago; the old shape showed the bookmark age in :done
  // while the list was ordered by done_at.
  {
    const done = await get("type=done");
    const both = done.items.find((it) => it.problem.id === "p-both");
    assert.ok(Math.abs(new Date(both.markedAt) - daysAgo(2)) < DAY / 2, ":done shows the done time");

    const books = await get("type=bookmarked");
    const bothB = books.items.find((it) => it.problem.id === "p-both");
    assert.ok(Math.abs(new Date(bothB.markedAt) - daysAgo(200)) < DAY / 2, ":bookmarks shows the bookmark time");
  }

  // Both raw timestamps ride along so the client never guesses again.
  {
    const d = await get("type=all");
    const both = d.items.find((it) => it.problem.id === "p-both");
    assert.ok(both.doneAt && both.bookmarkedAt, "doneAt and bookmarkedAt both present");
  }

  // aged=90 keeps only what was marked at least 90 days ago, per the VIEW's
  // timestamp — p-both (done 2 days ago) is excluded from :done even though
  // its bookmark is ancient.
  {
    const d = await get("type=done&aged=90");
    assert.deepEqual(ids(d), ["p-old"], "only the four-month-old done survives");
    assert.equal(d.aged, 90, "the filter is echoed");

    const b = await get("type=bookmarked&aged=90");
    assert.deepEqual(new Set(ids(b)), new Set(["p-both", "p-book"]), "old bookmarks survive in :bookmarks");
  }

  // A row with no timestamp for this view cannot claim an age — but in :all
  // the view time falls back to bookmarked_at, so a bookmark-only row keeps
  // its bookmark age rather than being dropped.
  {
    const d = await get("type=all&aged=90");
    assert.ok(!ids(d).includes("p-new"), "recent rows excluded");
    assert.ok(ids(d).includes("p-book"), "bookmark-only rows keep their bookmark age in :all");
  }

  // order=oldest flips the SQL ordering.
  {
    calls.length = 0;
    const d = await get("type=done&order=oldest");
    assert.equal(d.order, "oldest");
    const sql = calls.find((c) => /FROM user_problem_state/.test(c.sql)).sql;
    assert.ok(/ASC NULLS LAST/.test(sql), "oldest first means ASC");
    const plain = await get("type=done");
    assert.equal(plain.order, undefined);
  }

  // Composes with the other facets; garbage is ignored, not a 400.
  {
    const d = await get("type=done&aged=90&platform=codeforces&difficulty=cf:1400-1600");
    assert.deepEqual(ids(d), ["p-old"]);
    const junk = await get("type=done&aged=abc");
    assert.equal(junk.aged, undefined, "garbage aged is dropped");
    assert.equal(junk.total, 3, "and the list is unfiltered");
    const negative = await get("type=done&aged=-5");
    assert.equal(negative.aged, undefined);
  }

  console.log("library route tests passed");
  server.close();
})().catch((err) => {
  server.close();
  throw err;
});
