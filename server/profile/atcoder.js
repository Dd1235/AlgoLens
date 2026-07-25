// AtCoder: submissions come from the community API that the AtCoder Problems
// site runs (there is no official submissions endpoint); rating comes from
// AtCoder's own contest-history JSON. Rating is best-effort — if that call
// fails the profile still shows solved counts and the heatmap.

const SUBMISSIONS_URL = "https://kenkoooo.com/atcoder/atcoder-api/v3/user/submissions";
const HISTORY_URL = (handle) => `https://atcoder.jp/users/${encodeURIComponent(handle)}/history/json`;
const PAGE_LIMIT = 10; // the API returns ≤500 rows per call; cap the walk like CF
const WINDOW_DAYS = 371; // one heatmap window; older submissions aren't rendered

async function fetchAtCoder(handle, { fetchImpl, timeoutMs }) {
  const { fetchWithTimeout, dayBucket, errorWithCode, DAY_SECONDS } = require("./index");

  let from = Math.floor(Date.now() / 1000) - WINDOW_DAYS * DAY_SECONDS;
  const solved = new Set();
  const calendar = {};
  let rows = 0;

  for (let page = 0; page < PAGE_LIMIT; page += 1) {
    const url = `${SUBMISSIONS_URL}?user=${encodeURIComponent(handle)}&from_second=${from}`;
    const res = await fetchWithTimeout(
      fetchImpl,
      url,
      { headers: { "user-agent": "Mozilla/5.0 (cosine profile)" } },
      timeoutMs
    );
    if (!res.ok) throw errorWithCode(`atcoder http ${res.status}`, "PARSE_FAILED");
    const batch = await res.json();
    if (!Array.isArray(batch)) throw errorWithCode("atcoder unexpected payload", "PARSE_FAILED");
    if (!batch.length) break;

    for (const sub of batch) {
      if (typeof sub.epoch_second !== "number") continue;
      const key = dayBucket(sub.epoch_second);
      calendar[key] = (calendar[key] || 0) + 1;
      if (sub.result === "AC" && sub.problem_id) solved.add(sub.problem_id);
    }
    rows += batch.length;
    if (batch.length < 500) break;
    // Walk forward from the newest row seen; +1s so the page can't repeat.
    from = Math.max(...batch.map((s) => s.epoch_second || 0)) + 1;
  }

  // An unknown handle simply has no submissions — distinguish it from a
  // quiet-but-real account only if the account page 404s below.
  let rating = null;
  let historyOk = false;
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      HISTORY_URL(handle),
      { headers: { "user-agent": "Mozilla/5.0 (cosine profile)" } },
      timeoutMs
    );
    if (res.status === 404) throw errorWithCode("atcoder user not found", "NOT_FOUND");
    if (res.ok) {
      const history = await res.json();
      historyOk = true;
      if (Array.isArray(history) && history.length) {
        rating = history[history.length - 1].NewRating ?? null;
      }
    }
  } catch (err) {
    if (err && err.code === "NOT_FOUND") throw err;
    // rating is optional; keep the submission data
  }

  if (!rows && !historyOk) throw errorWithCode("atcoder user not found", "NOT_FOUND");
  return { solved: solved.size, rating, calendar };
}

module.exports = { fetchAtCoder };
