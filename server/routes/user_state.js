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

function createUserStateRouter() {
  const router = express.Router();
  router.use(requireUser);

  router.post("/done/:problemId", async (req, res) => {
    if (!validProblemId(req.params.problemId)) return res.status(400).json({ error: "bad_problem_id" });
    try {
      await setFlag(req.user.id, req.params.problemId, "done", true);
      res.json({ ok: true });
    } catch (_e) {
      res.status(500).json({ error: "db_error" });
    }
  });

  router.delete("/done/:problemId", async (req, res) => {
    if (!validProblemId(req.params.problemId)) return res.status(400).json({ error: "bad_problem_id" });
    try {
      await setFlag(req.user.id, req.params.problemId, "done", false);
      res.json({ ok: true });
    } catch (_e) {
      res.status(500).json({ error: "db_error" });
    }
  });

  router.post("/bookmark/:problemId", async (req, res) => {
    if (!validProblemId(req.params.problemId)) return res.status(400).json({ error: "bad_problem_id" });
    try {
      await setFlag(req.user.id, req.params.problemId, "bookmarked", true);
      res.json({ ok: true });
    } catch (_e) {
      res.status(500).json({ error: "db_error" });
    }
  });

  router.delete("/bookmark/:problemId", async (req, res) => {
    if (!validProblemId(req.params.problemId)) return res.status(400).json({ error: "bad_problem_id" });
    try {
      await setFlag(req.user.id, req.params.problemId, "bookmarked", false);
      res.json({ ok: true });
    } catch (_e) {
      res.status(500).json({ error: "db_error" });
    }
  });

  // GET /api/user-state — returns {done: [...ids], bookmarked: [...ids]} so
  // the client can decorate UI on first paint without per-problem queries.
  router.get("/user-state", async (req, res) => {
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
