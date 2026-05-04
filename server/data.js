const fs = require("fs");
const path = require("path");

const PROBLEMS_DIR = path.join(__dirname, "..", "data", "problems");

function loadProblems() {
  const files = fs
    .readdirSync(PROBLEMS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();

  return files.map((file) => {
    const raw = fs.readFileSync(path.join(PROBLEMS_DIR, file), "utf8");
    return JSON.parse(raw);
  });
}

module.exports = { loadProblems, PROBLEMS_DIR };
