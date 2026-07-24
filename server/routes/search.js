const express = require("express");
const fs = require("fs");
const path = require("path");
const db = require("../db");
const { expandQuery } = require("../search/query_expand");
const { logEvent } = require("../telemetry");

const VALID_FILTERS = new Set(["all", "done", "notdone"]);
// Pattern labels are slugs (see data/pattern_taxonomy.json); anything else is ignored.
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// Sentinel for "give me everything you have" — bigger than the corpus.
const FULL_PAGE_SIZE = 100000;

function pickRanker(indexes, defaultRanker, req) {
  const requested = (req.query.ranker || "").toString().toLowerCase();
  if (requested && indexes[requested]) return requested;
  return defaultRanker;
}

async function timedSearch(index, q, k, offset = 0) {
  const t = process.hrtime.bigint();
  const result = await Promise.resolve(index.search(q, k, offset));
  const latencyMs = Number(process.hrtime.bigint() - t) / 1e6;
  // Handle both old (array) and new ({ hits, total }) return shapes for backwards compat
  if (Array.isArray(result)) {
    return { hits: result, total: result.length, latencyMs: +latencyMs.toFixed(3) };
  }
  return { hits: result.hits, total: result.total, latencyMs: +latencyMs.toFixed(3) };
}

async function loadUserState(userId) {
  const result = await db.query(
    `SELECT problem_id, done, bookmarked
       FROM user_problem_state
      WHERE user_id = $1 AND (done OR bookmarked)`,
    [userId]
  );
  const done = new Set();
  const bookmarked = new Set();
  for (const row of result.rows) {
    if (row.done) done.add(row.problem_id);
    if (row.bookmarked) bookmarked.add(row.problem_id);
  }
  return { done, bookmarked };
}

// Canonical taxonomy labels with per-label problem counts, grouped by
// category. Computed once — the corpus is immutable per process. Drift labels
// don't appear here by design; the validate --gaps report is their surface.
function buildPatternsPayload(problems) {
  const taxonomy = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "..", "data", "pattern_taxonomy.json"), "utf8")
  );
  const aliases = taxonomy.aliases || {};
  const counts = new Map(Object.keys(taxonomy.canonical).map((p) => [p, 0]));
  for (const problem of problems || []) {
    for (const label of problem.patterns || []) {
      const canonical = aliases[label] || label;
      if (counts.has(canonical)) counts.set(canonical, counts.get(canonical) + 1);
    }
  }
  const byCategory = new Map();
  for (const [pattern, meta] of Object.entries(taxonomy.canonical)) {
    const category = meta.category || "general";
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category).push({ pattern, count: counts.get(pattern) });
  }
  const categories = [...byCategory.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, patterns]) => ({
      category,
      patterns: patterns.sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern)),
    }));
  return { version: 1, totalProblems: (problems || []).length, categories };
}

