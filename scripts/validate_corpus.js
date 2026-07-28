#!/usr/bin/env node
// Validate the served corpus, the pattern vocabulary, the bench query labels,
// and the committed embeddings artifact — the checks that used to be tribal
// knowledge ("did you re-run npm run embed?") as one gate.
//
//   npm run validate            errors fail, warnings report
//   npm run validate -- --strict   warnings fail too
//
// Hard errors are structural (schema, duplicate ids, stale artifact) and exit 1.
// Warnings are vocabulary drift (non-canonical or alias pattern labels) — the
// pattern list is deliberately open, canonical is preferred, so drift reports
// rather than blocks unless --strict.

const fs = require("fs");
const path = require("path");
const { CORPUS_ROOT, DEFAULT_PLATFORMS } = require("../server/data");
const {
  MODEL_ID,
  DTYPE,
  DIMS,
  corpusHash,
  loadArtifact,
} = require("../server/search/embedding");

const ROOT = path.join(__dirname, "..");
const TAXONOMY_PATH = path.join(ROOT, "data", "pattern_taxonomy.json");
const QUERIES_PATH = path.join(ROOT, "bench", "queries.json");

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DIFFICULTIES = new Set(["Easy", "Medium", "Hard"]);
const RATED_PLATFORMS = new Set(["codeforces", "atcoder"]);
// Hard-focus corpus: LeetCode Easies are not ingested. These four are the
// deliberate exceptions — they ground 6 bench queries (two-sum, climbing
// stairs, valid parentheses = the exp-05 paraphrase demo, binary search) and
// the experiment write-ups depend on them staying in the corpus.
const ANCHOR_EASIES = new Set([
  "leetcode-two-sum",
  "leetcode-climbing-stairs",
  "leetcode-valid-parentheses",
  "leetcode-binary-search",
]);
const SLICES = new Set(["keyword", "paraphrase", "technique", "title"]);
const MAX_LABELS = 12;
const MAX_STATEMENT_CHARS = 600;

const errors = [];
const warnings = [];
const err = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);

function loadTaxonomy() {
  const data = JSON.parse(fs.readFileSync(TAXONOMY_PATH, "utf8"));
  const canonical = new Set(Object.keys(data.canonical || {}));
  const aliases = data.aliases || {};
  for (const [alias, target] of Object.entries(aliases)) {
    if (!canonical.has(target)) err(`taxonomy: alias "${alias}" -> "${target}" is not canonical`);
    if (canonical.has(alias)) err(`taxonomy: "${alias}" is both an alias and canonical`);
  }
  return { canonical, aliases };
}

// Mirrors loadProblems() (same platform order, same per-dir sort) but keeps
// filenames so problems can be reported per-file and corpusHash sees the exact
// boot-time order.
function walkCorpus() {
  const out = [];
  for (const platform of DEFAULT_PLATFORMS) {
    const dir = path.join(CORPUS_ROOT, platform);
    if (!fs.existsSync(dir)) {
      err(`corpus dir missing: ${dir}`);
      continue;
    }
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    for (const file of files) {
      const rel = path.join("data", "problemset_llm", platform, file);
      try {
        const problem = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
        out.push({ rel, platform, basename: file.replace(/\.json$/, ""), problem });
      } catch (e) {
        err(`${rel}: invalid JSON (${e.message})`);
      }
    }
  }
  return out;
}

