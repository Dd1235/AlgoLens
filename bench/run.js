const fs = require("fs");
const path = require("path");
const { loadProblems } = require("../server/data");
const { TfIdfIndex } = require("../server/search/tfidf");
const { Bm25Index } = require("../server/search/bm25");
const { GrpcSearchIndex, probe } = require("../server/search/grpc_index");
const { tryCreateDenseIndex } = require("../server/search/dense");
const { HybridIndex } = require("../server/search/hybrid");
const { expandQuery } = require("../server/search/query_expand");

// The serving path expands alias queries at the route ("aliens trick" →
// +wqs binary search), so the bench does too by default — it measures the
// pipeline users hit. BENCH_EXPAND=0 gives the raw-ranker measurement for A/Bs.
const BENCH_EXPAND = process.env.BENCH_EXPAND !== "0";

const QUERIES_PATH = path.join(__dirname, "queries.json");
const RESULTS_DIR = path.join(__dirname, "..", "experiments");
const K_FOR_PRECISION = 5;
const K_FOR_NDCG = 10;
// Recall at the hybrid ranker's fusion window: ≈1.0 here is the empirical
// justification for fusing only each leg's top-100.
const K_FOR_RECALL = 100;
// re-run each query to get a stable distribution; env-tunable because dense
// embeds the query on every repeat (LATENCY_REPEATS=5 for quick iterations)
const LATENCY_REPEATS = Number(process.env.LATENCY_REPEATS || 50);

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

