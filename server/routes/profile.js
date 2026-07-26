const express = require("express");
const db = require("../db");
const { requireUser } = require("../auth/middleware");

const PLATFORMS = ["leetcode", "codeforces", "codechef", "github", "atcoder"];
// Each activity source belongs to a category; the client composes the
// dsa / dev / overall heatmap views from these. "algolens" = done-marks here.
const CATEGORIES = {
  leetcode: "dsa",
  codeforces: "dsa",
  codechef: "dsa",
  atcoder: "dsa",
  algolens: "dsa",
  github: "dev",
};
const HANDLE_RE = /^[A-Za-z0-9_.-]{1,64}$/;
// External stats are cached in user_platform_stats; a row older than the TTL
// is refetched. ?refresh=1 shrinks the TTL to a floor so the button works but
// can't hammer the upstream APIs.
const secrets = require("../crypto/secrets");

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
  // Rows written before encryption shipped come back without the version
  // prefix and decrypt to themselves, so this needs no backfill to work.
  for (const row of result.rows) handles[row.platform] = secrets.decrypt(row.handle);
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
            [req.user.id, platform, secrets.encrypt(handle)]
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
      // The three reads are independent — one Neon round-trip instead of a
      // sequential waterfall (matters: Render↔Neon is a cross-region hop).
      const [handles, cached, doneRows] = await Promise.all([
        loadHandles(req.user.id),
        db.query(
          `SELECT platform, payload, fetched_at FROM user_platform_stats WHERE user_id = $1`,
          [req.user.id]
        ),
        db.query(
          `SELECT done_at FROM user_problem_state WHERE user_id = $1 AND done AND done_at IS NOT NULL`,
          [req.user.id]
        ),
      ]);
      const cacheByPlatform = new Map(cached.rows.map((r) => [r.platform, r]));

      const platforms = {};
      await Promise.all(
        Object.entries(handles).map(async ([platform, handle]) => {
          const row = cacheByPlatform.get(platform);
          const age = row ? Date.now() - new Date(row.fetched_at).getTime() : Infinity;
          if (row && age < maxAgeMs) {
            platforms[platform] = { ...secrets.decryptJson(row.payload), fetchedAt: row.fetched_at };
            return;
          }
          const payload = await fetchStats(platform, handle);
          if (payload.unavailable && row) {
            // stale-if-error: keep serving the last good numbers
            platforms[platform] = { ...secrets.decryptJson(row.payload), fetchedAt: row.fetched_at, stale: true };
            return;
          }
          await db.query(
            `INSERT INTO user_platform_stats (user_id, platform, payload, fetched_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (user_id, platform)
             DO UPDATE SET payload = EXCLUDED.payload, fetched_at = NOW()`,
            [req.user.id, platform, JSON.stringify(secrets.encryptJson(payload))]
          );
          platforms[platform] = { ...payload, fetchedAt: new Date().toISOString() };
        })
      );

      // The client composes the dsa / dev / overall heatmap views from the
      // per-platform calendars (already in platforms.*.calendar) plus this
      // AlgoLens done-marks calendar — no server-side pre-merge, so tab
      // switches cost zero network and the payload carries each day once.
      const cutoff = Math.floor(Date.now() / 1000 / DAY_SECONDS - HEATMAP_WINDOW_DAYS) * DAY_SECONDS;
      const algolensCalendar = {};
      for (const row of doneRows.rows) {
        const daySec = Math.floor(new Date(row.done_at).getTime() / 1000 / DAY_SECONDS) * DAY_SECONDS;
        if (daySec >= cutoff) {
          algolensCalendar[String(daySec)] = (algolensCalendar[String(daySec)] || 0) + 1;
        }
      }

      const totalSolved = Object.values(platforms).reduce(
        (sum, s) => sum + (typeof s.solved === "number" ? s.solved : 0),
        0
      );
      // Browser may reuse this for a minute (per user; ?refresh=1 is a
      // different URL and always revalidates). Stats are 12h-cached anyway.
      if (!wantRefresh) res.set("Cache-Control", "private, max-age=60");
      res.json({
        handles,
        platforms,
        combined: {
          totalSolved,
          algolensDone: doneRows.rows.length,
          categories: CATEGORIES,
          calendars: { algolens: algolensCalendar },
        },
      });
    } catch (_err) {
      res.status(500).json({ error: "db_error" });
    }
  });

  return router;
}

module.exports = { createProfileRouter };
