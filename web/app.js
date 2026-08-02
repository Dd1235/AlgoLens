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
const libChips = libBar.querySelectorAll(".lib-chips .lib-chip");
const libBackChip = libBar.querySelector(".lib-chip-back");
const libAgeRow = document.getElementById("lib-age-row");
// Revision filters: "marked N+ days ago" and oldest-first. Library-only state,
// deliberately separate from the search filters — they mean nothing there.
let libAged = null;
let libOldest = false;
let libRecall = null;   // "again" | "hard" | "none" (unrated) | null (any)
let googleClientId = null;       // from /api/rankers; sheet feature hidden while null
let sheetSyncedThisSession = false;

// :help works for everyone, signed in or not. Parsed by helpQuery() below,
// which also takes a section name — this set is only the "is it a command"
// check for the unknown-command hint.
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
const difficultyRow = document.getElementById("difficulty-row");
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
let difficultyPayload = { named: [], rated: [], acceptance: null }; // controls, from /api/rankers
const bootRanges = []; // ?difficulty= ranges parked until the payload names their judge
let sortDir = null;    // null | "asc" | "desc" — difficulty order, one judge only
let sortWindow = 20;   // how many relevance-ranked results get reordered
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
// On a phone the algorithm name is what breaks the layout: at the 16px the
// iOS zoom fix mandates, plus the caret padding, "meaning · dense" pushes the
// submit button onto a third row. The mode is the part that matters to the
// person choosing; the algorithm is still in :help and the status line.
const RANKER_LABELS_SHORT = {
  bm25: "keyword",
  dense: "meaning",
  hybrid: "both",
  tfidf: "keyword",
  "bm25-grpc": "keyword",
};
const NARROW = typeof matchMedia === "function" ? matchMedia("(max-width: 720px)") : null;
const rankerLabel = (name) =>
  (NARROW && NARROW.matches ? RANKER_LABELS_SHORT[name] : RANKER_LABELS[name]) || name;

// hybrid is no longer registered server-side; the label stays in RANKER_LABELS
// so an old ?ranker=hybrid link still renders a sensible status line.
const PICKER_RANKERS = ["bm25", "dense"];

if (NARROW) {
  const relabel = () => {
    for (const opt of rankerSelect.options) opt.textContent = rankerLabel(opt.value);
  };
  if (NARROW.addEventListener) NARROW.addEventListener("change", relabel);
  else if (NARROW.addListener) NARROW.addListener(relabel); // older WebKit
}

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
    opt.textContent = rankerLabel(name);
    rankerSelect.appendChild(opt);
  }
  difficultyPayload = data.difficulty || { named: [], rated: [], acceptance: null };
  googleClientId = data.googleClientId || null;
  maybeInitSheets();
  // A range in the URL names a judge by its short form ("cf"), which only the
  // payload can resolve — so it is applied here rather than at boot.
  for (const [, short, lo, hi] of bootRanges.splice(0)) {
    const meta = (difficultyPayload.rated || []).find((r) => r.short === short);
    if (meta) activeRanges.set(meta.judge, { min: Number(lo), max: Number(hi) });
  }
  syncDifficultyControls();
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

const sheetBtnEl = document.getElementById("sheet-btn");
if (sheetBtnEl) sheetBtnEl.addEventListener("click", () => { doSheetSync(); });

// The age chips and oldest-first re-issue whatever library view is open.
if (libAgeRow) {
  libAgeRow.querySelectorAll(".lib-age").forEach((chip) => {
    chip.addEventListener("click", () => {
      libAged = chip.dataset.aged ? Number(chip.dataset.aged) : null;
      track("library_aged", { days: libAged || 0 });
      syncUrl();
      reissueCurrentView();
    });
  });
  const oldest = document.getElementById("lib-oldest");
  if (oldest) oldest.addEventListener("click", () => {
    libOldest = !libOldest;
    track("library_order", { oldest: libOldest });
    syncUrl();
    reissueCurrentView();
  });
  const recallSel = document.getElementById("lib-recall");
  if (recallSel) recallSel.addEventListener("change", () => {
    libRecall = recallSel.value || null;
    track("library_recall", { value: libRecall || "any" });
    syncUrl();
    reissueCurrentView();
  });
}

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
  // The profile page caches its whole response — handles included — under this
  // key so revisits paint instantly. It used to be cleared only when
  // /profile.html next loaded while signed out, so logging out from here left
  // someone's linked usernames sitting in localStorage on a shared machine.
  // Duplicated rather than imported: these two pages share no module.
  try { localStorage.removeItem("algolens_profile_v1"); } catch (_e) {}
  // Same shared-machine reasoning for the sheet pointer; the token itself was
  // never persisted, so dropping the in-memory state is the whole cleanup.
  if (typeof cosineSheets !== "undefined") cosineSheets.clearLocal();
  sheetSyncedThisSession = false;
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

// Sheets needs the client id (from /api/rankers) AND the signed-in user id
// (from /auth/me); whichever resolves second completes the init.
function maybeInitSheets() {
  if (typeof cosineSheets === "undefined") return;
  cosineSheets.init({
    clientId: googleClientId,
    userId: currentUser && currentUser.id,
    onChange: syncSheetChip,
  });
  syncSheetChip();
}

function syncSheetChip() {
  const wrap = document.getElementById("lib-sheet");
  if (!wrap) return;
  const usable = typeof cosineSheets !== "undefined" && cosineSheets.available();
  wrap.hidden = !usable;
  if (!usable) return;
  const btn = document.getElementById("sheet-btn");
  const open = document.getElementById("sheet-open");
  const connected = cosineSheets.connected();
  btn.textContent = connected ? "sync sheet" : "connect sheet";
  btn.title = "notes live in your own Google Sheet — nothing is stored on this server";
  open.hidden = !connected;
  if (connected) open.href = cosineSheets.url();
}

