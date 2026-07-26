// Symmetric encryption for the few columns that identify a person: the judge
// handles someone links, and the stats derived from them.
//
// Why this exists: `user_platform_handles.handle` was a plaintext column, so
// anyone holding DATABASE_URL — a Neon breach, a leaked connection string, a
// stray backup — could read every linked LeetCode/Codeforces account. The key
// lives in the app's environment, never in Postgres, so a copy of the database
// on its own is ciphertext. That separation is the entire security property.
//
// What this deliberately does NOT claim: it does not put the data beyond the
// reach of whoever operates the server, because the server must decrypt to
// call the judges' APIs. Reversible encryption is a hard requirement here —
// hashing is impossible, since we send the handle to leetcode.com.
//
// AES-256-GCM: authenticated, so a tampered ciphertext fails loudly instead of
// decrypting to garbage. Random 12-byte IV per value, which is why two users
// with the same handle produce different ciphertext. Nothing queries these
// columns by value (handles are only ever selected by user_id), so randomized
// encryption costs us no lookup.
const crypto = require("crypto");

const PREFIX = "v1";
const ALGO = "aes-256-gcm";
const IV_BYTES = 12;

let cachedKey = null;

function key() {
  if (cachedKey) return cachedKey;
  const raw = process.env.HANDLE_KEY;
  if (!raw) {
    // Fail closed, the same way JWT_SECRET does. A server that boots without a
    // key would silently write plaintext handles, which is the exact failure
    // this module exists to prevent — and it would be invisible until someone
    // looked in the database.
    throw new Error(
      "HANDLE_KEY is not set. Generate one with `openssl rand -base64 32` and set it " +
        "in the app environment (never in the database). See docs/internals.md."
    );
  }
  if (raw.length < 16) {
    throw new Error("HANDLE_KEY is too short to be a secret. Use `openssl rand -base64 32`.");
  }
  // Derive rather than require an exact 32-byte base64 blob. Render's
  // generateValue emits a random string of its own choosing, and demanding a
  // specific encoding would turn a perfectly good secret into a boot crash on
  // deploy. HKDF accepts whatever high-entropy string it's given and always
  // yields the 32 bytes AES-256 needs, deterministically.
  cachedKey = Buffer.from(crypto.hkdfSync("sha256", Buffer.from(raw, "utf8"), Buffer.alloc(0), Buffer.from("cosine:handle-encryption:v1"), 32));
  return cachedKey;
}

// Call at boot so a misconfigured deploy dies immediately rather than on the
// first user who tries to save a handle.
function assertKeyPresent() {
  key();
}

function encrypt(plain) {
  if (plain === null || plain === undefined || plain === "") return plain;
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return [PREFIX, iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}

// Tolerant of rows written before this shipped: anything without the version
// prefix is legacy plaintext, returned as-is and re-encrypted on next write.
// That's what makes the migration a no-downtime one.
function decrypt(stored) {
  if (stored === null || stored === undefined || stored === "") return stored;
  const text = String(stored);
  if (!text.startsWith(`${PREFIX}:`)) return text;
  const [, ivB64, tagB64, ctB64] = text.split(":");
  const decipher = crypto.createDecipheriv(ALGO, key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

function isEncrypted(stored) {
  return typeof stored === "string" && stored.startsWith(`${PREFIX}:`);
}

// The stats payload is a JSON blob, and it identifies just as well as the
// handle does — a 371-day submission calendar plus a rating is a fingerprint of
// the named account. Encrypting the handle and leaving this readable would
// defeat the point.
function encryptJson(value) {
  return value === null || value === undefined ? value : encrypt(JSON.stringify(value));
}

function decryptJson(stored) {
  if (stored === null || stored === undefined) return stored;
  if (typeof stored === "object") return stored; // legacy row: JSONB came back parsed
  const text = decrypt(stored);
  try {
    return JSON.parse(text);
  } catch (_e) {
    return null;
  }
}

module.exports = { encrypt, decrypt, encryptJson, decryptJson, isEncrypted, assertKeyPresent };
