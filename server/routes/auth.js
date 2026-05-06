const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { COOKIE_NAME, sign, cookieOptions } = require("../auth/jwt");
const { requireUser } = require("../auth/middleware");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BCRYPT_ROUNDS = 10;

function normalizeEmail(s) {
  return String(s || "").trim().toLowerCase();
}

function validateCredentials(email, password) {
  if (!EMAIL_RE.test(email)) return "invalid_email";
  if (typeof password !== "string" || password.length < 8) return "password_too_short";
  if (password.length > 200) return "password_too_long";
  return null;
}

function createAuthRouter() {
  const router = express.Router();

  router.post("/auth/signup", async (req, res) => {
    const email = normalizeEmail(req.body && req.body.email);
    const password = (req.body && req.body.password) || "";
    const bad = validateCredentials(email, password);
    if (bad) return res.status(400).json({ error: bad });

    let hash;
    try {
      hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    } catch (e) {
      return res.status(500).json({ error: "hash_failed" });
    }

    let row;
    try {
      const result = await db.query(
        "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email",
        [email, hash]
      );
      row = result.rows[0];
    } catch (e) {
      if (e.code === "23505") return res.status(409).json({ error: "email_taken" });
      return res.status(500).json({ error: "db_error" });
    }

    const token = sign({ sub: row.id, email: row.email });
    res.cookie(COOKIE_NAME, token, cookieOptions());
    res.status(201).json({ user: { id: row.id, email: row.email } });
  });

  router.post("/auth/login", async (req, res) => {
    const email = normalizeEmail(req.body && req.body.email);
    const password = (req.body && req.body.password) || "";
    if (!email || !password) return res.status(400).json({ error: "missing_credentials" });

    let row;
    try {
      const result = await db.query(
        "SELECT id, email, password_hash FROM users WHERE email = $1",
        [email]
      );
      row = result.rows[0];
    } catch (_e) {
      return res.status(500).json({ error: "db_error" });
    }

    // Run bcrypt even on miss to keep timing roughly constant.
    const fakeHash = "$2a$10$abcdefghijklmnopqrstuvCYG7Df8xN7vGI3VWYCZ7wEJhWnG6zR0a";
    const ok = await bcrypt.compare(password, row ? row.password_hash : fakeHash);
    if (!row || !ok) return res.status(401).json({ error: "invalid_credentials" });

    const token = sign({ sub: row.id, email: row.email });
    res.cookie(COOKIE_NAME, token, cookieOptions());
    res.json({ user: { id: row.id, email: row.email } });
  });

  router.post("/auth/logout", (_req, res) => {
    res.clearCookie(COOKIE_NAME, { ...cookieOptions(), maxAge: 0 });
    res.json({ ok: true });
  });

  router.get("/auth/me", requireUser, (req, res) => {
    res.json({ user: req.user });
  });

  return router;
}

module.exports = { createAuthRouter };
