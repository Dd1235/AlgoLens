const input = document.getElementById("search-input");
const form = document.getElementById("search-form");
const resultsEl = document.getElementById("results");
const statusEl = document.getElementById("status");
const loadMoreEl = document.getElementById("load-more");
const filterSelect = document.getElementById("filter-select");
const filterWrap = document.getElementById("filter-wrap");
const rankerSelect = document.getElementById("ranker-select");
const authWidget = document.getElementById("auth-widget");
const authEmailEl = document.getElementById("auth-email");
const logoutBtn = document.getElementById("logout-btn");
const libBar = document.getElementById("lib-bar");
const libPathEl = document.getElementById("lib-path");
const libCountBookmarks = document.getElementById("lib-count-bookmarks");
const libCountDone = document.getElementById("lib-count-done");
const libChips = libBar.querySelectorAll(".lib-chip");

// :help works for everyone, signed in or not.
const HELP_COMMANDS = new Set([":help", ":h"]);

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

const compareEl = document.getElementById("compare-results");
const compareToggle = document.getElementById("compare-toggle");
const latencySummaryEl = document.getElementById("latency-summary");
// The compare view is a fixed pair — renderCompare's delta badges are pairwise.
// Other registered rankers stay reachable via /api/compare?rankers=….
const COMPARE_RANKERS = ["bm25", "dense"];

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
let activePattern = "";
let activeRanker = ""; // "" = server default (bm25); set by the picker or ?ranker=
let currentSearchId = null; // ties outcome beacons to the search that produced them
let currentRankerAnswered = "";

// Outcome beacon: fire-and-forget, survives page navigation via sendBeacon.
function track(type, props = {}) {
  const body = JSON.stringify({ type, props });
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon("/api/track", new Blob([body], { type: "application/json" }));
      return;
    }
  } catch (_e) {}
  fetch("/api/track", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => {});
}

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
  track("load_more", { searchId: currentSearchId, offset: currentOffset, ranker: currentRankerAnswered });
  runSearch(currentQuery, { append: true });
});

filterSelect.addEventListener("change", () => {
  currentFilter = filterSelect.value;
  if (currentQuery) runSearch(currentQuery, { append: false });
});

// Ranker picker: keyword (bm25), semantic (dense), or fused (hybrid).
// Options come from /api/rankers so only registered rankers show up.
const RANKER_LABELS = {
  tfidf: "tfidf · classic",
  bm25: "bm25 · keyword",
  dense: "dense · semantic",
  hybrid: "hybrid · both",
  "bm25-grpc": "bm25-grpc · go",
};

async function populateRankerSelect() {
  let data;
  try {
    const res = await fetch("/api/rankers");
    data = await res.json();
  } catch (_e) {
    return; // keep the static bm25 option
  }
  rankerSelect.innerHTML = "";
  for (const name of data.available || []) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = RANKER_LABELS[name] || name;
    rankerSelect.appendChild(opt);
  }
  rankerSelect.value = activeRanker || data.default || "bm25";
  if (!rankerSelect.value) rankerSelect.value = data.default || "bm25";
}

rankerSelect.addEventListener("change", () => {
  track("ranker_changed", { from: activeRanker || "bm25", to: rankerSelect.value });
  activeRanker = rankerSelect.value;
  currentOffset = 0;
  if (currentQuery) runSearch(currentQuery, { append: false });
});

// Clicking a library chip is the same as typing its command. Empty cmd means
// "leave library mode" — clears the input, returns to bm25 search.
libChips.forEach((chip) => {
  chip.addEventListener("click", () => {
    const cmd = chip.dataset.cmd || "";
    input.value = cmd;
    input.focus();
    if (cmd) runSearch(cmd, { append: false });
    else runSearch("", { append: false });
  });
});

// Tab inside the search input cycles through library commands when the user is
// signed in — picks up where they are in the LIBRARY_COMMANDS list.
const TAB_CYCLE = [":bookmarks", ":done", ":all"];
input.addEventListener("keydown", (e) => {
  if (e.key !== "Tab" || !currentUser) return;
  e.preventDefault();
  const cur = input.value.trim().toLowerCase();
  const idx = TAB_CYCLE.indexOf(cur);
  const next = TAB_CYCLE[(idx + 1) % TAB_CYCLE.length];
  input.value = next;
  runSearch(next, { append: false });
});

