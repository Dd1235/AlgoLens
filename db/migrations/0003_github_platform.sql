-- 0003: allow 'github' as a platform in user_platform_handles.
--
-- Additive (constraint widening) — run against prod BEFORE the code that
-- saves github handles deploys; existing rows all satisfy the wider check,
-- and running code never writes 'github' until the new code ships.
-- DROP IF EXISTS + ADD keeps this idempotent (constraint name is Postgres's
-- auto-name for 0002's inline CHECK, verified against the live schema).

ALTER TABLE user_platform_handles
  DROP CONSTRAINT IF EXISTS user_platform_handles_platform_check;

ALTER TABLE user_platform_handles
  ADD CONSTRAINT user_platform_handles_platform_check
  CHECK (platform IN ('leetcode', 'codeforces', 'codechef', 'github'));
