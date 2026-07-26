// Hybrid ranker: reciprocal rank fusion (RRF) over a lexical leg (BM25) and a
// dense leg. Each leg contributes 1/(kRrf + rank) per doc, rank 1-based over
// its top-N candidates. Fusing on ranks instead of scores sidesteps the scale
// mismatch between unbounded BM25 scores and cosines in [-1, 1]. kRrf = 60 is
// the standard Cormack/Clarke/Buettcher constant; topN = 100 is justified by
// Recall@100 ≈ 1.0 on the bench (see experiments/05).
class HybridIndex {
  // lexical: any sync or async ranker honoring the SearchIndex seam
  // dense: DenseIndex (async)
  constructor({ lexical, dense, kRrf = 60, topN = 100 }) {
    this.lexical = lexical;
    this.dense = dense;
    this.kRrf = kRrf;
    this.topN = topN;
  }

  // depth is how deep each leg goes before fusing. It floors at topN so the
  // common shallow query keeps exp 05's tuning, and widens when the caller
  // asks for more than 100 rows — which the route does when it has to filter
  // and page over the whole ranked list. Reading topN here instead of the
  // caller's k capped every fused result set at 200 rows no matter what was
  // requested, so filtered pages past offset 200 came back empty.
  async _legs(query, depth = this.topN) {
    const n = Math.max(this.topN, depth);
    const [lex, den] = await Promise.all([
      Promise.resolve(this.lexical.search(query, n, 0)),
      this.dense.search(query, n, 0),
    ]);
    return { lex: lex.hits, den: den.hits };
  }

  _fuse(lexHits, denseHits) {
    const fused = new Map();
    const add = (hit, rank, leg) => {
      const id = hit.problem.id;
      let row = fused.get(id);
      if (!row) {
        row = { problem: hit.problem, score: 0, matchedTerms: [], lexRank: null, denseRank: null };
        fused.set(id, row);
      }
      row.score += 1 / (this.kRrf + rank);
      if (leg === "lex") {
        row.lexRank = rank;
        row.matchedTerms = hit.matchedTerms || [];
      } else {
        row.denseRank = rank;
      }
    };
    lexHits.forEach((h, i) => add(h, i + 1, "lex"));
    denseHits.forEach((h, i) => add(h, i + 1, "dense"));

    const rows = [...fused.values()];
    // deterministic: score desc, then lexical rank asc (docs the lexical leg
    // saw win ties; nulls last), then id
    rows.sort(
      (a, b) =>
        b.score - a.score ||
        (a.lexRank ?? Infinity) - (b.lexRank ?? Infinity) ||
        (a.problem.id < b.problem.id ? -1 : 1)
    );
    return rows;
  }

  async search(query, k = 10, offset = 0) {
    const { lex, den } = await this._legs(query, offset + k);
    const rows = this._fuse(lex, den);
    const hits = rows
      .slice(offset, offset + k)
      .map(({ problem, score, matchedTerms }) => ({ problem, score, matchedTerms }));
    return { hits, total: rows.length };
  }

  async explain(query) {
    const { lex, den } = await this._legs(query);
    const rows = this._fuse(lex, den);
    const leg = (hits) =>
      hits.slice(0, 10).map((h, i) => ({ id: h.problem.id, title: h.problem.title, score: h.score, rank: i + 1 }));
    return {
      query,
      params: { kRrf: this.kRrf, topN: this.topN, lexical: "bm25", dense: "dense" },
      note: `score(d) = Σ legs 1/(${this.kRrf} + rank); only each leg's top ${this.topN} participate`,
      legs: { lexical: leg(lex), dense: leg(den) },
      docs: rows.slice(0, 20).map((r) => ({
        problem: r.problem,
        lexRank: r.lexRank,
        denseRank: r.denseRank,
        lexContribution: r.lexRank === null ? 0 : 1 / (this.kRrf + r.lexRank),
        denseContribution: r.denseRank === null ? 0 : 1 / (this.kRrf + r.denseRank),
        total: r.score,
      })),
    };
  }
}

module.exports = { HybridIndex };
