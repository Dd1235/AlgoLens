const groupsEl = document.getElementById("pattern-groups");
const statusEl = document.getElementById("patterns-status");

async function loadPatterns() {
  let data;
  try {
    const res = await fetch("/api/patterns");
    data = await res.json();
  } catch (err) {
    statusEl.textContent = `error: ${err.message || "failed to load patterns"}`;
    return;
  }

  const labeled = data.categories.reduce(
    (sum, c) => sum + c.patterns.filter((p) => p.count > 0).length,
    0
  );
  const total = data.categories.reduce((sum, c) => sum + c.patterns.length, 0);
  statusEl.textContent = `${total} canonical patterns · ${labeled} with problems · corpus: ${data.totalProblems}`;

  for (const { category, patterns } of data.categories) {
    const section = document.createElement("section");
    section.className = "pattern-cat";

    const heading = document.createElement("h2");
    heading.textContent = category;
    section.appendChild(heading);

    const grid = document.createElement("div");
    grid.className = "chip-grid";
    for (const { pattern, count } of patterns) {
      const chip = document.createElement("a");
      chip.className = "pattern-chip" + (count === 0 ? " empty" : "");
      chip.href = `/?pattern=${encodeURIComponent(pattern)}`;
      if (count === 0) chip.title = "no problems carry this label yet";
      chip.textContent = pattern + " ";
      const badge = document.createElement("span");
      badge.className = "chip-count";
      badge.textContent = String(count);
      chip.appendChild(badge);
      grid.appendChild(chip);
    }
    section.appendChild(grid);
    groupsEl.appendChild(section);
  }
}

loadPatterns();
