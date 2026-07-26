#!/usr/bin/env node
// One-shot backfill: encrypt handles and cached stats written before 0006.
//
// Safe to run repeatedly and safe to run while the app is serving. Rows that
// already carry the `v1:` prefix are skipped, and the read path understands
// both shapes, so there is no window where the site is broken either way.
//
//   node scripts/encrypt_handles.js            # report what would change
//   node scripts/encrypt_handles.js --write    # convert
//
// Needs the same HANDLE_KEY the app uses. Run it with the key from the app
// environment, not from anywhere near the database:
//
//   HANDLE_KEY=... DATABASE_URL=... node scripts/encrypt_handles.js --write

require("dotenv").config({ quiet: true });
const db = require("../server/db");
const secrets = require("../server/crypto/secrets");

const write = process.argv.includes("--write");

async function main() {
  secrets.assertKeyPresent();

  const handles = await db.query(`SELECT user_id, platform, handle FROM user_platform_handles`);
  const stats = await db.query(`SELECT user_id, platform, payload FROM user_platform_stats`);

  const plainHandles = handles.rows.filter((r) => !secrets.isEncrypted(r.handle));
  // A legacy payload comes back from JSONB already parsed into an object; an
  // encrypted one comes back as a string. That type difference is the test.
  const plainStats = stats.rows.filter((r) => typeof r.payload !== "string");

  console.log(`handles: ${handles.rows.length} total, ${plainHandles.length} still plaintext`);
  console.log(`stats:   ${stats.rows.length} total, ${plainStats.length} still plaintext`);

  if (!write) {
    console.log("\ndry run — pass --write to convert");
    return;
  }

  for (const row of plainHandles) {
    await db.query(
      `UPDATE user_platform_handles SET handle = $3 WHERE user_id = $1 AND platform = $2`,
      [row.user_id, row.platform, secrets.encrypt(row.handle)]
    );
  }
  for (const row of plainStats) {
    await db.query(
      `UPDATE user_platform_stats SET payload = $3 WHERE user_id = $1 AND platform = $2`,
      [row.user_id, row.platform, JSON.stringify(secrets.encryptJson(row.payload))]
    );
  }

  console.log(`\nencrypted ${plainHandles.length} handle(s) and ${plainStats.length} stats row(s)`);
  console.log("verify with: SELECT handle FROM user_platform_handles LIMIT 5;  -- expect v1:…");
}

main()
  .catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(() => db.close());