// Connect on first use, then sync; either way the status line says what
// happened — a background write to someone's Drive should never be silent.
async function doSheetSync() {
  const btn = document.getElementById("sheet-btn");
  if (btn) btn.disabled = true;
  try {
    if (!cosineSheets.connected()) await cosineSheets.connect();
    const res = await fetch("/api/library?type=all");
    const data = await res.json();
    const out = await cosineSheets.sync(data.items || []);
    sheetSyncedThisSession = true;
    setStatus(`sheet: ${out.total} rows · ${out.added} added · ${out.updated} updated`);
    // Notes may have arrived from the sheet; a library view should show them.
    if (currentUser && LIBRARY_COMMANDS[(currentQuery || "").toLowerCase()]) reissueCurrentView();
  } catch (err) {
    setStatus(`sheet: ${err.message || "sync failed"}`);
  } finally {
    if (btn) btn.disabled = false;
    syncSheetChip();
  }
}

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
  loadLevelSignals();
  maybeInitSheets();
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
    libCountBookmarks.hidden = false;
    libCountDone.hidden = false;
    refreshLibraryCounts();
    setLibPath("~");
  } else {
    anon.hidden = false;
    signed.hidden = true;
    filterWrap.hidden = true;
    filterSelect.value = "all";
    currentFilter = "all";
    // The bar and its command chips stay visible signed out. They are the only
    // place these commands are advertised now the tagline is gone, and a
    // feature nobody can see is a feature nobody uses.
    libBar.hidden = false;
    libCountBookmarks.hidden = true;
    libCountDone.hidden = true;
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
  if (libBackChip) libBackChip.hidden = path === "~";
  // The age row exists only where timestamps do — the three library views.
  // `path === "~"` was the wrong test: a search sets the path to `~/search
  // "..."`, so the chips showed there too, where clicking one is a no-op
  // (the filter resets the moment a non-library view re-issues).
  if (libAgeRow) {
    const inLibrary = /^~\/(bookmarked|done|all)\b/.test(path);
    libAgeRow.hidden = !inLibrary || !currentUser;
    libAgeRow.querySelectorAll(".lib-age").forEach((c) => {
      c.classList.toggle("is-active", String(libAged ?? "") === c.dataset.aged);
    });
    const oldest = document.getElementById("lib-oldest");
    if (oldest) oldest.classList.toggle("is-active", libOldest);
    const recallSelect = document.getElementById("lib-recall");
    if (recallSelect) recallSelect.value = libRecall || "";
  }
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

// Names whatever is narrowing the current view, so a short or empty library
// listing explains itself instead of looking broken.
//
// This was deleted by accident when the browse shuffle was reverted — the
// removal was done by slicing between two source markers, and this function sat
// between them. runLibrary still called it, so :bookmarks / :done / :all threw
// a ReferenceError and rendered nothing at all.
function orderNote() {
  if (sortDir) return ` · ${sortDir === "desc" ? "hardest" : "easiest"} first`;
  return libOldest ? " · oldest first" : "";
}

// Cache-only on the server, so this costs one indexed read and never makes the
// search page wait on leetcode.com. A signed-out user, or one who has never
// opened the profile page, simply doesn't get the button.
async function loadLevelSignals() {
  if (!currentUser || levelSuggest) return;
  try {
    const res = await fetch("/api/level");
    if (!res.ok) return;
    const data = await res.json();
    if (!data.suggest || !Object.keys(data.suggest).length) return;
    levelSuggest = data.suggest;
    syncDifficultyControls();
  } catch (_err) {
    // A missing button is the right failure here — never block the page.
  }
}

function activeFacets() {
  const bits = [];
  if (activePlatforms.size) bits.push([...activePlatforms].map((p) => (PLATFORM_LABELS[p] || [p])[0]).join("+"));
  for (const id of activeTiers) {
    const b = (difficultyPayload.named || []).find((x) => x.id === id);
    if (b) bits.push(b.label);
  }
  for (const [judge, r] of activeRanges) {
    const short = (PLATFORM_LABELS[judge] || [judge])[0];
    bits.push(r.min === r.max ? `${short} ${r.min}` : `${short} ${r.min}-${r.max}`);
  }
  if (activeAcceptance) bits.push(`ac ${activeAcceptance.min}-${activeAcceptance.max}%`);
  if (currentUser && currentFilter !== "all") bits.push(currentFilter === "done" ? "done" : "not done");
  if (libAged) bits.push(`marked ${libAged >= 180 ? "6mo" : libAged >= 90 ? "3mo" : "1mo"}+ ago`);
  if (libRecall) bits.push(libRecall === "none" ? "unrated" : `recall ${libRecall}`);
  return bits;
}

// Difficulty only means something inside one judge, so the row is built from
// whichever judges are currently selected. No judge selected means "all
// judges", and there is no scale that spans all four — so the row stays hidden
// rather than offering a choice that can't be honoured.
//
// Two control shapes, because the two kinds of scale differ in kind: LeetCode's
// three named tiers are chips, while Codeforces and AtCoder ratings get a
// from/to range. Fixed coarse bands could not express "only 1500-rated", and on
// Codeforces — where every rating is a multiple of 100 — that is a reasonable
// thing to want.
const activeTiers = new Set();     // named tiers, e.g. lc-hard
const activeRanges = new Map();    // judge -> { min, max }
let activeAcceptance = null;       // { min, max } — leetcode acceptance rate
let levelSuggest = null;           // judge -> { difficulty, why, count }, from /api/level

function difficultyParam() {
  const parts = [...activeTiers];
  for (const [judge, r] of activeRanges) {
    const meta = (difficultyPayload.rated || []).find((x) => x.judge === judge);
    if (meta) parts.push(`${meta.short}:${r.min}-${r.max}`);
  }
  if (activeAcceptance) parts.push(`ac:${activeAcceptance.min}-${activeAcceptance.max}`);
  return parts.join(",");
}

// Applies one `difficulty=` token to the live controls. The URL restore and
// the "my level" button both produce these tokens, so they parse in one place.
function applyDifficultyToken(token) {
  const t = String(token || "").trim().toLowerCase();
  if (!t) return;
  const range = /^([a-z]{2,4}):(-?\d+)-(-?\d+)$/.exec(t);
  if (range && range[1] === "ac") {
    activeAcceptance = { min: Number(range[2]), max: Number(range[3]) };
  } else if (range) {
    const meta = (difficultyPayload.rated || []).find((r) => r.short === range[1]);
    if (meta) activeRanges.set(meta.judge, { min: Number(range[2]), max: Number(range[3]) });
  } else if (/^[a-z]{2,3}-[a-z]+$/.test(t)) {
    activeTiers.add(t);
  }
}

// The suggestions that apply to what's on screen: a judge you haven't selected
// shouldn't have its band silently set behind a control you can't see.
function levelForSelection() {
  if (!levelSuggest) return [];
  return [...activePlatforms].map((j) => levelSuggest[j]).filter(Boolean);
}

function levelIsApplied() {
  const suggested = levelForSelection();
  if (!suggested.length) return false;
  const want = suggested.flatMap((s) => s.difficulty.split(",")).sort().join(",");
  const have = (difficultyParam() || "").split(",").filter(Boolean).sort().join(",");
  return want === have;
}

function syncDifficultyControls() {
  if (!difficultyRow) return;
  const payloadLoaded =
    (difficultyPayload.named || []).length ||
    (difficultyPayload.rated || []).length ||
    difficultyPayload.acceptance;
  if (!payloadLoaded) {
    // Boot order: this runs once before /api/rankers responds. Hide the row
    // but touch NO state — sortDir and boot-restored tiers must survive until
    // the payload can actually render them. Clearing here is how
    // ?platform=atcoder&sort=difficulty-asc used to boot unsorted.
    difficultyRow.classList.add("hidden");
    difficultyRow.innerHTML = "";
    return;
  }
  const judges = [...activePlatforms];
  const named = (difficultyPayload.named || []).filter((b) => activePlatforms.has(b.judge));
  const rated = (difficultyPayload.rated || []).filter((r) => activePlatforms.has(r.judge));

  if (!judges.length || (!named.length && !rated.length)) {
    // Dropping a judge drops its difficulty with it. Leaving a live "cf 1500"
    // filter active with Codeforces switched off would filter by something the
    // user can no longer see or clear.
    activeTiers.clear();
    activeRanges.clear();
    activeAcceptance = null;
    sortDir = null; // no scale on screen, so no order to sort by
    difficultyRow.classList.add("hidden");
    difficultyRow.innerHTML = "";
    return;
  }
  for (const id of [...activeTiers]) if (!named.some((b) => b.id === id)) activeTiers.delete(id);
  for (const j of [...activeRanges.keys()]) if (!rated.some((r) => r.judge === j)) activeRanges.delete(j);

  // Acceptance rate is only offered once a tier is chosen, because across tiers
  // it isn't comparable in this corpus — the Mediums here were selected FOR a
  // low acceptance rate and the Hards weren't. Picking the tier first is what
  // makes "the hardest Mediums" an honest question. So the control comes and
  // goes with the tier selection, and its value goes with it.
  const acc = difficultyPayload.acceptance;
  const accTiers = acc
    ? [...activeTiers].map((id) => named.find((b) => b.id === id)).filter((b) => b && b.judge === acc.judge)
    : [];
  if (!accTiers.length) activeAcceptance = null;

  // Acceptance rate belongs to LeetCode, so it is rendered as part of
  // LeetCode's group rather than appended after every judge — it used to sit
  // past the Codeforces rating range, which read as a third judge's control.
  let acceptanceHtml = "";
  if (accTiers.length) {
    // Bounds are the union of the SELECTED tiers, not of all LeetCode: the
    // Easies top out at 65% and the Mediums reach 90%, so a shared range would
    // offer stops that can never match what's on screen.
    const lo = Math.min(...accTiers.map((b) => (acc.tiers[b.label] || acc).min));
    const hi = Math.max(...accTiers.map((b) => (acc.tiers[b.label] || acc).max));
    const stops = acc.stops.filter((v) => v >= lo && v <= hi);
    const cur = activeAcceptance || { min: lo, max: hi };
    const opts = (selected) =>
      stops.map((v) => `<option value="${v}"${v === selected ? " selected" : ""}>${v}%</option>`).join("");
    acceptanceHtml =
      '<span class="difficulty-group acceptance-group"><span class="difficulty-label" title="acceptance rate — lower is harder">ac</span>' +
      '<select class="filter-select acceptance-select" data-edge="min" aria-label="minimum acceptance rate">' +
      `${opts(cur.min)}</select><span class="range-dash">to</span>` +
      '<select class="filter-select acceptance-select" data-edge="max" aria-label="maximum acceptance rate">' +
      `${opts(cur.max)}</select></span>`;
  }

  const groups = [];
  for (const judge of judges) {
    const short = (PLATFORM_LABELS[judge] || [judge])[0];
    const tiers = named.filter((b) => b.judge === judge);
    const range = rated.find((r) => r.judge === judge);
    if (!tiers.length && !range) continue;

    let body = "";
    if (tiers.length) {
      body = tiers
        .map(
          (b) =>
            `<button type="button" class="judge-chip difficulty-chip${activeTiers.has(b.id) ? " active" : ""}"` +
            ` data-tier="${escapeHtml(b.id)}"${b.count ? "" : " disabled"}>` +
            `${escapeHtml(b.label)}<span class="chip-count">${b.count}</span></button>`
        )
        .join("");
    } else {
      const cur = activeRanges.get(judge) || { min: range.min, max: range.max };
      const opts = (selected) =>
        range.stops
          .map((v) => `<option value="${v}"${v === selected ? " selected" : ""}>${v}</option>`)
          .join("");
      body =
        `<select class="filter-select rating-select" data-judge="${escapeHtml(judge)}" data-edge="min"` +
        ` aria-label="${escapeHtml(judge)} minimum rating">${opts(cur.min)}</select>` +
        `<span class="range-dash">to</span>` +
        `<select class="filter-select rating-select" data-judge="${escapeHtml(judge)}" data-edge="max"` +
        ` aria-label="${escapeHtml(judge)} maximum rating">${opts(cur.max)}</select>`;
    }
    groups.push(
      `<span class="difficulty-group"><span class="difficulty-label">${escapeHtml(short)}</span>${body}</span>`
    );
    if (acceptanceHtml && acc && judge === acc.judge) groups.push(acceptanceHtml);
  }

  // Sorting shares the difficulty row's rule — one judge, because there is no
  // order between "Medium" and 1600 — so it lives here rather than in the
  // search bar where it would look available all the time.
  const canSort = activePlatforms.size === 1 && (named.length > 0 || rated.length > 0);
  if (canSort) {
    const typed = (input.value.trim() || currentQuery || "").toLowerCase();
    // A ranking only exists for a real query. `:bookmarks` is a command, and the
    // library sorts the whole saved list — offering it a "top 20" would lie.
    const searching = !!typed && !(currentUser && LIBRARY_COMMANDS[typed]);
    groups.push(
      '<span class="difficulty-group sort-group"><span class="difficulty-label">sort</span>' +
        `<select class="filter-select" id="sort-select" aria-label="sort by difficulty">` +
        `<option value=""${!sortDir ? " selected" : ""}>${searching ? "relevance" : "default"}</option>` +
        `<option value="asc"${sortDir === "asc" ? " selected" : ""}>easiest first</option>` +
        `<option value="desc"${sortDir === "desc" ? " selected" : ""}>hardest first</option>` +
        "</select>" +
        // The window only exists while searching: with a query there IS a
        // relevance order worth protecting, so we reorder its top N rather
        // than discarding it. Browsing has no such order to protect.
        (sortDir && searching
          ? `<select class="filter-select" id="sort-window" aria-label="how many results to sort">` +
            [20, 50, 100].map((n) => `<option value="${n}"${n === sortWindow ? " selected" : ""}>top ${n}</option>`).join("") +
            "</select>"
          : "") +
        "</span>"
    );
  } else if (sortDir) {
    sortDir = null; // the judge that made it legal is gone
  }

  // "my level" sets each selected judge's band from that judge's own stats. It
  // only shows when there IS a suggestion for something on screen, so it can
  // never be a button that does nothing.
  const suggested = levelForSelection();
  if (suggested.length) {
    const applied = levelIsApplied();
    const why = suggested.map((x) => `${x.why} → ${x.count} problems`).join("; ");
    groups.push(
      `<button type="button" class="judge-chip level-chip${applied ? " active" : ""}" id="level-apply"` +
        ` title="${escapeHtml(why)}">${applied ? "my level ✓" : "my level"}</button>`
    );
  }

  if (activeTiers.size || activeRanges.size || activeAcceptance) {
    groups.push('<button type="button" class="judge-chip judge-clear" id="difficulty-clear" title="any difficulty">any ✕</button>');
  }
  difficultyRow.innerHTML = groups.join("");
  difficultyRow.classList.toggle("hidden", groups.length === 0);

  difficultyRow.querySelectorAll(".difficulty-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.tier;
      if (activeTiers.has(id)) activeTiers.delete(id);
      else activeTiers.add(id);
      track("difficulty_selected", { tier: id });
      afterDifficultyChange();
    });
  });
  difficultyRow.querySelectorAll(".rating-select").forEach((sel) => {
    sel.addEventListener("change", () => {
      const judge = sel.dataset.judge;
      const meta = rated.find((r) => r.judge === judge);
      const cur = activeRanges.get(judge) || { min: meta.min, max: meta.max };
      const v = Number(sel.value);
      const next = sel.dataset.edge === "min" ? { min: v, max: cur.max } : { min: cur.min, max: v };
      // Dragging one edge past the other is a slip, not an empty-set request.
      if (next.min > next.max) {
        if (sel.dataset.edge === "min") next.max = next.min;
        else next.min = next.max;
      }
      if (next.min === meta.min && next.max === meta.max) activeRanges.delete(judge);
      else activeRanges.set(judge, next);
      track("difficulty_selected", { judge, min: next.min, max: next.max });
      afterDifficultyChange();
    });
  });
  difficultyRow.querySelectorAll(".acceptance-select").forEach((sel) => {
    sel.addEventListener("change", () => {
      const lo = Math.min(...accTiers.map((b) => (acc.tiers[b.label] || acc).min));
      const hi = Math.max(...accTiers.map((b) => (acc.tiers[b.label] || acc).max));
      const cur = activeAcceptance || { min: lo, max: hi };
      const v = Number(sel.value);
      const next = sel.dataset.edge === "min" ? { min: v, max: cur.max } : { min: cur.min, max: v };
      if (next.min > next.max) {
        if (sel.dataset.edge === "min") next.max = next.min;
        else next.min = next.max;
      }
      activeAcceptance = next.min === lo && next.max === hi ? null : next;
      track("difficulty_selected", { acceptance: `${next.min}-${next.max}` });
      afterDifficultyChange();
    });
  });

  const sortSel = difficultyRow.querySelector("#sort-select");
  if (sortSel) sortSel.addEventListener("change", () => {
    sortDir = sortSel.value || null;
    track("sort_changed", { dir: sortDir || "relevance" });
    afterDifficultyChange();
  });
  const windowSel = difficultyRow.querySelector("#sort-window");
  if (windowSel) windowSel.addEventListener("change", () => {
    sortWindow = Number(windowSel.value) || 20;
    afterDifficultyChange();
  });

  const level = difficultyRow.querySelector("#level-apply");
  if (level) level.addEventListener("click", () => {
    const suggestions = levelForSelection();
    if (levelIsApplied()) {
      activeTiers.clear();
      activeRanges.clear();
      activeAcceptance = null;
      track("level_cleared", {});
    } else {
      activeTiers.clear();
      activeRanges.clear();
      activeAcceptance = null;
      for (const s of suggestions) for (const tok of s.difficulty.split(",")) applyDifficultyToken(tok);
      // Say what it did and why. A filter that changes the page without
      // explaining itself reads as a bug, and the reasoning is a guess worth
      // showing: these are proxies for your level, not measurements of it.
      setStatus(`my level · ${suggestions.map((x) => `${x.why} → ${x.count} problems`).join(" · ")}`);
      track("level_applied", { judges: suggestions.length });
    }
    afterDifficultyChange();
  });

  const clear = difficultyRow.querySelector("#difficulty-clear");
  if (clear) clear.addEventListener("click", () => {
    activeTiers.clear();
    activeRanges.clear();
    activeAcceptance = null;
    afterDifficultyChange();
  });
}

