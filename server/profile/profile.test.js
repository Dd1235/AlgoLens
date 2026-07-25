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

  // ── GitHub via GraphQL (token path): normalization, zero-skip ──
  {
    process.env.GITHUB_TOKEN = "test-token";
    const fetchImpl = async (url, opts) => {
      if (!url.includes("api.github.com")) throw new Error("expected graphql path");
      if (!opts.headers.authorization.includes("test-token")) throw new Error("missing token");
      return jsonResponse({
        data: {
          user: {
            contributionsCollection: {
              contributionCalendar: {
                totalContributions: 42,
                weeks: [
                  { contributionDays: [
                    { date: "2026-07-20", contributionCount: 5 },
                    { date: "2026-07-21", contributionCount: 0 },
                    { date: "2026-07-22", contributionCount: 7 },
                  ] },
                ],
              },
            },
          },
        },
      });
    };
    const r = await fetchPlatformStats("github", "octocat", { fetchImpl });
    assert.equal(r.contributions, 42);
    assert.equal(Object.keys(r.calendar).length, 2); // zero-count day skipped
    assert.equal(r.calendar[String(Date.parse("2026-07-22T00:00:00Z") / 1000)], 7);
    assert.ok(!r.approximate);

    const notFound = await fetchPlatformStats("github", "nobody", {
      fetchImpl: async () => jsonResponse({ data: { user: null } }),
    });
    assert.equal(notFound.error, "not_found");
    delete process.env.GITHUB_TOKEN;
  }

  // ── GitHub via scrape (no token): tool-tip counts ──
  {
    delete process.env.GITHUB_TOKEN;
    const html = `
      <td id="contribution-day-component-0-1" data-date="2026-07-20" data-level="2"></td>
      <td id="contribution-day-component-0-2" data-date="2026-07-21" data-level="0"></td>
      <tool-tip for="contribution-day-component-0-1">6 contributions on July 20th.</tool-tip>
      <tool-tip for="contribution-day-component-0-2">No contributions on July 21st.</tool-tip>`;
    const r = await fetchPlatformStats("github", "octocat", { fetchImpl: async (url) => {
      if (!url.includes("github.com/users/")) throw new Error("expected scrape path");
      return htmlResponse(html);
    } });
    assert.equal(r.contributions, 6);
    assert.equal(r.calendar[String(Date.parse("2026-07-20T00:00:00Z") / 1000)], 6);
    assert.ok(!r.approximate);
  }

  // ── GitHub scrape: counts unparseable → levels as pseudo-counts, approximate ──
  {
    delete process.env.GITHUB_TOKEN;
    const html = `
      <td id="c1" data-date="2026-07-20" data-level="3"></td>
      <td id="c2" data-date="2026-07-21" data-level="0"></td>`;
    const r = await fetchPlatformStats("github", "octocat", { fetchImpl: async () => htmlResponse(html) });
    assert.equal(r.approximate, true);
    assert.equal(r.calendar[String(Date.parse("2026-07-20T00:00:00Z") / 1000)], 3);
    assert.equal(r.contributions, null);

    const garbage = await fetchPlatformStats("github", "octocat", { fetchImpl: async () => htmlResponse("<html>nope</html>") });
    assert.equal(garbage.error, "parse_failed");
  }

  // ── AtCoder: distinct AC solved, activity calendar, rating from history ──
  {
    const day = 86400;
    const now = Math.floor(Date.now() / 1000);
    const t1 = now - 3 * day, t2 = now - 2 * day;
    const fetchImpl = async (url) => {
      if (url.includes("kenkoooo")) {
        if (url.includes("from_second=" + (t2 + 1))) return jsonResponse([]);
        return jsonResponse([
          { epoch_second: t1, result: "AC", problem_id: "abc300_a" },
          { epoch_second: t1 + 60, result: "WA", problem_id: "abc300_b" },
          { epoch_second: t2, result: "AC", problem_id: "abc300_a" }, // resolve, same problem
          { epoch_second: t2, result: "AC", problem_id: "abc300_b" },
        ]);
      }
      return jsonResponse([{ NewRating: 1234 }, { NewRating: 1500 }]);
    };
    const r = await fetchPlatformStats("atcoder", "someone", { fetchImpl });
    assert.equal(r.solved, 2); // abc300_a counted once
    assert.equal(r.rating, 1500); // latest contest
    assert.equal(r.calendar[String(Math.floor(t1 / day) * day)], 2);

    // Unknown handle: no submissions AND a 404 history page.
    const missing = await fetchPlatformStats("atcoder", "nobody", {
      fetchImpl: async (url) =>
        url.includes("kenkoooo") ? jsonResponse([]) : jsonResponse({}, 404),
    });
    assert.equal(missing.error, "not_found");

    // Rating endpoint down, submissions fine → still usable, rating null.
    const partial = await fetchPlatformStats("atcoder", "someone", {
      fetchImpl: async (url) => {
        if (url.includes("kenkoooo")) return jsonResponse([{ epoch_second: t1, result: "AC", problem_id: "x" }]);
        throw new Error("history down");
      },
    });
    assert.equal(partial.solved, 1);
    assert.equal(partial.rating, null);
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
    const u = await fetchPlatformStats("topcoder", "x", {}); // genuinely unsupported
    assert.equal(u.error, "unknown_platform");
  }

  assert.equal(dayBucket(86400 + 5), "86400");
  console.log("profile fetcher tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
