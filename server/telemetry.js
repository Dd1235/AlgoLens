// Fire-and-forget event logging into Postgres (see db/migrations/0004).
// Never awaited on a request path and never throws: telemetry must cost the
// user nothing, and a missing DATABASE_URL (corpus-only local runs) or a
// hiccuping Neon simply drops the event.

const db = require("./db");

// Only the deployed app writes events. A local `npm run dev` usually points
// DATABASE_URL at the same Neon instance production uses, so without this gate
// every restart and every test query lands in the public stats page — which is
// exactly what happened: 798 of 1,228 "visitors" and a third of all searches
// were a developer's curl loops, and the top-queries list was a load test.
// Stats are a claim about real usage; they have to come from real usage.
// TELEMETRY=on forces it back on for deliberate local testing.
const ENABLED = process.env.NODE_ENV === "production" || process.env.TELEMETRY === "on";

function logEvent(type, { visitor = null, userId = null, props = {} } = {}) {
  if (!ENABLED) return;
  db.query(
    `INSERT INTO events (type, visitor, user_id, props) VALUES ($1, $2, $3, $4)`,
    [type, visitor, userId, JSON.stringify(props)]
  ).catch(() => {});
}

module.exports = { logEvent };
