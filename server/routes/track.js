const express = require("express");
const { logEvent } = require("../telemetry");

// Client-side outcome beacons (result opens, feedback, UI actions). Types are
// allowlisted and props are clipped/validated; visitor + user identity is
// attached server-side, never trusted from the body.
//
// Every type the client actually sends must be here. It wasn't: nine of them
// (every filter chip, the difficulty controls, "my level", the recall rating)
// were 400ing on arrival — invisible in the app, since a beacon nobody awaits
// cannot report a failure, but visible as a console error and, worse, as a
// stats page that had never recorded a single one of those interactions.
// web/app.smoke.test.js now asserts this set covers every track() call in the
// bundle, so adding a beacon without allowing it fails the build instead.
const TYPES = new Set([
  "result_open",
  "pattern_selected",
  "ranker_changed",
  "load_more",
  "search_feedback",
  "platform_selected",
  "difficulty_selected",
  "sort_changed",
  "level_applied",
  "level_cleared",
  "library_aged",
  "library_order",
  "library_recall",
  "recall_set",
]);

const clip = (v, n) => (typeof v === "string" && v ? v.slice(0, n) : undefined);

function cleanProps(type, raw = {}) {
  const p = {};
  if (raw.searchId && /^[a-f0-9-]{8,40}$/i.test(String(raw.searchId))) {
    p.searchId = String(raw.searchId);
  }
  if (type === "result_open") {
    p.problemId = clip(raw.problemId, 120);
    p.ranker = clip(raw.ranker, 20);
    const pos = Number(raw.position);
    if (Number.isInteger(pos) && pos > 0 && pos <= 100000) p.position = pos;
    if (raw.kind === "external" || raw.kind === "expand") p.kind = raw.kind;
  } else if (type === "pattern_selected") {
    p.pattern = clip(raw.pattern, 60);
  } else if (type === "ranker_changed") {
    p.from = clip(raw.from, 20);
    p.to = clip(raw.to, 20);
  } else if (type === "load_more") {
    p.ranker = clip(raw.ranker, 20);
    const off = Number(raw.offset);
    if (Number.isInteger(off) && off >= 0) p.offset = off;
  } else if (type === "platform_selected") {
    p.platform = clip(raw.platform, 20);
    p.active = clip(raw.active, 60);
  } else if (type === "difficulty_selected") {
    // One event, three shapes: a LeetCode tier, a judge's rating range, or an
    // acceptance-rate band. Each field is optional and cleaned on its own.
    p.tier = clip(raw.tier, 20);
    p.judge = clip(raw.judge, 20);
    p.acceptance = clip(raw.acceptance, 20);
    for (const k of ["min", "max"]) {
      const n = Number(raw[k]);
      if (Number.isFinite(n)) p[k] = n;
    }
  } else if (type === "sort_changed") {
    p.dir = clip(raw.dir, 20);
  } else if (type === "level_applied") {
    const n = Number(raw.judges);
    if (Number.isInteger(n) && n >= 0 && n <= 10) p.judges = n;
  } else if (type === "library_aged") {
    const n = Number(raw.days);
    if (Number.isInteger(n) && n >= 0 && n <= 100000) p.days = n;
  } else if (type === "library_order") {
    p.oldest = raw.oldest === true;
  } else if (type === "library_recall") {
    p.value = clip(raw.value, 20);
  } else if (type === "recall_set") {
    p.problemId = clip(raw.problemId, 120);
    p.value = clip(raw.value, 20);
  } else if (type === "search_feedback") {
    p.useful = raw.useful === true;
    p.reason = clip(raw.reason, 200);
    p.ranker = clip(raw.ranker, 20);
    p.q = clip(raw.q, 100);
  }
  for (const key of Object.keys(p)) if (p[key] === undefined) delete p[key];
  return p;
}

function createTrackRouter() {
  const router = express.Router();

  router.post("/track", (req, res) => {
    const { type, props } = req.body || {};
    if (!TYPES.has(type)) return res.status(400).json({ error: "bad_type" });
    logEvent(type, { visitor: req.visitor, userId: req.user?.id, props: cleanProps(type, props) });
    res.status(204).end();
  });

  return router;
}

module.exports = { createTrackRouter };
