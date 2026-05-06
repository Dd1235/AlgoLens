// Round-trip integration test for the auth router.
// Requires a running Postgres reachable via DATABASE_URL and JWT_SECRET set.
// Truncates `users` between runs — only point at a dev DB.

const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const cookieParser = require("cookie-parser");
const db = require("../db");
const { createAuthRouter } = require("../routes/auth");
const { attachUser } = require("./middleware");

async function withServer(handler) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(attachUser);
  app.use("/api", createAuthRouter());
  await new Promise((resolve) => app.listen(0, resolve).on("listening", function () {
    handler.server = this;
    handler.port = this.address().port;
    resolve();
  }));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function req(port, method, path, { body, cookie } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (_e) { json = null; }
  return { status: res.status, json, setCookie: res.headers.get("set-cookie") };
}

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error("auth.test.js: DATABASE_URL not set; skipping");
    process.exit(0);
  }

  await db.query("TRUNCATE users CASCADE");

  const handler = {};
  await withServer(handler);
  const { port, server } = handler;

  // signup
  const a = await req(port, "POST", "/api/auth/signup", {
    body: { email: "Test@Example.COM", password: "hunter2hunter" },
  });
  assert.equal(a.status, 201, "signup 201");
  assert.equal(a.json.user.email, "test@example.com", "email is normalized");
  assert.match(a.setCookie || "", /algolens_session=/, "session cookie set");

  // duplicate signup
  const b = await req(port, "POST", "/api/auth/signup", {
    body: { email: "test@example.com", password: "anotherpass" },
  });
  assert.equal(b.status, 409, "duplicate email rejected");

  // wrong password
  const c = await req(port, "POST", "/api/auth/login", {
    body: { email: "test@example.com", password: "wrongpassword" },
  });
  assert.equal(c.status, 401, "wrong password rejected");

  // correct password
  const d = await req(port, "POST", "/api/auth/login", {
    body: { email: "test@example.com", password: "hunter2hunter" },
  });
  assert.equal(d.status, 200, "login 200");
  const sessionCookie = (d.setCookie || "").split(";")[0];
  assert.match(sessionCookie, /^algolens_session=/);

  // me with cookie
  const e = await req(port, "GET", "/api/auth/me", { cookie: sessionCookie });
  assert.equal(e.status, 200);
  assert.equal(e.json.user.email, "test@example.com");

  // me without cookie
  const f = await req(port, "GET", "/api/auth/me");
  assert.equal(f.status, 401);

  // short password rejected
  const g = await req(port, "POST", "/api/auth/signup", {
    body: { email: "second@example.com", password: "short" },
  });
  assert.equal(g.status, 400);
  assert.equal(g.json.error, "password_too_short");

  await close(server);
  await db.close();
  console.log("auth tests passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
