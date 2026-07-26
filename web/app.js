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

// Comparing rankers is a thing you do while tuning the engine, not while
// looking for a problem. It used to be a checkbox sitting above every search;
// as a command it costs nothing until you ask for it.
const COMPARE_COMMANDS = [":compare ", ":cmp "];
function compareQuery(q) {
  const lower = q.toLowerCase();
  for (const cmd of COMPARE_COMMANDS) {
    if (lower.startsWith(cmd)) return q.slice(cmd.length).trim();
  }
  return lower.trim() === ":compare" || lower.trim() === ":cmp" ? "" : null;
}

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
const judgeRow = document.getElementById("judge-row");
const judgeClearBtn = document.getElementById("judge-clear");
const latencySummaryEl = document.getElementById("latency-summary");
// The compare view is a fixed pair — renderCompare's delta badges are pairwise.
// Other registered rankers stay reachable via /api/compare?rankers=….
const COMPARE_RANKERS = ["bm25", "dense"];

const DEBOUNCE_MS = 200;
// How long a search may take before we admit to it. Under this, the answer
// lands first and the user never sees a "searching" flash; over it (a sleeping
// free-tier instance takes ~a minute to wake) they get told what's happening.
const SEARCHING_AFTER_MS = 400;
const TOP_K = 20;
let debounceTimer = null;
let lastQueryAt = 0;
let typeTimer = null;
let searchingTimer = null;
let inFlight = null; // aborts the request a newer keystroke just superseded
let currentQuery = "";
let currentOffset = 0;
let currentTotal = 0;
let currentTopScore = 0;
let currentUser = null;
// Read from the DOM, not assumed: browsers can restore a <select> across a
// soft reload, and a hardcoded "all" here would silently disagree with it.
let currentFilter = filterSelect.value || "all";
let activePattern = "";
const activePlatforms = new Set(); // empty = every judge
let activeRanker = ""; // "" = server default (bm25); set by the picker or ?ranker=
let compareMode = false;  // entered with :compare, left by any other query
let bootNeedsAuth = false; // restored state that only means something signed in
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
  // Typing a new question ends the drill-down that produced the pattern.
  //
  // Judges and patterns look like the same kind of filter and aren't. A judge
  // is a standing preference over ~500 problems, so carrying it into a new
  // query always leaves you something: across 5 queries x 4 judges, the
  // emptiest cell was still 14 results. A pattern is a drill-down into the
  // results you were just reading, and the median one covers a single problem
  // — 9 of 25 query x pattern pairs return nothing at all. Keeping it turns
  // the next search into a dead end you have to notice and undo.
  //
  // Clearing the box is different and still keeps it: that's browsing the
  // label, not asking a new question.
  if (activePattern && input.value.trim()) {
    activePattern = "";
    updatePatternPill();
  }
  debounceTimer = setTimeout(() => runSearch(input.value, { append: false }), DEBOUNCE_MS);
});

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



// Ranker picker. Plain word first (a newcomer picks by meaning), technical
// name second (this audience likes seeing it). tfidf and bm25-grpc are
// deliberately not offered — they're bench/debug rankers, still reachable
// with ?ranker= and on /debug.html.
const RANKER_LABELS = {
  bm25: "keyword · bm25",
  dense: "meaning · dense",
  hybrid: "both · hybrid",
  tfidf: "keyword · tfidf",
  "bm25-grpc": "keyword · go",
};
const PICKER_RANKERS = ["bm25", "dense", "hybrid"];