function afterDifficultyChange() {
  syncDifficultyControls();
  syncUrl();
  currentOffset = 0;
  reissueCurrentView();
}

// Re-runs whatever the user is looking at — a search, a browse, or a library
// listing — so a filter change behaves the same in all three. This used to
// hardcode runSearch, which meant changing a filter inside :bookmarks bounced
// you back to search results.
function reissueCurrentView() {
  const typed = input.value.trim();
  if (currentUser && LIBRARY_COMMANDS[typed.toLowerCase()]) return runSearch(typed, { append: false });
  if (typed || currentQuery) return runSearch(typed || currentQuery, { append: false });
  if (activePattern || activePlatforms.size) return runBrowse({ append: false });
  return undefined;
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
  syncDifficultyControls();
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

  const helpArg = helpQuery(q);
  if (helpArg !== null) {
    // Keep the query rather than blanking it, so syncUrl writes ?q=:help sheet
    // and a shared or refreshed link lands on the section it names.
    currentQuery = q;
    currentOffset = 0;
    currentTotal = 0;
    renderHelp(helpArg);
    syncUrl();
    return;
  }

  // Shell-style library commands.
  const libraryType = currentUser ? LIBRARY_COMMANDS[q.toLowerCase()] : null;
  if (!libraryType && (libAged || libOldest || libRecall)) {
    libAged = null;
    libOldest = false;
    libRecall = null;
  }
  // A leading colon means "command", and every real one has been matched by
  // now — so this is a typo or a half-typed command, not a question about
  // problems. Searching the corpus for ":bo" costs a round trip to say nothing.
  // Also stops the debounce firing a query per keystroke while someone types
  // ":bookmarks" one character at a time.
  if (!currentUser && LIBRARY_COMMANDS[q.toLowerCase()]) {
    // It IS a command — it just needs somewhere to save things to. Calling it
    // "not a command" (as the branch below would) reads as a broken feature.
    //
    // Keep currentQuery: on a refresh of `?q=:bookmarks` this runs BEFORE
    // /auth/me resolves, and bootstrapAuth re-issues only `if (wasPending &&
    // currentUser && currentQuery)`. Blanking it here made that condition
    // false, so the page sat on "needs an account" until you pressed enter
    // yourself — while signed in the whole time.
    currentQuery = q;
    currentOffset = 0;
    currentTotal = 0;
    hideLoadMore();
    hideFeedback();
    resultsEl.innerHTML = "";
    setStatus(`${q} needs an account — sign in to bookmark and track what you have solved`);
    return;
  }
  if (!libraryType && q.startsWith(":")) {
    currentQuery = "";
    currentOffset = 0;
    currentTotal = 0;
    hideLoadMore();
    hideFeedback();
    resultsEl.innerHTML = "";
    const known = currentUser
      ? ":help :bookmarks :done :all :compare"
      : ":help :compare  (sign in for :bookmarks, :done, :all)";
    setStatus(`${q} is not a command · try ${known}`);
    return;
  }
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
  const dp = difficultyParam();
  const bandParam = dp ? `&difficulty=${encodeURIComponent(dp)}` : "";
  const sortParam = sortDir ? `&sort=difficulty-${sortDir}` : "";
  // Sorting reorders a fixed window of the best matches, so the window size
  // replaces the page size — and paging is withdrawn, not silently broken.
  const pageSize = sortDir ? sortWindow : TOP_K;
  const url = `/api/search?q=${encodeURIComponent(q)}&k=${pageSize}&offset=${sortDir ? 0 : currentOffset}${filterParam}${patternParam}${rankerParam}${platformParam}${bandParam}${sortParam}`;

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
  // A sorted search is one fixed window of the best matches, not page 1 of
  // many — there is no coherent next page to offer.
  if (data.sortWindow) hideLoadMore();
  else updateLoadMore();
  if (!append) offerFeedback(data);
}

