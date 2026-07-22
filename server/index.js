require("dotenv").config({ quiet: true });
const express = require("express");
const cookieParser = require("cookie-parser");
const path = require("path");
const { loadProblems } = require("./data");
const { TfIdfIndex } = require("./search/tfidf");
const { Bm25Index } = require("./search/bm25");
const { GrpcSearchIndex, probe } = require("./search/grpc_index");
const { tryCreateDenseIndex } = require("./search/dense");
const { HybridIndex } = require("./search/hybrid");
const { createSearchRouter } = require("./routes/search");
const { createDebugRouter } = require("./routes/debug");
const { createAuthRouter } = require("./routes/auth");
const { createUserStateRouter } = require("./routes/user_state");
const { attachUser } = require("./auth/middleware");

const app = express();
const PORT = process.env.PORT || 3000;

async function main() {
  const problems = loadProblems();
  const indexes = {
    tfidf: new TfIdfIndex(problems),
    bm25: new Bm25Index(problems),
  };

  const grpcAddr = process.env.GRPC_BM25_ADDR;
  if (grpcAddr) {
    const reachable = await probe(grpcAddr);
    if (reachable) {
      indexes["bm25-grpc"] = new GrpcSearchIndex({ address: grpcAddr, name: "bm25-grpc" });
      console.log(`gRPC bm25-grpc ranker reachable at ${grpcAddr} — registered`);
    } else {
      console.warn(`gRPC bm25-grpc at ${grpcAddr} unreachable on boot — skipping registration. Start the Go service (go/algolens_server) and restart Node, or omit GRPC_BM25_ADDR to silence this.`);
    }
  }

  // Dense + hybrid register only when the committed embeddings artifact is
  // present and fresh and the ONNX model loads — same graceful-degradation
  // pattern as the gRPC ranker. (RANKER=dense|hybrid without the artifact
  // falls back to bm25 via the unknown-RANKER warning below.)
  if (process.env.DENSE_DISABLED !== "1") {
    const dense = await tryCreateDenseIndex(problems);
    if (dense) {
      indexes.dense = dense;
      indexes.hybrid = new HybridIndex({ lexical: indexes.bm25, dense });
      const s = dense.stats();
      console.log(`dense ranker ready (${s.model}, ${s.dims}d, ${s.dtype}, ${s.count} vectors) — registered dense + hybrid`);
    }
  }

  const defaultRanker = (process.env.RANKER || "bm25").toLowerCase();
  if (!indexes[defaultRanker]) {
    console.warn(`unknown RANKER='${defaultRanker}', falling back to bm25`);
  }
  const activeDefault = indexes[defaultRanker] ? defaultRanker : "bm25";
  console.log(`Loaded ${problems.length} problems; rankers: ${Object.keys(indexes).join(", ")}; default: ${activeDefault}`);

  const webDir = path.join(__dirname, "..", "web");
  app.use(express.json({ limit: "32kb" }));
  app.use(cookieParser());
  app.use(attachUser);
  app.use(express.static(webDir));
  app.use("/api", createAuthRouter());
  app.use("/api", createUserStateRouter({ problems }));
  app.use("/api", createSearchRouter({ indexes, defaultRanker: activeDefault, problems }));
  app.use("/api", createDebugRouter({ problems, indexes, defaultRanker: activeDefault }));

  app.listen(PORT, () => {
    console.log(`AlgoLens listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error("startup failed:", err);
  process.exit(1);
});
