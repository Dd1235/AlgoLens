const express = require("express");
const path = require("path");
const { loadProblems } = require("./data");
const { TfIdfIndex } = require("./search/tfidf");
const { createSearchRouter } = require("./routes/search");

const app = express();
const PORT = process.env.PORT || 3000;

const problems = loadProblems();
const index = new TfIdfIndex(problems);
console.log(`Loaded ${problems.length} problems; tf-idf index ready`);

const webDir = path.join(__dirname, "..", "web");
app.use(express.static(webDir));
app.use("/api", createSearchRouter(index));

app.listen(PORT, () => {
  console.log(`AlgoLens listening on http://localhost:${PORT}`);
});
