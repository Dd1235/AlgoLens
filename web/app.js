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
  for (const hit of hits) {
    const li = document.createElement("li");
    li.className = "result";

    const header = document.createElement("div");
    header.className = "result-header";

    const title = document.createElement("span");
    title.className = "result-title";
    title.textContent = hit.problem.title;

    const meta = document.createElement("span");
    meta.className = "result-meta";
    const score = typeof hit.score === "number" ? hit.score.toFixed(4) : "—";
    meta.textContent = `${hit.problem.difficulty} · score ${score}`;

    header.appendChild(title);
    header.appendChild(meta);

    const matched = document.createElement("div");
    matched.className = "result-matched";
    matched.textContent = (hit.matchedTerms || []).length
      ? `matched: ${hit.matchedTerms.join(", ")}`
      : "";

    const detail = document.createElement("div");
    detail.className = "result-detail hidden";
    detail.innerHTML = `
      <p>${escapeHtml(hit.problem.statement || "")}</p>
      <p class="tags"><strong>tags:</strong> ${(hit.problem.tags || []).map(escapeHtml).join(", ")}</p>
      <p class="patterns"><strong>patterns:</strong> ${(hit.problem.patterns || []).map(escapeHtml).join(", ")}</p>
    `;

    header.addEventListener("click", () => {
      detail.classList.toggle("hidden");
    });

    li.appendChild(header);
    if (matched.textContent) li.appendChild(matched);
    li.appendChild(detail);
    resultsEl.appendChild(li);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
