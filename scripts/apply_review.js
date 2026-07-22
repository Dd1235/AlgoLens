#!/usr/bin/env node
// Merge HUMAN-reviewed audit candidates from data/review_queue/ into the
// corpus. Convention: the reviewer edits each queue file and DELETES the
// candidates they reject (or deletes the whole file); whatever remains in
// `candidates` when --write runs is accepted.
//
//   node scripts/apply_review.js           dry run: print the merge plan
//   node scripts/apply_review.js --write   apply + delete consumed queue files
//
// After --write the corpus text has changed: run `npm run embed` then
// `npm run validate` and commit corpus + embeddings + queue deletions together.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const QUEUE_DIR = path.join(ROOT, "data", "review_queue");
const CORPUS_ROOT = path.join(ROOT, "data", "problemset_llm");
const MAX_LABELS = 12;

const TAXONOMY = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "pattern_taxonomy.json"), "utf8"));
const CANONICAL = new Set(Object.keys(TAXONOMY.canonical));
const ALIASES = TAXONOMY.aliases || {};
const fold = (label) => ALIASES[label] || label;

function main() {
  const write = process.argv.includes("--write");
  if (!fs.existsSync(QUEUE_DIR)) {
    console.log("no review queue at data/review_queue/ — run scripts/audit_patterns.py first");
    return;
  }
  const files = fs.readdirSync(QUEUE_DIR).filter((f) => f.endsWith(".json")).sort();
  if (!files.length) {
    console.log("review queue is empty");
    return;
  }

  let merged = 0;
  let filesChanged = 0;
  for (const file of files) {
    const queuePath = path.join(QUEUE_DIR, file);
    const review = JSON.parse(fs.readFileSync(queuePath, "utf8"));
    const platform = review.id.split("-")[0];
    const problemPath = path.join(CORPUS_ROOT, platform, `${review.id}.json`);
    if (!fs.existsSync(problemPath)) {
      console.error(`error: ${review.id}: corpus file missing — keeping queue entry`);
      continue;
    }
    const problem = JSON.parse(fs.readFileSync(problemPath, "utf8"));
    const existing = new Set((problem.patterns || []).map(fold));

    let changed = false;
    for (const c of review.candidates || []) {
      const pattern = fold(String(c.pattern || ""));
      if (!pattern || existing.has(pattern)) continue;
      if ((problem.patterns || []).length >= MAX_LABELS) {
        console.log(`warn: ${review.id}: pattern cap ${MAX_LABELS} reached — skipped ${pattern} (trim its patterns or the queue file)`);
        continue;
      }
      if (!CANONICAL.has(pattern)) {
        console.log(`warn: ${review.id}: ${pattern} not in taxonomy — merging anyway, will count as drift`);
      }
      console.log(`${review.id}: + ${pattern} (${(+c.confidence || 0).toFixed(2)})`);
      problem.patterns.push(pattern);
      problem.annotation = problem.annotation || {};
      problem.annotation.pattern_confidence = problem.annotation.pattern_confidence || {};
      problem.annotation.pattern_confidence[pattern] = +(+c.confidence || 0).toFixed(2);
      existing.add(pattern);
      merged += 1;
      changed = true;
    }

    if (write) {
      if (changed) {
        fs.writeFileSync(problemPath, JSON.stringify(problem, null, 2) + "\n");
        filesChanged += 1;
      }
      fs.unlinkSync(queuePath); // consumed (incl. empty/no-candidate reviews)
    }
  }

  if (write) {
    console.log(`applied ${merged} label(s) across ${filesChanged} file(s); consumed ${files.length} queue file(s)`);
    if (merged) console.log("corpus text changed — run: npm run embed && npm run validate");
  } else {
    console.log(`dry run: would apply ${merged} label(s) from ${files.length} queue file(s) (pass --write)`);
  }
}

main();
