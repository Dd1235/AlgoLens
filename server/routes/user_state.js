const express = require("express");
const { logEvent } = require("../telemetry");
const db = require("../db");
const { requireUser } = require("../auth/middleware");
const {
  parseSelection, passesDifficulty, parseSort, sortByDifficulty, sortableJudge, SORTABLE_JUDGES,
} = require("../search/difficulty");

// Sets one of {done, bookmarked} flags to `value` for (user, problem_id) and
// keeps the row only if at least one flag is true. The CHECK constraint on
// user_problem_state forbids all-false rows, so unsetting the last true flag
// triggers a DELETE.
async function setFlag(userId, problemId, flag, value) {
  if (flag !== "done" && flag !== "bookmarked") {
    throw new Error(`bad flag: ${flag}`);
  }
  const tsCol = flag === "done" ? "done_at" : "bookmarked_at";
  const otherFlag = flag === "done" ? "bookmarked" : "done";

  if (value) {
    await db.query(
      `INSERT INTO user_problem_state (user_id, problem_id, ${flag}, ${tsCol}, updated_at)
       VALUES ($1, $2, TRUE, NOW(), NOW())
       ON CONFLICT (user_id, problem_id)
       DO UPDATE SET ${flag} = TRUE,
                     ${tsCol} = NOW(),
                     updated_at = NOW()`,
      [userId, problemId]
    );
  } else {
    // Two-step to dodge the CHECK constraint (done OR bookmarked):
    //   1. If the OTHER flag is also false, delete the row outright.
    //   2. Otherwise update this flag to false; the row stays valid because
    //      the other flag is still true.
    await db.query(
      `DELETE FROM user_problem_state
        WHERE user_id = $1 AND problem_id = $2 AND NOT ${otherFlag}`,
      [userId, problemId]
    );
    await db.query(
      `UPDATE user_problem_state
         SET ${flag} = FALSE,
             ${tsCol} = NULL,
             updated_at = NOW()
       WHERE user_id = $1 AND problem_id = $2`,
      [userId, problemId]
    );
  }
}

const PROBLEM_ID_RE = /^[a-z0-9-]{3,128}$/;
// How a solve went. `none` clears it. Whitelisted rather than passed through,
// for the same reason setFlag whitelists its column name.
const RECALL_VALUES = new Set(["again", "hard", "medium", "easy"]);

// Deliberately UPDATE-only, and deliberately not routed through setFlag.
//
// setFlag's upsert sets `done_at = NOW()` on every write, so rating a problem
// through it would move when you solved it — silently resetting the library's
// "marked 3mo+ ago" filter, which is the exact feature the rating exists to
// feed. Rating something you have not saved is a no-op: no row, nothing to
// rate. That keeps "a rating belongs to a saved problem" true in the schema
// instead of only in a comment.
async function setRecall(userId, problemId, value) {
  const result = await db.query(
    `UPDATE user_problem_state
        SET recall = $3, recall_at = CASE WHEN $3::text IS NULL THEN NULL ELSE NOW() END,
            updated_at = NOW()
      WHERE user_id = $1 AND problem_id = $2`,
    [userId, problemId, value]
  );
  return result.rowCount > 0;
}

function validProblemId(id) {
  return typeof id === "string" && PROBLEM_ID_RE.test(id);
}

