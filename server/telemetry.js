// Fire-and-forget event logging into Postgres (see db/migrations/0004).
// Never awaited on a request path and never throws: telemetry must cost the
// user nothing, and a missing DATABASE_URL (corpus-only local runs) or a
// hiccuping Neon simply drops the event.

const db = require("./db");

function logEvent(type, { visitor = null, userId = null, props = {} } = {}) {
  db.query(
    `INSERT INTO events (type, visitor, user_id, props) VALUES ($1, $2, $3, $4)`,
    [type, visitor, userId, JSON.stringify(props)]
  ).catch(() => {});
}

module.exports = { logEvent };
