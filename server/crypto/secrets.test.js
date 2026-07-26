// Tests for at-rest encryption of judge handles. No database — the point is
// the cipher contract, and every property here is one the profile route relies
// on. Sets its own key so it never depends on the environment.
const assert = require("node:assert/strict");

process.env.HANDLE_KEY = "dGVzdC1rZXktZm9yLXVuaXQtdGVzdHMtb25seS0zMmI=";
const secrets = require("./secrets");

// Round trip.
{
  const ct = secrets.encrypt("tourist");
  assert.notEqual(ct, "tourist", "must not store the handle in the clear");
  assert.ok(ct.startsWith("v1:"), "versioned so the format can change later");
  assert.equal(secrets.decrypt(ct), "tourist");
}

// Randomized IV: two users with the same handle must not produce the same
// ciphertext, or the column leaks who shares an account name.
{
  assert.notEqual(secrets.encrypt("tourist"), secrets.encrypt("tourist"));
}

// Legacy rows written before 0006 are plaintext. They must survive the read
// path untouched — that is what makes the deploy safe without a backfill.
{
  assert.equal(secrets.decrypt("Dd1235"), "Dd1235");
  assert.equal(secrets.isEncrypted("Dd1235"), false);
  assert.equal(secrets.isEncrypted(secrets.encrypt("Dd1235")), true);
}

// Empty and absent values pass straight through; a deleted handle is a DELETE,
// not an encrypted empty string.
{
  for (const v of ["", null, undefined]) {
    assert.equal(secrets.encrypt(v), v);
    assert.equal(secrets.decrypt(v), v);
  }
}

// GCM is authenticated: a tampered row must throw, not decrypt to garbage that
// then gets sent to a judge's API as if it were a username.
{
  const ct = secrets.encrypt("tourist");
  const tampered = ct.slice(0, -8) + "AAAAAAAA";
  assert.throws(() => secrets.decrypt(tampered));
}

// The stats payload round-trips as JSON, and a legacy JSONB row (already an
// object by the time pg hands it over) is returned as-is.
{
  const payload = { solved: 412, rating: 1653, calendar: { 1700000000: 3 } };
  assert.deepEqual(secrets.decryptJson(secrets.encryptJson(payload)), payload);
  assert.deepEqual(secrets.decryptJson(payload), payload, "pre-0006 JSONB row");
  assert.equal(secrets.decryptJson(null), null);
}

// Any high-entropy secret works — Render's generateValue does not promise
// base64 of exactly 32 bytes, and demanding one would be a boot crash on
// deploy rather than a security property.
{
  const saved = process.env.HANDLE_KEY;
  for (const candidate of ["0".repeat(64), "a-long-passphrase-from-a-dashboard"]) {
    delete require.cache[require.resolve("./secrets")];
    process.env.HANDLE_KEY = candidate;
    const fresh = require("./secrets");
    assert.equal(fresh.decrypt(fresh.encrypt("handle")), "handle");
  }
  // ...but a short one is rejected rather than silently weakening the key.
  delete require.cache[require.resolve("./secrets")];
  process.env.HANDLE_KEY = "short";
  assert.throws(() => require("./secrets").encrypt("x"), /too short/);

  // No key at all must throw, never fall back to writing plaintext.
  delete require.cache[require.resolve("./secrets")];
  delete process.env.HANDLE_KEY;
  assert.throws(() => require("./secrets").encrypt("x"), /HANDLE_KEY is not set/);

  process.env.HANDLE_KEY = saved;
}

console.log("secrets tests passed");