function checkProblem({ rel, platform, basename, problem }, taxonomy, driftCounts) {
  for (const field of ["id", "title", "slug", "platform", "source_url", "statement"]) {
    if (typeof problem[field] !== "string" || !problem[field].trim()) {
      err(`${rel}: missing/empty required field "${field}"`);
    }
  }
  if (problem.platform !== platform) err(`${rel}: platform "${problem.platform}" but lives in ${platform}/`);
  if (problem.id !== basename) err(`${rel}: id "${problem.id}" != filename`);
  if (typeof problem.id === "string" && !problem.id.startsWith(`${platform}-`)) {
    err(`${rel}: id does not start with "${platform}-"`);
  }
  if (platform === "leetcode" && !DIFFICULTIES.has(problem.difficulty)) {
    err(`${rel}: leetcode difficulty "${problem.difficulty}" not in Easy/Medium/Hard`);
  }
  if (platform === "leetcode" && problem.difficulty === "Easy" && !ANCHOR_EASIES.has(problem.id)) {
    warn(`${rel}: non-anchor Easy in a hard-focus corpus (anchors: ${[...ANCHOR_EASIES].join(", ")})`);
  }
  // Codeforces and AtCoder carry a numeric rating instead of a named tier; the
  // UI bands it for colour, so a stringified "1500" would silently render grey.
  if (RATED_PLATFORMS.has(platform) && problem.difficulty != null
      && typeof problem.difficulty !== "number") {
    err(`${rel}: ${platform} difficulty must be a number, got ${typeof problem.difficulty}`);
  }
  if (typeof problem.slug === "string" && !SLUG_RE.test(problem.slug)) {
    err(`${rel}: slug "${problem.slug}" is not slug-shaped`);
  }
  if (!problem.annotation || typeof problem.annotation.version !== "string") {
    err(`${rel}: missing annotation.version`);
  }

  for (const field of ["tags", "patterns"]) {
    const list = problem[field];
    if (!Array.isArray(list)) {
      err(`${rel}: "${field}" is not an array`);
      continue;
    }
    if (list.length > MAX_LABELS) err(`${rel}: ${field} has ${list.length} entries (max ${MAX_LABELS})`);
    if (new Set(list).size !== list.length) err(`${rel}: duplicate entries in ${field}`);
    for (const label of list) {
      if (typeof label !== "string" || !SLUG_RE.test(label)) {
        err(`${rel}: ${field} entry "${label}" is not slug-shaped`);
      } else if (taxonomy.aliases[label]) {
        driftCounts.alias.set(label, (driftCounts.alias.get(label) || 0) + 1);
      } else if (field === "patterns" && !taxonomy.canonical.has(label)) {
        const entry = driftCounts.unknown.get(label) || { count: 0, confSum: 0, samples: [] };
        entry.count += 1;
        entry.confSum += ((problem.annotation || {}).pattern_confidence || {})[label] || 0;
        if (entry.samples.length < 3) entry.samples.push(problem.id);
        driftCounts.unknown.set(label, entry);
      }
    }
  }

  const conf = (problem.annotation || {}).pattern_confidence || {};
  const patternSet = new Set(problem.patterns || []);
  const strays = Object.keys(conf).filter((k) => !patternSet.has(k));
  if (strays.length) warn(`${rel}: pattern_confidence keys not in patterns: ${strays.join(", ")}`);
  if (typeof problem.statement === "string" && problem.statement.length > MAX_STATEMENT_CHARS) {
    warn(`${rel}: statement is ${problem.statement.length} chars (> ${MAX_STATEMENT_CHARS}; should be a short summary)`);
  }
  if (!problem.source_topic) warn(`${rel}: missing source_topic`);
}

function checkCrossFile(entries) {
  const byId = new Map();
  const bySlug = new Map();
  for (const { rel, problem } of entries) {
    if (byId.has(problem.id)) err(`duplicate id "${problem.id}": ${byId.get(problem.id)} and ${rel}`);
    byId.set(problem.id, rel);
    const key = `${problem.platform}/${problem.slug}`;
    if (bySlug.has(key)) err(`duplicate slug "${key}": ${bySlug.get(key)} and ${rel}`);
    bySlug.set(key, rel);
  }
  return byId;
}

function checkBenchQueries(idSet) {
  const data = JSON.parse(fs.readFileSync(QUERIES_PATH, "utf8"));
  if (!Number.isInteger(data.version)) err(`bench/queries.json: version is not an integer`);
  const queries = data.queries || [];
  for (const q of queries) {
    if (typeof q.query !== "string" || !q.query.trim()) {
      err(`bench/queries.json: query with missing text`);
      continue;
    }
    if (!Array.isArray(q.relevant) || q.relevant.length === 0) {
      err(`bench/queries.json "${q.query}": empty relevant list`);
      continue;
    }
    for (const id of q.relevant) {
      if (!idSet.has(id)) err(`bench/queries.json "${q.query}": relevant id "${id}" not in served corpus`);
    }
    if (q.slice !== undefined && !SLICES.has(q.slice)) {
      err(`bench/queries.json "${q.query}": unknown slice "${q.slice}"`);
    }
  }
  return queries.length;
}