// "+extra words" when the expansion only added, "-> rewritten" when a phrase
// alias replaced what was typed. Showing the rewrite matters: the results for
// "square root decomposition" are really the results for "sqrt decomposition",
// and the user should be able to see that.
function describeExpansion(q, expandedQuery) {
  if (!expandedQuery || expandedQuery === q) return "";
  const lower = String(q).toLowerCase();
  if (expandedQuery.startsWith(lower)) {
    const extra = expandedQuery.slice(lower.length).trim();
    return extra ? ` · +${extra}` : "";
  }
  if (expandedQuery.startsWith(q)) {
    const extra = expandedQuery.slice(q.length).trim();
    return extra ? ` · +${extra}` : "";
  }
  return ` · → ${expandedQuery}`;
}

function renderSingle(data, q, append) {
  if (!data.hits || data.hits.length === 0) {
    if (!append) {
      // Name the words that matched nothing. "0 hits" reads as a broken search;
      // "no problem mentions deepya" tells you the corpus is finite and that
      // your query, not the engine, is the thing to change.
      const unknown = data.unknownTerms || [];
      setStatus(
        unknown.length
          ? `no problem mentions ${unknown.map((t) => `"${t}"`).join(" or ")} — try a technique, a title, or describe the problem`
          : `0 hits for "${q}"`
      );
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
  // Expansion used to only ever append, so slicing the original off the front
  // was enough. A phrase alias now REPLACES its span ("square root
  // decomposition" -> "sqrt decomposition"), which is shorter than the input
  // and shares no prefix with it — that slice produced a bare " · +".
  const expanded = describeExpansion(q, data.expandedQuery);
  // Say when a word was corrected. Silently searching for something the user
  // didn't type is the kind of helpfulness that reads as a bug.
  const fixed = (data.corrected || []).length
    ? ` · read ${data.corrected.map((c) => `${c.from} as ${c.to}`).join(", ")}`
    : "";
  const shown = currentOffset + data.hits.length;
  const total = currentTotal;
  const modeName = { bm25: "keyword", dense: "meaning", hybrid: "both" }[data.ranker] || data.ranker;
  // Dropped from this line: the query (it's in the box two rows up) and the
  // raw ranker id in parens. On a phone the picker shortens to just "keyword",
  // so this is the only place the mode is spelled out — keep it.
  if (data.sortWindow) {
    // Deliberately not "1-20 of 142": this is the top N by relevance, then
    // reordered. Saying "of 142" would imply a page 2 that cannot exist.
    setStatus(
      `top ${data.sortWindow} of ${total} by ${modeName}, ${sortDir === "desc" ? "hardest" : "easiest"} first${lat}${expanded}${fixed}`
    );
  } else {
    setStatus(`showing 1–${shown} of ${total} · ${modeName}${lat}${expanded}${fixed}`);
  }
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
  const dp = difficultyParam();
  const bandParam = dp ? `&difficulty=${encodeURIComponent(dp)}` : "";
  const sortParam = sortDir ? `&sort=difficulty-${sortDir}` : "";
  const url = `/api/search?q=&k=${TOP_K}&offset=${currentOffset}${patternParam}${platformParam}${filterParam}${bandParam}${sortParam}`;

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
  setStatus(`browsing ${label} · ${shown} of ${currentTotal}${orderNote()}`);
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
    const dp = difficultyParam();
    const bandParam = dp ? `&difficulty=${encodeURIComponent(dp)}` : "";
    const sortParam = sortDir ? `&sort=difficulty-${sortDir}` : "";
    const agedParam = libAged ? `&aged=${libAged}` : "";
    const orderParam = libOldest ? "&order=oldest" : "";
    const recallParam = libRecall ? `&recall=${encodeURIComponent(libRecall)}` : "";
    const res = await fetch(`/api/library?type=${encodeURIComponent(type)}${platformParam}${doneParam}${bandParam}${sortParam}${agedParam}${orderParam}${recallParam}`);
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
    recall: it.recall,
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

  setStatus(`${hits.length} ${type === "all" ? "saved" : type}${facets.length ? " · " + facets.join(" · ") : ""}${orderNote()}`);
  renderHitsList(resultsEl, hits, { append: false, startIndex: 0, libraryMode: true });
  // One background sync per session, on the first library view: cheap, and it
  // is the moment the sheet's mirror is actually being looked at.
  // Auto-sync only when a token is ALREADY in memory. Requesting one from a
  // background path is what nagged people with sign-in popups on every visit
  // (and popup blockers eat non-gesture requests anyway). A fresh session
  // syncs on the first explicit press of `sync sheet`, which is also the only
  // moment Google may show its popup — at most once per session, on a click.
  if (!sheetSyncedThisSession && typeof cosineSheets !== "undefined"
      && cosineSheets.connected() && cosineSheets.hasToken()) {
    sheetSyncedThisSession = true;
    doSheetSync();
  }
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
  const dParam = difficultyParam();
  if (dParam) p.set("difficulty", dParam);
  if (sortDir) p.set("sort", `difficulty-${sortDir}`);
  // Library-only state, written only when a library view is open so a plain
  // search URL never carries stale revision filters.
  if (currentUser && LIBRARY_COMMANDS[(currentQuery || "").toLowerCase()]) {
    if (libAged) p.set("aged", String(libAged));
    if (libOldest) p.set("order", "oldest");
    if (libRecall) p.set("recall", libRecall);
  }
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
  reissueCurrentView();
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

// The manual, as sections rather than one scroll. `:help` is an index plus
// the three lines that get someone searching; `:help filters` is one section.
// Addressable on purpose: the previous 180-line wall meant the answer to
// "can I see what I bookmarked but never solved?" was in there and nobody
// read far enough to find it.
//
// Kept as plain text in a <pre> (no HTML, so nothing here can inject) and
// wrapped to 64 columns, because `white-space: pre` scrolls sideways on a
// phone at any width the wrapper doesn't control.
const HELP_SECTIONS = [
  {
    name: "search",
    blurb: "the three modes, and which to use",
    body: `SEARCH — pick a mode next to the box

  keyword   matches words in the title, the statement AND our
            technique labels. A problem that opens "Alice and
            Bob play a game..." never says "dp" — but its label
            does, so "game theory dp" still finds it. Best when
            you know the terms.

  meaning   describe it in plain english. "thief robbing
            houses" finds House Robber; "check if brackets
            close in order" finds Valid Parentheses. Best when
            you remember the story, not the words.

  both      runs the two and blends the rankings. Use it when
            you are not sure.

  A problem's exact name goes to the top: "two sum" and "2 sum"
  both land on Two Sum. A word that appears nowhere in the
  corpus says so rather than guessing.

  Community names expand on their own: type "aliens trick" and
  the status line shows "+wqs binary search" — you get the
  results and the real name.

FIND SIMILAR
  inside an expanded result, "find similar problems" lists the
  ten problems closest in meaning to that one — neighbours of
  the problem itself, not of your query. Built for upsolving:
  open the one that beat you, see its family.

BROWSE
  a filter with no query lists everything it selects. Clear the
  box while a label or a judge is on and you get the whole set,
  paged.

CORPUS
  four judges, tagged [lc] [cf] [atc] [cses] on every card.
  Deliberately hard: no LeetCode Easy, Codeforces and AtCoder
  stratified from 1300 up — the number on the card is the
  rating.`,
  },
  {
    name: "patterns",
    blurb: "the technique vocabulary",
    body: `PATTERNS — what a problem IS, not what it says

  Statements hide their technique on purpose. The labels don't,
  which is why searching for one works at all.

  /patterns.html lists every label with counts, filterable.
  Type "dp" there and you get the whole family: digit-dp,
  tree-dp, slope-trick, state-compression. Click one to browse
  the problems carrying it. Useful when your exposure stops at
  one sheet and you don't yet know what to search for.

  Every expanded result lists its labels — click one to narrow
  to it; the pill clears it.

  Clear the query and the label stays: you are browsing every
  problem carrying it. Type a new query and the label drops —
  it was a drill-down into what you were reading, and most
  labels are narrow enough that keeping it would find nothing.
  Judges are not like this: they stay until you drop them.`,
  },
  {
    name: "filters",
    blurb: "judges, difficulty, sort, level, age, recall",
    body: `FILTERS — they stack

  A filter is a set, not a radio button: pick as many as you
  like. The status line spells out what is narrowing the view,
  and all of it lands in the URL, so a refresh keeps it and the
  link shares exactly what you see.

  judges       the lc / cses / cf / atc chips above the
               results, or the [lc] tag on any card. All four
               are on until you narrow. Turning the last one
               off returns to all four, so this filter can
               never find nothing. "all ✕" resets.

  difficulty   appears under the judges, in each judge's own
               scale: lc has three tiers, cf and atc a rating
               range you set both ends of — "cf 1500 to 1500"
               is exactly 1500. There is no shared scale across
               judges, so a difficulty only ever filters its
               own judge: narrowing cf to 1500 leaves your
               LeetCode results untouched rather than deleting
               them. Drop the judge and its difficulty goes
               with it.

  ac           pick a LeetCode tier and an acceptance-rate
               range appears under it: "hard" + "ac 10% to 30%"
               is the hardest Hards. Lower acceptance means
               harder. It appears only after a tier is chosen,
               because across tiers it doesn't compare — most
               Mediums here were picked FOR a low acceptance
               rate and every Hard came in regardless, so a 15%
               Medium outranking a 60% Hard would say more
               about how this corpus was built than about the
               problems.

  sort         with ONE judge selected: easiest or hardest
               first. Two judges have no shared order — nothing
               places a Medium against a 1600 — so it is
               offered only when it means something. Unrated
               problems sort last either way. While searching
               it reorders the top N (20/50/100) rather than
               discarding the ranking, so there is no next
               page; browsing sorts everything and pages. On
               LeetCode, acceptance rate breaks the tie inside
               a tier — otherwise "easiest first" is 661
               Mediums in no particular order.

  my level     appears when your profile has stats for a judge
               you have selected, and sets that judge's band
               from its own scale: Codeforces and AtCoder from
               your rating (your rating to +200 — a problem at
               your rating is roughly a coin flip, so the band
               is winnable but not free), LeetCode from your
               solved counts, since it publishes no rating.
               Hover it for the reasoning and the count; press
               it again to drop it.

  pattern      click a technique label inside a result

  IN THE LIBRARY                                   (signed in)

  all / not done / done   the dropdown next to the ranker

  marked       1mo+ / 3mo+ / 6mo+ keep only problems you marked
               at least that long ago, and "oldest first"
               starts from the longest ago. The age follows the
               view: :done by when you finished, :bookmarks by
               when you saved.

  recall       a dropdown beside the age chips: again / hard /
               medium / easy, or "unrated" for everything you
               never rated. See ":help saving".

  These compose. ":bookmarks" with cf+atc selected and "not
  done" is your unfinished Codeforces and AtCoder saves.
  ":done" with "again" and "3mo+" is a revision queue.

  Library filters are library-only: type an ordinary query and
  they drop, so a rating or an age can never quietly follow you
  into a search and delete results you meant to see.`,
  },
  {
    name: "saving",
    blurb: "bookmarks, done, and how the solve went",
    body: `SAVING                                             (signed in)

  ☆ / ★   bookmark a problem, on any result card
  ○ / ✓   mark it done — done marks feed your heatmap

  In your library, a saved problem grows a third chip: how it
  went. Tap it to cycle

    ·  →  A again  →  H hard  →  M medium  →  E easy  →  ·

  One letter, so the buttons don't change size under your
  thumb as you rate a page; the colour is the part you read.
  It only appears in :bookmarks / :done / :all — an ordinary
  search result keeps its two buttons.

  It saves as you tap, without waiting. If the save fails the
  letter goes back to what it was and the status line says so.

  It is optional and nothing is scheduled off it — it exists
  so that ":done" plus "again" is a list worth reopening.

  Rating does NOT change when you solved it, so re-rating an
  old solve never moves it out of "marked 3mo+".

  Un-bookmark AND un-mark the same problem and it leaves your
  library — but the rating is KEPT. Save it again months later
  and your "again" is still on it.

  Two things people ask for that already exist:

    ":bookmarks" with "not done" is everything you saved and
    never solved.

    Your sheet already has columns for status, time taken,
    concept, tactics, solution summary and notes — and you
    never type a row into it by hand. See ":help sheet".`,
  },
  {
    name: "sheet",
    blurb: "your notes, in your own Google Sheet",
    body: `SHEET — the sheet is the notebook, the site is the index

  "connect sheet" in the library bar makes a Google Sheet named
  "cosine notes" in YOUR Drive. This app created it, and it is
  the only file this app can see (drive.file scope — not your
  Drive). Nothing is stored here: the Google token lives in
  your browser tab and the notes live in your sheet. This
  server never sees either.

  You never add a row by hand. Bookmark or tick done on the
  site and sync writes the row for you — id, title, link,
  judge, difficulty, bookmarked, done, done date, recall. Those
  columns belong to the site and are rewritten each sync. A
  sheet you made before one of them existed gains it on the
  next sync, added to the RIGHT of everything in the sheet;
  nothing of yours is moved or overwritten.

  EVERYTHING ELSE IS YOURS, and is edited in the sheet itself:
  the suggested columns (status, time taken, concept, tactics,
  solution summary, notes — free-form, so "todo" is a status if
  you say it is), any columns you add after them, any rows you
  add. The app never writes, blanks or deletes any of it. It
  finds its own columns by their names in row 1, so reordering
  is safe, and a sheet made before a column existed simply
  doesn't get it. The site reads your columns and shows them on
  the expanded card (✎ marks an annotated problem).

  Google is asked for access once per browser session, and only
  when YOU press sync — never on page load. After that press,
  opening your library keeps the sheet current on its own.
  Notes you have already synced are cached in this browser, so
  a refresh shows them without contacting Google at all.

  Your cosine login and the Google account holding the sheet
  are independent. Connect a DIFFERENT Google account and the
  site says so plainly: that account cannot see the sheet,
  which is sitting safely in the first one.`,
  },
  {
    name: "commands",
    blurb: "everything that starts with a colon",
    body: `COMMANDS — a leading ":" means command, never a search

  So a typo like ":bo" tells you it isn't a command instead of
  spending a round trip searching the corpus for it.

  :help :h          this manual
  :help <section>   one section: search, patterns, filters,
                    saving, sheet, commands
  :compare :cmp     ":compare knapsack" runs the query in
                    keyword and meaning mode side by side, with
                    rank deltas. Any ordinary search leaves
                    compare mode.
  :bookmarks :b     starred problems              (signed in)
  :done :d          problems marked done          (signed in)
  :all :lib         everything saved              (signed in)
  Tab               cycle library views           (signed in)

LINKS
  the address bar follows what you are looking at — query,
  judges, difficulty, sort, pattern, ranker and library filters
  all land in it, so a refresh keeps your view and copying the
  URL shares exactly what you see:

    /?q=knapsack&platform=codeforces,atcoder&ranker=dense

MORE
  handles + combined heatmap: /profile.html
  live usage + latency:       /stats.html
  scoring math:               /debug.html`,
  },
];

const HELP_INDEX = `COSINE(1)                                          the manual

  A search engine for practice problems. Ask for a technique,
  describe the problem in plain english, or type the name you
  half-remember — it handles all three, and says so when a word
  appears nowhere in the corpus.

SECTIONS
${HELP_SECTIONS.map((s) => `  :help ${s.name.padEnd(11)}${s.blurb}`).join("\n")}

TRY
  two sum                exact names go to the top
  thief robbing houses   describe it, in "meaning" mode
  monotonic stack        a technique, not a word in the
                         statement
  :bookmarks             what you saved            (signed in)`;

// ":help", ":h", or either with one section name after it. Returns null when
// this isn't a help command at all, "" for the index, or the argument as
// typed — an unknown one falls back to the index rather than an error, since
// the index is the answer to "what can I ask for?" anyway.
function helpQuery(q) {
  const m = /^:(?:help|h)(?:\s+(.*))?$/i.exec(q.trim());
  return m ? (m[1] || "").trim().toLowerCase() : null;
}

function renderHelp(sectionName) {
  if (compareMode) {
    compareMode = false;
    applyMode();
  }
  clearPatternFilter({ reissue: false });
  hideLoadMore();
  hideFeedback();
  currentSearchId = null;
  currentRankerAnswered = "";
  const section = HELP_SECTIONS.find((sec) => sec.name === sectionName);
  if (currentUser) setLibPath(section ? `~/help/${section.name}` : "~/help");
  setStatus(section ? `man cosine ${section.name}` : "man cosine");
  resultsEl.innerHTML = "";
  const li = document.createElement("li");
  li.className = "result help-block";
  li.setAttribute("data-rank", "[man]");
  const pre = document.createElement("pre");
  pre.className = "help-man";
  pre.textContent = section
    ? `${section.body}\n\n  ← :help for the index`
    : HELP_INDEX;
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
  const expanded = describeExpansion(q, data.expandedQuery);
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
    if (typeof cosineSheets !== "undefined" && cosineSheets.connected()) {
      const note = cosineSheets.noteFor(hit.problem.id);
      const hasNotes = note && cosineSheets.userColumns().some((fld) => (note[fld.key] || "").trim());
      if (hasNotes) metaHtml += '<span class="note-mark" title="has notes in your sheet">✎</span>';
    }
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
      header.appendChild(buildActions(hit, libraryMode));
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
    if (typeof cosineSheets !== "undefined" && cosineSheets.connected()) {
      const noteView = buildNoteView(hit.problem.id);
      if (noteView) detail.appendChild(noteView);
    }

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

function buildActions(hit, libraryMode) {
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
  // The rating shows up in the LIBRARY only, and only on a row that is
  // actually saved. Searching is the busy surface — a third chip on every
  // result there is chrome you have to look past to read a title — while the
  // library is exactly where "how did that go?" is the question being asked.
  if (libraryMode && (hit.done || hit.bookmarked)) actions.appendChild(buildRecall(hit));
  return actions;
}

// One cycling chip rather than four buttons — the card grows by a single
// element, and "how did it go" is a one-tap answer at the moment you tick
// something done, which was the whole point (a separate sheet is friction
// nobody pays twice).
//
// It shows ONE character, always the same width as ☆ and ✓. The first cut
// wrote the word ("again", "med"), which made the chip a different size in
// every row and shoved the whole action group left and right as you rated
// things. The letter is explained by its tooltip, by the colour, and by
// `:help saving`.
const RECALL_CYCLE = [null, "again", "hard", "medium", "easy"];
const RECALL_LETTER = { again: "A", hard: "H", medium: "M", easy: "E" };
const RECALL_WORD = { again: "again", hard: "hard", medium: "medium", easy: "easy" };

function buildRecall(hit) {
  const btn = document.createElement("button");
  btn.type = "button";
  const paint = () => {
    const v = hit.recall || null;
    btn.className = `result-action recall${v ? ` recall-${v}` : ""}`;
    btn.textContent = v ? RECALL_LETTER[v] : "·";
    btn.title = v
      ? `how it went: ${RECALL_WORD[v]} — tap to change`
      : "rate how it went: again / hard / medium / easy";
    btn.setAttribute("aria-label", btn.title);
  };
  paint();
  btn.addEventListener("click", (e) => {
    e.stopPropagation(); // the header click toggles the card open
    const before = hit.recall || null;
    const next = RECALL_CYCLE[(RECALL_CYCLE.indexOf(before) + 1) % RECALL_CYCLE.length];
    // Optimistic: paint first, ask after. Four taps to get from unrated to
    // "easy" behind a disabled button and a spinner is unusable — and there
    // is nothing to lose by being wrong, since the only recovery a failure
    // needs is putting the old letter back.
    hit.recall = next || undefined;
    paint();
    track("recall_set", { problemId: hit.problem.id, value: next || "none" });
    fetch(`/api/recall/${encodeURIComponent(hit.problem.id)}/${next || "none"}`, { method: "PUT" })
      .then((res) => {
        if (res.ok) {
          // A recall filter may mean this row no longer belongs in the view.
          // Re-issue on the way out, never mid-cycle.
          if (libRecall && currentUser && LIBRARY_COMMANDS[(currentQuery || "").toLowerCase()]) {
            reissueCurrentView();
          }
          return;
        }
        hit.recall = before || undefined;
        paint();
        setStatus(res.status === 409 ? "rating needs a saved problem" : "could not save that rating");
      })
      .catch(() => {
        hit.recall = before || undefined;
        paint();
        setStatus("offline — rating not saved");
      });
  });
  return btn;
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

  // Un-saving something you had rated: the row leaves your library but the
  // rating is kept, and saying so beats letting someone discover it later.
  if (!next && !hit.done && !hit.bookmarked && hit.recall) {
    setStatus(`unsaved — your "${RECALL_WORD[hit.recall] || hit.recall}" rating is kept if you save it again`);
  }

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

// Read-only view of a problem's sheet row. The sheet is the editing surface —
// status, time taken, whatever columns the user invents live there, and the
// site just shows what it finds. No form means no save path, which means the
// Google token is only ever requested when the user presses sync.
//
// A problem with no notes gets NOTHING — not an empty form. Status and
// time-taken make no sense on a problem you just searched for and never
// attempted; the fields appear exactly where the user chose to write them.
function buildNoteView(problemId) {
  const note = cosineSheets.noteFor(problemId);
  if (!note) return null;
  // Whatever columns YOUR sheet has, in your order — not a fixed list of six.
  // Add a column called "revision date" and it shows up here.
  const filled = cosineSheets.userColumns().filter((fld) => (note[fld.key] || "").trim());
  if (!filled.length) return null;

  const wrap = document.createElement("div");
  wrap.className = "note-view";
  for (const fld of filled) {
    const row = document.createElement("div");
    row.className = "note-row";
    const cap = document.createElement("span");
    cap.className = "note-label";
    cap.textContent = fld.label;
    const val = document.createElement("span");
    val.className = "note-value";
    val.textContent = note[fld.key];
    row.appendChild(cap);
    row.appendChild(val);
    wrap.appendChild(row);
  }
  const edit = document.createElement("a");
  edit.className = "note-edit-link";
  edit.href = cosineSheets.url() || "#";
  edit.target = "_blank";
  edit.rel = "noopener";
  edit.textContent = "edit in your sheet ↗";
  edit.addEventListener("click", (e) => e.stopPropagation());
  wrap.appendChild(edit);
  return wrap;
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
const bootAged = Number.parseInt(bootParams.get("aged") || "", 10);
if ([30, 90, 180].includes(bootAged)) libAged = bootAged;
if ((bootParams.get("order") || "").toLowerCase() === "oldest") libOldest = true;
const bootRecall = (bootParams.get("recall") || "").trim().toLowerCase();
if (["again", "hard", "medium", "easy", "none"].includes(bootRecall)) libRecall = bootRecall;
const bootSort = (bootParams.get("sort") || "").trim().toLowerCase();
if (bootSort === "difficulty-asc" || bootSort === "difficulty") sortDir = "asc";
else if (bootSort === "difficulty-desc") sortDir = "desc";
const bootFilter = (bootParams.get("filter") || "").trim().toLowerCase();
if (["done", "notdone"].includes(bootFilter)) {
  currentFilter = bootFilter;
  filterSelect.value = bootFilter;
  bootNeedsAuth = true;
}
for (const p of (bootParams.get("platform") || "").toLowerCase().split(",")) {
  if (PLATFORM_LABELS[p.trim()]) activePlatforms.add(p.trim());
}
for (const tok of (bootParams.get("difficulty") || "").toLowerCase().split(",")) {
  const t = tok.trim();
  const range = /^([a-z]{2,4}):(-?\d+)-(-?\d+)$/.exec(t);
  // A judge range names its judge by a short form only the payload can resolve,
  // so it waits. "ac" names a quantity, and tiers are already canonical.
  if (range && range[1] !== "ac") bootRanges.push(range);
  else applyDifficultyToken(t);
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
