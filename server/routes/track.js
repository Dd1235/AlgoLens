const express = require("express");
const { logEvent } = require("../telemetry");

// Client-side outcome beacons (result opens, feedback, UI actions). Types are
// allowlisted and props are clipped/validated; visitor + user identity is
// attached server-side, never trusted from the body.
const TYPES = new Set([
  "result_open",
  "pattern_selected",
  "ranker_changed",
  "load_more",
  "search_feedback",
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
