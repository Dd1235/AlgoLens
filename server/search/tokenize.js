const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "of", "for", "to", "in",
  "on", "at", "by", "with", "from", "as", "is", "are", "was", "were", "be",
  "been", "being", "it", "its", "this", "that", "these", "those", "you", "your",
  "we", "our", "they", "them", "their", "i", "me", "my", "have", "has", "had",
  "do", "does", "did", "so", "not", "no", "yes", "than", "into", "out", "up",
  "down", "over", "under", "may", "can", "will", "would", "should", "could",
  "given", "return", "such", "each", "any", "all", "some", "more", "most",
  "other", "same", "only", "one", "two",
]);

function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((tok) => tok.length > 0 && !STOPWORDS.has(tok));
}

module.exports = { tokenize, STOPWORDS };
