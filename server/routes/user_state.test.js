// Round-trip integration test for the user-state router.
// Requires DATABASE_URL + JWT_SECRET set; truncates user tables.

const assert = require("node:assert/strict");
const express = require("express");
const cookieParser = require("cookie-parser");
const db = require("../db");
const { createAuthRouter } = require("./auth");
const { createUserStateRouter } = require("./user_state");
const { attachUser } = require("../auth/middleware");

async function withServer() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(attachUser);
  app.use("/api", createAuthRouter());
  app.use("/api", createUserStateRouter());
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

async function req(port, method, path, { body, cookie } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (_e) { json = null; }
  return { status: res.status, json, setCookie: res.headers.get("set-cookie") };
}

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error("user_state.test.js: DATABASE_URL not set; skipping");
    process.exit(0);
  }

  await db.query("TRUNCATE users CASCADE");

  const { server, port } = await withServer();

  // Anonymous bookmark must 401.
  const anon = await req(port, "POST", "/api/done/leetcode-two-sum");
  assert.equal(anon.status, 401);

  // Sign up and grab cookie.
  const su = await req(port, "POST", "/api/auth/signup", {
    body: { email: "u@e.com", password: "passwordok123" },
  });
  assert.equal(su.status, 201);
  const cookie = (su.setCookie || "").split(";")[0];

  // Mark done.
  const a = await req(port, "POST", "/api/done/leetcode-two-sum", { cookie });
  assert.equal(a.status, 200);

  // Mark bookmark.
  const b = await req(port, "POST", "/api/bookmark/leetcode-two-sum", { cookie });
  assert.equal(b.status, 200);

  // Aggregate.
  const c = await req(port, "GET", "/api/user-state", { cookie });
  assert.equal(c.status, 200);
  assert.deepEqual(c.json.done, ["leetcode-two-sum"]);
  assert.deepEqual(c.json.bookmarked, ["leetcode-two-sum"]);

  // Idempotent re-mark done — still one row.
  const d = await req(port, "POST", "/api/done/leetcode-two-sum", { cookie });
  assert.equal(d.status, 200);
  const count = await db.query("SELECT COUNT(*)::int AS n FROM user_problem_state");
  assert.equal(count.rows[0].n, 1, "no duplicate rows on re-mark");

  // Unset done — row stays because bookmarked is still true.
  const e = await req(port, "DELETE", "/api/done/leetcode-two-sum", { cookie });
  assert.equal(e.status, 200);
  const e2 = await req(port, "GET", "/api/user-state", { cookie });
  assert.deepEqual(e2.json.done, []);
  assert.deepEqual(e2.json.bookmarked, ["leetcode-two-sum"]);

  // Unset bookmark — row deletes since both flags are false.
  const f = await req(port, "DELETE", "/api/bookmark/leetcode-two-sum", { cookie });
  assert.equal(f.status, 200);
  const left = await db.query("SELECT COUNT(*)::int AS n FROM user_problem_state");
  assert.equal(left.rows[0].n, 0, "row deleted when both flags false");

  // Bad problem id rejected.
  const g = await req(port, "POST", "/api/done/not%20a%20valid%20id", { cookie });
  assert.equal(g.status, 400);

  await new Promise((r) => server.close(r));
  await db.close();
  console.log("user-state tests passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
