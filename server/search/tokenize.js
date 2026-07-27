// Stopwords for a DSA problem corpus. We deliberately keep words that look
// generic in English but carry meaning here: "two" (two-sum, two-pointers),
// "one" (one-edit-away), "all" (find-all-…), "any", "more", "most", "same",
// "only", "other" all appear in real problem titles or pattern names.
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "of", "for", "to", "in",
  "on", "at", "by", "with", "from", "as", "is", "are", "was", "were", "be",
  "been", "being", "it", "its", "this", "that", "these", "those", "you", "your",
  "we", "our", "they", "them", "their", "i", "me", "my", "have", "has", "had",
  "do", "does", "did", "so", "not", "no", "yes", "than", "into", "out", "up",
  "down", "over", "under", "may", "can", "will", "would", "should", "could",
  "given", "return", "such", "each", "some",
]);

function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((tok) => tok.length > 0 && !STOPWORDS.has(tok));
}


// Digit/word equivalences. Not technique names, so the taxonomy can't hold
// them: the tokenizer splits on non-alphanumerics, which makes "2" and "two"
// unrelated terms, and no problem title spells the digit. "2 sum" found Two Sum
// at rank 75 before this existed.
//
// Deliberately tiny. "k" is absent on purpose — it means something specific in
// this domain and expanding it would fire on a large slice of the corpus.
const NUMBER_WORDS = { 1: "one", 2: "two", 3: "three", 4: "four" };

// Rewrites standalone digit tokens to their word form. Used for the known-item
// title lookup, where the query has to match a title exactly.
function normalizeNumbers(tokens) {
  return tokens.map((t) => NUMBER_WORDS[t] || t);
}

module.exports = {
  NUMBER_WORDS,
  normalizeNumbers, tokenize, STOPWORDS };
