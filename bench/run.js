const fs = require("fs");
const path = require("path");
const { loadProblems } = require("../server/data");
const { TfIdfIndex } = require("../server/search/tfidf");
const { Bm25Index } = require("../server/search/bm25");

const QUERIES_PATH = path.join(__dirname, "queries.json");
const RESULTS_DIR = path.join(__dirname, "..", "experiments");
const K_FOR_PRECISION = 5;
const K_FOR_NDCG = 10;
const LATENCY_REPEATS = 50; // re-run each query to get a stable distribution

function precisionAtK(hits, relevant, k) {
  const top = hits.slice(0, k).map((h) => h.problem.id);
  const rel = new Set(relevant);
  const matched = top.filter((id) => rel.has(id)).length;
  return matched / k;
}

function reciprocalRank(hits, relevant) {
  const rel = new Set(relevant);
  for (let i = 0; i < hits.length; i++) {
    if (rel.has(hits[i].problem.id)) return 1 / (i + 1);
  }
  return 0;
}

// Binary-relevance nDCG: gain is 1 for relevant, 0 otherwise.
function ndcgAtK(hits, relevant, k) {
  const rel = new Set(relevant);
  let dcg = 0;
  for (let i = 0; i < Math.min(k, hits.length); i++) {
    if (rel.has(hits[i].problem.id)) dcg += 1 / Math.log2(i + 2);
  }
  // ideal: relevant docs packed at the top, capped at k and at |relevant|.
  let idcg = 0;
  for (let i = 0; i < Math.min(k, relevant.length); i++) {
    idcg += 1 / Math.log2(i + 2);
  }
  return idcg === 0 ? 0 : dcg / idcg;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function summarize(latencies) {
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    median_ms: +percentile(sorted, 50).toFixed(3),
    p95_ms: +percentile(sorted, 95).toFixed(3),
    mean_ms: +(sorted.reduce((s, x) => s + x, 0) / sorted.length).toFixed(3),
  };
}

function evalRanker(name, index, queries) {
  const perQuery = [];
  const allLatencies = [];
  let sumP1 = 0, sumP5 = 0, sumMRR = 0, sumNDCG = 0;

  for (const { query, relevant } of queries) {
    // first run for correctness; then re-run for latency
    const hits = index.search(query, Math.max(K_FOR_NDCG, K_FOR_PRECISION));
    const latencies = [];
    for (let i = 0; i < LATENCY_REPEATS; i++) {
      const t = process.hrtime.bigint();
      index.search(query, K_FOR_NDCG);
      latencies.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    allLatencies.push(...latencies);

    const p1 = precisionAtK(hits, relevant, 1);
    const p5 = precisionAtK(hits, relevant, K_FOR_PRECISION);
    const rr = reciprocalRank(hits, relevant);
    const ndcg = ndcgAtK(hits, relevant, K_FOR_NDCG);

    sumP1 += p1; sumP5 += p5; sumMRR += rr; sumNDCG += ndcg;
    perQuery.push({
      query,
      relevant,
      top5: hits.slice(0, 5).map((h) => ({ id: h.problem.id, score: +h.score.toFixed(4) })),
      "P@1": +p1.toFixed(3),
      "P@5": +p5.toFixed(3),
      RR: +rr.toFixed(3),
      "nDCG@10": +ndcg.toFixed(3),
      latency: summarize(latencies),
    });
  }

  const n = queries.length;
  return {
    ranker: name,
    queryCount: n,
    aggregate: {
      "P@1": +(sumP1 / n).toFixed(3),
      "P@5": +(sumP5 / n).toFixed(3),
      MRR: +(sumMRR / n).toFixed(3),
      "nDCG@10": +(sumNDCG / n).toFixed(3),
    },
    latency: summarize(allLatencies),
    perQuery,
  };
}

function pad(s, n) { return String(s).padEnd(n); }

function printTable(results) {
  console.log();
  console.log(pad("ranker", 10), pad("P@1", 8), pad("P@5", 8), pad("MRR", 8), pad("nDCG@10", 10), pad("p50_ms", 10), pad("p95_ms", 10));
  console.log("-".repeat(64));
  for (const r of results) {
    console.log(
      pad(r.ranker, 10),
      pad(r.aggregate["P@1"].toFixed(3), 8),
      pad(r.aggregate["P@5"].toFixed(3), 8),
      pad(r.aggregate.MRR.toFixed(3), 8),
      pad(r.aggregate["nDCG@10"].toFixed(3), 10),
      pad(r.latency.median_ms.toFixed(3), 10),
      pad(r.latency.p95_ms.toFixed(3), 10),
    );
  }
}

function main() {
  const queriesData = JSON.parse(fs.readFileSync(QUERIES_PATH, "utf8"));
  const queries = queriesData.queries;

  const t0 = Date.now();
  const problems = loadProblems();
  const loadMs = Date.now() - t0;

  const tBuildTf = Date.now();
  const tfidf = new TfIdfIndex(problems);
  const tBuildTfMs = Date.now() - tBuildTf;

  const tBuildBm = Date.now();
  const bm25 = new Bm25Index(problems);
  const tBuildBmMs = Date.now() - tBuildBm;

  console.log(`corpus: ${problems.length} docs, load ${loadMs}ms`);
  console.log(`build:  tfidf ${tBuildTfMs}ms, bm25 ${tBuildBmMs}ms`);
  console.log(`queries: ${queries.length} (each repeated ${LATENCY_REPEATS}x for latency)`);

  const results = [
    evalRanker("tfidf", tfidf, queries),
    evalRanker("bm25", bm25, queries),
  ];

  printTable(results);

  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(RESULTS_DIR, `bench-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    corpus: { docs: problems.length, loadMs, build: { tfidf: tBuildTfMs, bm25: tBuildBmMs } },
    queriesFile: path.relative(path.join(__dirname, ".."), QUERIES_PATH),
    queryCount: queries.length,
    latencyRepeats: LATENCY_REPEATS,
    results,
  }, null, 2));
  const latestPath = path.join(RESULTS_DIR, "bench-latest.json");
  fs.writeFileSync(latestPath, fs.readFileSync(outPath));
  console.log();
  console.log(`wrote ${path.relative(process.cwd(), outPath)}`);
  console.log(`wrote ${path.relative(process.cwd(), latestPath)}`);
}

if (require.main === module) main();

module.exports = { evalRanker, precisionAtK, reciprocalRank, ndcgAtK, summarize };
