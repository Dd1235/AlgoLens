-- 0005: allow 'atcoder' as a platform handle.
--
-- Additive constraint widening (same shape as 0003): every existing row
-- already satisfies the new predicate, and running code never writes the new
-- value until it deploys — so this is safe to run before the merge.

ALTER TABLE user_platform_handles
  DROP CONSTRAINT IF EXISTS user_platform_handles_platform_check;

ALTER TABLE user_platform_handles
  ADD CONSTRAINT user_platform_handles_platform_check
  CHECK (platform IN ('leetcode', 'codeforces', 'codechef', 'github', 'atcoder'));
