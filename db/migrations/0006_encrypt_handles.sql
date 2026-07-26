-- 0006: linked judge handles and their cached stats are encrypted at rest.
--
-- No schema change is needed and none is made: the ciphertext is text, and it
-- fits the existing `handle TEXT` column and the existing `payload JSONB`
-- (stored as a JSON string). This file exists so the migration history records
-- when the contract changed, and so a fresh database and an upgraded one end
-- up in the same place.
--
-- The application encrypts on write and decrypts on read with a key held in
-- HANDLE_KEY, an app-environment variable that is deliberately NOT stored
-- alongside this database. A copy of this database on its own is ciphertext.
--
-- Rows written before this point are plaintext. The decrypt path recognises
-- them (no `v1:` prefix) and returns them untouched, so the deploy needs no
-- downtime and no ordering guarantee against the backfill. To convert them:
--
--   HANDLE_KEY=... DATABASE_URL=... node scripts/encrypt_handles.js --write
--
-- The `length BETWEEN 1 AND 64` check from 0002 has to go: it was sized for a
-- judge username, and ciphertext is ~100 characters.

ALTER TABLE user_platform_handles
  DROP CONSTRAINT IF EXISTS user_platform_handles_handle_check;

COMMENT ON COLUMN user_platform_handles.handle IS
  'AES-256-GCM ciphertext, format v1:<iv>:<tag>:<ct> (base64). Key is HANDLE_KEY in the app environment, never in this database. Pre-0006 rows may still be plaintext.';

COMMENT ON COLUMN user_platform_stats.payload IS
  'AES-256-GCM ciphertext of the stats JSON, held as a JSON string. The submission calendar identifies the linked account as surely as the handle does, so it is encrypted too.';