// The staleness class of bug this catches: edit any problem JSON, forget
// `npm run embed`, and dense/hybrid silently vanish at next boot.
function checkArtifact(problems) {
  const artifact = loadArtifact();
  if (!artifact) {
    err(`embeddings artifact missing under data/embeddings/ — run \`npm run embed\``);
    return;
  }
  const { manifest, matrix } = artifact;
  if (manifest.model !== MODEL_ID || manifest.dtype !== DTYPE || manifest.dims !== DIMS) {
    err(`embeddings manifest model/dtype/dims (${manifest.model}/${manifest.dtype}/${manifest.dims}) != pinned (${MODEL_ID}/${DTYPE}/${DIMS})`);
  }
  if (manifest.count !== problems.length) {
    err(`embeddings count ${manifest.count} != corpus size ${problems.length} — run \`npm run embed\``);
  }
  if (manifest.count * DIMS !== matrix.length) {
    err(`embeddings matrix length ${matrix.length} != count*dims ${manifest.count * DIMS}`);
  }
  const corpusIds = new Set(problems.map((p) => p.id));
  const manifestIds = new Set(manifest.ids || []);
  if (corpusIds.size !== manifestIds.size || [...corpusIds].some((id) => !manifestIds.has(id))) {
    err(`embeddings manifest ids != corpus ids — run \`npm run embed\``);
  }
  if (manifest.corpusHash !== corpusHash(problems)) {
    err(`embeddings corpusHash is stale (corpus text changed) — run \`npm run embed\``);
  }
}

function reportDrift(driftCounts) {
  const fmt = (map) =>
    [...map.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} (${n})`);
  if (driftCounts.alias.size) {
    warn(
      `alias labels present in ${driftCounts.alias.size} form(s) — run \`node scripts/normalize_patterns.js --write\`: ` +
        fmt(driftCounts.alias).join(", ")
    );
  }
  if (driftCounts.unknown.size) {
    const all = [...driftCounts.unknown.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([k, e]) => `${k} (${e.count})`);
    const head = all.slice(0, 15).join(", ");
    warn(
      `${driftCounts.unknown.size} non-canonical pattern label(s) (open vocabulary, canonical preferred): ` +
        head + (all.length > 15 ? `, … +${all.length - 15} more` : "")
    );
  }
}

// --gaps: the promotion path for the open vocabulary — non-canonical labels
// ranked by usage and the LLM's own confidence, so recurring high-confidence
// drift surfaces as a canonical-taxonomy candidate instead of noise.
function printGaps(driftCounts) {
  const rows = [...driftCounts.unknown.entries()]
    .map(([pattern, e]) => ({ pattern, count: e.count, meanConf: e.confSum / e.count, samples: e.samples }))
    .sort((a, b) => b.count - a.count || b.meanConf - a.meanConf);
  console.log(`\n${rows.length} non-canonical pattern label(s) — taxonomy candidates first:`);
  console.log("pattern".padEnd(38) + "docs".padStart(5) + "  conf" + "  samples");
  for (const r of rows.slice(0, 40)) {
    console.log(
      r.pattern.padEnd(38) + String(r.count).padStart(5) + "  " + r.meanConf.toFixed(2) + "  " + r.samples.join(", ")
    );
  }
  if (rows.length > 40) console.log(`… +${rows.length - 40} more`);
}

function main() {
  const strict = process.argv.includes("--strict");
  const taxonomy = loadTaxonomy();
  const entries = walkCorpus();
  const driftCounts = { alias: new Map(), unknown: new Map() };

  for (const entry of entries) checkProblem(entry, taxonomy, driftCounts);
  const byId = checkCrossFile(entries);
  const queryCount = checkBenchQueries(new Set(byId.keys()));
  checkArtifact(entries.map((e) => e.problem));
  reportDrift(driftCounts);
  if (process.argv.includes("--gaps")) printGaps(driftCounts);

  // Staged-but-unserved platforms. This used to name codeforces unconditionally,
  // from back when it wasn't in DEFAULT_PLATFORMS — so it kept reporting 1,083
  // files as unreachable while the search page was happily serving them.
  const unserved = fs
    .readdirSync(CORPUS_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !DEFAULT_PLATFORMS.includes(e.name));
  for (const dir of unserved) {
    const n = fs.readdirSync(path.join(CORPUS_ROOT, dir.name)).length;
    console.log(`note: ${n} ${dir.name} file(s) on disk are not served (DEFAULT_PLATFORMS)`);
  }

  for (const w of warnings) console.log(`warn: ${w}`);
  for (const e of errors) console.error(`error: ${e}`);
  const summary = `${entries.length} problems, ${queryCount} bench queries, ${errors.length} error(s), ${warnings.length} warning(s)`;
  if (errors.length || (strict && warnings.length)) {
    console.error(`FAIL ${summary}`);
    process.exit(1);
  }
  console.log(`OK ${summary}`);
}

main();
