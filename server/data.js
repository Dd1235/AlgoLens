const fs = require("fs");
const path = require("path");

const CORPUS_ROOT = path.join(__dirname, "..", "data", "problemset_llm");
const DEFAULT_PLATFORMS = ["leetcode", "cses"];

function loadProblems({ platforms = DEFAULT_PLATFORMS, root = CORPUS_ROOT } = {}) {
  const problems = [];
  for (const platform of platforms) {
    const dir = path.join(root, platform);
    if (!fs.existsSync(dir)) {
      console.warn(`corpus dir missing, skipping: ${dir}`);
      continue;
    }
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    for (const file of files) {
      const raw = fs.readFileSync(path.join(dir, file), "utf8");
      problems.push(JSON.parse(raw));
    }
  }
  return problems;
}

module.exports = { loadProblems, CORPUS_ROOT, DEFAULT_PLATFORMS };
