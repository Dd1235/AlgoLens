const { tokenize } = require("./tokenize");

function problemText(p) {
  return [p.title, p.statement, ...(p.tags || []), ...(p.patterns || [])].join(" ");
}

function buildInvertedIndex(problems) {
  const postings = new Map();
  problems.forEach((p, docId) => {
    const tokens = tokenize(problemText(p));
    const seen = new Set();
    for (const tok of tokens) {
      if (seen.has(tok)) continue;
      seen.add(tok);
      let set = postings.get(tok);
      if (!set) {
        set = new Set();
        postings.set(tok, set);
      }
      set.add(docId);
    }
  });

  function lookup(term) {
    return postings.get(term) || null;
  }

  return { postings, lookup };
}

module.exports = { buildInvertedIndex };
