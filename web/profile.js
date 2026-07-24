const statusEl = document.getElementById("profile-status");
const form = document.getElementById("handles-form");
const msgEl = document.getElementById("handles-msg");
const cardsEl = document.getElementById("platform-cards");
const heatmapSection = document.getElementById("heatmap-section");
const heatmapEl = document.getElementById("heatmap");
const heatmapMonthsEl = document.getElementById("heatmap-months");
const heatmapTotalEl = document.getElementById("heatmap-total");
const refreshLink = document.getElementById("refresh-link");

const PLATFORMS = ["leetcode", "codeforces", "codechef", "github"];
const inputs = Object.fromEntries(PLATFORMS.map((p) => [p, document.getElementById(`handle-${p}`)]));
const tabsEl = document.getElementById("heatmap-tabs");

let lastData = null;
let activeTab = "overall";
let currentUserId = null;

// Stale-while-revalidate: the last good profile response is kept in
// localStorage (keyed by user id, so accounts never see each other's data)
// and painted instantly on the next visit while a fresh fetch runs behind it.
const CACHE_KEY = "algolens_profile_v1";

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && parsed.userId === currentUserId ? parsed.data : null;
  } catch (_e) {
    return null;
  }
}

function saveCache(data) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ userId: currentUserId, data }));
  } catch (_e) {}
}

function clearCache() {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch (_e) {}
}

function setStatus(text) {
  statusEl.innerHTML = "";
  statusEl.append(text);
  const cursor = document.createElement("span");
  cursor.className = "cursor";
  cursor.textContent = "_";
  statusEl.appendChild(cursor);
}

function formatRelative(iso) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 60000) return "just now";
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function statCard(platform, stats) {
  const card = document.createElement("section");
  card.className = "platform-card";
  const name = document.createElement("h2");
  name.textContent = platform;
  card.appendChild(name);

  if (!stats) {
    const p = document.createElement("p");
    p.className = "card-dim";
    p.textContent = "no handle saved";
    card.appendChild(p);
    return card;
  }
  if (stats.unavailable) {
    const p = document.createElement("p");
    p.className = "card-dim";
    p.textContent = `unavailable (${stats.error || "fetch failed"}) — check the handle or refresh`;
    card.appendChild(p);
    return card;
  }

  // GitHub cards lead with contributions; judge cards lead with solved.
  const isDev = stats.contributions !== undefined;
  const big = document.createElement("p");
  big.className = "card-big";
  big.textContent = isDev
    ? stats.contributions != null ? String(stats.contributions) : "—"
    : stats.solved != null ? String(stats.solved) : "—";
  card.appendChild(big);
  const bigLabel = document.createElement("p");
  bigLabel.className = "card-dim";
  bigLabel.textContent = isDev
    ? `contributions (year)${stats.approximate ? " · approximate" : ""}`
    : "solved";
  card.appendChild(bigLabel);

  if (typeof stats.rating === "number") {
    const rating = document.createElement("p");
    rating.textContent = `rating ${stats.rating}`;
    card.appendChild(rating);
  }
  if (stats.byDifficulty && Object.keys(stats.byDifficulty).length) {
    const d = stats.byDifficulty;
    const split = document.createElement("p");
    split.className = "card-dim";
    split.textContent = `E ${d.easy ?? 0} · M ${d.medium ?? 0} · H ${d.hard ?? 0}`;
    card.appendChild(split);
  }
  const meta = document.createElement("p");
  meta.className = "card-meta";
  meta.textContent = `as of ${formatRelative(stats.fetchedAt)}${stats.stale ? " · cached" : ""}`;
  card.appendChild(meta);
  return card;
}

function renderCards(data) {
  cardsEl.innerHTML = "";
  for (const platform of PLATFORMS) {
    cardsEl.appendChild(statCard(platform, data.handles[platform] ? data.platforms[platform] : null));
  }
  const algolens = document.createElement("section");
  algolens.className = "platform-card";
  const name = document.createElement("h2");
  name.textContent = "algolens";
  algolens.appendChild(name);
  const big = document.createElement("p");
  big.className = "card-big";
  big.textContent = String(data.combined.algolensDone);
  algolens.appendChild(big);
  const label = document.createElement("p");
  label.className = "card-dim";
  label.textContent = "marked done here";
  algolens.appendChild(label);
  cardsEl.appendChild(algolens);
}

const DAY = 86400;

// Compose a heatmap view client-side from the per-source calendars the API
// already ships — dsa = judges + algolens done marks, dev = github, overall =
// everything. Tab switches never refetch.
function composeView(tab, data) {
  const categories = (data.combined || {}).categories || {};
  const merged = {};
  const add = (calendar) => {
    for (const [day, count] of Object.entries(calendar || {})) {
      merged[day] = (merged[day] || 0) + Number(count || 0);
    }
  };
  let sources = 0;
  for (const [platform, stats] of Object.entries(data.platforms || {})) {
    const cat = categories[platform] || "dsa";
    if (tab === "overall" || cat === tab) {
      add(stats.calendar);
      sources += 1;
    }
  }
  const algolensCat = categories.algolens || "dsa";
  if (tab === "overall" || algolensCat === tab) {
    add(((data.combined || {}).calendars || {}).algolens);
    sources += 1;
  }
  return { merged, sources };
}

