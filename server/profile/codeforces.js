// Codeforces official API: user.info for rating, user.status for submissions.
// The two calls are SEQUENTIAL on purpose (CF asks for ≤~2 req/s per IP).
// Calendar counts ALL submissions (activity, mirroring CF's own heatmap);
// solved = distinct problems with verdict OK. Accounts with >5000 submissions
// are truncated to the most recent 5000 — documented limitation.

const API = "https://codeforces.com/api";
const MAX_SUBMISSIONS = 5000;

async function fetchCodeforces(handle, { fetchImpl, timeoutMs }) {
  const { fetchWithTimeout, dayBucket, errorWithCode } = require("./index");

  const infoRes = await fetchWithTimeout(
    fetchImpl,
    `${API}/user.info?handles=${encodeURIComponent(handle)}`,
    {},
    timeoutMs
  );
  if (!infoRes.ok) throw errorWithCode(`codeforces http ${infoRes.status}`, "PARSE_FAILED");
  const info = await infoRes.json();
  if (info.status !== "OK") {
    const comment = String(info.comment || "").toLowerCase();
    throw errorWithCode(
      info.comment || "codeforces failed",
      comment.includes("not found") ? "NOT_FOUND" : "PARSE_FAILED"
    );
  }
  const rating = (info.result && info.result[0] && info.result[0].rating) ?? null;

  const statusRes = await fetchWithTimeout(
    fetchImpl,
    `${API}/user.status?handle=${encodeURIComponent(handle)}&from=1&count=${MAX_SUBMISSIONS}`,
    {},
    timeoutMs
  );
  if (!statusRes.ok) throw errorWithCode(`codeforces http ${statusRes.status}`, "PARSE_FAILED");
  const status = await statusRes.json();
  if (status.status !== "OK") throw errorWithCode(status.comment || "codeforces failed", "PARSE_FAILED");

  const solvedSet = new Set();
  const calendar = {};
  for (const sub of status.result || []) {
    if (typeof sub.creationTimeSeconds === "number") {
      const key = dayBucket(sub.creationTimeSeconds);
      calendar[key] = (calendar[key] || 0) + 1;
    }
    if (sub.verdict === "OK" && sub.problem) {
      solvedSet.add(`${sub.problem.contestId}-${sub.problem.index}`);
    }
  }

  return { solved: solvedSet.size, rating, calendar };
}

module.exports = { fetchCodeforces };
