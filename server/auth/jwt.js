const jwt = require("jsonwebtoken");

const COOKIE_NAME = "algolens_session";
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

function getSecret() {
  const s = process.env.JWT_SECRET;
  if (!s || s === "change-me") {
    throw new Error("JWT_SECRET is not set (or still 'change-me'). See .env.example.");
  }
  return s;
}

function sign(payload) {
  return jwt.sign(payload, getSecret(), { expiresIn: TOKEN_TTL_SECONDS });
}

function verify(token) {
  try {
    return jwt.verify(token, getSecret());
  } catch (_e) {
    return null;
  }
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: TOKEN_TTL_SECONDS * 1000,
    path: "/",
  };
}

module.exports = { COOKIE_NAME, TOKEN_TTL_SECONDS, sign, verify, cookieOptions };
