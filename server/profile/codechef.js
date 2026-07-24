// CodeChef has no official API — this is a best-effort scrape of the public
// profile page for rating and fully-solved count. No heatmap by design (that
// data is rendered client-side and isn't reliably extractable). Anything
// unexpected → parse_failed; the profile page shows "unavailable" and moves on.

const PROFILE_URL = (handle) => `https://www.codechef.com/users/${encodeURIComponent(handle)}`;

async function fetchCodeChef(handle, { fetchImpl, timeoutMs }) {
  const { fetchWithTimeout, errorWithCode } = require("./index");

  const res = await fetchWithTimeout(
    fetchImpl,
    PROFILE_URL(handle),
    { headers: { "user-agent": "Mozilla/5.0 (AlgoLens profile)" } },
    timeoutMs
  );
  if (res.status === 404) throw errorWithCode("codechef user not found", "NOT_FOUND");
  if (!res.ok) throw errorWithCode(`codechef http ${res.status}`, "PARSE_FAILED");
  const html = await res.text();

  const ratingMatch =
    html.match(/class="rating-number"[^>]*>\s*(\d+)/) || html.match(/"currentRating"\s*:\s*(\d+)/);
  const solvedMatch =
    html.match(/Total Problems Solved:\s*(\d+)/i) || html.match(/"problemsSolved"\s*:\s*"?(\d+)/);

  if (!ratingMatch && !solvedMatch) throw errorWithCode("codechef markup changed", "PARSE_FAILED");

  return {
    solved: solvedMatch ? Number(solvedMatch[1]) : null,
    rating: ratingMatch ? Number(ratingMatch[1]) : null,
    calendar: {},
  };
}

module.exports = { fetchCodeChef };
