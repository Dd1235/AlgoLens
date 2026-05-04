const { tokenize } = require("./tokenize");

function problemText(p) {
  return [p.title, p.statement, ...(p.tags || []), ...(p.patterns || [])].join(" ");
}

class TfIdfIndex {
  constructor(problems) {
    this.problems = problems;
    this.N = problems.length;

    this.docTermCounts = []; // Array<Map<term, count>>
    this.docLengths = []; // total tokens per doc
    this.df = new Map(); // term -> doc frequency
    this.postings = new Map(); // term -> Set<docId>

    problems.forEach((p, docId) => {
      const tokens = tokenize(problemText(p));
      const counts = new Map();
      for (const tok of tokens) {
        counts.set(tok, (counts.get(tok) || 0) + 1);
      }
      this.docTermCounts.push(counts);
      this.docLengths.push(tokens.length);

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

    this.idf = new Map();
    for (const [term, df] of this.df) {
      this.idf.set(term, Math.log(this.N / df));
    }
  }

  search(query, k = 10) {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const scoreByDoc = new Map();
    const matchedByDoc = new Map();

    for (const term of queryTokens) {
      const idf = this.idf.get(term);
      if (idf === undefined || idf === 0) continue;
      const docs = this.postings.get(term);
      if (!docs) continue;
      for (const docId of docs) {
        const count = this.docTermCounts[docId].get(term) || 0;
        const len = this.docLengths[docId] || 1;
        const tf = count / len;
        const contribution = tf * idf;
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
}

module.exports = { TfIdfIndex };