function viewLabel(tab, total, data) {
  const approx = Object.values(data.platforms || {}).some((s) => s.approximate);
  if (tab === "dsa") return `${total} dsa marks in the last 53 weeks · judges + done here`;
  if (tab === "dev") {
    if (!(data.handles || {}).github) return "no dev sources yet — add a github handle above";
    return `${total} contributions in the last 53 weeks · github${approx ? " (approximate)" : ""}`;
  }
  return `${total} activity marks in the last 53 weeks · dsa + dev`;
}

function renderActiveTab() {
  if (!lastData) return;
  for (const btn of tabsEl.querySelectorAll("[data-tab]")) {
    btn.classList.toggle("is-active", btn.dataset.tab === activeTab);
  }
  const { merged } = composeView(activeTab, lastData);
  renderHeatmap(merged);
  heatmapTotalEl.textContent = viewLabel(
    activeTab,
    Object.values(merged).reduce((a, c) => a + c, 0),
    lastData
  );
}

tabsEl.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-tab]");
  if (!btn) return;
  activeTab = btn.dataset.tab;
  renderActiveTab();
});

// GitHub-style 53-week grid, column-major (grid-auto-flow: column with 7 rows
// = one column per week), starting on the Sunday 52 weeks back.
function renderHeatmap(heatmap) {
  heatmapEl.innerHTML = "";
  heatmapMonthsEl.innerHTML = "";
  const today = Math.floor(Date.now() / 1000 / DAY) * DAY;
  const todayDow = new Date(today * 1000).getUTCDay();
  const start = today - (52 * 7 + todayDow) * DAY;

  const counts = [];
  for (let d = start; d <= today; d += DAY) counts.push(heatmap[String(d)] || 0);
  const nonzero = counts.filter((c) => c > 0).sort((a, b) => a - b);
  const q = (p) => nonzero[Math.min(nonzero.length - 1, Math.floor(p * nonzero.length))] || 0;
  const thresholds = nonzero.length >= 4 ? [q(0.25), q(0.5), q(0.75)] : [1, 2, 4];
  const level = (c) => (c === 0 ? 0 : 1 + thresholds.filter((t) => c > t).length);

  let lastMonth = -1;
  let column = 0;
  for (let d = start; d <= today; d += DAY) {
    const c = heatmap[String(d)] || 0;
    const cell = document.createElement("span");
    cell.className = `hm hm-l${level(c)}`;
    const date = new Date(d * 1000);
    cell.title = `${c} on ${date.toISOString().slice(0, 10)}`;
    heatmapEl.appendChild(cell);

    if (date.getUTCDay() === 0) {
      const label = document.createElement("span");
      const month = date.getUTCMonth();
      if (month !== lastMonth && column !== 0) {
        label.textContent = date.toLocaleString("en", { month: "short", timeZone: "UTC" }).toLowerCase();
        lastMonth = month;
      }
      heatmapMonthsEl.appendChild(label);
      column += 1;
    }
  }
  heatmapSection.classList.remove("hidden");
}

function applyData(data, { fromCache = false } = {}) {
  for (const p of PLATFORMS) inputs[p].value = data.handles[p] || "";
  lastData = data;
  renderCards(data);
  renderActiveTab();
  const savedCount = Object.keys(data.handles).length;
  const base = savedCount
    ? `~/profile · ${data.combined.totalSolved} solved across judges · ${data.combined.algolensDone} done here`
    : "~/profile · add your handles to pull combined stats";
  setStatus(fromCache ? `${base} · cached, refreshing…` : base);
  if (!fromCache) saveCache(data);
}

async function fetchProfileJson(refresh) {
  const res = await fetch(`/api/profile${refresh ? "?refresh=1" : ""}`);
  if (!res.ok) throw new Error("profile failed");
  return res.json();
}

async function load(refresh) {
  if (!lastData) setStatus(refresh ? "refreshing stats" : "loading profile");
  try {
    applyData(await fetchProfileJson(refresh));
  } catch (_e) {
    // Keep whatever is on screen (possibly the cached paint); just say so.
    setStatus(lastData ? "refresh failed — showing last known stats" : "error: profile failed to load");
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  msgEl.textContent = "saving…";
  const body = Object.fromEntries(PLATFORMS.map((p) => [p, inputs[p].value.trim()]));
  let res;
  try {
    res = await fetch("/api/handles", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (_e) {
    msgEl.textContent = "network error";
    return;
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    msgEl.textContent = data.error === "bad_handle" ? "invalid handle" : "save failed";
    return;
  }
  msgEl.textContent = "saved";
  load(true);
});

refreshLink.addEventListener("click", (e) => {
  e.preventDefault();
  load(true);
});

// Gate: profile is meaningless anonymous — redirect to login (new convention
// for authed pages; index.html itself still degrades gracefully instead).
// The profile fetch starts in PARALLEL with the gate (it 401s harmlessly for
// anon), and the cached paint lands as soon as the gate confirms identity.
(async () => {
  const early = fetchProfileJson(false).catch(() => null);
  try {
    const res = await fetch("/api/auth/me");
    if (!res.ok) {
      clearCache();
      window.location.href = "/login.html";
      return;
    }
    currentUserId = ((await res.json()).user || {}).id || null;
  } catch (_e) {
    window.location.href = "/login.html";
    return;
  }

  const cached = readCache();
  if (cached) applyData(cached, { fromCache: true });
  else setStatus("loading profile");

  const fresh = await early;
  if (fresh) applyData(fresh);
  else load(false); // the parallel fetch raced a hiccup — one retry
})();
