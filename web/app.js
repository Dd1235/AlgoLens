const input = document.getElementById("search-input");
const form = document.getElementById("search-form");
const resultsEl = document.getElementById("results");
const statusEl = document.getElementById("status");
const loadMoreEl = document.getElementById("load-more");
const filterSelect = document.getElementById("filter-select");
const filterWrap = document.getElementById("filter-wrap");
const authWidget = document.getElementById("auth-widget");
const authEmailEl = document.getElementById("auth-email");
const logoutBtn = document.getElementById("logout-btn");
const hintRow = document.getElementById("hint-row");

// Shell-style library commands: typing one of these in the search box bypasses
// BM25 and lists the user's saved problems.
const LIBRARY_COMMANDS = {
  ":bookmarks": "bookmarked",
  ":b": "bookmarked",
  ":done": "done",
  ":d": "done",
  ":all": "all",
  ":library": "all",
  ":lib": "all",
  "ls bookmarks": "bookmarked",
  "ls done": "done",
};

// COMPARE_MODE_DISABLED: see web/index.html for the full re-enable note.
// const compareEl = document.getElementById("compare-results");
// const compareToggle = document.getElementById("compare-toggle");
// const latencySummaryEl = document.getElementById("latency-summary");

const DEBOUNCE_MS = 200;
const TOP_K = 20;
let debounceTimer = null;
let lastQueryAt = 0;
let typeTimer = null;
let currentQuery = "";
let currentOffset = 0;
let currentTotal = 0;
let currentTopScore = 0;
let currentUser = null;
let currentFilter = "all";

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

form.addEventListener("submit", (e) => {
  e.preventDefault();
  runSearch(input.value, { append: false });
});

input.addEventListener("input", () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => runSearch(input.value, { append: false }), DEBOUNCE_MS);
});

input.addEventListener("focus", () => setStatus("ready"));

loadMoreEl.addEventListener("click", () => {
  if (!currentQuery) return;
  currentOffset += TOP_K;
  runSearch(currentQuery, { append: true });
});

filterSelect.addEventListener("change", () => {
  currentFilter = filterSelect.value;
  if (currentQuery) runSearch(currentQuery, { append: false });
});

logoutBtn.addEventListener("click", async () => {
  try { await fetch("/api/auth/logout", { method: "POST" }); } catch (_e) {}
  currentUser = null;
  applyAuthState();
  if (currentQuery) runSearch(currentQuery, { append: false });
});

async function bootstrapAuth() {
  try {
    const res = await fetch("/api/auth/me");
    if (res.ok) {
      const data = await res.json();
      currentUser = data.user || null;
    }
  } catch (_e) {}
  applyAuthState();
}

function applyAuthState() {
  const anon = authWidget.querySelector("[data-anon]");
  const signed = authWidget.querySelector("[data-signed]");
  if (currentUser) {
    anon.hidden = true;
    signed.hidden = false;
    authEmailEl.textContent = currentUser.email;
    filterWrap.hidden = false;
    hintRow.hidden = false;
  } else {
    anon.hidden = false;
    signed.hidden = true;
    filterWrap.hidden = true;
    filterSelect.value = "all";
    currentFilter = "all";
    hintRow.hidden = true;
  }
}

bootstrapAuth();

// COMPARE_MODE_DISABLED:
// compareToggle.addEventListener("change", () => {
//   applyMode();
//   if (input.value.trim()) runSearch(input.value);
// });
// applyMode();
//
// function applyMode() {
//   if (compareToggle.checked) {
//     resultsEl.classList.add("hidden");
//     compareEl.classList.remove("hidden");
//   } else {
//     resultsEl.classList.remove("hidden");
//     compareEl.classList.add("hidden");
//     latencySummaryEl.textContent = "";
//   }
// }

