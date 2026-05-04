const { tokenize } = require("./tokenize");

function problemText(p) {
  return [p.title, p.statement, ...(p.tags || []), ...(p.patterns || [])].join(" ");
}

class Bm25Index {
  constructor(problems, { k1 = 1.5, b = 0.75 } = {}) {
    this.problems = problems;
    this.N = problems.length;
    this.k1 = k1;
    this.b = b;

    this.docTermCounts = [];
    this.docLengths = [];
    this.df = new Map();
    this.postings = new Map();

    let totalLen = 0;
    problems.forEach((p, docId) => {
      const tokens = tokenize(problemText(p));
      const counts = new Map();
      for (const tok of tokens) counts.set(tok, (counts.get(tok) || 0) + 1);
      this.docTermCounts.push(counts);
      this.docLengths.push(tokens.length);
      totalLen += tokens.length;

      for (const term of counts.keys()) {
        this.df.set(term, (this.df.get(term) || 0) + 1);
        let set = this.postings.get(term);
        if (!set) {
          set = new Set();
          this.postings.set(term, set);
        }
        set.add(docId);
      }
    });

    this.avgdl = this.N > 0 ? totalLen / this.N : 0;

    // Robertson-Sparck-Jones-style IDF (with +1 smoothing) — never negative
    this.idf = new Map();
    for (const [term, df] of this.df) {
      this.idf.set(term, Math.log(1 + (this.N - df + 0.5) / (df + 0.5)));
    }
  }

  _termContribution(term, docId) {
    const idf = this.idf.get(term);
    if (idf === undefined) return 0;
    const tf = this.docTermCounts[docId].get(term) || 0;
    if (tf === 0) return 0;
    const dl = this.docLengths[docId] || 0;
    const norm = 1 - this.b + this.b * (dl / (this.avgdl || 1));
    const num = tf * (this.k1 + 1);
    const den = tf + this.k1 * norm;
    return idf * (num / den);
  }

  search(query, k = 10) {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const scoreByDoc = new Map();
    const matchedByDoc = new Map();

    for (const term of queryTokens) {
      const docs = this.postings.get(term);
      if (!docs) continue;
      for (const docId of docs) {
        const contribution = this._termContribution(term, docId);
        if (contribution <= 0) continue;
        scoreByDoc.set(docId, (scoreByDoc.get(docId) || 0) + contribution);
        let arr = matchedByDoc.get(docId);
        if (!arr) {
          arr = [];
          matchedByDoc.set(docId, arr);
        }
        arr.push(term);
      }
    }

    const hits = [];
    for (const [docId, score] of scoreByDoc) {
      hits.push({
        problem: this.problems[docId],
        score,
        matchedTerms: matchedByDoc.get(docId),
      });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }

  dumpInverted() {
    const terms = [];
    for (const [term, docIds] of this.postings) {
      const docs = [...docIds].map((docId) => ({
        id: this.problems[docId].id,
        title: this.problems[docId].title,
        count: this.docTermCounts[docId].get(term) || 0,
      }));
      terms.push({
        term,
        df: this.df.get(term) || 0,
        idf: this.idf.get(term) ?? 0,
        docs,
      });
    }
    terms.sort((a, b) => b.df - a.df || a.term.localeCompare(b.term));
    return { totalTerms: terms.length, totalDocs: this.N, avgdl: this.avgdl, k1: this.k1, b: this.b, terms };
  }

  explain(query) {
    const queryTokens = tokenize(query);
    const perTerm = queryTokens.map((term) => {
      const idf = this.idf.get(term);
      const df = this.df.get(term) || 0;
      const docs = this.postings.get(term);
      const skipped = idf === undefined ? "unknown-term" : null;
      return { term, df, idf: idf ?? null, docCount: docs ? docs.size : 0, skipped };
    });

    const breakdown = new Map();
    for (const term of queryTokens) {
      const docs = this.postings.get(term);
      if (!docs) continue;
      for (const docId of docs) {
        const tf = this.docTermCounts[docId].get(term) || 0;
        if (tf === 0) continue;
        const idf = this.idf.get(term);
        const dl = this.docLengths[docId] || 0;
        const norm = 1 - this.b + this.b * (dl / (this.avgdl || 1));
        const contribution = this._termContribution(term, docId);
        let row = breakdown.get(docId);
        if (!row) {
          row = { docId, problem: this.problems[docId], total: 0, terms: [] };
          breakdown.set(docId, row);
        }
        row.terms.push({ term, count: tf, docLength: dl, norm, idf, contribution });
        row.total += contribution;
      }
    }

    const docs = [...breakdown.values()].sort((a, b) => b.total - a.total);
    return { query, queryTokens, perTerm, params: { k1: this.k1, b: this.b, avgdl: this.avgdl }, docs };
  }
}

module.exports = { Bm25Index };
