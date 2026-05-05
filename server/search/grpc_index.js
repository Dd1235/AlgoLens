const path = require("path");
const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");

const PROTO_PATH = path.join(__dirname, "..", "..", "proto", "algolens.proto");

function loadProto() {
  const def = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  return grpc.loadPackageDefinition(def).algolens;
}

// Implements the same SearchIndex contract as TfIdfIndex / Bm25Index.
// All scoring happens server-side; this class is a thin transport.
class GrpcSearchIndex {
  constructor({ address = "127.0.0.1:50051", deadlineMs = 1500, name = "grpc" } = {}) {
    this.address = address;
    this.deadlineMs = deadlineMs;
    this.name = name;
    this.lastLatencyMs = null;
    this.lastScoringLatencyMs = null;

    const proto = loadProto();
    this.client = new proto.Search(address, grpc.credentials.createInsecure());
  }

  // Returns hits in the same shape as the in-memory rankers:
  //   [{ problem: {...}, score, matchedTerms }]
  // The synchronous SearchIndex API is preserved by deasync-style? No — the
  // routes already accept a sync return. We change the search() to async-aware
  // by returning a Promise; routes/search.js awaits when needed (see below).
  async search(query, k = 10) {
    const t = process.hrtime.bigint();
    const resp = await new Promise((resolve, reject) => {
      const deadline = new Date(Date.now() + this.deadlineMs);
      this.client.searchTopK({ query, k }, { deadline }, (err, res) => {
        if (err) reject(err);
        else resolve(res);
      });
    });
    this.lastLatencyMs = Number(process.hrtime.bigint() - t) / 1e6;
    this.lastScoringLatencyMs = resp.scoringLatencyMs;

    return (resp.hits || []).map((h) => ({
      problem: {
        id: h.id,
        title: h.title,
        slug: h.slug,
        difficulty: h.difficulty,
        tags: h.tags || [],
        statement: h.statement,
        patterns: h.patterns || [],
        source_url: h.sourceUrl,
      },
      score: h.score,
      matchedTerms: h.matchedTerms || [],
    }));
  }

  close() {
    if (this.client && typeof this.client.close === "function") this.client.close();
  }
}

// Probe the server with a deadline so boot doesn't hang when C++ is offline.
async function probe(address, timeoutMs = 600) {
  const proto = loadProto();
  const client = new proto.Search(address, grpc.credentials.createInsecure());
  try {
    await new Promise((resolve, reject) => {
      const deadline = new Date(Date.now() + timeoutMs);
      client.searchTopK({ query: "ping", k: 1 }, { deadline }, (err, res) => {
        if (err) reject(err);
        else resolve(res);
      });
    });
    return true;
  } catch (_e) {
    return false;
  } finally {
    if (client && typeof client.close === "function") client.close();
  }
}

module.exports = { GrpcSearchIndex, probe };