function createSearchRouter({ indexes, defaultRanker, problems }) {
  const router = express.Router();
  const patternsPayload = buildPatternsPayload(problems);

  router.get("/patterns", (_req, res) => {
    res.json(patternsPayload);
  });

  router.get("/search", async (req, res) => {
    const q = (req.query.q || "").toString();
    const k = Number.parseInt(req.query.k, 10) || 10;
    const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
    const filterRaw = (req.query.filter || "all").toString().toLowerCase();
    const filter = VALID_FILTERS.has(filterRaw) ? filterRaw : "all";
    const patternRaw = (req.query.pattern || "").toString().toLowerCase();
    const pattern = SLUG_RE.test(patternRaw) ? patternRaw : "";
    // Alias expansion ("aliens trick" → +wqs binary search) happens here at
    // the route, once, so every ranker — lexical, dense, gRPC — sees the
    // searchable form. The response echoes expandedQuery when it differs.
    const exp = expandQuery(q);
    const ranker = pickRanker(indexes, defaultRanker, req);
    const index = indexes[ranker];

    try {
      // Load the user's done/bookmarked sets once. Anonymous users skip this
      // and the filter degrades silently to "all".
      const userState = req.user ? await loadUserState(req.user.id) : null;
      const effectiveFilter = userState ? filter : "all";

      let hits, total, latencyMs;
      if (effectiveFilter === "all" && !pattern) {
        ({ hits, total, latencyMs } = await timedSearch(index, exp.query, k, offset));
      } else {
        // Need the full ranked list so filters + slice produce a stable
        // total and disjoint pages. The ranker materializes everything before
        // slicing internally, so this costs no extra scoring work. The pattern
        // filter composes with done/notdone in the same pass and works for
        // anonymous users too.
        const full = await timedSearch(index, exp.query, FULL_PAGE_SIZE, 0);
        latencyMs = full.latencyMs;
        const filtered = full.hits.filter((h) => {
          if (pattern && !(h.problem.patterns || []).includes(pattern)) return false;
          if (effectiveFilter === "all") return true;
          const isDone = userState.done.has(h.problem.id);
          return effectiveFilter === "done" ? isDone : !isDone;
        });
        total = filtered.length;
        hits = filtered.slice(offset, offset + k);
      }

      // Decorate hits for signed-in users so the UI can badge done/bookmarked.
      if (userState) {
        hits = hits.map((h) => ({
          ...h,
          done: userState.done.has(h.problem.id),
          bookmarked: userState.bookmarked.has(h.problem.id),
        }));
      }

      if (q && offset === 0) {
        logEvent("search", {
          visitor: req.visitor,
          userId: req.user?.id,
          props: {
            q: q.slice(0, 100),
            ranker,
            latencyMs,
            total,
            ...(pattern ? { pattern } : {}),
            ...(exp.expanded ? { expanded: true } : {}),
          },
        });
      }
      res.json({
        query: q,
        expandedQuery: exp.expanded ? exp.query : undefined,
        ranker,
        latencyMs,
        offset,
        k,
        total,
        filter: effectiveFilter,
        pattern: pattern || undefined,
        hits,
      });
    } catch (err) {
      res.status(502).json({ query: q, ranker, error: err.message || "search failed" });
    }
  });

  // "Find similar problems": doc-to-doc cosine over the precomputed vectors.
  // Pure stored-vector math — the embedding model is not involved, so this is
  // sync and fast (~1 ms full-corpus scan).
  router.get("/similar/:problemId", async (req, res) => {
    const dense = indexes.dense;
    if (!dense) {
      return res.status(503).json({ error: "dense ranker unavailable — run `npm run embed` and restart" });
    }
    const k = Math.min(50, Number.parseInt(req.query.k, 10) || 10);

    try {
      const t = process.hrtime.bigint();
      const result = dense.similar(req.params.problemId, k);
      const latencyMs = +(Number(process.hrtime.bigint() - t) / 1e6).toFixed(3);
      if (!result) return res.status(404).json({ error: "unknown problem id" });

      let { hits } = result;
      const userState = req.user ? await loadUserState(req.user.id) : null;
      if (userState) {
        hits = hits.map((h) => ({
          ...h,
          done: userState.done.has(h.problem.id),
          bookmarked: userState.bookmarked.has(h.problem.id),
        }));
      }
      logEvent("similar", { visitor: req.visitor, userId: req.user?.id, props: { problemId: req.params.problemId, latencyMs } });
      res.json({ problemId: req.params.problemId, source: result.source, ranker: "dense", latencyMs, k, total: result.total, hits });
    } catch (err) {
      res.status(502).json({ error: err.message || "similar failed" });
    }
  });

  // Compare mode: the same query across several rankers, side by side.
  // ?rankers=bm25,dense narrows the set (default: all registered). Ignores the
  // done/pattern filters on purpose — it's a ranker-quality lens, not a browse view.
  router.get("/compare", async (req, res) => {
    const q = (req.query.q || "").toString();
    const exp = expandQuery(q);
    const k = Number.parseInt(req.query.k, 10) || 10;
    const requested = (req.query.rankers || "")
      .toString()
      .toLowerCase()
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const names = requested.length ? requested.filter((n) => indexes[n]) : Object.keys(indexes);
    const settled = await Promise.all(
      names.map(async (name) => {
        try {
          const { hits, latencyMs } = await timedSearch(indexes[name], exp.query, k);
          return { ranker: name, latencyMs, hits };
        } catch (err) {
          return { ranker: name, latencyMs: null, error: err.message || "failed", hits: [] };
        }
      })
    );
    if (q) {
      logEvent("compare", { visitor: req.visitor, userId: req.user?.id, props: { q: q.slice(0, 100), rankers: names } });
    }
    res.json({ query: q, expandedQuery: exp.expanded ? exp.query : undefined, k, results: settled });
  });

  return router;
}

module.exports = { createSearchRouter };
