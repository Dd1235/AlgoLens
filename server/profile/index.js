// Per-platform stat fetchers for the profile feature. Contract: every fetcher
// returns the normalized payload
//   { solved, byDifficulty?, rating, calendar: { [epochDaySeconds]: count } }
// and the orchestrator NEVER throws — any failure becomes
//   { unavailable: true, error: "timeout" | "fetch_failed" | "not_found" | "parse_failed",
//     solved: null, rating: null, calendar: {} }
// so one broken platform can never take down /api/profile.

const { fetchLeetCode } = require("./leetcode");
const { fetchCodeforces } = require("./codeforces");
const { fetchCodeChef } = require("./codechef");
const { fetchGitHub } = require("./github");
const { fetchAtCoder } = require("./atcoder");

const DAY_SECONDS = 86400;

function dayBucket(epochSeconds) {
  return String(Math.floor(epochSeconds / DAY_SECONDS) * DAY_SECONDS);
}

// fetch with an AbortController deadline; errors are classified by the caller.
async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const FETCHERS = {
  leetcode: fetchLeetCode,
  codeforces: fetchCodeforces,
  codechef: fetchCodeChef,
  github: fetchGitHub,
  atcoder: fetchAtCoder,
};

function unavailable(error) {
  return { unavailable: true, error, solved: null, rating: null, calendar: {} };
}

async function fetchPlatformStats(platform, handle, { fetchImpl = fetch, timeoutMs = 6000 } = {}) {
  const fetcher = FETCHERS[platform];
  if (!fetcher) return unavailable("unknown_platform");
  try {
    return await fetcher(handle, { fetchImpl, timeoutMs });
  } catch (err) {
    if (err && err.name === "AbortError") return unavailable("timeout");
    if (err && err.code === "NOT_FOUND") return unavailable("not_found");
    if (err && err.code === "PARSE_FAILED") return unavailable("parse_failed");
    return unavailable("fetch_failed");
  }
}

function errorWithCode(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

module.exports = { fetchPlatformStats, fetchWithTimeout, dayBucket, errorWithCode, DAY_SECONDS };
