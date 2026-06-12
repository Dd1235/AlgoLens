// Offline corpus embedding: embeds every problem with the pinned model and
// writes data/embeddings/{corpus.f32,manifest.json}. The artifact is committed
// so dev/CI/prod all score against bit-identical doc vectors and the server
// never re-embeds the corpus at boot. Re-run (`npm run embed`) whenever the
// corpus or the model pin changes.
const { loadProblems } = require("../server/data");
const {
  MODEL_ID,
  DTYPE,
  DIMS,
  problemText,
  corpusHash,
  createEmbedder,
  saveArtifact,
  installedPackageVersion,
} = require("../server/search/embedding");

const BATCH_SIZE = 32;

async function main() {
  const t0 = Date.now();
  const problems = loadProblems();
  console.log(`embedding ${problems.length} problems with ${MODEL_ID} (dtype=${DTYPE}, ${DIMS}d)`);

  const embed = await createEmbedder();
  const matrix = new Float32Array(problems.length * DIMS);

  for (let start = 0; start < problems.length; start += BATCH_SIZE) {
    const batch = problems.slice(start, start + BATCH_SIZE);
    const vecs = await embed(batch.map(problemText));
    matrix.set(vecs, start * DIMS);
    process.stdout.write(
      `\r  ${Math.min(start + BATCH_SIZE, problems.length)}/${problems.length}`
    );
  }
  process.stdout.write("\n");

  // Sanity: unit norms, no NaNs.
  for (let i = 0; i < problems.length; i++) {
    let sq = 0;
    for (let j = 0; j < DIMS; j++) {
      const x = matrix[i * DIMS + j];
      if (Number.isNaN(x)) throw new Error(`NaN in vector for ${problems[i].id}`);
      sq += x * x;
    }
    const norm = Math.sqrt(sq);
    if (Math.abs(norm - 1) > 1e-3) {
      throw new Error(`non-unit norm ${norm} for ${problems[i].id}`);
    }
  }

  const manifest = {
    version: 1,
    model: MODEL_ID,
    dtype: DTYPE,
    dims: DIMS,
    count: problems.length,
    normalized: true,
    textFields: "title+statement+tags+patterns",
    ids: problems.map((p) => p.id),
    corpusHash: corpusHash(problems),
    package: installedPackageVersion(),
    createdAt: new Date().toISOString(),
  };
  const { vecPath } = saveArtifact(matrix, manifest);

  // Self-check: nearest neighbors of a problem everyone knows.
  const probeId = "leetcode-two-sum";
  const row = problems.findIndex((p) => p.id === probeId);
  if (row >= 0) {
    const sims = [];
    for (let i = 0; i < problems.length; i++) {
      if (i === row) continue;
      let dot = 0;
      for (let j = 0; j < DIMS; j++) dot += matrix[row * DIMS + j] * matrix[i * DIMS + j];
      sims.push([dot, problems[i].id]);
    }
    sims.sort((a, b) => b[0] - a[0]);
    console.log(`nearest to ${probeId}:`);
    for (const [s, id] of sims.slice(0, 5)) console.log(`  ${s.toFixed(4)}  ${id}`);
  }

  const mb = (matrix.byteLength / 1024 / 1024).toFixed(2);
  console.log(`wrote ${vecPath} (${mb} MB) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error("embed failed:", err);
  process.exit(1);
});
