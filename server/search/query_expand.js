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
// Aliases that REPLACE their span instead of adding to it — see the taxonomy
// note. Consuming every multi-word alias was measured and rejected: it cost
// Recall@100 -0.014, entirely on "sum over subsets", whose words the relevant
// problems actually contain.
const CONSUMING = new Set(TAXONOMY.consumingAliases || []);
const MAX_QUERY_LENGTH = 300;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Longest phrases first so "aliens trick" is consumed before "aliens" would be.
const RULES = Object.entries(TAXONOMY.aliases || {})
  .map(([alias, canonical]) => {
    const aliasWords = alias.split("-");
    return {
      alias,
      aliasWordCount: aliasWords.length,
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

  // Multi-word aliases CONSUME the span they match, and they run first.
  //
  // "square root decomposition" is one technique, not `square` + `root` +
  // `decomposition` — but those words are what got scored, and they fire on
  // problems about arithmetic square roots. Appending `sqrt decomposition`
  // (which alone scores a perfect P@5) did not help enough, because the junk
  // terms survived alongside it. Blanking the matched span removes them.
  //
  // Consuming also stops a SHORTER alias firing inside a longer one: "dsu on
  // trees" used to hit `dsu -> union-find` and drag 105 generic union-find
  // problems ahead of the four real ones.
  //
  // Single-word aliases below stay append-only — there is no span to
  // disambiguate, and appending is what keeps existing matches intact.
  let work = lower;
  const replaced = [];
  const consumedWords = [];
  for (const rule of RULES) {
    if (rule.aliasWordCount < 2 || !CONSUMING.has(rule.alias)) continue;
    const m = rule.re.exec(work);
    if (!m) continue;
    matches.push(rule.alias);
    // Blank the span (including the boundary char the pattern consumed) so it
    // can neither re-match nor be seen by any later rule.
    work = work.slice(0, m.index) + " ".repeat(m[0].length) + work.slice(m.index + m[0].length);
    consumedWords.push(...rule.canonicalWords);
  }

  // Dedup against what SURVIVED, not against the original query. A canonical
  // word can also appear inside the span we just blanked — `z-function` shares
  // `z` with "z algorithm", `sqrt-decomposition` shares `decomposition` with
  // "square root decomposition". Checking the pre-consumption text would treat
  // those as already present and drop them, leaving "function" and "sqrt".
  present.clear();
  for (const w of work.split(/[^a-z0-9]+/)) if (w) present.add(w);
  for (const word of consumedWords) {
    if (present.has(word) || replaced.length >= MAX_ADDED_WORDS) continue;
    present.add(word);
    replaced.push(word);
  }

  for (const rule of RULES) {
    if (rule.aliasWordCount >= 2 && CONSUMING.has(rule.alias)) continue;
    if (replaced.length + added.length >= MAX_ADDED_WORDS) break;
    if (!rule.re.test(work)) continue;
    matches.push(rule.alias);
    for (const word of rule.canonicalWords) {
      if (present.has(word) || replaced.length + added.length >= MAX_ADDED_WORDS) continue;
      present.add(word);
      added.push(word);
    }
  }
  // A bare digit that has a word form: append the word. Runs after the alias
  // rules so it can't consume their budget, and only for standalone tokens so
  // "1234" and "abc2" are untouched.
  for (const token of work.split(/[^a-z0-9]+/)) {
    const word = NUMBER_WORDS[token];
    if (!word || present.has(word) || replaced.length + added.length >= MAX_ADDED_WORDS) continue;
    present.add(word);
    added.push(word);
    matches.push(token);
  }

  if (!added.length && !replaced.length) return { query: q, expanded: false, added, matches };
  // What survived consumption, plus the canonical words. When nothing was
  // consumed this is byte-identical to the old append-only behaviour.
  const kept = work.trim().replace(/\s+/g, " ");
  const query = [kept, ...replaced, ...added].filter(Boolean).join(" ");
  return { query, expanded: true, added: [...replaced, ...added], matches };
}

module.exports = { expandQuery };
