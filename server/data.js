const fs = require("fs");
const path = require("path");

const PROBLEMS_PATH = path.join(__dirname, "..", "data", "problems.json");

function loadProblems() {
  const raw = fs.readFileSync(PROBLEMS_PATH, "utf8");
  return JSON.parse(raw);
}

module.exports = { loadProblems };
