const {
  MODEL_ID,
  DTYPE,
  DIMS,
  corpusHash,
  createEmbedder,
  loadArtifact,
} = require("./embedding");

// Dense (semantic) ranker. Doc vectors are precomputed offline (`npm run
// embed`) and committed; only the query is embedded at request time. Vectors
// are unit-norm, so cosine similarity is a plain dot product. Scoring is a
// brute-force scan over a contiguous Float32Array — at 1185 docs × 384 dims
// that's ~0.45M multiply-adds, well under a millisecond, which is why there is
// deliberately no vector database here.
class DenseIndex {
  // matrix: Float32Array(problems.length * dims), row i = problems[i]
  // embed: async (texts: string[]) => Float32Array(texts.length * dims)
  constructor(problems, { matrix, dims = DIMS, embed, model = MODEL_ID, dtype = DTYPE }) {
    this.problems = problems;
    this.N = problems.length;
    this.matrix = matrix;
    this.dims = dims;
    this.embed = embed;
    this.model = model;
    this.dtype = dtype;
    this.lastEmbedMs = null;
    this.lastScanMs = null;

    this.rowById = new Map();
    problems.forEach((p, i) => this.rowById.set(p.id, i));
  }

  _scoreAgainst(q) {
    const { matrix, dims, N } = this;
    const scores = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      let dot = 0;
      const base = i * dims;
      for (let j = 0; j < dims; j++) dot += matrix[base + j] * q[j];
      scores[i] = dot;
    }
    return scores;
  }

  // Every doc has a similarity to the query, so the ranking is over the whole
  // corpus: total = N. Ties break by problem id for determinism.
  _rank(scores) {
    const order = Array.from({ length: this.N }, (_, i) => i);
    order.sort((a, b) => scores[b] - scores[a] || (this.problems[a].id < this.problems[b].id ? -1 : 1));
    return order;
  }

  async search(query, k = 10, offset = 0) {
    if (!query || !query.trim()) return { hits: [], total: 0 };

    let t = process.hrtime.bigint();
    const q = await this.embed([query]);
    this.lastEmbedMs = Number(process.hrtime.bigint() - t) / 1e6;

    t = process.hrtime.bigint();
    const scores = this._scoreAgainst(q);
    const order = this._rank(scores);
    this.lastScanMs = Number(process.hrtime.bigint() - t) / 1e6;

    const hits = order.slice(offset, offset + k).map((i) => ({
      problem: this.problems[i],
      score: scores[i],
      matchedTerms: [],
    }));
    return { hits, total: this.N };
  }

  // Doc-to-doc similarity over the stored vectors — no model involved, sync.
  // Returns null for unknown ids (route maps that to 404).
  similar(problemId, k = 10) {
    const row = this.rowById.get(problemId);
    if (row === undefined) return null;

    const q = this.matrix.subarray(row * this.dims, (row + 1) * this.dims);
    const scores = this._scoreAgainst(q);
    const order = this._rank(scores).filter((i) => i !== row);

    const hits = order.slice(0, k).map((i) => ({
      problem: this.problems[i],
      score: scores[i],
      matchedTerms: [],
    }));
    const src = this.problems[row];
    return { source: { id: src.id, title: src.title }, hits, total: this.N - 1 };
  }

  async explain(query) {
    const { hits } = await this.search(query, 20, 0);
    return {
      query,
      model: this.model,
      dtype: this.dtype,
      dims: this.dims,
      count: this.N,
      embedMs: this.lastEmbedMs,
      scanMs: this.lastScanMs,
      note: "score = q · d over unit vectors (cosine, in [-1, 1]); no terms, no postings — the whole corpus is ranked",
      docs: hits.map(({ problem, score }) => ({
        problem,
        score,
        angleDeg: (Math.acos(Math.max(-1, Math.min(1, score))) * 180) / Math.PI,
      })),
    };
  }

  stats() {
    return { model: this.model, dtype: this.dtype, dims: this.dims, count: this.N };
  }
}

// Boot-time factory, analogous to grpc_index's probe(): returns a ready
// DenseIndex or null, never throws. Skips (with a warning) when the artifact
// is missing or stale, or the model can't load — the app then serves the
// lexical rankers only.
async function tryCreateDenseIndex(problems, { artifactDir, embed } = {}) {
  const artifact = artifactDir === undefined ? loadArtifact() : loadArtifact(artifactDir);
  if (!artifact) {
    console.warn("dense: no embeddings artifact (data/embeddings) — run `npm run embed`; skipping dense + hybrid");
    return null;
  }
  const { manifest, matrix } = artifact;

  if (manifest.model !== MODEL_ID || manifest.dtype !== DTYPE || manifest.dims !== DIMS) {
    console.warn(
      `dense: artifact built with ${manifest.model}/${manifest.dtype}/${manifest.dims}d ` +
        `but code pins ${MODEL_ID}/${DTYPE}/${DIMS}d — run \`npm run embed\`; skipping`
    );
    return null;
  }
  if (manifest.count * manifest.dims !== matrix.length || manifest.count !== problems.length) {
    console.warn(
      `dense: artifact has ${manifest.count} vectors for a ${problems.length}-doc corpus — run \`npm run embed\`; skipping`
    );
    return null;
  }
  if (manifest.corpusHash !== corpusHash(problems)) {
    console.warn("dense: embeddings stale (corpus text changed since `npm run embed`) — re-run it; skipping");
    return null;
  }

  // Row order is keyed by manifest.ids, not assumed: reorder into problems
  // order if the two ever diverge (same sorted loader today, so usually a
  // straight copy).
  const rowById = new Map(manifest.ids.map((id, i) => [id, i]));
  let ordered = matrix;
  const needsReorder = problems.some((p, i) => rowById.get(p.id) !== i);
  if (needsReorder) {
    ordered = new Float32Array(matrix.length);
    for (let i = 0; i < problems.length; i++) {
      const src = rowById.get(problems[i].id);
      if (src === undefined) {
        console.warn(`dense: artifact missing vector for ${problems[i].id} — run \`npm run embed\`; skipping`);
        return null;
      }
      ordered.set(matrix.subarray(src * DIMS, (src + 1) * DIMS), i * DIMS);
    }
  }

  let embedFn = embed;
  if (!embedFn) {
    try {
      embedFn = await createEmbedder();
      await embedFn(["warmup"]); // pay ORT session init now, not on the first user query
    } catch (err) {
      console.warn(`dense: model load failed (${err.message}) — skipping dense + hybrid`);
      return null;
    }
  }

  return new DenseIndex(problems, { matrix: ordered, dims: DIMS, embed: embedFn });
}

module.exports = { DenseIndex, tryCreateDenseIndex };
