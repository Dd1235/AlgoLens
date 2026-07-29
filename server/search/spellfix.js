// Spelling correction for query terms the corpus has never seen.
//
// `djikstra` and `kruskals` returned literally nothing: the vocabulary guard in
// routes/search.js correctly identified them as words no problem contains, and
// then said so. Which is honest, and useless — the user knows what they meant.
//
// The rule that makes this safe is that it only touches terms that are ALREADY
// contributing nothing. A token absent from the corpus vocabulary scores zero
// in BM25 and pulls the dense vector toward noise; appending its nearest real
// neighbour cannot displace a match that exists, because there was no match.
// Known terms are never rewritten, so no working query can regress. That is
// also why this is append-only rather than a substitution: if the correction is
// wrong, the original token is still there and still contributing its nothing.
//
// Deliberately NOT a general fuzzy index. There is no trigram table and no
// per-term index — the scan is over the vocabulary only for tokens that failed
// the exact check, which on real traffic is close to never.

// 3 so "tre" can reach "tree". Real 3-letter terms (dsu, lca, bfs, mex) are in
// the vocabulary and skipped before distance is ever computed.
const MIN_LENGTH = 3;
const MAX_CORRECTIONS = 2;
// Only correct TOWARD a term the corpus genuinely uses. 59% of the vocabulary
// appears in fewer than 3 problems — names, units, one-off words — and aiming
// at that tail is how "how much rainwater collects" became "muh" (df 2), which
// cost the paraphrase slice real nDCG. A correction to a term used twice is not
// a correction, it is a coincidence.
const MIN_TARGET_DF = 3;

// Damerau-Levenshtein with a cutoff: returns `cutoff + 1` as soon as the row
// minimum exceeds the budget, so most candidates cost a few cells rather than
// a full matrix.
function editDistance(a, b, cutoff) {
  if (Math.abs(a.length - b.length) > cutoff) return cutoff + 1;
  const n = a.length;
  const m = b.length;
  let prev2 = [];
  let prev = new Array(m + 1);
  let curr = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      // transposition: "teh" -> "the" is one edit, not two
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > cutoff) return cutoff + 1;
    prev2 = prev;
    prev = curr;
    curr = new Array(m + 1);
  }
  return prev[m];
}

// A longer word can absorb more damage before it stops being recognisable.
// The threshold is 8 rather than 6 because at 6 the name "deepya" corrects to
// "deep" (two deletions) — and "a person's name returns nothing" is a property
// an earlier round deliberately bought. One edit is plenty below that.
function budgetFor(term) {
  return term.length >= 8 ? 2 : 1;
}

// vocabulary: Map<term, docFreq> (or a bare Set) of every term in the corpus,
// built once in the route. The counts are only used to break ties, but they
// matter: "tre" is one edit from both "tree" and "pre", and alphabetical order
// picks "pre".
const freqOf = (vocabulary, term) =>
  typeof vocabulary.get === "function" ? vocabulary.get(term) || 0 : 0;

function correctTerms(terms, vocabulary) {
  const corrections = [];
  if (!vocabulary || !vocabulary.size) return corrections;
  const seen = new Set();
  for (const term of terms) {
    if (corrections.length >= MAX_CORRECTIONS) break;
    if (term.length < MIN_LENGTH || vocabulary.has(term) || seen.has(term)) continue;
    seen.add(term);
    const budget = budgetFor(term);
    let best = null;
    let bestDist = budget + 1;
    let bestFreq = 0;
    for (const candidate of vocabulary.keys()) {
      // Cheap rejects first — length gap alone kills most of the vocabulary.
      if (Math.abs(candidate.length - term.length) > budget) continue;
      if (freqOf(vocabulary, candidate) < MIN_TARGET_DF) continue;
      if (candidate[0] !== term[0] && candidate[candidate.length - 1] !== term[term.length - 1]) continue;
      const d = editDistance(term, candidate, budget);
      if (d > budget) continue;
      if (d < bestDist) {
        bestDist = d;
        best = candidate;
        bestFreq = freqOf(vocabulary, candidate);
        continue;
      }
      if (d === bestDist && best !== null) {
        // Same distance: prefer the term the corpus actually uses more, and
        // fall back to alphabetical so the result is stable across runs.
        const f = freqOf(vocabulary, candidate);
        if (f > bestFreq || (f === bestFreq && candidate < best)) {
          best = candidate;
          bestFreq = f;
        }
      }
    }
    if (best) corrections.push({ from: term, to: best, distance: bestDist });
  }
  return corrections;
}

module.exports = { correctTerms, editDistance, MIN_LENGTH };