async function runSearch(rawQuery, { append = false } = {}) {
  const q = rawQuery.trim();
  if (!q) {
    setStatus("type a query to search");
    resultsEl.innerHTML = "";
    currentQuery = "";
    currentOffset = 0;
    currentTotal = 0;
    hideLoadMore();
    return;
  }

  // Shell-style library commands.
  const libraryType = currentUser ? LIBRARY_COMMANDS[q.toLowerCase()] : null;
  if (libraryType) {
    if (!append) {
      currentQuery = q;
      currentOffset = 0;
    }
    return runLibrary(libraryType, q);
  }

  if (!append) {
    currentQuery = q;
    currentOffset = 0;
    currentTopScore = 0;
  }

  const issuedAt = ++lastQueryAt;
  setStatus(`searching: "${q}"`);
  const filterParam = currentUser && currentFilter !== "all" ? `&filter=${currentFilter}` : "";
  const url = `/api/search?q=${encodeURIComponent(q)}&k=${TOP_K}&offset=${currentOffset}${filterParam}`;

  let data;
  try {
    const res = await fetch(url);
    data = await res.json();
  } catch (err) {
    if (issuedAt !== lastQueryAt) return;
    setStatus(`error: ${err.message || "search failed"}`);
    return;
  }

  if (issuedAt !== lastQueryAt) return;

  currentTotal = data.total || 0;
  renderSingle(data, q, append);
  updateLoadMore();
}

function renderSingle(data, q, append) {
  if (!data.hits || data.hits.length === 0) {
    if (!append) {
      setStatus(`0 hits for "${q}"`);
      resultsEl.innerHTML = "";
    }
    return;
  }
  const lat = typeof data.latencyMs === "number" ? ` · ${data.latencyMs.toFixed(3)}ms` : "";
  const shown = currentOffset + data.hits.length;
  const total = currentTotal;
  setStatus(`showing 1–${shown} of ${total} for "${q}" via ${data.ranker}${lat}`);
  renderHitsList(resultsEl, data.hits, { append, startIndex: currentOffset });
}

function updateLoadMore() {
  const shown = currentOffset + TOP_K;
  if (currentTotal > 0 && shown < currentTotal) {
    loadMoreEl.classList.remove("hidden");
    const remaining = currentTotal - shown;
    loadMoreEl.textContent = `load more (${remaining} remaining)`;
  } else {
    hideLoadMore();
  }
}

function hideLoadMore() {
  loadMoreEl.classList.add("hidden");
}

// COMPARE_MODE_DISABLED:
// function renderCompare(data, q) {
//   const results = data.results || [];
//   if (results.length === 0) { setStatus("no rankers configured"); compareEl.innerHTML = ""; return; }
//   const rankMaps = results.map((r) => {
//     const m = new Map();
//     r.hits.forEach((h, i) => m.set(h.problem.id, i + 1));
//     return m;
//   });
//   const totalHits = results.reduce((s, r) => s + r.hits.length, 0);
//   if (totalHits === 0) { setStatus(`0 hits for "${q}"`); compareEl.innerHTML = ""; latencySummaryEl.textContent = ""; return; }
//   setStatus(`compare: "${q}"`);
//   latencySummaryEl.textContent = results.map((r) => `${r.ranker} ${r.latencyMs.toFixed(3)}ms`).join("  ·  ");
//   compareEl.innerHTML = "";
//   results.forEach((r, idx) => {
//     const col = document.createElement("section");
//     col.className = "compare-col";
//     const head = document.createElement("div");
//     head.className = "compare-col-head";
//     head.innerHTML = `<span class="ranker-name">${escapeHtml(r.ranker)}</span><span class="ranker-latency">${r.latencyMs.toFixed(3)}ms</span>`;
//     col.appendChild(head);
//     const list = document.createElement("ul");
//     list.className = "compare-list";
//     col.appendChild(list);
//     if (r.hits.length === 0) {
//       const empty = document.createElement("li"); empty.className = "compare-empty"; empty.textContent = "no hits"; list.appendChild(empty);
//     } else {
//       const otherIdx = idx === 0 ? 1 : 0;
//       const otherMap = rankMaps[otherIdx];
//       const otherName = results[otherIdx]?.ranker || "other";
//       renderHitsList(list, r.hits, { otherRankMap: otherMap, otherName });
//     }
//     compareEl.appendChild(col);
//   });
// }

