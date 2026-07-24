const express = require("express");
const db = require("../db");
const { requireUser } = require("../auth/middleware");

const PLATFORMS = ["leetcode", "codeforces", "codechef"];
const HANDLE_RE = /^[A-Za-z0-9_.-]{1,64}$/;
// External stats are cached in user_platform_stats; a row older than the TTL
// is refetched. ?refresh=1 shrinks the TTL to a floor so the button works but
// can't hammer the upstream APIs.
const TTL_MS = 12 * 60 * 60 * 1000;
const REFRESH_FLOOR_MS = 10 * 60 * 1000;
const DAY_SECONDS = 86400;
const HEATMAP_WINDOW_DAYS = 371; // 53 weeks

async function loadHandles(userId) {
  const result = await db.query(
    `SELECT platform, handle FROM user_platform_handles WHERE user_id = $1`,
    [userId]
  );
  const handles = {};
  for (const row of result.rows) handles[row.platform] = row.handle;
  return handles;
}

function createProfileRouter({ fetchStats = require("../profile").fetchPlatformStats } = {}) {
  const router = express.Router();

  router.get("/handles", requireUser, async (req, res) => {
    try {
      res.json({ handles: await loadHandles(req.user.id) });
    } catch (_err) {
      res.status(500).json({ error: "db_error" });
    }
  });

  // Body: { leetcode?, codeforces?, codechef? } — empty string deletes the
  // handle. Any handle change drops the cached stats row (cache is keyed to
  // the handle's identity, not just the platform).
  router.put("/handles", requireUser, async (req, res) => {
    const body = req.body || {};
    const changes = [];
    for (const platform of PLATFORMS) {
      if (!(platform in body)) continue;
      if (typeof body[platform] !== "string") {
        return res.status(400).json({ error: "bad_handle" });
      }
      const handle = body[platform].trim();
      if (handle && !HANDLE_RE.test(handle)) {
        return res.status(400).json({ error: "bad_handle" });
      }
      changes.push({ platform, handle });
    }
    try {
      for (const { platform, handle } of changes) {
        if (handle) {
          await db.query(
            `INSERT INTO user_platform_handles (user_id, platform, handle)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, platform)
             DO UPDATE SET handle = EXCLUDED.handle, updated_at = NOW()`,
            [req.user.id, platform, handle]
          );
        } else {
          await db.query(
            `DELETE FROM user_platform_handles WHERE user_id = $1 AND platform = $2`,
            [req.user.id, platform]
          );
        }
        await db.query(
          `DELETE FROM user_platform_stats WHERE user_id = $1 AND platform = $2`,
          [req.user.id, platform]
        );
      }
      res.json({ ok: true, handles: await loadHandles(req.user.id) });
    } catch (_err) {
      res.status(500).json({ error: "db_error" });
    }
  });

  router.get("/profile", requireUser, async (req, res) => {
    const wantRefresh = req.query.refresh === "1";
    const maxAgeMs = wantRefresh ? REFRESH_FLOOR_MS : TTL_MS;
    try {
      const handles = await loadHandles(req.user.id);
      const cached = await db.query(
        `SELECT platform, payload, fetched_at FROM user_platform_stats WHERE user_id = $1`,
        [req.user.id]
      );
      const cacheByPlatform = new Map(cached.rows.map((r) => [r.platform, r]));

      const platforms = {};
      await Promise.all(
        Object.entries(handles).map(async ([platform, handle]) => {
          const row = cacheByPlatform.get(platform);
          const age = row ? Date.now() - new Date(row.fetched_at).getTime() : Infinity;
          if (row && age < maxAgeMs) {
            platforms[platform] = { ...row.payload, fetchedAt: row.fetched_at };
            return;
          }
          const payload = await fetchStats(platform, handle);
          if (payload.unavailable && row) {
            // stale-if-error: keep serving the last good numbers
            platforms[platform] = { ...row.payload, fetchedAt: row.fetched_at, stale: true };
            return;
          }
          await db.query(
            `INSERT INTO user_platform_stats (user_id, platform, payload, fetched_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (user_id, platform)
             DO UPDATE SET payload = EXCLUDED.payload, fetched_at = NOW()`,
            [req.user.id, platform, JSON.stringify(payload)]
          );
          platforms[platform] = { ...payload, fetchedAt: new Date().toISOString() };
        })
      );

      // Combined heatmap: platform submission calendars + AlgoLens done marks,
      // trimmed to the last 53 weeks.
      const cutoff = Math.floor(Date.now() / 1000 / DAY_SECONDS - HEATMAP_WINDOW_DAYS) * DAY_SECONDS;
      const heatmap = {};
      const add = (daySec, count) => {
        if (daySec >= cutoff && count > 0) heatmap[String(daySec)] = (heatmap[String(daySec)] || 0) + count;
      };
      for (const stats of Object.values(platforms)) {
        for (const [sec, count] of Object.entries(stats.calendar || {})) add(Number(sec), Number(count));
      }
      const doneRows = await db.query(
        `SELECT done_at FROM user_problem_state WHERE user_id = $1 AND done AND done_at IS NOT NULL`,
        [req.user.id]
      );
      for (const row of doneRows.rows) {
        add(Math.floor(new Date(row.done_at).getTime() / 1000 / DAY_SECONDS) * DAY_SECONDS, 1);
      }

      const totalSolved = Object.values(platforms).reduce(
        (sum, s) => sum + (typeof s.solved === "number" ? s.solved : 0),
        0
      );
      res.json({
        handles,
        platforms,
        combined: { totalSolved, algolensDone: doneRows.rows.length, heatmap },
      });
    } catch (_err) {
      res.status(500).json({ error: "db_error" });
    }
  });

  return router;
}

module.exports = { createProfileRouter };
