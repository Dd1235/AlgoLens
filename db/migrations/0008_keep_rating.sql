-- 0008: un-saving a problem must not silently throw away how it went.
--
-- 0001 said a row means "saved": CHECK (done OR bookmarked), so clearing the
-- last flag DELETEs the row. Once 0007 hung a rating off that row, the same
-- delete quietly destroyed it — un-tick done on something you had rated
-- "again" and the rating was gone with no warning and no way back. Nobody
-- un-ticking a checkbox is asking to erase a note.
--
-- So the invariant widens by exactly one term: a row means saved OR rated.
-- All-empty rows are still impossible, the delete still fires for the ordinary
-- case (un-saving something you never rated), and a rating outlives the flags
-- that introduced it — re-bookmark the problem later and it is still there.
--
-- Rows with no flag are invisible everywhere: /api/library, /api/user-state
-- and the profile heatmap all filter on `done` or `bookmarked`, so this adds
-- no row to any listing. It only stops one from being destroyed.
--
-- Idempotent (the runner replays every file): drop by both the generated name
-- 0001 produced and the explicit name below, then add.

ALTER TABLE user_problem_state
  DROP CONSTRAINT IF EXISTS user_problem_state_check;

ALTER TABLE user_problem_state
  DROP CONSTRAINT IF EXISTS user_problem_state_saved_check;

ALTER TABLE user_problem_state
  ADD CONSTRAINT user_problem_state_saved_check
  CHECK (done OR bookmarked OR recall IS NOT NULL);
