// GitHub contributions calendar, two paths:
//   1. GITHUB_TOKEN set → GraphQL contributionsCollection (exact data — the
//      same calendar github.com renders; any no-scope PAT can read public
//      calendars, and authenticated api.github.com is reliable from
//      datacenter IPs).
//   2. No token → scrape the public contributions fragment that github.com
//      itself embeds. Day cells carry data-date (+ data-level 0-4); counts
//      live in sibling <tool-tip> elements. If counts can't be parsed but
//      levels can, levels are used as pseudo-counts and the payload is
//      flagged { approximate: true }.

const GRAPHQL_URL = "https://api.github.com/graphql";
const CONTRIB_URL = (handle) => `https://github.com/users/${encodeURIComponent(handle)}/contributions`;

const CALENDAR_QUERY = `query($login: String!) {
  user(login: $login) {
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount } }
      }
    }
  }
}`;

function dateToDayBucket(isoDate) {
  const ms = Date.parse(`${isoDate}T00:00:00Z`);
  return Number.isFinite(ms) ? String(ms / 1000) : null;
}

async function fetchViaGraphql(handle, token, { fetchImpl, timeoutMs }) {
  const { fetchWithTimeout, errorWithCode } = require("./index");
  const res = await fetchWithTimeout(
    fetchImpl,
    GRAPHQL_URL,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `bearer ${token}`,
        "user-agent": "AlgoLens profile",
      },
      body: JSON.stringify({ query: CALENDAR_QUERY, variables: { login: handle } }),
    },
    timeoutMs
  );
  if (!res.ok) throw errorWithCode(`github http ${res.status}`, "PARSE_FAILED");
  const data = await res.json();
  const user = (data.data || {}).user;
  if (!user) throw errorWithCode("github user not found", "NOT_FOUND");

  const cal = ((user.contributionsCollection || {}).contributionCalendar) || {};
  const calendar = {};
  for (const week of cal.weeks || []) {
    for (const day of week.contributionDays || []) {
      if (!day.contributionCount) continue;
      const key = dateToDayBucket(day.date);
      if (key) calendar[key] = day.contributionCount;
    }
  }
  return {
    solved: null,
    rating: null,
    contributions: cal.totalContributions ?? null,
    calendar,
  };
}

async function fetchViaScrape(handle, { fetchImpl, timeoutMs }) {
  const { fetchWithTimeout, errorWithCode } = require("./index");
  const res = await fetchWithTimeout(
    fetchImpl,
    CONTRIB_URL(handle),
    { headers: { "user-agent": "Mozilla/5.0 (AlgoLens profile)" } },
    timeoutMs
  );
  if (res.status === 404) throw errorWithCode("github user not found", "NOT_FOUND");
  if (!res.ok) throw errorWithCode(`github http ${res.status}`, "PARSE_FAILED");
  const html = await res.text();

  // Cells: <td ... id="contribution-day-component-X-Y" data-date="…" data-level="N" …>
  const cellRe = /id="([^"]+)"[^>]*data-date="(\d{4}-\d{2}-\d{2})"[^>]*data-level="(\d+)"|data-date="(\d{4}-\d{2}-\d{2})"[^>]*id="([^"]+)"[^>]*data-level="(\d+)"/g;
  const cells = [];
  let m;
  while ((m = cellRe.exec(html)) !== null) {
    cells.push(
      m[1] !== undefined
        ? { id: m[1], date: m[2], level: Number(m[3]) }
        : { id: m[5], date: m[4], level: Number(m[6]) }
    );
  }
  if (!cells.length) throw errorWithCode("github contributions markup changed", "PARSE_FAILED");

  // Counts: <tool-tip for="cell-id" …>12 contributions on …</tool-tip>
  const counts = new Map();
  const tipRe = /<tool-tip[^>]*for="([^"]+)"[^>]*>\s*(No|\d+)\s+contribution/g;
  while ((m = tipRe.exec(html)) !== null) {
    counts.set(m[1], m[2] === "No" ? 0 : Number(m[2]));
  }

  const haveCounts = counts.size > 0;
  const calendar = {};
  let total = 0;
  for (const cell of cells) {
    const count = haveCounts ? (counts.get(cell.id) ?? 0) : cell.level;
    if (!count) continue;
    const key = dateToDayBucket(cell.date);
    if (!key) continue;
    calendar[key] = count;
    total += count;
  }
  return {
    solved: null,
    rating: null,
    contributions: haveCounts ? total : null,
    calendar,
    ...(haveCounts ? {} : { approximate: true }),
  };
}

async function fetchGitHub(handle, { fetchImpl, timeoutMs }) {
  const token = process.env.GITHUB_TOKEN;
  if (token) return fetchViaGraphql(handle, token, { fetchImpl, timeoutMs });
  return fetchViaScrape(handle, { fetchImpl, timeoutMs });
}

module.exports = { fetchGitHub };