logoutBtn.addEventListener("click", async () => {
  try { await fetch("/api/auth/logout", { method: "POST" }); } catch (_e) {}
  currentUser = null;
  applyAuthState();
  clearPatternFilter({ reissue: false });
  // Clear results and the input — old results were rendered with bookmark
  // buttons that no longer apply, and we want anon UX from this point.
  input.value = "";
  currentQuery = "";
  resultsEl.innerHTML = "";
  hideLoadMore();
  setStatus("logged out · type a query to search");
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
    libBar.hidden = false;
    refreshLibraryCounts();
    setLibPath("~");
  } else {
    anon.hidden = false;
    signed.hidden = true;
    filterWrap.hidden = true;
    filterSelect.value = "all";
    currentFilter = "all";
    libBar.hidden = true;
  }
}

async function refreshLibraryCounts() {
  try {
    const res = await fetch("/api/user-state");
    if (!res.ok) return;
    const data = await res.json();
    libCountBookmarks.textContent = (data.bookmarked || []).length;
    libCountDone.textContent = (data.done || []).length;
  } catch (_e) {}
}

function setLibPath(path) {
  libPathEl.textContent = path;
  // Highlight the matching chip so the bar reads like a state indicator.
  libChips.forEach((c) => {
    const active =
      (path === "~/bookmarked" && c.dataset.cmd === ":bookmarks") ||
      (path === "~/done" && c.dataset.cmd === ":done") ||
      (path === "~/all" && c.dataset.cmd === ":all");
    c.classList.toggle("is-active", active);
  });
}

bootstrapAuth();

compareToggle.addEventListener("change", () => {
  applyMode();
  if (input.value.trim()) runSearch(input.value, { append: false });
});
applyMode();

function applyMode() {
  if (compareToggle.checked) {
    resultsEl.classList.add("hidden");
    compareEl.classList.remove("hidden");
    hideLoadMore();
  } else {
    resultsEl.classList.remove("hidden");
    compareEl.classList.add("hidden");
    latencySummaryEl.textContent = "";
  }
}