function setStatus(text) {
  clearTimeout(typeTimer);
  if (reduceMotion) {
    statusEl.innerHTML = `${escapeHtml(text)}<span class="cursor">_</span>`;
    return;
  }
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

// COMPARE_MODE_DISABLED:
// function rankDeltaBadge(thisRank, otherRank, otherName) {
//   if (otherRank == null) return `<span class="rank-delta absent" title="not in ${escapeHtml(otherName)} top ${TOP_K}">– ${escapeHtml(otherName)}</span>`;
//   if (otherRank === thisRank) return `<span class="rank-delta same" title="same rank in ${escapeHtml(otherName)}">= ${escapeHtml(otherName)}</span>`;
//   if (otherRank > thisRank) return `<span class="rank-delta up" title="${escapeHtml(otherName)} ranks this #${otherRank}">↑${otherRank - thisRank} ${escapeHtml(otherName)}</span>`;
//   return `<span class="rank-delta down" title="${escapeHtml(otherName)} ranks this #${otherRank}">↓${thisRank - otherRank} ${escapeHtml(otherName)}</span>`;
// }

function renderHitsList(container, hits, opts = {}) {
  if (!opts.append) container.innerHTML = "";
  const startIndex = opts.startIndex || 0;
  currentTopScore = hits.reduce(
    (m, h) => (typeof h.score === "number" ? Math.max(m, h.score) : m),
    currentTopScore
  );
  const topScore = currentTopScore;

  hits.forEach((hit, i) => {
    const li = document.createElement("li");
    li.className = "result";
    const rank = String(startIndex + i + 1).padStart(2, "0");
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
    let metaHtml = `<span class="difficulty ${diffClass(diff)}">${escapeHtml(diff)}</span>${score}`;
    // COMPARE_MODE_DISABLED:
    // if (opts.otherRankMap) {
    //   const other = opts.otherRankMap.get(hit.problem.id);
    //   metaHtml = rankDeltaBadge(i + 1, other, opts.otherName) + metaHtml;
    // }
    meta.innerHTML = metaHtml;

    header.appendChild(title);
    header.appendChild(meta);

    if (currentUser) {
      header.appendChild(buildActions(hit));
    }

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
      ${hit.problem.source_url ? `<p><a href="${escapeHtml(hit.problem.source_url)}" target="_blank" rel="noopener">open original problem &rarr;</a></p>` : ""}
    `;

    header.addEventListener("click", () => {
      detail.classList.toggle("hidden");
    });

    li.appendChild(header);
    li.appendChild(bar);
    if (matched.childNodes.length > 0) li.appendChild(matched);
    li.appendChild(detail);
    container.appendChild(li);

    if (topScore > 0 && typeof hit.score === "number") {
      const pct = Math.max(2, Math.round((hit.score / topScore) * 100));
      requestAnimationFrame(() => {
        fill.style.width = `${pct}%`;
      });
    }
  });
}

function buildActions(hit) {
  const actions = document.createElement("span");
  actions.className = "result-actions";

  const bookmark = document.createElement("button");
  bookmark.type = "button";
  bookmark.className = "result-action bookmark";
  bookmark.title = hit.bookmarked ? "remove bookmark" : "bookmark this problem";
  bookmark.setAttribute("aria-pressed", String(!!hit.bookmarked));
  bookmark.textContent = hit.bookmarked ? "★" : "☆";
  bookmark.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFlag(hit, "bookmarked", bookmark);
  });

  const done = document.createElement("button");
  done.type = "button";
  done.className = "result-action done";
  done.title = hit.done ? "unmark as done" : "mark as done";
  done.setAttribute("aria-pressed", String(!!hit.done));
  done.textContent = hit.done ? "✓" : "○";
  done.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFlag(hit, "done", done);
  });

  actions.appendChild(bookmark);
  actions.appendChild(done);
  return actions;
}

async function toggleFlag(hit, flag, btn) {
  const next = !hit[flag];
  const path = flag === "done" ? "done" : "bookmark";
  btn.disabled = true;
  let res;
  try {
    res = await fetch(`/api/${path}/${encodeURIComponent(hit.problem.id)}`, {
      method: next ? "POST" : "DELETE",
    });
  } catch (_e) {
    btn.disabled = false;
    return;
  }
  btn.disabled = false;
  if (!res.ok) return;

  hit[flag] = next;
  if (flag === "bookmarked") {
    btn.textContent = next ? "★" : "☆";
    btn.title = next ? "remove bookmark" : "bookmark this problem";
  } else {
    btn.textContent = next ? "✓" : "○";
    btn.title = next ? "unmark as done" : "mark as done";
  }
  btn.setAttribute("aria-pressed", String(next));

  // If the active filter excludes this row now, re-run the search so the list
  // and the total stay honest.
  if (currentFilter === "done" && flag === "done" && !next) reissueSearch();
  if (currentFilter === "notdone" && flag === "done" && next) reissueSearch();
}

function reissueSearch() {
  if (!currentQuery) return;
  currentOffset = 0;
  runSearch(currentQuery, { append: false });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

setStatus("type a query to search");
