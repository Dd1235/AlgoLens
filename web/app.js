const input = document.getElementById("search-input");
const form = document.getElementById("search-form");
const resultsEl = document.getElementById("results");
const statusEl = document.getElementById("status");

const DEBOUNCE_MS = 200;
let debounceTimer = null;
let lastQueryAt = 0;
let typeTimer = null;

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

form.addEventListener("submit", (e) => {
  e.preventDefault();
  runSearch(input.value);
});

input.addEventListener("input", () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => runSearch(input.value), DEBOUNCE_MS);
});

input.addEventListener("focus", () => setStatus("ready"));

async function runSearch(rawQuery) {
  const q = rawQuery.trim();
  if (!q) {
    setStatus("type a query to search");
    resultsEl.innerHTML = "";
    return;
  }

  const issuedAt = ++lastQueryAt;
  setStatus(`searching: "${q}"`);

  let data;
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&k=20`);
    data = await res.json();
  } catch (err) {
    if (issuedAt !== lastQueryAt) return;
    setStatus(`error: ${err.message || "search failed"}`);
    return;
  }

  if (issuedAt !== lastQueryAt) return;

  if (!data.hits || data.hits.length === 0) {
    setStatus(`0 hits for "${q}"`);
    resultsEl.innerHTML = "";
    return;
  }

  const n = data.hits.length;
  setStatus(`${n} ${n === 1 ? "hit" : "hits"} for "${q}"`);
  render(data.hits);
}

function setStatus(text) {
  clearTimeout(typeTimer);
  if (reduceMotion) {
    statusEl.innerHTML = `${escapeHtml(text)}<span class="cursor">_</span>`;
    return;
  }
  // typewriter: write one char at a time, keep blinking cursor at the end
  let i = 0;
  const tick = () => {
    i = Math.min(i + 1, text.length);
    statusEl.innerHTML = `${escapeHtml(text.slice(0, i))}<span class="cursor">_</span>`;
    if (i < text.length) {
      typeTimer = setTimeout(tick, 12);
    }
  };
  tick();
}

function diffClass(d) {
  return d === "easy" || d === "medium" || d === "hard" ? d : "";
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
    const rank = String(i + 1).padStart(2, "0");
    li.setAttribute("data-rank", `[${rank}]`);
    li.style.animationDelay = `${Math.min(i, 8) * 35}ms`;

    const header = document.createElement("div");
    header.className = "result-header";

    const title = document.createElement("span");
    title.className = "result-title";
    title.textContent = hit.problem.title;

    const meta = document.createElement("span");
    meta.className = "result-meta";
    const diff = hit.problem.difficulty || "";
    const score = typeof hit.score === "number" ? hit.score.toFixed(4) : "—";
    meta.innerHTML = `<span class="difficulty ${diffClass(diff)}">${escapeHtml(diff)}</span>${score}`;

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

setStatus("type a query to search");
