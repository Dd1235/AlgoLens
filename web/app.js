const input = document.getElementById("search-input");
const form = document.getElementById("search-form");
const resultsEl = document.getElementById("results");
const statusEl = document.getElementById("status");

const DEBOUNCE_MS = 200;
let debounceTimer = null;
let lastQueryAt = 0;

form.addEventListener("submit", (e) => {
  e.preventDefault();
  runSearch(input.value);
});

input.addEventListener("input", () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => runSearch(input.value), DEBOUNCE_MS);
});

async function runSearch(rawQuery) {
  const q = rawQuery.trim();
  if (!q) {
    statusEl.textContent = "Type a query to search.";
    resultsEl.innerHTML = "";
    return;
  }

  const issuedAt = ++lastQueryAt;
  statusEl.textContent = "Searching...";

  let data;
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&k=20`);
    data = await res.json();
  } catch (err) {
    if (issuedAt !== lastQueryAt) return;
    statusEl.textContent = "Search failed.";
    return;
  }

  if (issuedAt !== lastQueryAt) return;

  if (!data.hits || data.hits.length === 0) {
    statusEl.textContent = `No results for "${q}".`;
    resultsEl.innerHTML = "";
    return;
  }

  statusEl.textContent = `${data.hits.length} result${data.hits.length === 1 ? "" : "s"} for "${q}".`;
  render(data.hits);
}

function render(hits) {
  resultsEl.innerHTML = "";

  const topScore = hits.reduce(
    (m, h) => (typeof h.score === "number" ? Math.max(m, h.score) : m),
    0
  );

  hits.forEach((hit, i) => {
    const li = document.createElement("li");
    li.className = "result";
    li.style.animationDelay = `${Math.min(i, 8) * 30}ms`;

    const header = document.createElement("div");
    header.className = "result-header";

    const title = document.createElement("span");
    title.className = "result-title";
    title.textContent = hit.problem.title;

    const meta = document.createElement("span");
    meta.className = "result-meta";
    const score = typeof hit.score === "number" ? hit.score.toFixed(4) : "—";
    meta.textContent = `${hit.problem.difficulty} · ${score}`;

    header.appendChild(title);
    header.appendChild(meta);

    const bar = document.createElement("div");
    bar.className = "score-bar";
    const fill = document.createElement("div");
    fill.className = "score-bar-fill";
    bar.appendChild(fill);

    const matched = document.createElement("div");
    matched.className = "result-matched";
    if ((hit.matchedTerms || []).length) {
      for (const t of hit.matchedTerms) {
        const chip = document.createElement("span");
        chip.className = "matched-chip";
        chip.textContent = t;
        matched.appendChild(chip);
      }
    }

    const detail = document.createElement("div");
    detail.className = "result-detail hidden";
    detail.innerHTML = `
      <p>${escapeHtml(hit.problem.statement || "")}</p>
      <p class="tags"><strong>tags:</strong> ${(hit.problem.tags || []).map(escapeHtml).join(", ")}</p>
      <p class="patterns"><strong>patterns:</strong> ${(hit.problem.patterns || []).map(escapeHtml).join(", ")}</p>
      ${hit.problem.source_url ? `<p><a href="${escapeHtml(hit.problem.source_url)}" target="_blank" rel="noopener">open on leetcode &rarr;</a></p>` : ""}
    `;

    header.addEventListener("click", () => {
      detail.classList.toggle("hidden");
    });

    li.appendChild(header);
    li.appendChild(bar);
    if (matched.childNodes.length > 0) li.appendChild(matched);
    li.appendChild(detail);
    resultsEl.appendChild(li);

    if (topScore > 0 && typeof hit.score === "number") {
      const pct = Math.max(2, Math.round((hit.score / topScore) * 100));
      requestAnimationFrame(() => {
        fill.style.width = `${pct}%`;
      });
    }
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
