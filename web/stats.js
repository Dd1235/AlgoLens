const statusEl = document.getElementById("stats-status");
const cardsEl = document.getElementById("stat-cards");
const barsEl = document.getElementById("daily-bars");
const rankerBody = document.querySelector("#ranker-table tbody");
const topEl = document.getElementById("top-queries");
const zeroEl = document.getElementById("zero-queries");

function card(label, big, dim) {
  const el = document.createElement("section");
  el.className = "platform-card";
  const h = document.createElement("h2");
  h.textContent = label;
  el.appendChild(h);
  const b = document.createElement("p");
  b.className = "card-big";
  b.textContent = String(big);
  el.appendChild(b);
  if (dim) {
    const d = document.createElement("p");
    d.className = "card-dim";
    d.textContent = dim;
    el.appendChild(d);
  }
  return el;
}

function queryList(el, rows) {
  el.innerHTML = "";
  if (!rows.length) {
    const li = document.createElement("li");
    li.className = "card-dim";
    li.textContent = "nothing yet";
    el.appendChild(li);
    return;
  }
  for (const { q, n } of rows) {
    const li = document.createElement("li");
    li.textContent = `${q} `;
    const count = document.createElement("span");
    count.className = "chip-count";
    count.textContent = `×${n}`;
    li.appendChild(count);
    el.appendChild(li);
  }
}

async function load() {
  let data;
  try {
    const res = await fetch("/api/stats");
    if (!res.ok) throw new Error("stats failed");
    data = await res.json();
  } catch (_e) {
    statusEl.textContent = "error: stats unavailable";
    return;
  }

  cardsEl.innerHTML = "";
  cardsEl.appendChild(card("visitors", data.visitors.day, `${data.visitors.week} this week · ${data.visitors.total} ever`));
  cardsEl.appendChild(card("searches", data.searches.week, `this week · ${data.searches.total} ever`));
  cardsEl.appendChild(card("signups", data.signups.total, `${data.signups.week} this week`));
  cardsEl.appendChild(
    card("cold starts", data.coldStarts.week, data.coldStarts.avg_boot_ms ? `7d · boots in ~${data.coldStarts.avg_boot_ms}ms` : "7d")
  );

  // 14-day bars: searches as the filled bar, visits as the tooltip context.
  barsEl.innerHTML = "";
  const max = Math.max(1, ...data.daily.map((d) => d.visits + d.searches));
  for (const d of data.daily) {
    const wrap = document.createElement("div");
    wrap.className = "daily-bar-wrap";
    wrap.title = `${d.day}: ${d.visits} visits, ${d.searches} searches`;
    const bar = document.createElement("div");
    bar.className = "daily-bar";
    bar.style.height = `${Math.max(4, Math.round(((d.visits + d.searches) / max) * 60))}px`;
    wrap.appendChild(bar);
    const label = document.createElement("span");
    label.className = "daily-bar-label";
    label.textContent = d.day.slice(5);
    wrap.appendChild(label);
    barsEl.appendChild(wrap);
  }
  if (!data.daily.length) barsEl.textContent = "no activity yet";

  rankerBody.innerHTML = "";
  for (const r of data.byRanker) {
    const tr = document.createElement("tr");
    for (const v of [r.ranker, r.searches, `${r.p50_ms}ms`, `${r.p95_ms}ms`]) {
      const td = document.createElement("td");
      td.textContent = String(v);
      tr.appendChild(td);
    }
    rankerBody.appendChild(tr);
  }

  queryList(topEl, data.topQueries);
  queryList(zeroEl, data.zeroHitQueries);

  statusEl.textContent = `~/stats · ${data.visitors.total} visitors ever · ${data.searches.total} searches served`;
}

load();