async function populateRankerSelect() {
  let data;
  try {
    const res = await fetch("/api/rankers");
    data = await res.json();
  } catch (_e) {
    return; // keep the static bm25 option
  }
  rankerSelect.innerHTML = "";
  for (const name of (data.available || []).filter((r) => PICKER_RANKERS.includes(r))) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = RANKER_LABELS[name] || name;
    rankerSelect.appendChild(opt);
  }
  if (data.corpusSize) {
    const el = document.getElementById("corpus-size");
    if (el) el.textContent = data.corpusSize.toLocaleString();
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
  if (e.key !== "Tab" || e.shiftKey || !currentUser) return;
  const cur = input.value.trim().toLowerCase();
  // Only cycle from an empty box or from a library command. With a real query
  // typed, Tab does its native job (move focus) instead of eating the query.
  if (cur && !TAB_CYCLE.includes(cur)) return;
  e.preventDefault();
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
  setStatus("logged out");
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
  // The boot search deliberately fires before this resolves — waiting on
  // /auth/me would add a round trip to every deep link. Two pieces of restored
  // state need a user though: the done filter, and a library command like
  // :bookmarks (which would otherwise be searched as a literal string). Those
  // re-issue once here instead of being silently dropped.
  const wasPending = bootNeedsAuth;
  bootNeedsAuth = false;
  if (wasPending && currentUser && currentQuery) reissueSearch();
}

