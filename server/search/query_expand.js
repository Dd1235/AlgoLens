const fs = require("fs");
const path = require("path");

// Query-side alias expansion: taxonomy aliases are folded to canonical slugs
// at annotation time, so the alias words never appear in document text — a
// query like "aliens trick" or "sum over subsets" would match nothing
// lexically (the sos-dp regression measured in experiments/06). This helper
// appends the canonical slug's words to the query when an alias phrase is
// detected, so every ranker (lexical, dense, gRPC) sees the searchable form.
// Append-only: the original tokens stay, so existing matches are preserved.

const { NUMBER_WORDS } = require("./tokenize");

const TAXONOMY = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "data", "pattern_taxonomy.json"), "utf8")
);

const MAX_ADDED_WORDS = 8;
const MAX_QUERY_LENGTH = 300;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Longest phrases first so "aliens trick" is consumed before "aliens" would be.
const RULES = Object.entries(TAXONOMY.aliases || {})
  .map(([alias, canonical]) => {
    const aliasWords = alias.split("-");
    return {
      alias,
      canonicalWords: canonical.split("-"),
      // Alias hyphens match whitespace or hyphen in the query; both ends must
      // sit on non-alphanumeric boundaries ("aliens" never fires inside "alien").
      re: new RegExp(
        "(?:^|[^a-z0-9])" + aliasWords.map(escapeRe).join("[\\s-]+") + "(?![a-z0-9])"
      ),
    };
  })
  .sort(
    (a, b) =>
      b.canonicalWords.length - a.canonicalWords.length || b.alias.length - a.alias.length
  );

function expandQuery(q) {
  if (typeof q !== "string" || !q.trim() || q.length > MAX_QUERY_LENGTH) {
    return { query: q, expanded: false, added: [], matches: [] };
  }
  const lower = q.toLowerCase();
  const present = new Set(lower.split(/[^a-z0-9]+/).filter(Boolean));
  const added = [];
  const matches = [];
  for (const rule of RULES) {
    if (added.length >= MAX_ADDED_WORDS) break;
    if (!rule.re.test(lower)) continue;
    matches.push(rule.alias);
    for (const word of rule.canonicalWords) {
      if (present.has(word) || added.length >= MAX_ADDED_WORDS) continue;
      present.add(word);
      added.push(word);
    }
  }
  // A bare digit that has a word form: append the word. Runs after the alias
  // rules so it can't consume their budget, and only for standalone tokens so
  // "1234" and "abc2" are untouched.
  for (const token of lower.split(/[^a-z0-9]+/)) {
    const word = NUMBER_WORDS[token];
    if (!word || present.has(word) || added.length >= MAX_ADDED_WORDS) continue;
    present.add(word);
    added.push(word);
    matches.push(token);
  }

  if (!added.length) return { query: q, expanded: false, added, matches };
  return { query: `${q} ${added.join(" ")}`, expanded: true, added, matches };
}

module.exports = { expandQuery };