async function runSearch(rawQuery, { append = false } = {}) {
  const q = rawQuery.trim();
  if (!q) {
    setStatus("type a query to search · :help for the manual");
    resultsEl.innerHTML = "";
    currentQuery = "";
    currentOffset = 0;
    currentTotal = 0;
    hideLoadMore();
    hideFeedback();
    if (currentUser) setLibPath("~");
    return;
  }

  if (HELP_COMMANDS.has(q.toLowerCase())) {
    currentQuery = "";
    currentOffset = 0;
    currentTotal = 0;
    return renderHelp();
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

  if (compareToggle.checked) return runCompare(q);

  // Search mode: path drops the leading tilde and shows the query so the bar
  // reads like a real shell prompt: ~/search "graph cycle".
  if (currentUser) setLibPath(`~/search "${q.length > 24 ? q.slice(0, 24) + "…" : q}"`);

  if (!append) {
    currentQuery = q;
    currentOffset = 0;
    currentTopScore = 0;
  }

  const issuedAt = ++lastQueryAt;
  setStatus(`searching: "${q}"`);
  const filterParam = currentUser && currentFilter !== "all" ? `&filter=${currentFilter}` : "";
  const patternParam = activePattern ? `&pattern=${encodeURIComponent(activePattern)}` : "";
  const rankerParam = activeRanker ? `&ranker=${encodeURIComponent(activeRanker)}` : "";
  const url = `/api/search?q=${encodeURIComponent(q)}&k=${TOP_K}&offset=${currentOffset}${filterParam}${patternParam}${rankerParam}`;

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
  if (!append) {
    currentSearchId = data.searchId || null;
    currentRankerAnswered = data.ranker || "";
  }
  renderSingle(data, q, append);
  updateLoadMore();
  if (!append) offerFeedback(data);
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
  // Alias expansion is server-side; show what was added so the vocabulary is
  // learnable ("aliens trick" → +wqs binary search).
  const expanded = data.expandedQuery ? ` · +${data.expandedQuery.slice(q.length).trim()}` : "";
  const shown = currentOffset + data.hits.length;
  const total = currentTotal;
  setStatus(`showing 1–${shown} of ${total} for "${q}" via ${data.ranker}${lat}${expanded}`);
  renderHitsList(resultsEl, data.hits, { append, startIndex: currentOffset });
}

async function runLibrary(type, q) {
  const issuedAt = ++lastQueryAt;
  clearPatternFilter({ reissue: false }); // library views ignore the pattern filter
  currentSearchId = null;
  currentRankerAnswered = "";
  hideFeedback();
  setLibPath(`~/${type}`);
  setStatus(`ls ~/${type}`);
  hideLoadMore();

  let data;
  try {
    const res = await fetch(`/api/library?type=${encodeURIComponent(type)}`);
    data = await res.json();
  } catch (err) {
    if (issuedAt !== lastQueryAt) return;
    setStatus(`error: ${err.message || "library failed"}`);
    return;
  }
  if (issuedAt !== lastQueryAt) return;

  // Adapt library items to the renderHitsList hit shape.
  const hits = (data.items || []).map((it) => ({
    problem: it.problem,
    done: it.done,
    bookmarked: it.bookmarked,
    matchedTerms: [],
    markedAt: it.markedAt,
  }));

  currentTotal = hits.length;

  if (hits.length === 0) {
    const empty =
      type === "bookmarked"
        ? "ls: ~/bookmarked is empty — star ☆ a problem to save it here"
        : type === "done"
        ? "ls: ~/done is empty — mark ○ a problem to track it"
        : "ls: ~ is empty — bookmark or mark problems done from search";
    setStatus(empty);
    resultsEl.innerHTML = "";
    return;
  }

  setStatus(`${hits.length} ${type === "all" ? "saved" : type}`);
  renderHitsList(resultsEl, hits, { append: false, startIndex: 0, libraryMode: true });
}

// "Find similar" view: doc-to-doc cosine over the precomputed embeddings.
// Not a query search — the source problem's stored vector is the query, so
// there's no text in the input and no load-more.
async function runSimilar(problem) {
  const issuedAt = ++lastQueryAt;
  clearPatternFilter({ reissue: false }); // similar view is vector-driven, not filtered
  currentSearchId = null;
  currentRankerAnswered = "";
  hideFeedback();
  const shortTitle = problem.title.length > 24 ? problem.title.slice(0, 24) + "…" : problem.title;
  if (currentUser) setLibPath(`~/similar/${problem.id}`);
  setStatus(`similar to "${shortTitle}" · dense cosine`);
  hideLoadMore();

  let res, data;
  try {
    res = await fetch(`/api/similar/${encodeURIComponent(problem.id)}?k=10`);
    data = await res.json();
  } catch (err) {
    if (issuedAt !== lastQueryAt) return;
    setStatus(`error: ${err.message || "similar failed"}`);
    return;
  }
  if (issuedAt !== lastQueryAt) return;
  if (!res.ok) {
    setStatus(data.error || "similar unavailable");
    return;
  }

  // Leave query state so load-more / reissue logic doesn't fight this view;
  // typing or clicking a chip exits back to search.
  currentQuery = "";
  currentOffset = 0;
  currentTotal = 0;
  currentTopScore = 0;

  const lat = typeof data.latencyMs === "number" ? ` · ${data.latencyMs.toFixed(3)}ms` : "";
  setStatus(`${data.hits.length} similar to "${shortTitle}" · cosine over stored vectors${lat}`);
  renderHitsList(resultsEl, data.hits, { append: false, startIndex: 0 });
}

// "Was this useful?" — the one-line prompt under results. One answer per
// search; a "no" reveals an optional reason box. Reasons land in the events
// log and surface on /stats.html as the improvement backlog.
const feedbackRow = document.getElementById("feedback-row");
const feedbackAsk = feedbackRow.querySelector(".feedback-ask");
const fbYes = document.getElementById("fb-yes");
const fbNo = document.getElementById("fb-no");
const fbReason = document.getElementById("fb-reason");
const fbSend = document.getElementById("fb-send");
let feedbackSearchId = null;

function hideFeedback() {
  feedbackRow.classList.add("hidden");
}

function offerFeedback(data) {
  if (!data.searchId || !(data.hits || []).length) return hideFeedback();
  feedbackSearchId = data.searchId;
  feedbackAsk.textContent = "// useful?";
  fbYes.classList.remove("hidden");
  fbNo.classList.remove("hidden");
  fbReason.classList.add("hidden");
  fbSend.classList.add("hidden");
  fbReason.value = "";
  feedbackRow.classList.remove("hidden");
}

function sendFeedback(useful, reason) {
  track("search_feedback", {
    searchId: feedbackSearchId,
    useful,
    reason: reason || undefined,
    ranker: currentRankerAnswered || undefined,
    q: (currentQuery || "").slice(0, 100),
  });
  feedbackAsk.textContent = "// thanks, logged.";
  for (const el of [fbYes, fbNo, fbReason, fbSend]) el.classList.add("hidden");
}

fbYes.addEventListener("click", () => sendFeedback(true));
fbNo.addEventListener("click", () => {
  fbYes.classList.add("hidden");
  fbNo.classList.add("hidden");
  fbReason.classList.remove("hidden");
  fbSend.classList.remove("hidden");
  fbReason.focus();
});
fbSend.addEventListener("click", () => sendFeedback(false, fbReason.value.trim()));
fbReason.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    sendFeedback(false, fbReason.value.trim());
  }
});