function createUserStateRouter({ problems } = {}) {
  const router = express.Router();
  const problemsById = new Map((problems || []).map((p) => [p.id, p]));

  router.post("/done/:problemId", requireUser, async (req, res) => {
    if (!validProblemId(req.params.problemId)) return res.status(400).json({ error: "bad_problem_id" });
    try {
      await setFlag(req.user.id, req.params.problemId, "done", true);
      logEvent("done_set", { visitor: req.visitor, userId: req.user.id, props: { problemId: req.params.problemId, on: true } });
      res.json({ ok: true });
    } catch (_e) {
      res.status(500).json({ error: "db_error" });
    }
  });

  router.delete("/done/:problemId", requireUser, async (req, res) => {
    if (!validProblemId(req.params.problemId)) return res.status(400).json({ error: "bad_problem_id" });
    try {
      await setFlag(req.user.id, req.params.problemId, "done", false);
      logEvent("done_set", { visitor: req.visitor, userId: req.user.id, props: { problemId: req.params.problemId, on: false } });
      res.json({ ok: true });
    } catch (_e) {
      res.status(500).json({ error: "db_error" });
    }
  });

  router.post("/bookmark/:problemId", requireUser, async (req, res) => {
    if (!validProblemId(req.params.problemId)) return res.status(400).json({ error: "bad_problem_id" });
    try {
      await setFlag(req.user.id, req.params.problemId, "bookmarked", true);
      logEvent("bookmark_set", { visitor: req.visitor, userId: req.user.id, props: { problemId: req.params.problemId, on: true } });
      res.json({ ok: true });
    } catch (_e) {
      res.status(500).json({ error: "db_error" });
    }
  });

  router.delete("/bookmark/:problemId", requireUser, async (req, res) => {
    if (!validProblemId(req.params.problemId)) return res.status(400).json({ error: "bad_problem_id" });
    try {
      await setFlag(req.user.id, req.params.problemId, "bookmarked", false);
      logEvent("bookmark_set", { visitor: req.visitor, userId: req.user.id, props: { problemId: req.params.problemId, on: false } });
      res.json({ ok: true });
    } catch (_e) {
      res.status(500).json({ error: "db_error" });
    }
  });

  // PUT /api/recall/:problemId/:value — value is one of the four, or "none".
  router.put("/recall/:problemId/:value", requireUser, async (req, res) => {
    if (!validProblemId(req.params.problemId)) return res.status(400).json({ error: "bad_problem_id" });
    const raw = (req.params.value || "").toLowerCase();
    if (raw !== "none" && !RECALL_VALUES.has(raw)) return res.status(400).json({ error: "bad_recall" });
    const value = raw === "none" ? null : raw;
    try {
      const applied = await setRecall(req.user.id, req.params.problemId, value);
      if (!applied) return res.status(409).json({ error: "not_saved" });
      logEvent("recall_set", { visitor: req.visitor, userId: req.user.id, props: { problemId: req.params.problemId, value } });
      res.json({ ok: true, recall: value || undefined });
    } catch (_e) {
      res.status(500).json({ error: "db_error" });
    }
  });

  // GET /api/library?type=bookmarked|done|all — returns the user's saved
  // problems with their full metadata, hydrated from the in-memory corpus.
  // Sorted by most-recent-mark first so the listing reads chronologically.
  router.get("/library", requireUser, async (req, res) => {
    const type = (req.query.type || "all").toString().toLowerCase();
    if (type !== "bookmarked" && type !== "done" && type !== "all") {
      return res.status(400).json({ error: "bad_type" });
    }
    // The saved lists take the same facets as search, so a view like "my
    // bookmarked AtCoder problems that aren't done yet" is expressible. Both
    // are applied while hydrating, not in SQL — problem_id is a free-form
    // string with no join to the corpus.
    const wanted = new Set(
      (req.query.platform || "").toString().toLowerCase().split(",").map((x) => x.trim()).filter(Boolean)
    );
    const doneFilter = ["done", "notdone"].includes((req.query.filter || "").toString().toLowerCase())
      ? req.query.filter.toString().toLowerCase()
      : "all";
    const bands = parseSelection(req.query.difficulty);
    const wantSort = parseSort(req.query.sort);
    const sortDir = wantSort ? (sortableJudge(wanted, SORTABLE_JUDGES) ? wantSort : null) : null;
    // "marked more than N days ago" — the revision filter. Whitelist-parsed
    // like everything else here: garbage is ignored, not a 400.
    const agedDays = Number.parseInt(req.query.aged, 10);
    const aged = Number.isInteger(agedDays) && agedDays > 0 && agedDays <= 3650 ? agedDays : null;
    const agedCutoff = aged ? Date.now() - aged * 86400000 : null;
    const oldestFirst = (req.query.order || "").toString().toLowerCase() === "oldest";
    // "how did it go" — same whitelist discipline as every other facet here:
    // an unknown value is ignored, not a 400, so a stale link still works.
    const recallRaw = (req.query.recall || "").toString().toLowerCase();
    const recallWanted = RECALL_VALUES.has(recallRaw) ? recallRaw
      : recallRaw === "none" ? "none"
      : null;
    let where = "user_id = $1";
    if (type === "done") where += " AND done";
    if (type === "bookmarked") where += " AND bookmarked";
    const orderBy = type === "bookmarked" ? "bookmarked_at" : "done_at";
    try {
      const result = await db.query(
        `SELECT problem_id, done, bookmarked, done_at, bookmarked_at, updated_at, recall
           FROM user_problem_state
          WHERE ${where}
       ORDER BY COALESCE(${orderBy}, updated_at) ${oldestFirst ? "ASC" : "DESC"} NULLS LAST`,
        [req.user.id]
      );
      const items = [];
      for (const row of result.rows) {
        const problem = problemsById.get(row.problem_id);
        if (!problem) continue; // dangling row from a removed corpus entry
        if (wanted.size && !wanted.has(problem.platform)) continue;
        if (!passesDifficulty(problem, bands)) continue;
        if (doneFilter === "done" && !row.done) continue;
        if (doneFilter === "notdone" && row.done) continue;
        // The timestamp this VIEW is about. :done shows when you finished it,
        // :bookmarks when you saved it. The old shape (bookmarked_at first,
        // always) meant a problem that was both showed its bookmark age in
        // :done while the list was ordered by done_at — the visible "3mo ago"
        // and the actual order could disagree, and an age filter would have
        // contradicted the label on the card.
        const viewAt =
          type === "done" ? row.done_at
          : type === "bookmarked" ? row.bookmarked_at
          : row.done_at || row.bookmarked_at;
        // An age filter needs a date to compare; a row without one can't claim
        // to be "3 months old", so it is excluded rather than assumed ancient.
        // "none" means explicitly unrated — a real thing to want, since those
        // are the problems you saved and never judged.
        if (recallWanted === "none" && row.recall) continue;
        if (recallWanted && recallWanted !== "none" && row.recall !== recallWanted) continue;
        if (agedCutoff) {
          if (!viewAt) continue;
          if (new Date(viewAt).getTime() > agedCutoff) continue;
        }
        items.push({
          problem,
          done: row.done,
          bookmarked: row.bookmarked,
          markedAt: (viewAt || row.updated_at || new Date()).toISOString(),
          recall: row.recall || undefined,
          doneAt: row.done_at ? row.done_at.toISOString() : undefined,
          bookmarkedAt: row.bookmarked_at ? row.bookmarked_at.toISOString() : undefined,
        });
      }
      // A saved list has no ranking either, so sorting it is free.
      const ordered = sortDir ? sortByDifficulty(items, sortDir, (it) => it.problem) : items;
      res.json({
        type,
        total: ordered.length,
        sort: sortDir ? `difficulty-${sortDir}` : undefined,
        aged: aged || undefined,
        recall: recallWanted || undefined,
        order: oldestFirst ? "oldest" : undefined,
        platform: wanted.size ? [...wanted].sort() : undefined,
        difficulty: bands.size ? String(req.query.difficulty).toLowerCase() : undefined,
        filter: doneFilter,
        items: ordered,
      });
    } catch (_e) {
      res.status(500).json({ error: "db_error" });
    }
  });

  // GET /api/user-state — returns {done: [...ids], bookmarked: [...ids]} so
  // the client can decorate UI on first paint without per-problem queries.
  router.get("/user-state", requireUser, async (req, res) => {
    try {
      const result = await db.query(
        `SELECT problem_id, done, bookmarked
           FROM user_problem_state
          WHERE user_id = $1`,
        [req.user.id]
      );
      const done = [];
      const bookmarked = [];
      for (const row of result.rows) {
        if (row.done) done.push(row.problem_id);
        if (row.bookmarked) bookmarked.push(row.problem_id);
      }
      res.json({ done, bookmarked });
    } catch (_e) {
      res.status(500).json({ error: "db_error" });
    }
  });

  return router;
}

module.exports = { createUserStateRouter };
