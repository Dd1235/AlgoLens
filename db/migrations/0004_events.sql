-- 0004: append-only telemetry event log.
--
-- The Render free instance spins down when idle and its filesystem is wiped
-- on deploy, so Postgres is the only durable home for usage metrics. Writes
-- are fire-and-forget from the app (never awaited on the request path).
--
-- visitor is an anonymous random cookie id; user_id is a plain uuid with no
-- FK (events outlive accounts, same looseness as problem_id elsewhere).
-- props examples: visit {path}, search {q, ranker, latencyMs, total},
-- boot {bootMs, rankers}, signup {}.

CREATE TABLE IF NOT EXISTS events (
  id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  type    TEXT        NOT NULL,
  visitor TEXT,
  user_id UUID,
  props   JSONB       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events (type, ts);
