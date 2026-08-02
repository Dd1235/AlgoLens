-- 0007: how a solve went, so the library can answer "what should I revise?"
--
-- Additive and nullable: every existing row satisfies it, and running code
-- never writes the column until it deploys — safe to run before the merge
-- (same rule as 0002 and 0005). The runner has no ledger and replays every
-- file, so both statements are IF NOT EXISTS / DROP-then-ADD.
--
-- `recall_at` is separate from `done_at` on purpose. Re-rating a problem must
-- NOT move when you solved it: the library's age filter ("marked 3mo+ ago")
-- reads done_at, so writing it here would quietly reset the very revision
-- queue this column exists to feed.
--
-- No index. The rating is only ever read for one user's own rows, which the
-- (user_id, problem_id) primary key already covers, and the filter is applied
-- while hydrating against the in-memory corpus rather than in SQL.

ALTER TABLE user_problem_state
  ADD COLUMN IF NOT EXISTS recall TEXT;

ALTER TABLE user_problem_state
  ADD COLUMN IF NOT EXISTS recall_at TIMESTAMPTZ;

ALTER TABLE user_problem_state
  DROP CONSTRAINT IF EXISTS user_problem_state_recall_check;

ALTER TABLE user_problem_state
  ADD CONSTRAINT user_problem_state_recall_check
  CHECK (recall IS NULL OR recall IN ('again', 'hard', 'medium', 'easy'));
