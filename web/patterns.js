const groupsEl = document.getElementById("pattern-groups");
const statusEl = document.getElementById("patterns-status");
const filterEl = document.getElementById("pattern-filter");

let sections = []; // [{ category, el, chips: [{ pattern, el }] }]
let groups = [];   // umbrella terms from the taxonomy
let baseStatus = "";

async function loadPatterns() {
  let data;
  try {
    const res = await fetch("/api/patterns");
    data = await res.json();
  } catch (err) {
    statusEl.textContent = `error: ${err.message || "failed to load patterns"}`;
    return;
  }

  groups = data.groups || [];
  const labeled = data.categories.reduce(
    (sum, c) => sum + c.patterns.filter((p) => p.count > 0).length,
    0
  );
  const total = data.categories.reduce((sum, c) => sum + c.patterns.length, 0);
  baseStatus = `${total} canonical patterns · ${labeled} with problems · corpus: ${data.totalProblems}`;
  statusEl.textContent = baseStatus;

  for (const { category, patterns } of data.categories) {
    const section = document.createElement("section");
    section.className = "pattern-cat";

    // The count in the heading is distinct problems is NOT what this is — a
    // problem can carry several labels in one category, so summing labels
    // would double-count. This is "how many labels live here", which is the
    // number that helps you judge how much of the vocabulary you're looking at.
    const heading = document.createElement("h2");
    heading.textContent = category;
    const meta = document.createElement("span");
    meta.className = "cat-count";
    meta.textContent = `${patterns.filter((p) => p.count > 0).length} techniques`;
    heading.appendChild(meta);
    section.appendChild(heading);

    const grid = document.createElement("div");
    grid.className = "chip-grid";
    const chips = [];
    for (const { pattern, count } of patterns) {
      const chip = document.createElement("a");
      chip.className = "pattern-chip" + (count === 0 ? " empty" : "");
      chip.href = `/?pattern=${encodeURIComponent(pattern)}`;
      // Browse the label. From there the shuffle chip appears, since browsing
      // is the only state where a random order means anything.
      if (count === 0) chip.title = "no problems carry this label yet";
      chip.textContent = pattern + " ";
      const badge = document.createElement("span");
      badge.className = "chip-count";
      badge.textContent = String(count);
      chip.appendChild(badge);
      grid.appendChild(chip);
      chips.push({ pattern, el: chip });
    }
    section.appendChild(grid);
    groupsEl.appendChild(section);
    sections.push({ category, el: section, chips });
  }

  applyFilter();
}

// Labels are slugs and people type prose, so both sides are flattened to
// space-separated words before comparing. Without this, "segment tree" did not
// match `segment-tree` — a plain substring test says false — and the same held
// for "binary search", "sparse table" and every other multi-word technique.
const normalize = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// 165 chips is a wall. Typing narrows it in place — matching the category name
// keeps that whole group, so "tree" shows the tree family rather than only the
// labels with "tree" in the slug.
// Umbrellas resolve in two places, and the order matters. An EXACT name or
// alias ("range queries", "rmq", "dp optimization") always wins — that phrase
// names a family and nothing else. Anything shorter is only tried once the
// literal search has come up empty, so "tree" and "dp" keep listing every label
// that contains them instead of being silently swapped for a curated family.
function findGroup(q, exactOnly) {
  let best = null;
  for (const g of groups) {
    for (const name of [g.label, ...(g.aliases || [])]) {
      const n = normalize(name);
      const hit = exactOnly ? n === q : n.startsWith(q) || n.includes(` ${q}`);
      if (!hit) continue;
      if (!best || n.length < best.len) best = { label: g.label, members: new Set(g.members), len: n.length };
    }
  }
  return best;
}

// 165 chips is a wall. Typing narrows it in place — matching the category name
// keeps that whole group, so "tree" shows the tree family rather than only the
// labels with "tree" in the slug.
function applyFilter() {
  const q = normalize(filterEl.value);
  let group = q ? findGroup(q, true) : null;
  if (q && !group && !literalHits(q)) group = findGroup(q, false);

  let shown = 0;
  for (const { category, el, chips } of sections) {
    const catMatch = !!q && !group && normalize(category).includes(q);
    let visible = 0;
    for (const { pattern, el: chip } of chips) {
      const hit = !q || (group ? group.members.has(pattern) : catMatch || normalize(pattern).includes(q));
      chip.classList.toggle("hidden", !hit);
      if (hit) visible++;
    }
    el.classList.toggle("hidden", visible === 0);
    shown += visible;
  }
  statusEl.textContent = !q
    ? baseStatus
    : group
    ? `${shown} technique${shown === 1 ? "" : "s"} under "${group.label}"`
    : `${shown} technique${shown === 1 ? "" : "s"} matching "${q}"`;
}

// Would a plain label/category search find anything? Decides whether an
// umbrella is filling a void or overriding a perfectly good answer.
function literalHits(q) {
  for (const { category, chips } of sections) {
    if (normalize(category).includes(q)) return true;
    for (const { pattern } of chips) if (normalize(pattern).includes(q)) return true;
  }
  return false;
}

filterEl.addEventListener("input", applyFilter);

loadPatterns();
