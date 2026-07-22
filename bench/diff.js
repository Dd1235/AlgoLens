#!/usr/bin/env node
// Cross-ranker per-query comparison from a saved bench run — mechanizes the
// "where dense wins / loses" tables that experiment 05 assembled by hand.
//
//   node bench/diff.js --base bm25 --cand dense
//   node bench/diff.js --base bm25 --cand hybrid --slice technique --top 5
//   node bench/diff.js --base bm25 --cand dense --file experiments/bench-2026-06-12T09-26-53-802Z.json
//
// Reads per-query reciprocal ranks (RR) for two rankers and prints win/loss
// counts plus markdown-ready ΔRR tables. Rank is recovered from RR (1/RR);
// RR = 0 means no relevant doc in the scored window and prints as >100.

const fs = require("fs");
const path = require("path");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const file = arg("file", path.join(__dirname, "..", "experiments", "bench-latest.json"));
const baseName = arg("base", "bm25");
const candName = arg("cand", "dense");
const sliceFilter = arg("slice", null);
const top = Number.parseInt(arg("top", "8"), 10);

const run = JSON.parse(fs.readFileSync(file, "utf8"));
const byRanker = new Map(run.results.map((r) => [r.ranker, r]));
for (const name of [baseName, candName]) {
  if (!byRanker.has(name)) {
    console.error(`ranker "${name}" not in ${file} (has: ${run.results.map((r) => r.ranker).join(", ")})`);
    process.exit(1);
  }
}

const basePq = byRanker.get(baseName).perQuery;
const candByQuery = new Map(byRanker.get(candName).perQuery.map((q) => [q.query, q]));

const rows = [];
for (const b of basePq) {
  if (sliceFilter && (b.slice || "keyword") !== sliceFilter) continue;
  const c = candByQuery.get(b.query);
  if (!c) continue; // query sets should match; skip defensively
  rows.push({
    query: b.query,
    slice: b.slice || "keyword",
    baseRR: b.RR,
    candRR: c.RR,
    delta: c.RR - b.RR,
  });
}
if (!rows.length) {
  console.error(sliceFilter ? `no queries in slice "${sliceFilter}"` : "no queries matched");
  process.exit(1);
}

const rank = (rr) => (rr > 0 ? String(Math.round(1 / rr)) : ">100");
const wins = rows.filter((r) => r.delta > 1e-9).length;
const losses = rows.filter((r) => r.delta < -1e-9).length;
const ties = rows.length - wins - losses;
const mean = (xs) => xs.reduce((a, x) => a + x, 0) / xs.length;

console.log(
  `${candName} vs ${baseName} on ${rows.length} queries` +
    (sliceFilter ? ` (slice: ${sliceFilter})` : "") +
    ` — ${candName} wins ${wins}, loses ${losses}, ties ${ties}` +
    ` | mean RR ${mean(rows.map((r) => r.candRR)).toFixed(3)} vs ${mean(rows.map((r) => r.baseRR)).toFixed(3)}`
);

function table(title, list) {
  if (!list.length) return;
  console.log(`\n${title}\n`);
  console.log(`| Δ RR | Query | Slice | ${baseName} rank | ${candName} rank |`);
  console.log(`|------|-------|-------|------|------|`);
  for (const r of list) {
    const sign = r.delta > 0 ? "+" : "";
    console.log(
      `| ${sign}${r.delta.toFixed(3)} | ${r.query} | ${r.slice} | ${rank(r.baseRR)} | ${rank(r.candRR)} |`
    );
  }
}

const sorted = [...rows].sort((a, b) => b.delta - a.delta);
table(`Where ${candName} wins biggest:`, sorted.filter((r) => r.delta > 1e-9).slice(0, top));
table(`Where ${candName} loses biggest:`, sorted.filter((r) => r.delta < -1e-9).reverse().slice(0, top));
