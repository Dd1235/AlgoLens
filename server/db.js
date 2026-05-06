const { Pool } = require("pg");

// Single Pool for the lifetime of the process. node-postgres queues queries
// and reuses connections; we don't manually acquire/release.
let pool = null;

function getPool() {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env and set DATABASE_URL, or run `docker compose up -d` and export it."
    );
  }
  pool = new Pool({
    connectionString,
    // Render Managed Postgres requires SSL; locally docker-compose doesn't.
    // Toggle on the URL containing render.com to keep local dev free of certs.
    ssl: /render\.com|amazonaws\.com/.test(connectionString) ? { rejectUnauthorized: false } : false,
  });
  return pool;
}

async function query(text, params) {
  return getPool().query(text, params);
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { getPool, query, close };