const patternPill = document.getElementById("pattern-pill");
patternPill.addEventListener("click", () => clearPatternFilter());

// Pattern chips narrow search results to problems carrying that label (the
// server filters post-rank). The pill under the status line shows the active
// filter; clicking it clears the filter.
function applyPatternFilter(pattern) {
  track("pattern_selected", { pattern });
  activePattern = pattern;
  updatePatternPill();
  // Filtering needs a query to rank against; fall back to the label's words.
  if (!input.value.trim()) input.value = pattern.replace(/-/g, " ");
  currentOffset = 0;
  runSearch(input.value, { append: false });
}

function clearPatternFilter({ reissue = true } = {}) {
  if (!activePattern) return;
  activePattern = "";
  updatePatternPill();
  if (reissue && currentQuery) {
    currentOffset = 0;
    runSearch(currentQuery, { append: false });
  }
}

function updatePatternPill() {
  if (activePattern) {
    patternPill.textContent = `pattern: ${activePattern} ✕`;
    patternPill.classList.remove("hidden");
  } else {
    patternPill.classList.add("hidden");
  }
}

const HELP_TEXT = `ALGOLENS(1)                                        the manual

SEARCH — three ways to find a problem
  knapsack coin change       keyword: exact terms, bm25 scores them
  thief robbing houses       describe the idea: dense (minilm) bridges
                             the vocabulary gap — try /?ranker=dense
  wqs binary search          technique label: the curated taxonomy
  Aliases expand automatically: "aliens trick" -> +wqs binary search
  (the + in the status line shows what was added)

RANKERS
  bm25 (default) · tfidf · dense · hybrid (rrf fusion of bm25+dense)
  per request:  /?q=two+sum&ranker=hybrid
  the "compare rankers" toggle runs bm25 and dense side by side

PATTERNS
  every expanded result lists technique labels — click one to
  filter results to that label; the pill clears it
  browse the whole taxonomy with counts: /patterns.html

COMMANDS
  :help :h          this manual
  :bookmarks :b     starred problems           (signed in)
  :done :d          problems marked done       (signed in)
  :all :lib         everything saved           (signed in)
  Tab               cycles library views       (signed in)

MORE
  click a result to expand · "find similar" = cosine over the
  stored embeddings · handles + combined heatmap: /profile.html
  live usage + latency numbers: /stats.html`;

