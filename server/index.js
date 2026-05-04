const express = require("express");
const path = require("path");
const { loadProblems } = require("./data");
const { createSearchRouter } = require("./routes/search");

const app = express();
const PORT = process.env.PORT || 3000;

const problems = loadProblems();
console.log(`Loaded ${problems.length} problems`);

const webDir = path.join(__dirname, "..", "web");
app.use(express.static(webDir));
app.use("/api", createSearchRouter(problems));

app.listen(PORT, () => {
  console.log(`AlgoLens listening on http://localhost:${PORT}`);
});
