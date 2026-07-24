const express = require("express");
const db = require("../db");

// Public aggregate stats over the events log — the numbers behind
// /stats.html. Aggregate-only by design: raw events stay in the database.
// All queries run in one parallel batch; the response is cacheable for a
// few minutes (this is a dashboard, not a control loop).

function createStatsRouter() {
  const router = express.Router();

  router.get("/stats", async (_req, res) => {
    try {
      const [visitors, searches, byRanker, topQueries, zeroHit, signups, boots, daily] =
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
        ]);

      res.set("Cache-Control", "public, max-age=300");
      res.json({
        visitors: visitors.rows[0],
        searches: searches.rows[0],
        byRanker: byRanker.rows,
        topQueries: topQueries.rows,
        zeroHitQueries: zeroHit.rows,
        signups: signups.rows[0],
        coldStarts: boots.rows[0],
        daily: daily.rows,
      });
    } catch (_err) {
      res.status(500).json({ error: "db_error" });
    }
  });

  return router;
}

module.exports = { createStatsRouter };