function recallAtK(hits, relevant, k) {
  const top = new Set(hits.slice(0, k).map((h) => h.problem.id));
  const found = relevant.filter((id) => top.has(id)).length;
  return relevant.length === 0 ? 0 : found / relevant.length;
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

async function evalRanker(name, index, queries) {
  const perQuery = [];
  const allLatencies = [];
  const allScoring = [];
  // overall sums plus per-slice sums (slice = "keyword" | "paraphrase")
  const newSums = () => ({ n: 0, p1: 0, p5: 0, mrr: 0, ndcg: 0, recall: 0 });
  const overall = newSums();
  const bySlice = new Map();

  for (const { query, relevant, slice = "keyword" } of queries) {
    const searchQuery = BENCH_EXPAND ? expandQuery(query).query : query;
    // first run for correctness (k=100 so Recall@100 is measurable);
    // then re-run at serving size for latency
    const result = await Promise.resolve(index.search(searchQuery, K_FOR_RECALL));
    const hits = Array.isArray(result) ? result : result.hits;
    const latencies = [];
    const scoring = [];
    for (let i = 0; i < LATENCY_REPEATS; i++) {
      const t = process.hrtime.bigint();
      await Promise.resolve(index.search(searchQuery, K_FOR_NDCG));
      latencies.push(Number(process.hrtime.bigint() - t) / 1e6);
      // gRPC client exposes lastScoringLatencyMs from the server's perspective
      if (typeof index.lastScoringLatencyMs === "number") {
        scoring.push(index.lastScoringLatencyMs);
      }
    }
    allLatencies.push(...latencies);
    allScoring.push(...scoring);

    const p1 = precisionAtK(hits, relevant, 1);
    const p5 = precisionAtK(hits, relevant, K_FOR_PRECISION);
    const rr = reciprocalRank(hits, relevant);
    const ndcg = ndcgAtK(hits, relevant, K_FOR_NDCG);
    const recall = recallAtK(hits, relevant, K_FOR_RECALL);

    if (!bySlice.has(slice)) bySlice.set(slice, newSums());
    for (const sums of [overall, bySlice.get(slice)]) {
      sums.n += 1;
      sums.p1 += p1; sums.p5 += p5; sums.mrr += rr; sums.ndcg += ndcg; sums.recall += recall;
    }

    perQuery.push({
      query,
      slice,
      relevant,
      top5: hits.slice(0, 5).map((h) => ({ id: h.problem.id, score: +h.score.toFixed(4) })),
      "P@1": +p1.toFixed(3),
      "P@5": +p5.toFixed(3),
      RR: +rr.toFixed(3),
      "nDCG@10": +ndcg.toFixed(3),
      "Recall@100": +recall.toFixed(3),
      latency: summarize(latencies),
      ...(scoring.length > 0 ? { serverScoringLatency: summarize(scoring) } : {}),
    });
  }

  const agg = (s) => ({
    queryCount: s.n,
    "P@1": +(s.p1 / s.n).toFixed(3),
    "P@5": +(s.p5 / s.n).toFixed(3),
    MRR: +(s.mrr / s.n).toFixed(3),
    "nDCG@10": +(s.ndcg / s.n).toFixed(3),
    "Recall@100": +(s.recall / s.n).toFixed(3),
  });
  return {
    ranker: name,
    queryCount: queries.length,
    aggregate: agg(overall),
    bySlice: Object.fromEntries([...bySlice].map(([s, sums]) => [s, agg(sums)])),
    latency: summarize(allLatencies),
    ...(allScoring.length > 0 ? { serverScoringLatency: summarize(allScoring) } : {}),
    perQuery,
  };
}

function pad(s, n) { return String(s).padEnd(n); }

function printTable(results) {
  console.log();
  console.log(pad("ranker", 12), pad("P@1", 8), pad("P@5", 8), pad("MRR", 8), pad("nDCG@10", 10), pad("R@100", 8), pad("p50_ms", 10), pad("p95_ms", 10), pad("p50_score", 11));
  console.log("-".repeat(90));
  for (const r of results) {
    const scoringP50 = r.serverScoringLatency ? r.serverScoringLatency.median_ms.toFixed(3) : "—";
    console.log(
      pad(r.ranker, 12),
      pad(r.aggregate["P@1"].toFixed(3), 8),
      pad(r.aggregate["P@5"].toFixed(3), 8),
      pad(r.aggregate.MRR.toFixed(3), 8),
      pad(r.aggregate["nDCG@10"].toFixed(3), 10),
      pad(r.aggregate["Recall@100"].toFixed(3), 8),
      pad(r.latency.median_ms.toFixed(3), 10),
      pad(r.latency.p95_ms.toFixed(3), 10),
      pad(scoringP50, 11),
    );
  }
}

// ranker × slice breakdown — the headline for dense vs lexical is usually in
// the paraphrase rows.
function printSliceTable(results) {
  const slices = [...new Set(results.flatMap((r) => Object.keys(r.bySlice)))];
  console.log();
  console.log(pad("ranker", 12), pad("slice", 12), pad("n", 4), pad("P@1", 8), pad("P@5", 8), pad("MRR", 8), pad("nDCG@10", 10), pad("R@100", 8));
  console.log("-".repeat(78));
  for (const r of results) {
    for (const s of slices) {
      const a = r.bySlice[s];
      if (!a) continue;
      console.log(
        pad(r.ranker, 12),
        pad(s, 12),
        pad(a.queryCount, 4),
        pad(a["P@1"].toFixed(3), 8),
        pad(a["P@5"].toFixed(3), 8),
        pad(a.MRR.toFixed(3), 8),
        pad(a["nDCG@10"].toFixed(3), 10),
        pad(a["Recall@100"].toFixed(3), 8),
      );
    }
  }
}

async function main() {
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

  const rankers = [
    { name: "tfidf", index: tfidf },
    { name: "bm25", index: bm25 },
  ];

  // dense + hybrid join the bench only when the embeddings artifact is present
  // and fresh — same skip semantics as the server boot.
  const tBuildDense = Date.now();
  const dense = await tryCreateDenseIndex(problems);
  const denseInitMs = dense ? Date.now() - tBuildDense : null;
  if (dense) {
    rankers.push({ name: "dense", index: dense });
    rankers.push({ name: "hybrid", index: new HybridIndex({ lexical: bm25, dense }) });
    console.log(`dense:  model+artifact ready in ${denseInitMs}ms — included dense + hybrid`);
  }

  let grpcIdx = null;
  const grpcAddr = process.env.GRPC_BM25_ADDR;
  if (grpcAddr) {
    const reachable = await probe(grpcAddr);
    if (reachable) {
      grpcIdx = new GrpcSearchIndex({ address: grpcAddr, name: "bm25-grpc" });
      rankers.push({ name: "bm25-grpc", index: grpcIdx });
      console.log(`grpc:   bm25-grpc reachable at ${grpcAddr} — included`);
    } else {
      console.warn(`grpc:   ${grpcAddr} unreachable; skipping bm25-grpc`);
    }
  }

  console.log(`queries: ${queries.length} (each repeated ${LATENCY_REPEATS}x for latency)`);

  const results = [];
  for (const { name, index } of rankers) {
    results.push(await evalRanker(name, index, queries));
  }

  printTable(results);
  printSliceTable(results);

  if (grpcIdx) grpcIdx.close();

  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(RESULTS_DIR, `bench-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    corpus: { docs: problems.length, loadMs, build: { tfidf: tBuildTfMs, bm25: tBuildBmMs, dense: denseInitMs } },
    queriesFile: path.relative(path.join(__dirname, ".."), QUERIES_PATH),
    queriesVersion: queriesData.version,
    expansion: BENCH_EXPAND ? "on" : "off",
    queryCount: queries.length,
    latencyRepeats: LATENCY_REPEATS,
    grpcAddr: grpcIdx ? grpcAddr : null,
    results,
  }, null, 2));
  const latestPath = path.join(RESULTS_DIR, "bench-latest.json");
  fs.writeFileSync(latestPath, fs.readFileSync(outPath));
  console.log();
  console.log(`wrote ${path.relative(process.cwd(), outPath)}`);
  console.log(`wrote ${path.relative(process.cwd(), latestPath)}`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { evalRanker, precisionAtK, reciprocalRank, ndcgAtK, summarize };