function applyAuthState() {
  const anon = authWidget.querySelector("[data-anon]");
  const signed = authWidget.querySelector("[data-signed]");
  if (currentUser) {
    anon.hidden = true;
    signed.hidden = false;
    // Local part only — you know your own domain, and the full address is
    // what pushes the nav onto a second row (content caps at 720px).
    authEmailEl.textContent = String(currentUser.email).split("@")[0];
    authEmailEl.title = currentUser.email;
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

// Judge chips. Multi-select on purpose: "codeforces + atcoder" is a real way
// to think about practice, and the single-pick dropdown this replaced couldn't
// express it. Lives here rather than in the library bar so anonymous users get
// it too, and so it composes with :bookmarks / :done instead of fighting them.
judgeRow.querySelectorAll(".judge-chip[data-platform]").forEach((chip) => {
  chip.addEventListener("click", () => togglePlatformFilter(chip.dataset.platform));
});
judgeClearBtn.addEventListener("click", () => clearPlatformFilter());

// Says what's narrowing the current view, so an empty or short list explains
// itself instead of looking broken.
function activeFacets() {
  const bits = [];
  if (activePlatforms.size) bits.push([...activePlatforms].map((p) => (PLATFORM_LABELS[p] || [p])[0]).join("+"));
  if (currentUser && currentFilter !== "all") bits.push(currentFilter === "done" ? "done" : "not done");
  return bits;
}

function syncJudgeControls() {
  // An empty set means "every judge" — the server collapses none and all-four
  // to the same no-filter query. So the default has to render every chip as on:
  // showing them all off said "nothing is included", which is a state this
  // filter cannot actually reach and which implies an empty result set.
  const unfiltered = activePlatforms.size === 0;
  judgeRow.querySelectorAll(".judge-chip[data-platform]").forEach((chip) => {
    const on = unfiltered || activePlatforms.has(chip.dataset.platform);
    chip.classList.toggle("active", on);
    chip.setAttribute("aria-pressed", String(on));
  });
  // Quieter styling while it's the default, so four lit chips don't read as
  // four filters someone applied.
  judgeRow.classList.toggle("all-on", unfiltered);
  judgeClearBtn.classList.toggle("hidden", unfiltered);
}

function applyMode() {
  if (compareMode) {
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
  // An empty box with a filter still on isn't "nothing to show" — it's a
  // browse. Clearing your query keeps the active label and judges and lists
  // everything they select, which is what they claim to be doing.
  if (!q && (activePattern || activePlatforms.size)) {
    currentQuery = "";
    if (!append) currentOffset = 0;
    return runBrowse({ append });
  }
  if (!q) {
    setStatus("");
    resultsEl.innerHTML = "";
    currentQuery = "";
    currentOffset = 0;
    currentTotal = 0;
    hideLoadMore();
    hideFeedback();
    if (currentUser) setLibPath("~");
    syncUrl();
    return;
  }

  // :compare <query> — one-shot, leaves compare mode as soon as you search
  // for something else.
  const cmp = compareQuery(q);
  if (cmp !== null) {
    compareMode = true;
    applyMode();
    if (!cmp) {
      setStatus("compare: type a query after :compare");
      compareEl.innerHTML = "";
      return;
    }
    currentQuery = q;
    return runCompare(cmp);
  }
  if (compareMode) {
    compareMode = false;
    applyMode();
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
    syncUrl();
    return runLibrary(libraryType, q);
  }

  if (compareMode) return runCompare(q);

  // Search mode: path drops the leading tilde and shows the query so the bar
  // reads like a real shell prompt: ~/search "graph cycle".
  if (currentUser) setLibPath(`~/search "${q.length > 24 ? q.slice(0, 24) + "…" : q}"`);

  if (!append) {
    currentQuery = q;
    currentOffset = 0;
    currentTopScore = 0;
  }
  syncUrl();

  const issuedAt = ++lastQueryAt;
  // Deliberately not setStatus(): that runs the typewriter, so every keystroke
  // animated `searching: "..."` one character at a time and then the result
  // line restarted the animation on top of it. Two typewriters racing per
  // keystroke read as noise. This waits, and prints plainly if it fires.
  clearTimeout(searchingTimer);
  searchingTimer = setTimeout(() => {
    if (issuedAt !== lastQueryAt) return;
    clearTimeout(typeTimer);
    statusEl.textContent = `searching: "${q}"`;
  }, SEARCHING_AFTER_MS);
  const filterParam = currentUser && currentFilter !== "all" ? `&filter=${currentFilter}` : "";
  const patternParam = activePattern ? `&pattern=${encodeURIComponent(activePattern)}` : "";
  const rankerParam = activeRanker ? `&ranker=${encodeURIComponent(activeRanker)}` : "";
  const platformParam = activePlatforms.size ? `&platform=${encodeURIComponent([...activePlatforms].join(","))}` : "";
  const url = `/api/search?q=${encodeURIComponent(q)}&k=${TOP_K}&offset=${currentOffset}${filterParam}${patternParam}${rankerParam}${platformParam}`;

  let data;
  try {
    if (inFlight) inFlight.abort();
    inFlight = new AbortController();
    const res = await fetch(url, { signal: inFlight.signal });
    data = await res.json();
  } catch (err) {
    // A superseded request is the normal case while typing, not an error.
    if (err.name === "AbortError" || issuedAt !== lastQueryAt) return;
    clearTimeout(searchingTimer);
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
  // "ranked in", not a bare number. This clock wraps index.search() only — no
  // network, no JSON, no user-state read — so it ran 13-66x faster than the
  // round trip even on localhost, and far more than that over the wire. A bare
  // "0.373ms" next to results you waited a beat for is the same false precision
  // the per-result similarity scores had before they moved to /debug.
  const lat = typeof data.latencyMs === "number" ? ` · ranked in ${data.latencyMs.toFixed(3)}ms` : "";
  // Alias expansion is server-side; show what was added so the vocabulary is
  // learnable ("aliens trick" → +wqs binary search).
  const expanded = data.expandedQuery ? ` · +${data.expandedQuery.slice(q.length).trim()}` : "";
  const shown = currentOffset + data.hits.length;
  const total = currentTotal;
  const modeName = { bm25: "keyword", dense: "meaning", hybrid: "both" }[data.ranker] || data.ranker;
  // Dropped from this line: the query (it's in the box two rows up) and the
  // raw ranker id in parens (the picker already says "keyword · bm25"). What's
  // left is what nothing else on the page tells you.
  setStatus(`showing 1–${shown} of ${total} · ${modeName}${lat}${expanded}`);
  renderHitsList(resultsEl, data.hits, { append, startIndex: currentOffset });
}

// Filters with no query. Same wire format and the same result renderer as a
// search — only the ranking is absent, so results come back in corpus order
// and the status line says "browsing" rather than quoting a query nobody typed.
async function runBrowse({ append = false } = {}) {
  const issuedAt = ++lastQueryAt;
  hideFeedback();
  currentSearchId = null;
  currentRankerAnswered = "";
  const facets = activeFacets();
  const label = [activePattern, ...facets].filter(Boolean).join(" · ");
  if (currentUser) setLibPath(`~/browse ${label}`);
  syncUrl();

  const patternParam = activePattern ? `&pattern=${encodeURIComponent(activePattern)}` : "";
  const platformParam = activePlatforms.size ? `&platform=${encodeURIComponent([...activePlatforms].join(","))}` : "";
  const filterParam = currentUser && currentFilter !== "all" ? `&filter=${currentFilter}` : "";
  const url = `/api/search?q=&k=${TOP_K}&offset=${currentOffset}${patternParam}${platformParam}${filterParam}`;

  let data;
  try {
    if (inFlight) inFlight.abort();
    inFlight = new AbortController();
    const res = await fetch(url, { signal: inFlight.signal });
    data = await res.json();
  } catch (err) {
    if (err.name === "AbortError" || issuedAt !== lastQueryAt) return;
    setStatus(`error: ${err.message || "browse failed"}`);
    return;
  }
  if (issuedAt !== lastQueryAt) return;

  currentTotal = data.total || 0;
  if (!append) currentTopScore = 0;
  const hits = data.hits || [];
  if (!hits.length) {
    setStatus(`nothing matches ${label}`);
    resultsEl.innerHTML = "";
    hideLoadMore();
    return;
  }
  renderHitsList(resultsEl, hits, { append, startIndex: currentOffset, unranked: true });
  const shown = currentOffset + hits.length;
  setStatus(`browsing ${label} · ${shown} of ${currentTotal}`);
  updateLoadMore();
}

async function runLibrary(type, q) {
  const issuedAt = ++lastQueryAt;
  clearPatternFilter({ reissue: false }); // a saved list isn't a ranked search
  currentSearchId = null;
  currentRankerAnswered = "";
  hideFeedback();
  const facets = activeFacets();
  setLibPath(`~/${type}${facets.length ? " " + facets.join(" ") : ""}`);
  setStatus(`ls ~/${type}${facets.length ? " · " + facets.join(" · ") : ""}`);
  hideLoadMore();

  let data;
  try {
    // Judge and done filters carry into the library: "my bookmarked AtCoder
    // problems I haven't finished" is one of the reasons to save things at all.
    const platformParam = activePlatforms.size ? `&platform=${encodeURIComponent([...activePlatforms].join(","))}` : "";
    const doneParam = currentFilter !== "all" ? `&filter=${currentFilter}` : "";
    const res = await fetch(`/api/library?type=${encodeURIComponent(type)}${platformParam}${doneParam}`);
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
    // An empty list under a filter is a filter result, not an empty library —
    // say which, or it reads as data loss.
    const empty = facets.length
      ? `ls: nothing in ~/${type} matches ${facets.join(" · ")}`
      : type === "bookmarked"
      ? "ls: ~/bookmarked is empty — star ☆ a problem to save it here"
      : type === "done"
      ? "ls: ~/done is empty — mark ○ a problem to track it"
      : "ls: ~ is empty — bookmark or mark problems done from search";
    setStatus(empty);
    resultsEl.innerHTML = "";
    return;
  }

  setStatus(`${hits.length} ${type === "all" ? "saved" : type}${facets.length ? " · " + facets.join(" · ") : ""}`);
  renderHitsList(resultsEl, hits, { append: false, startIndex: 0, libraryMode: true });
}

// "Find similar" view: doc-to-doc cosine over the precomputed embeddings.
// Not a query search — the source problem's stored vector is the query, so
// there's no text in the input and no load-more.
async function runSimilar(problem) {
  const issuedAt = ++lastQueryAt;
  clearPatternFilter({ reissue: false }); // similar view is vector-driven, not filtered
  clearPlatformFilter({ reissue: false });
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
// label; clicking it clears it. Judges need no such pill — their own chips
// show which are on and carry the clear button.
function applyPatternFilter(pattern) {
  track("pattern_selected", { pattern });
  activePattern = pattern;
  updatePatternPill();
  // No slug-as-query substitution any more. It used to put "line sweep" in the
  // box so BM25 had something to rank, which meant the search box filled with
  // words you never typed — and clearing them dead-ended on a blank page. The
  // server browses a filter with no query now, so the box stays yours.
  currentOffset = 0;
  runSearch(input.value, { append: false });
}

function clearPatternFilter({ reissue = true } = {}) {
  if (!activePattern) return;
  activePattern = "";
  updatePatternPill();
  syncUrl();
  if (reissue && currentQuery) {
    currentOffset = 0;
    runSearch(currentQuery, { append: false });
  }
}

// The address bar mirrors what you're looking at. It used to be read-only —
// deep links worked, but only if you typed one by hand, so a refresh threw away
// your query, your judges and your filter.
//
// replaceState, never pushState: runSearch fires on every debounced keystroke,
// so pushing would bury the real previous page under "g", "gr", "gra". Back
// still leaves the app in one step, which is what people expect from a search
// box. Offset is deliberately absent — restoring page 5 would silently refetch
// everything above it.
function syncUrl() {
  const p = new URLSearchParams();
  if (currentQuery) p.set("q", currentQuery);
  if (activePattern) p.set("pattern", activePattern);
  if (activePlatforms.size) p.set("platform", [...activePlatforms].join(","));
  if (activeRanker) p.set("ranker", activeRanker);
  if (currentUser && currentFilter !== "all") p.set("filter", currentFilter);
  const qs = p.toString();
  const next = location.pathname + (qs ? `?${qs}` : "") + location.hash;
  if (next !== location.pathname + location.search + location.hash) {
    history.replaceState(null, "", next);
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

// The [lc] [cf] [atc] [cses] badge on every card doubles as the judge filter —
// click to narrow, click again to drop it, several at once to union them. Same
// post-rank filter as pattern chips, so it composes with them for free.
function togglePlatformFilter(platform) {
  if (activePlatforms.size === 0) {
    // Everything was included, so clicking one judge means "just this one" —
    // not "all except this one", which is what a plain checkbox would do and
    // is almost never what someone clicking a judge wants.
    activePlatforms.add(platform);
  } else if (activePlatforms.has(platform)) {
    // Turning off the last active judge lands back on "all", never on none.
    activePlatforms.delete(platform);
  } else {
    activePlatforms.add(platform);
  }
  track("platform_selected", { platform, active: [...activePlatforms].join(",") });
  syncJudgeControls();
  currentOffset = 0;
  if (currentQuery || input.value.trim()) runSearch(input.value || currentQuery, { append: false });
}

function clearPlatformFilter({ reissue = true } = {}) {
  if (!activePlatforms.size) return;
  activePlatforms.clear();
  syncJudgeControls();
  syncUrl();
  if (reissue && currentQuery) {
    currentOffset = 0;
    runSearch(currentQuery, { append: false });
  }
}

const HELP_TEXT = `COSINE(1)                                          the manual

SEARCH — pick a mode next to the box

  keyword    matches words in the title, the statement AND our technique
             labels. A problem that opens "Alice and Bob play a game..."
             never says "dp" — but its label does, so "game theory dp"
             still finds it. Best when you know the terms.

  meaning    describe it in plain english. "thief robbing houses" finds
             House Robber; "check if brackets close in order" finds Valid
             Parentheses. Best when you remember the story, not the words.

  both       runs the two and blends the rankings. Use it when unsure.

  Community names expand on their own: type "aliens trick" and the status
  line shows "+wqs binary search" — you get the results and the real name.

PATTERNS
  every expanded result lists technique labels — click one to
  narrow your search to that label; the pill clears it

  clear the query and the label stays: you're browsing every
  problem carrying it. Type a new query and the label drops —
  it was a drill-down into what you were reading, and most
  labels are narrow enough that keeping it would find nothing.
  Judges are not like this: they stay until you drop them.

  browse the whole taxonomy with counts: /patterns.html

FIND SIMILAR
  inside an expanded result: "find similar problems" lists the ten
  problems closest in meaning to that one — neighbours of the problem
  itself, not of your query. Built for upsolving: open the one that
  beat you, see its family.

FILTERS — they stack, and they stack with the library too

  judges       the lc / cses / cf / atc chips above the results, or
               the [lc] tag on any card. Pick as many as you like;
               "all ✕" drops them. Not a picker — a set.
  pattern      click a technique label inside a result
  all/notdone  the dropdown next to the ranker      (signed in)
  /done

  These compose. ":bookmarks" with cf+atc selected and "not done"
  is your unfinished Codeforces and AtCoder saves — the path and the
  status line always spell out what's narrowing the view.

SAVING                                             (signed in)
  ☆ / ★              bookmark a problem, on any result card
  ○ / ✓              mark it done — done marks feed your heatmap

LINKS
  the address bar follows what you're looking at — query, judges,
  pattern, ranker and filter all land in the URL, so refresh keeps
  your view and copying the URL shares exactly what you see:
  /?q=knapsack&platform=codeforces,atcoder&ranker=dense

CORPUS
  four judges, tagged [lc] [cf] [atc] [cses] on every result
  deliberately hard: no LeetCode Easy, Codeforces and AtCoder
  stratified from 1300 up — the number on the card is the rating

COMMANDS
  :help :h          this manual
  :compare :cmp     ":compare knapsack" runs the query in keyword
                    and meaning mode side by side, with rank deltas.
                    Any ordinary search leaves compare mode.
  :bookmarks :b     starred problems           (signed in)
  :done :d          problems marked done       (signed in)
  :all :lib         everything saved           (signed in)
  Tab               cycle library views        (signed in)

MORE
  handles + combined heatmap: /profile.html
  live usage + latency: /stats.html · scoring math: /debug.html`;

function renderHelp() {
  if (compareMode) {
    compareMode = false;
    applyMode();
  }
  clearPatternFilter({ reissue: false });
  hideLoadMore();
  hideFeedback();
  currentSearchId = null;
  currentRankerAnswered = "";
  if (currentUser) setLibPath("~/help");
  setStatus("man cosine");
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
  // Same deal as runSearch: compare runs on every keystroke too, so announcing
  // it up front animated a line nobody had time to read.
  clearTimeout(searchingTimer);
  searchingTimer = setTimeout(() => {
    if (issuedAt !== lastQueryAt) return;
    clearTimeout(typeTimer);
    statusEl.textContent = `comparing: "${q}"`;
  }, SEARCHING_AFTER_MS);
  hideLoadMore();

  let data;
  try {
    if (inFlight) inFlight.abort();
    inFlight = new AbortController();
    const res = await fetch(
      `/api/compare?q=${encodeURIComponent(q)}&k=10&rankers=${COMPARE_RANKERS.join(",")}`,
      { signal: inFlight.signal }
    );
    data = await res.json();
  } catch (err) {
    if (err.name === "AbortError" || issuedAt !== lastQueryAt) return;
    clearTimeout(searchingTimer);
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
  clearTimeout(searchingTimer);
  // The cursor shows only while the line is typing itself out. A blinking
  // block sitting under the box at rest reads as "type here" — a real user
  // lost minutes to exactly that.
  if (reduceMotion) {
    statusEl.textContent = text;
    return;
  }
  let i = 0;
  const tick = () => {
    i = Math.min(i + 1, text.length);
    const done = i >= text.length;
    statusEl.innerHTML = escapeHtml(text.slice(0, i)) + (done ? "" : '<span class="cursor">_</span>');
    if (!done) typeTimer = setTimeout(tick, 12);
  };
  tick();
}

// Two difficulty scales share one column: LeetCode's Easy/Medium/Hard (stored
// capitalized — this compared lowercase and silently coloured nothing) and the
// numeric ratings Codeforces and AtCoder use. Rating cuts follow div2 shape:
// A/B grade, C/D, then E and up.
function diffClass(d) {
  if (typeof d === "number") return d < 1600 ? "easy" : d < 2100 ? "medium" : "hard";
  const k = String(d || "").toLowerCase();
  return k === "easy" || k === "medium" || k === "hard" ? k : "";
}

// How each community actually refers to its judge, short enough to sit inline.
const PLATFORM_LABELS = {
  leetcode: ["lc", "LeetCode"],
  codeforces: ["cf", "Codeforces"],
  atcoder: ["atc", "AtCoder"],
  cses: ["cses", "CSES"],
};

function platformBadge(platform) {
  const [short, full] = PLATFORM_LABELS[platform] || [platform, platform];
  if (!short) return "";
  const on = activePlatforms.has(platform);
  return `<button type="button" class="platform-badge${on ? " active" : ""}" data-platform="${escapeHtml(platform)}"
    title="${escapeHtml(on ? `stop filtering to ${full}` : `only ${full}`)}">${escapeHtml(short)}</button>`;
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
  // A browse has no ranking, so a relevance bar would be drawing a number that
  // doesn't exist. Library lists are the same — they're ordered by when you
  // saved something, not by score.
  const ranked = !opts.unranked && !libraryMode;
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
    // No raw score on cards. It read as a precise "similarity %" it never was,
    // and the same 4-decimal number meant a BM25 score in one view and a
    // cosine in another. The bar below still shows relative strength; exact
    // numbers live on /debug.html where they're explained.
    const trailing = libraryMode ? formatRelative(hit.markedAt) : "";
    // CSES ships no difficulty, so this used to render an empty bordered chip —
    // visible furniture standing in for nothing.
    const diffHtml = diff === "" ? "" : `<span class="difficulty ${diffClass(diff)}">${escapeHtml(String(diff))}</span>`;
    let metaHtml = platformBadge(hit.problem.platform) + diffHtml + escapeHtml(trailing);
    if (opts.otherRankMap) {
      const other = opts.otherRankMap.get(hit.problem.id);
      metaHtml = rankDeltaBadge(i + 1, other, opts.otherName) + metaHtml;
    }
    meta.innerHTML = metaHtml;
    // The badge lives inside the header, which toggles the card open — so the
    // filter click has to stop there or every judge filter also expands a result.
    meta.querySelectorAll(".platform-badge").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        togglePlatformFilter(btn.dataset.platform);
      });
    });

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
    if (!ranked) bar.classList.add("hidden");

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

// Deep links, both directions: the URL is read here at boot and written by
// syncUrl() as you browse, so refresh, bookmark and share all keep the view.
const bootParams = new URLSearchParams(location.search);
const urlRanker = (bootParams.get("ranker") || "").trim().toLowerCase();
if (/^[a-z0-9-]{1,24}$/.test(urlRanker)) activeRanker = urlRanker;
populateRankerSelect();
const bootQ = (bootParams.get("q") || "").trim();
const bootPattern = (bootParams.get("pattern") || "").trim().toLowerCase();
const bootFilter = (bootParams.get("filter") || "").trim().toLowerCase();
if (["done", "notdone"].includes(bootFilter)) {
  currentFilter = bootFilter;
  filterSelect.value = bootFilter;
  bootNeedsAuth = true;
}
for (const p of (bootParams.get("platform") || "").toLowerCase().split(",")) {
  if (PLATFORM_LABELS[p.trim()]) activePlatforms.add(p.trim());
}
syncJudgeControls();
if (bootQ) input.value = bootQ;
if (LIBRARY_COMMANDS[bootQ.toLowerCase()]) bootNeedsAuth = true;
if (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(bootPattern)) {
  applyPatternFilter(bootPattern);
} else if (bootQ) {
  runSearch(bootQ, { append: false });
} else {
  setStatus("");
}

// Put the caret where typing actually goes. Pointer-fine only, so mobile
// keyboards don't spring open on load.
if (window.matchMedia("(pointer: fine)").matches) input.focus();
