const express = require("express");
const path = require("path");
const { loadProblems } = require("./data");
const { TfIdfIndex } = require("./search/tfidf");
const { Bm25Index } = require("./search/bm25");
const { createSearchRouter } = require("./routes/search");
const { createDebugRouter } = require("./routes/debug");

const app = express();
const PORT = process.env.PORT || 3000;

const problems = loadProblems();
const indexes = {
  tfidf: new TfIdfIndex(problems),
  bm25: new Bm25Index(problems),
};
const defaultRanker = (process.env.RANKER || "tfidf").toLowerCase();
if (!indexes[defaultRanker]) {
  console.warn(`unknown RANKER='${defaultRanker}', falling back to tfidf`);
}
const activeDefault = indexes[defaultRanker] ? defaultRanker : "tfidf";
console.log(`Loaded ${problems.length} problems; rankers: ${Object.keys(indexes).join(", ")}; default: ${activeDefault}`);

const webDir = path.join(__dirname, "..", "web");
app.use(express.static(webDir));
app.use("/api", createSearchRouter({ indexes, defaultRanker: activeDefault }));
app.use("/api", createDebugRouter({ problems, indexes, defaultRanker: activeDefault }));

app.listen(PORT, () => {
  console.log(`AlgoLens listening on http://localhost:${PORT}`);
});
