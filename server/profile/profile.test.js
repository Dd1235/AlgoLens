const assert = require("node:assert/strict");
const { fetchPlatformStats, dayBucket } = require("./index");

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});
const htmlResponse = (html, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => { throw new Error("not json"); },
  text: async () => html,
});

(async () => {
  // ── LeetCode: normalization incl. the JSON-string calendar ──
  {
    const day = 86400;
    const calendar = JSON.stringify({ [String(10 * day + 3600)]: 2, [String(10 * day + 7200)]: 1, [String(11 * day)]: 5 });
    const fetchImpl = async () =>
      jsonResponse({
        data: {
          matchedUser: {
            username: "tourist",
            submitStatsGlobal: {
              acSubmissionNum: [
                { difficulty: "All", count: 300 },
                { difficulty: "Easy", count: 100 },
                { difficulty: "Medium", count: 150 },
                { difficulty: "Hard", count: 50 },
              ],
            },
            userCalendar: { submissionCalendar: calendar },
          },
        },
      });
    const r = await fetchPlatformStats("leetcode", "tourist", { fetchImpl });
    assert.equal(r.solved, 300);
    assert.deepEqual(r.byDifficulty, { easy: 100, medium: 150, hard: 50 });
    // same-day entries merge into one UTC bucket
    assert.equal(r.calendar[String(10 * day)], 3);
    assert.equal(r.calendar[String(11 * day)], 5);
  }

  // ── LeetCode: unknown user → not_found ──
  {
    const fetchImpl = async () => jsonResponse({ data: { matchedUser: null } });
    const r = await fetchPlatformStats("leetcode", "nobody-xyz", { fetchImpl });
    assert.equal(r.unavailable, true);
    assert.equal(r.error, "not_found");
  }

  // ── LeetCode: field-variant retry (submitStatsGlobal errors → submitStats works) ──
  {
    let calls = 0;
    const fetchImpl = async (_url, opts) => {
      calls += 1;
      if (opts.body.includes("submitStatsGlobal")) return jsonResponse({ errors: [{ message: "unknown field" }] });
      return jsonResponse({
        data: {
          matchedUser: {
            username: "x",
            submitStats: { acSubmissionNum: [{ difficulty: "All", count: 7 }] },
            userCalendar: { submissionCalendar: "{}" },
          },
        },
      });
    };
    const r = await fetchPlatformStats("leetcode", "x", { fetchImpl });
    assert.equal(r.solved, 7);
    assert.equal(calls, 2);
  }

  // ── Codeforces: distinct-OK solved count, activity calendar, rating ──
  {
    const day = 86400;
    const fetchImpl = async (url) => {
      if (url.includes("user.info")) return jsonResponse({ status: "OK", result: [{ handle: "x", rating: 1834 }] });
      return jsonResponse({
        status: "OK",
        result: [
          { creationTimeSeconds: 5 * day + 100, verdict: "OK", problem: { contestId: 1, index: "A" } },
          { creationTimeSeconds: 5 * day + 200, verdict: "OK", problem: { contestId: 1, index: "A" } }, // dup solve
          { creationTimeSeconds: 5 * day + 300, verdict: "WRONG_ANSWER", problem: { contestId: 2, index: "B" } },
          { creationTimeSeconds: 6 * day, verdict: "OK", problem: { contestId: 2, index: "B" } },
        ],
      });
    };
    const r = await fetchPlatformStats("codeforces", "x", { fetchImpl });
    assert.equal(r.solved, 2);
    assert.equal(r.rating, 1834);
    assert.equal(r.calendar[String(5 * day)], 3);
    assert.equal(r.calendar[String(6 * day)], 1);
  }

  // ── Codeforces: FAILED + "not found" comment → not_found ──
  {
    const fetchImpl = async () => jsonResponse({ status: "FAILED", comment: "handles: User with handle zz not found" });
    const r = await fetchPlatformStats("codeforces", "zz", { fetchImpl });
    assert.equal(r.error, "not_found");
  }

  // ── CodeChef: rating + solved from markup; garbage → parse_failed ──
  {
    const html = `<div class="rating-number">1912</div> ... <h3>Total Problems Solved: 431</h3>`;
    const r = await fetchPlatformStats("codechef", "x", { fetchImpl: async () => htmlResponse(html) });
    assert.equal(r.rating, 1912);
    assert.equal(r.solved, 431);
    assert.deepEqual(r.calendar, {});

    const bad = await fetchPlatformStats("codechef", "x", { fetchImpl: async () => htmlResponse("<html>nothing here</html>") });
    assert.equal(bad.error, "parse_failed");
  }

  // ── Timeout → unavailable, never throws ──
  {
    const fetchImpl = (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    const r = await fetchPlatformStats("leetcode", "slow", { fetchImpl, timeoutMs: 20 });
    assert.equal(r.unavailable, true);
    assert.equal(r.error, "timeout");
  }

  // ── Transport error → fetch_failed; unknown platform guarded ──
  {
    const r = await fetchPlatformStats("codeforces", "x", { fetchImpl: async () => { throw new Error("ECONNRESET"); } });
    assert.equal(r.error, "fetch_failed");
    const u = await fetchPlatformStats("atcoder", "x", {});
    assert.equal(u.error, "unknown_platform");
  }

  assert.equal(dayBucket(86400 + 5), "86400");
  console.log("profile fetcher tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
