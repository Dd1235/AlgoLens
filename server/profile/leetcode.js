// LeetCode public profile via GraphQL: solved counts by difficulty + the
// submission calendar (a JSON-string map of epoch-seconds → count).

const GRAPHQL_URL = "https://leetcode.com/graphql";
const HEADERS = {
  "content-type": "application/json",
  referer: "https://leetcode.com",
  "user-agent": "Mozilla/5.0 (AlgoLens profile)",
};

// Field names drift across LC schema versions — try variants in order, same
// pattern as the corpus scripts.
const STATS_FIELDS = ["submitStatsGlobal", "submitStats"];

function buildQuery(statsField) {
  return `query userProfile($username: String!) {
    matchedUser(username: $username) {
      username
      ${statsField} { acSubmissionNum { difficulty count } }
      userCalendar { submissionCalendar }
    }
  }`;
}

async function fetchLeetCode(handle, { fetchImpl, timeoutMs }) {
  const { fetchWithTimeout, dayBucket, errorWithCode } = require("./index");

  let user = null;
  let statsField = null;
  for (const field of STATS_FIELDS) {
    const res = await fetchWithTimeout(
      fetchImpl,
      GRAPHQL_URL,
      {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ query: buildQuery(field), variables: { username: handle } }),
      },
      timeoutMs
    );
    if (!res.ok) throw errorWithCode(`leetcode http ${res.status}`, "PARSE_FAILED");
    const data = await res.json();
    if (data.errors) continue; // wrong field name for this schema — try next
    user = (data.data || {}).matchedUser;
    statsField = field;
    break;
  }
  if (statsField === null) throw errorWithCode("leetcode graphql fields", "PARSE_FAILED");
  if (!user) throw errorWithCode("leetcode user not found", "NOT_FOUND");

  const byDifficulty = {};
  let solved = null;
  for (const row of ((user[statsField] || {}).acSubmissionNum || [])) {
    const d = String(row.difficulty || "").toLowerCase();
    if (d === "all") solved = row.count;
    else if (["easy", "medium", "hard"].includes(d)) byDifficulty[d] = row.count;
  }

  const calendar = {};
  const rawCalendar = (user.userCalendar || {}).submissionCalendar;
  if (typeof rawCalendar === "string" && rawCalendar) {
    try {
      for (const [sec, count] of Object.entries(JSON.parse(rawCalendar))) {
        const key = dayBucket(Number(sec));
        calendar[key] = (calendar[key] || 0) + Number(count || 0);
      }
    } catch (_e) {
      // calendar is optional; keep the solved counts
    }
  }

  return { solved, byDifficulty, rating: null, calendar };
}

module.exports = { fetchLeetCode };
