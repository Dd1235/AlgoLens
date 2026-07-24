-- 0002: per-user competitive-programming platform handles + cached stats.
--
-- Additive only — must run against prod BEFORE the code that reads it deploys
-- (v1 code never touches these tables, so migrating first is zero-downtime).
--
-- user_platform_stats is a cache of external API/scrape results (LeetCode
-- GraphQL, Codeforces API, CodeChef page). payload is the normalized stats
-- JSON; the route layer treats rows older than its TTL as stale and drops the
-- row whenever the handle changes. Losing this table costs one refetch.

CREATE TABLE IF NOT EXISTS user_platform_handles (
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform   TEXT        NOT NULL CHECK (platform IN ('leetcode', 'codeforces', 'codechef')),
  handle     TEXT        NOT NULL CHECK (length(handle) BETWEEN 1 AND 64),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, platform)
);

CREATE TABLE IF NOT EXISTS user_platform_stats (
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform   TEXT        NOT NULL,
  payload    JSONB       NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, platform)
);