function renderHelp() {
  if (compareToggle.checked) {
    compareToggle.checked = false;
    applyMode();
  }
  clearPatternFilter({ reissue: false });
  hideLoadMore();
  hideFeedback();
  currentSearchId = null;
  currentRankerAnswered = "";
  if (currentUser) setLibPath("~/help");
  setStatus("man algolens");
  resultsEl.innerHTML = "";
  const li = document.createElement("li");
  li.className = "result help-block";
  li.setAttribute("data-rank", "[man]");
  const pre = document.createElement("pre");
  pre.className = "help-man";
  pre.textContent = HELP_TEXT;
  li.appendChild(pre);
  resultsEl.appendChild(li);
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

async function runCompare(q) {
  const issuedAt = ++lastQueryAt;
  hideFeedback();
  if (currentUser) setLibPath(`~/compare "${q.length > 24 ? q.slice(0, 24) + "…" : q}"`);
  setStatus(`comparing: "${q}"`);
  hideLoadMore();

  let data;
  try {
    const res = await fetch(
      `/api/compare?q=${encodeURIComponent(q)}&k=10&rankers=${COMPARE_RANKERS.join(",")}`
    );
    data = await res.json();
  } catch (err) {
    if (issuedAt !== lastQueryAt) return;
    setStatus(`error: ${err.message || "compare failed"}`);
    return;
  }
  if (issuedAt !== lastQueryAt) return;
  renderCompare(data, q);
}

function renderCompare(data, q) {
  hideLoadMore(); // compare has no pagination; clear any leftover button
  const results = data.results || [];
  if (results.length === 0) { setStatus("no rankers configured"); compareEl.innerHTML = ""; return; }
  const rankMaps = results.map((r) => {
    const m = new Map();
    r.hits.forEach((h, i) => m.set(h.problem.id, i + 1));
    return m;
  });
  const totalHits = results.reduce((s, r) => s + r.hits.length, 0);
  if (totalHits === 0) { setStatus(`0 hits for "${q}"`); compareEl.innerHTML = ""; latencySummaryEl.textContent = ""; return; }
  const expanded = data.expandedQuery ? ` · +${data.expandedQuery.slice(q.length).trim()}` : "";
  setStatus(`compare: "${q}"${expanded}`);
  latencySummaryEl.textContent = results.map((r) => `${r.ranker} ${r.latencyMs.toFixed(3)}ms`).join("  ·  ");
  compareEl.innerHTML = "";
  results.forEach((r, idx) => {
    const col = document.createElement("section");
    col.className = "compare-col";
    const head = document.createElement("div");
    head.className = "compare-col-head";
    head.innerHTML = `<span class="ranker-name">${escapeHtml(r.ranker)}</span><span class="ranker-latency" title="scoring latency for this query">${r.latencyMs.toFixed(3)}ms</span>`;
    col.appendChild(head);
    const list = document.createElement("ul");
    list.className = "compare-list";
    col.appendChild(list);
    if (r.hits.length === 0) {
      const empty = document.createElement("li"); empty.className = "compare-empty"; empty.textContent = "no hits"; list.appendChild(empty);
    } else {
      const otherIdx = idx === 0 ? 1 : 0;
      const otherMap = rankMaps[otherIdx];
      const otherName = results[otherIdx]?.ranker || "other";
      renderHitsList(list, r.hits, { otherRankMap: otherMap, otherName });
    }
    compareEl.appendChild(col);
  });
}

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

// Badge wording deliberately leads with "vs <other>" — the old form put the
// other ranker's name first and read as a label for the card's own column.
function rankDeltaBadge(thisRank, otherRank, otherName) {
  if (otherRank == null) return `<span class="rank-delta absent" title="not in ${escapeHtml(otherName)}'s top 10">vs ${escapeHtml(otherName)}: –</span>`;
  if (otherRank === thisRank) return `<span class="rank-delta same" title="same rank in ${escapeHtml(otherName)}">vs ${escapeHtml(otherName)}: =</span>`;
  if (otherRank > thisRank) return `<span class="rank-delta up" title="${escapeHtml(otherName)} ranks this #${otherRank}">vs ${escapeHtml(otherName)}: ↑${otherRank - thisRank}</span>`;
  return `<span class="rank-delta down" title="${escapeHtml(otherName)} ranks this #${otherRank}">vs ${escapeHtml(otherName)}: ↓${thisRank - otherRank}</span>`;
}

function renderHitsList(container, hits, opts = {}) {
  if (!opts.append) container.innerHTML = "";
  const startIndex = opts.startIndex || 0;
  const libraryMode = !!opts.libraryMode;
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
    const trailing = libraryMode
      ? formatRelative(hit.markedAt)
      : (typeof hit.score === "number" ? hit.score.toFixed(4) : "—");
    let metaHtml = `<span class="difficulty ${diffClass(diff)}">${escapeHtml(diff)}</span>${escapeHtml(trailing)}`;
    if (opts.otherRankMap) {
      const other = opts.otherRankMap.get(hit.problem.id);
      metaHtml = rankDeltaBadge(i + 1, other, opts.otherName) + metaHtml;
    }
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
      <p class="patterns"><strong>patterns:</strong> ${(hit.problem.patterns || [])
        .map((p) => `<button type="button" class="pattern-chip" data-pattern="${escapeHtml(p)}" title="filter results by this label">${escapeHtml(p)}</button>`)
        .join(" ")}</p>
      <p><a href="#" class="similar-link">find similar problems &rarr;</a>${
        hit.problem.source_url
          ? ` · <a href="${escapeHtml(hit.problem.source_url)}" class="external-link" target="_blank" rel="noopener">open original problem &rarr;</a>`
          : ""
      }</p>
    `;
    detail.querySelector(".similar-link").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      runSimilar(hit.problem);
    });
    detail.querySelectorAll(".pattern-chip").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        applyPatternFilter(btn.dataset.pattern);
      });
    });

    header.addEventListener("click", () => {
      const opening = detail.classList.contains("hidden");
      detail.classList.toggle("hidden");
      // The outcome signal: someone cared enough to open this result. Logged
      // once per card; position + searchId make CTR-per-ranker computable.
      if (opening && !li.dataset.opened) {
        li.dataset.opened = "1";
        track("result_open", {
          kind: "expand",
          problemId: hit.problem.id,
          position: startIndex + i + 1,
          searchId: currentSearchId || undefined,
          ranker: currentRankerAnswered || undefined,
        });
      }
    });
    const externalLink = detail.querySelector(".external-link");
    if (externalLink) {
      externalLink.addEventListener("click", () => {
        track("result_open", {
          kind: "external",
          problemId: hit.problem.id,
          position: startIndex + i + 1,
          searchId: currentSearchId || undefined,
          ranker: currentRankerAnswered || undefined,
        });
      });
    }

    li.appendChild(header);
    if (!libraryMode) li.appendChild(bar);
    if (matched.childNodes.length > 0) li.appendChild(matched);
    li.appendChild(detail);
    container.appendChild(li);

    if (!libraryMode && topScore > 0 && typeof hit.score === "number") {
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

  if (currentUser) refreshLibraryCounts();

  // If the active filter or library view would no longer include this row,
  // re-run so the listing and the total stay honest.
  if (currentFilter === "done" && flag === "done" && !next) reissueSearch();
  if (currentFilter === "notdone" && flag === "done" && next) reissueSearch();
  if (currentUser && LIBRARY_COMMANDS[(currentQuery || "").toLowerCase()]) reissueSearch();
}

function reissueSearch() {
  if (!currentQuery) return;
  currentOffset = 0;
  runSearch(currentQuery, { append: false });
}

function formatRelative(iso) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Deep links: /?pattern=wqs-binary-search, /?q=slope+trick, /?ranker=dense.
// Read-only — state is not written back to the URL while browsing.
const bootParams = new URLSearchParams(location.search);
const urlRanker = (bootParams.get("ranker") || "").trim().toLowerCase();
if (/^[a-z0-9-]{1,24}$/.test(urlRanker)) activeRanker = urlRanker;
populateRankerSelect();
const bootQ = (bootParams.get("q") || "").trim();
const bootPattern = (bootParams.get("pattern") || "").trim().toLowerCase();
if (bootQ) input.value = bootQ;
if (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(bootPattern)) {
  applyPatternFilter(bootPattern);
} else if (bootQ) {
  runSearch(bootQ, { append: false });
} else {
  setStatus("type a query to search · :help for the manual");
}
