const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Single source of truth for the dense ranker's model identity. The committed
// corpus artifact and the query-time embedder MUST come from the same
// {model, dtype} pair or query/doc similarities silently drift — the manifest
// records both and boot refuses to register dense on mismatch.
const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const DTYPE = "q8"; // quantized ONNX weights (~23 MB) — fits a 512 MB instance
const DIMS = 384;

const ARTIFACT_DIR = path.join(__dirname, "..", "..", "data", "embeddings");
const VECTORS_FILE = "corpus.f32"; // raw little-endian Float32Array, row i = doc i
const MANIFEST_FILE = "manifest.json";

// Same text composition as tfidf.js / bm25.js / inverted.js / go/bm25.go —
// deliberately duplicated per ranker, like the others.
function problemText(p) {
  return [p.title, p.statement, ...(p.tags || []), ...(p.patterns || [])].join(" ");
}

// Fingerprint of the corpus text the vectors were computed from, in load
// order. Boot compares this against the manifest to detect a stale artifact.
function corpusHash(problems) {
  const h = crypto.createHash("sha256");
  for (const p of problems) h.update(`${p.id}\n${problemText(p)}\n`);
  return h.digest("hex");
}

function modelCacheDir() {
  return process.env.ALGOLENS_MODEL_CACHE || path.join(__dirname, "..", "..", ".model-cache");
}

// transformers.js is ESM-only and this repo is CommonJS on Node 20, so the
// import happens dynamically inside an async function.
async function createEmbedder() {
  const { pipeline, env } = await import("@huggingface/transformers");
  env.cacheDir = modelCacheDir();
  const extractor = await pipeline("feature-extraction", MODEL_ID, { dtype: DTYPE });
  // embed(texts) -> Float32Array(texts.length * DIMS), L2-normalized rows,
  // so cosine similarity between any two rows is a plain dot product.
  return async function embed(texts) {
    const out = await extractor(texts, { pooling: "mean", normalize: true });
    const [batch, dims] = out.dims;
    if (batch !== texts.length || dims !== DIMS) {
      throw new Error(`unexpected embedding shape [${out.dims}] for batch of ${texts.length}`);
    }
    // Copy out of the tensor view so we never hold backing ORT memory.
    return new Float32Array(out.data);
  };
}

function saveArtifact(matrix, manifest) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const vecPath = path.join(ARTIFACT_DIR, VECTORS_FILE);
  const manPath = path.join(ARTIFACT_DIR, MANIFEST_FILE);
  // tmp + rename so a crash mid-write can't leave a torn artifact
  fs.writeFileSync(`${vecPath}.tmp`, Buffer.from(matrix.buffer, matrix.byteOffset, matrix.byteLength));
  fs.renameSync(`${vecPath}.tmp`, vecPath);
  fs.writeFileSync(`${manPath}.tmp`, JSON.stringify(manifest, null, 2) + "\n");
  fs.renameSync(`${manPath}.tmp`, manPath);
  return { vecPath, manPath };
}

function loadArtifact(dir = ARTIFACT_DIR) {
  const vecPath = path.join(dir, VECTORS_FILE);
  const manPath = path.join(dir, MANIFEST_FILE);
  if (!fs.existsSync(vecPath) || !fs.existsSync(manPath)) return null;
  const manifest = JSON.parse(fs.readFileSync(manPath, "utf8"));
  const buf = fs.readFileSync(vecPath);
  // readFileSync returns a pooled Buffer whose byteOffset may not be 4-byte
  // aligned; viewing it directly as Float32Array can throw. Copy into a fresh
  // ArrayBuffer (1.7 MB — negligible).
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return { manifest, matrix: new Float32Array(ab) };
}

function installedPackageVersion() {
  // exact-pinned in package.json, which ships in the Docker image
  const pkg = require("../../package.json");
  return `@huggingface/transformers@${pkg.dependencies["@huggingface/transformers"]}`;
}

module.exports = {
  MODEL_ID,
  DTYPE,
  DIMS,
  ARTIFACT_DIR,
  problemText,
  corpusHash,
  modelCacheDir,
  createEmbedder,
  saveArtifact,
  loadArtifact,
  installedPackageVersion,
};

// `node server/search/embedding.js --warm` downloads the model into the cache
// dir and runs one inference. Used at Docker build time to bake the model into
// the image so prod boots need no network. Lives here (not scripts/) because
// .dockerignore excludes scripts/.
if (require.main === module && process.argv.includes("--warm")) {
  (async () => {
    const t0 = Date.now();
    const embed = await createEmbedder();
    const v = await embed(["warmup"]);
    const norm = Math.hypot(...v);
    console.log(
      `model warm: ${MODEL_ID} dtype=${DTYPE} dims=${DIMS} cache=${modelCacheDir()} ` +
        `norm=${norm.toFixed(6)} (${Date.now() - t0} ms)`
    );
    if (Math.abs(norm - 1) > 1e-3) {
      console.error("warmup vector is not unit-norm — check pooling/normalize options");
      process.exit(1);
    }
  })().catch((err) => {
    console.error("model warm failed:", err.message || err);
    process.exit(1);
  });
}
