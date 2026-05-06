-- 0001_init.sql
-- Initial schema for users + per-user problem state (bookmark / mark-as-done).
--
-- Design notes:
--   * problem_id is a free-form string (e.g. "leetcode-two-sum", "cses-1640").
--     The corpus on disk is the source of truth; no FK to a problems table.
--     Adding codeforces later means new IDs, no migration.
--   * Two flags in one row because a user can simultaneously bookmark and
--     complete the same problem. The CHECK constraint stops zombie rows
--     where both are false; the route layer DELETEs rather than UPDATEs in
--     that case.

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

CREATE TABLE users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT        UNIQUE NOT NULL CHECK (email = lower(email)),
  password_hash TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE user_problem_state (
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  problem_id    TEXT        NOT NULL,
  done          BOOLEAN     NOT NULL DEFAULT FALSE,
  bookmarked    BOOLEAN     NOT NULL DEFAULT FALSE,
  done_at       TIMESTAMPTZ,
  bookmarked_at TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, problem_id),
  CHECK (done OR bookmarked)
);

CREATE INDEX idx_ups_user_done       ON user_problem_state(user_id) WHERE done;
CREATE INDEX idx_ups_user_bookmarked ON user_problem_state(user_id) WHERE bookmarked;
