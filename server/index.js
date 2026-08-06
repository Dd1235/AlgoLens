require("dotenv").config({ quiet: true });
const BOOT_START = Date.now();
const express = require("express");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const path = require("path");
const { logEvent } = require("./telemetry");
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
const { createProfileRouter } = require("./routes/profile");
const { createStatsRouter } = require("./routes/stats");
const { createTrackRouter } = require("./routes/track");
const { attachUser } = require("./auth/middleware");
const secrets = require("./crypto/secrets");

const app = express();
const PORT = process.env.PORT || 3000;

async function main() {
  // Die here, not on the first user who saves a handle. Without the key the
  // profile route would happily write plaintext handles and nobody would find
  // out until they looked in the database.
  secrets.assertKeyPresent();

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
      // Hybrid is no longer served. Users found it confusing for a reason that
      // is inherent, not a bug: its dense leg gives every document some cosine
      // similarity, so a nonsense query still came back with 100 confident
      // results. Its click-through was also the worst of the three (0.02
      // against bm25's 0.10 and dense's 0.12).
      //
      // The class is deliberately still here and still tested — bench/run.js
      // builds its own, and routes/search.test.js uses it for the regression
      // test on the fused-set pagination bug. This is a serving decision.
      void HybridIndex;
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
  // Render terminates TLS at its proxy; trust it so req.hostname/req.protocol
  // reflect the real client request.
  app.set("trust proxy", 1);

  // One canonical host, so a session started on www isn't invisible on the
  // apex (cookies are host-only). Only redirects *within* the canonical
  // domain — the .onrender.com hostname is left alone so old links and
  // Render's health check keep working. Unset CANONICAL_HOST = no redirects.
  const canonicalHost = (process.env.CANONICAL_HOST || "").toLowerCase();
  if (canonicalHost) {
    app.use((req, res, next) => {
      const host = (req.hostname || "").toLowerCase();
      if (host !== canonicalHost && host.endsWith(`.${canonicalHost}`)) {
        return res.redirect(301, `https://${canonicalHost}${req.originalUrl}`);
      }
      next();
    });
  }

  app.use(express.json({ limit: "32kb" }));
  app.use(cookieParser());
  app.use(attachUser);
  // Anonymous visitor id (random cookie, no IP/UA stored) + page-view events.
  app.use((req, res, next) => {
    let visitor = req.cookies.algolens_visitor;
    if (!visitor) {
      visitor = crypto.randomUUID();
      res.cookie("algolens_visitor", visitor, {
        httpOnly: true,
        sameSite: "lax",
        maxAge: 365 * 24 * 60 * 60 * 1000,
      });
    }
    req.visitor = visitor;
    if (req.method === "GET" && (req.path === "/" || req.path.endsWith(".html"))) {
      logEvent("visit", { visitor, userId: req.user?.id, props: { path: req.path } });
    }
    next();
  });
  app.use(express.static(webDir));
  app.use("/api", createAuthRouter());
  app.use("/api", createUserStateRouter({ problems }));
  app.use("/api", createProfileRouter({ problems }));
  app.use("/api", createStatsRouter());
  app.use("/api", createTrackRouter());
  app.use("/api", createSearchRouter({ indexes, defaultRanker: activeDefault, problems }));
  app.use("/api", createDebugRouter({ problems, indexes, defaultRanker: activeDefault }));

  // Nothing matched. Until now that fell off the end of the stack and Express
  // answered "Cannot GET /prfoile.html" in Times New Roman — no way back to the
  // site, and no way to tell whether anyone was hitting it.
  //
  // AFTER express.static and every router, deliberately: a catch-all mounted
  // any earlier would swallow real pages. The status stays 404 in all three
  // branches, because a soft 200 tells a crawler the page exists.
  app.use((req, res) => {
    logEvent("not_found", { visitor: req.visitor, userId: req.user?.id, props: { path: req.path } });
    if (req.path.startsWith("/api/")) return res.status(404).json({ error: "not_found" });
    // `req.accepts` rather than a method check: a fetch() for JSON that 404s
    // should not be handed a page, and a browser navigation should not be
    // handed "not found" as plain text.
    if (req.method === "GET" && req.accepts("html")) {
      return res.status(404).sendFile(path.join(webDir, "404.html"));
    }
    res.status(404).type("text").send("not found\n");
  });

  app.listen(PORT, () => {
    console.log(`AlgoLens listening on http://localhost:${PORT}`);
    // On the free tier every idle spin-down means a fresh boot — counting
    // these on the stats page explains cold-start latency honestly.
    logEvent("boot", {
      props: { bootMs: Date.now() - BOOT_START, rankers: Object.keys(indexes), problems: problems.length },
    });
  });
}

main().catch((err) => {
  console.error("startup failed:", err);
  process.exit(1);
});
