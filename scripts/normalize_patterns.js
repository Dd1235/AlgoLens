#!/usr/bin/env node
// Rewrite alias labels to their canonical form across the served corpus:
// tags[], patterns[], and annotation.pattern_confidence keys, per the alias
// map in data/pattern_taxonomy.json.
//
//   node scripts/normalize_patterns.js           dry run: report what would change
//   node scripts/normalize_patterns.js --write   rewrite the files
//
// After --write the corpus text has changed, so `npm run embed` must be re-run
// (npm run validate enforces that).

const fs = require("fs");
const path = require("path");
const { CORPUS_ROOT, DEFAULT_PLATFORMS } = require("../server/data");

const ROOT = path.join(__dirname, "..");
const ALIASES = JSON.parse(
  fs.readFileSync(path.join(ROOT, "data", "pattern_taxonomy.json"), "utf8")
).aliases;

function normalizeList(list) {
  const out = [];
  const seen = new Set();
  let changed = false;
  for (const label of list) {
    const canonical = ALIASES[label] || label;
    if (canonical !== label) changed = true;
    if (seen.has(canonical)) {
      changed = true; // alias collapsed onto an already-present canonical
      continue;
    }
    seen.add(canonical);
    out.push(canonical);
  }
  return { out, changed };
}

function normalizeConfidence(conf) {
  const out = {};
  let changed = false;
  for (const [key, score] of Object.entries(conf)) {
    const canonical = ALIASES[key] || key;
    if (canonical !== key) changed = true;
    if (canonical in out) {
      out[canonical] = Math.max(out[canonical], score);
      changed = true;
    } else {
      out[canonical] = score;
    }
  }
  return { out, changed };
}

function main() {
  const write = process.argv.includes("--write");
  const perAlias = new Map();
  let filesChanged = 0;

  for (const platform of DEFAULT_PLATFORMS) {
    const dir = path.join(CORPUS_ROOT, platform);
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
      const full = path.join(dir, file);
      const problem = JSON.parse(fs.readFileSync(full, "utf8"));
      let changed = false;

      for (const field of ["tags", "patterns"]) {
        const list = problem[field] || [];
        for (const label of list) {
          if (ALIASES[label]) perAlias.set(label, (perAlias.get(label) || 0) + 1);
        }
        const res = normalizeList(list);
        if (res.changed) {
          problem[field] = res.out;
          changed = true;
        }
      }
      const conf = (problem.annotation || {}).pattern_confidence;
      if (conf) {
        const res = normalizeConfidence(conf);
        if (res.changed) {
          problem.annotation.pattern_confidence = res.out;
          changed = true;
        }
      }

      if (changed) {
        filesChanged += 1;
        if (write) fs.writeFileSync(full, JSON.stringify(problem, null, 2) + "\n");
      }
    }
  }

  for (const [alias, n] of [...perAlias.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`${alias} -> ${ALIASES[alias]}: ${n} occurrence(s)`);
  }
  console.log(
    write
      ? `rewrote ${filesChanged} file(s) — now run \`npm run embed\` then \`npm run validate\``
      : `dry run: ${filesChanged} file(s) would change (pass --write to apply)`
  );
}

main();
