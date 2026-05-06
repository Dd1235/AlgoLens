const express = require("express");
const db = require("../db");
const { requireUser } = require("../auth/middleware");

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
      res.json({ ok: true });
    } catch (_e) {
      res.status(500).json({ error: "db_error" });
    }
  });

  router.delete("/done/:problemId", requireUser, async (req, res) => {
    if (!validProblemId(req.params.problemId)) return res.status(400).json({ error: "bad_problem_id" });
    try {
      await setFlag(req.user.id, req.params.problemId, "done", false);
      res.json({ ok: true });
    } catch (_e) {
      res.status(500).json({ error: "db_error" });
    }
  });

  router.post("/bookmark/:problemId", requireUser, async (req, res) => {
    if (!validProblemId(req.params.problemId)) return res.status(400).json({ error: "bad_problem_id" });
    try {
      await setFlag(req.user.id, req.params.problemId, "bookmarked", true);
      res.json({ ok: true });
    } catch (_e) {
      res.status(500).json({ error: "db_error" });
    }
  });

  router.delete("/bookmark/:problemId", requireUser, async (req, res) => {
    if (!validProblemId(req.params.problemId)) return res.status(400).json({ error: "bad_problem_id" });
    try {
      await setFlag(req.user.id, req.params.problemId, "bookmarked", false);
      res.json({ ok: true });
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
    let where = "user_id = $1";
    if (type === "done") where += " AND done";
    if (type === "bookmarked") where += " AND bookmarked";
    const orderBy = type === "bookmarked" ? "bookmarked_at" : "done_at";
    try {
      const result = await db.query(
        `SELECT problem_id, done, bookmarked, done_at, bookmarked_at, updated_at
           FROM user_problem_state
          WHERE ${where}
       ORDER BY COALESCE(${orderBy}, updated_at) DESC NULLS LAST`,
        [req.user.id]
      );
      const items = [];
      for (const row of result.rows) {
        const problem = problemsById.get(row.problem_id);
        if (!problem) continue; // dangling row from a removed corpus entry
        items.push({
          problem,
          done: row.done,
          bookmarked: row.bookmarked,
          markedAt: (row.bookmarked_at || row.done_at || row.updated_at || new Date()).toISOString(),
        });
      }
      res.json({ type, total: items.length, items });
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
