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
    // Managed Postgres (Render, Neon, etc.) requires SSL; local docker-compose
    // doesn't. node-postgres ignores `sslmode` in the URL, so flip ssl on
    // explicitly whenever the URL asks for it — keeps local dev cert-free.
    ssl: /sslmode=require/.test(connectionString) ? { rejectUnauthorized: false } : false,
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
