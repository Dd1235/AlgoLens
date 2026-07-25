const express = require("express");
const db = require("../db");

// Public aggregate stats over the events log — the numbers behind
// /stats.html. Aggregate-only by design: raw events stay in the database.
// All queries run in one parallel batch. The cache window is short on
// purpose: HTTP caches are per-origin, so a long max-age made the same
// numbers look different on onebysec.com vs the .onrender.com host.

function createStatsRouter() {
  const router = express.Router();

  router.get("/stats", async (_req, res) => {
    try {
      const [visitors, searches, byRanker, topQueries, zeroHit, signups, boots, daily, opens, opensByRanker, saves, feedback, feedbackReasons] =
        await Promise.all([
          db.query(`
            SELECT
              count(DISTINCT visitor) FILTER (WHERE ts > now() - interval '1 day')  AS day,
              count(DISTINCT visitor) FILTER (WHERE ts > now() - interval '7 days') AS week,
              count(DISTINCT visitor)                                               AS total
            FROM events WHERE type = 'visit'`),
          db.query(`
            SELECT
              count(*) FILTER (WHERE ts > now() - interval '7 days') AS week,
              count(*)                                               AS total
            FROM events WHERE type = 'search'`),
          db.query(`
            SELECT
              props->>'ranker' AS ranker,
              count(*)::int AS searches,
              round(percentile_cont(0.5) WITHIN GROUP (ORDER BY (props->>'latencyMs')::float)::numeric, 2) AS p50_ms,
              round(percentile_cont(0.95) WITHIN GROUP (ORDER BY (props->>'latencyMs')::float)::numeric, 2) AS p95_ms
            FROM events
            WHERE type = 'search' AND ts > now() - interval '7 days' AND props ? 'latencyMs'
            GROUP BY 1 ORDER BY 2 DESC`),
          db.query(`
            SELECT props->>'q' AS q, count(*)::int AS n
            FROM events
            WHERE type = 'search' AND ts > now() - interval '7 days' AND length(props->>'q') > 0
            GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10`),
          db.query(`
            SELECT props->>'q' AS q, count(*)::int AS n
            FROM events
            WHERE type = 'search' AND ts > now() - interval '7 days'
              AND (props->>'total')::int = 0 AND length(props->>'q') > 0
            GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10`),
          db.query(`
            SELECT
              count(*) FILTER (WHERE ts > now() - interval '7 days') AS week,
              count(*)                                               AS total
            FROM events WHERE type = 'signup'`),
          db.query(`
            SELECT count(*)::int AS week,
                   round(avg((props->>'bootMs')::float)::numeric, 0) AS avg_boot_ms
            FROM events WHERE type = 'boot' AND ts > now() - interval '7 days'`),
          db.query(`
            SELECT to_char(date_trunc('day', ts), 'YYYY-MM-DD') AS day,
                   count(*) FILTER (WHERE type = 'visit')::int  AS visits,
                   count(*) FILTER (WHERE type = 'search')::int AS searches
            FROM events
            WHERE ts > now() - interval '14 days' AND type IN ('visit', 'search')
            GROUP BY 1 ORDER BY 1`),
          // ── outcomes: did searching actually help? ──
          db.query(`
            SELECT count(*)::int AS total,
                   count(*) FILTER (WHERE props->>'kind' = 'external')::int AS external,
                   round(avg((props->>'position')::float)::numeric, 1) AS avg_position
            FROM events WHERE type = 'result_open' AND ts > now() - interval '7 days'`),
          db.query(`
            SELECT props->>'ranker' AS ranker, count(*)::int AS opens
            FROM events
            WHERE type = 'result_open' AND ts > now() - interval '7 days' AND props ? 'ranker'
            GROUP BY 1`),
          db.query(`
            SELECT
              count(*) FILTER (WHERE type = 'bookmark_set' AND props->>'on' = 'true')::int AS bookmarks,
              count(*) FILTER (WHERE type = 'done_set' AND props->>'on' = 'true')::int     AS dones
            FROM events
            WHERE ts > now() - interval '7 days' AND type IN ('bookmark_set', 'done_set')`),
          db.query(`
            SELECT
              count(*) FILTER (WHERE props->>'useful' = 'true')::int  AS useful,
              count(*) FILTER (WHERE props->>'useful' = 'false')::int AS not_useful
            FROM events WHERE type = 'search_feedback' AND ts > now() - interval '7 days'`),
          db.query(`
            SELECT props->>'q' AS q, props->>'reason' AS reason
            FROM events
            WHERE type = 'search_feedback' AND props->>'useful' = 'false'
              AND length(coalesce(props->>'reason', '')) > 0
            ORDER BY ts DESC LIMIT 5`),
        ]);

      // Stitch opens into the per-ranker table as click-through rate.
      const opensMap = new Map(opensByRanker.rows.map((r) => [r.ranker, r.opens]));
      const rankerRows = byRanker.rows.map((r) => {
        const rOpens = opensMap.get(r.ranker) || 0;
        return { ...r, opens: rOpens, ctr: r.searches ? +(rOpens / r.searches).toFixed(2) : 0 };
      });

      res.set("Cache-Control", "public, max-age=30");
      res.json({
        generatedAt: new Date().toISOString(),
        visitors: visitors.rows[0],
        searches: searches.rows[0],
        byRanker: rankerRows,
        topQueries: topQueries.rows,
        zeroHitQueries: zeroHit.rows,
        signups: signups.rows[0],
        coldStarts: boots.rows[0],
        daily: daily.rows,
        outcomes: {
          opens: opens.rows[0],
          saves: saves.rows[0],
          feedback: { ...feedback.rows[0], recentReasons: feedbackReasons.rows },
        },
      });
    } catch (_err) {
      res.status(500).json({ error: "db_error" });
    }
  });

  return router;
}

module.exports = { createStatsRouter };
