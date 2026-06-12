const tabs = document.querySelectorAll(".tab");
const panes = document.querySelectorAll(".pane");

tabs.forEach((t) =>
  t.addEventListener("click", () => {
    tabs.forEach((x) => x.classList.remove("active"));
    panes.forEach((p) => p.classList.remove("active"));
    t.classList.add("active");
    document.getElementById(`pane-${t.dataset.pane}`).classList.add("active");
    if (t.dataset.pane === "problems") loadProblems();
    if (t.dataset.pane === "index") loadIndex();
  })
);

function fmt(n, digits = 4) {
  return Number(n).toFixed(digits);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

let problemsLoaded = false;
async function loadProblems() {
  if (problemsLoaded) return;
  const out = document.getElementById("problems-out");
  out.innerHTML = '<p class="note">loading...</p>';
  const res = await fetch("/api/problems");
  const data = await res.json();
  out.innerHTML = data.problems
    .map(
      (p) => `
        <div class="problem-card">
          <strong>${escapeHtml(p.title)}</strong>
          <span class="meta">${escapeHtml(p.difficulty)} · ${(p.tags || []).map(escapeHtml).join(", ")}</span>
          <div class="meta">id: <code>${escapeHtml(p.id)}</code> · <a href="${escapeHtml(p.source_url)}" target="_blank" rel="noopener">source</a></div>
          <div class="meta">patterns: ${(p.patterns || []).map(escapeHtml).join(", ")}</div>
        </div>
      `
    )
    .join("");
  problemsLoaded = true;
}

let indexData = null;
async function loadIndex() {
  if (!indexData) {
    const out = document.getElementById("index-out");
    out.innerHTML = '<p class="note">loading...</p>';
    const res = await fetch("/api/index");
    indexData = await res.json();
  }
  renderIndex(document.getElementById("index-filter").value.trim().toLowerCase());
}

function renderIndex(filter) {
  const out = document.getElementById("index-out");
  const terms = filter
    ? indexData.terms.filter((t) => t.term.includes(filter))
    : indexData.terms;

  const head = `
    <div class="term-row head">
      <span>term</span>
      <span class="numeric">df</span>
      <span class="numeric">idf</span>
      <span>postings (id × count)</span>
    </div>
  `;
  const rows = terms
    .slice(0, 250)
    .map(
      (t) => `
        <div class="term-row">
          <span class="term">${escapeHtml(t.term)}</span>
          <span class="numeric">${t.df}</span>
          <span class="numeric">${fmt(t.idf, 4)}</span>
          <span class="postings">${t.docs
            .map((d) => `<span class="posting" title="${escapeHtml(d.title)}">${escapeHtml(d.id)} × ${d.count}</span>`)
            .join("")}</span>
        </div>
      `
    )
    .join("");
  const note =
    terms.length > 250
      ? `<p class="note">showing first 250 of ${terms.length} terms; refine the filter to narrow.</p>`
      : `<p class="note">${terms.length} term${terms.length === 1 ? "" : "s"}.</p>`;
  out.innerHTML = note + head + rows;
}

document.getElementById("index-filter").addEventListener("input", () => {
  if (indexData) renderIndex(document.getElementById("index-filter").value.trim().toLowerCase());
});

// Ranker selector for explain — dense and hybrid produce different payloads
// than the lexical rankers, dispatched on shape below.
const rankerSelect = document.getElementById("explain-ranker");
(async () => {
  try {
    const res = await fetch("/api/rankers");
    const data = await res.json();
    rankerSelect.innerHTML = (data.available || [])
      .map((r) => `<option value="${escapeHtml(r)}"${r === data.default ? " selected" : ""}>${escapeHtml(r)}</option>`)
      .join("");
  } catch (_e) {
    rankerSelect.innerHTML = "<option value=''>default</option>";
  }
})();

document.getElementById("explain-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = document.getElementById("explain-input").value.trim();
  const out = document.getElementById("explain-out");
  if (!q) {
    out.innerHTML = '<p class="note">enter a query.</p>';
    return;
  }
  out.innerHTML = '<p class="note">explaining...</p>';
  const rankerParam = rankerSelect.value ? `&ranker=${encodeURIComponent(rankerSelect.value)}` : "";
  const res = await fetch(`/api/explain?q=${encodeURIComponent(q)}${rankerParam}`);
  const data = await res.json();

  if (data.error) {
    out.innerHTML = `<p class="note">error: ${escapeHtml(data.error)}</p>`;
    return;
  }
  if (data.params && data.params.kRrf !== undefined) {
    renderHybridExplain(out, data);
    return;
  }
  if (data.model && !data.perTerm) {
    renderDenseExplain(out, data);
    return;
  }

  const perTerm = data.perTerm
    .map(
      (t) =>
        `<span class="posting" title="${t.skipped ? "skipped: " + t.skipped : ""}">${escapeHtml(t.term)} (df=${t.df}, idf=${t.idf === null ? "—" : fmt(t.idf, 3)}${t.skipped ? `, ${t.skipped}` : ""})</span>`
    )
    .join("");

  if (!data.docs || data.docs.length === 0) {
    out.innerHTML = `
      <p class="note">tokens: ${perTerm || "<em>(none)</em>"}</p>
      <p class="note">no documents matched.</p>
    `;
    return;
  }

  const docs = data.docs
    .map(
      (d) => `
        <div class="explain-doc">
          <h3>${escapeHtml(d.problem.title)}<span class="total">total ${fmt(d.total, 4)}</span></h3>
          <table class="explain-table">
            <thead>
              <tr>
                <th>term</th>
                <th>count</th>
                <th>doc len</th>
                <th>tf</th>
                <th>idf</th>
                <th>contribution</th>
              </tr>
            </thead>
            <tbody>
              ${d.terms
                .map(
                  (t) => `
                    <tr>
                      <td class="term">${escapeHtml(t.term)}</td>
                      <td class="numeric">${t.count}</td>
                      <td class="numeric">${t.docLength}</td>
                      <td class="numeric">${fmt(t.tf, 4)}</td>
                      <td class="numeric">${fmt(t.idf, 4)}</td>
                      <td class="numeric">${fmt(t.contribution, 4)}</td>
                    </tr>
                  `
                )
                .join("")}
            </tbody>
          </table>
        </div>
      `
    )
    .join("");

  out.innerHTML = `
    <p class="note">tokens: ${perTerm || "<em>(none after stopword removal)</em>"}</p>
    ${docs}
  `;
});

// Dense explain: no terms, no postings — every doc gets a query·doc cosine.
function renderDenseExplain(out, data) {
  const rows = data.docs
    .map(
      (d, i) => `
        <tr>
          <td class="numeric">${i + 1}</td>
          <td class="term">${escapeHtml(d.problem.title)}</td>
          <td class="numeric">${fmt(d.score, 4)}</td>
          <td class="numeric">${fmt(d.angleDeg, 1)}&deg;</td>
        </tr>
      `
    )
    .join("");
  out.innerHTML = `
    <p class="note">${escapeHtml(data.model)} · ${data.dims}d · dtype=${escapeHtml(data.dtype)} ·
      query embed ${fmt(data.embedMs, 2)}ms · full-corpus scan (${data.count} docs) ${fmt(data.scanMs, 2)}ms</p>
    <p class="note">${escapeHtml(data.note)}</p>
    <div class="explain-doc">
      <table class="explain-table">
        <thead><tr><th>#</th><th>problem</th><th>cosine</th><th>angle</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// Hybrid explain: each leg's top-10, then the fused ranking with per-leg
// 1/(k + rank) contributions.
function renderHybridExplain(out, data) {
  const legChips = (leg) =>
    leg
      .map((l) => `<span class="posting" title="score ${fmt(l.score, 4)}">#${l.rank} ${escapeHtml(l.id)}</span>`)
      .join("");
  const rows = data.docs
    .map(
      (d, i) => `
        <tr>
          <td class="numeric">${i + 1}</td>
          <td class="term">${escapeHtml(d.problem.title)}</td>
          <td class="numeric">${d.lexRank === null ? "—" : "#" + d.lexRank}</td>
          <td class="numeric">${d.denseRank === null ? "—" : "#" + d.denseRank}</td>
          <td class="numeric">${d.lexRank === null ? "—" : fmt(d.lexContribution, 5)}</td>
          <td class="numeric">${d.denseRank === null ? "—" : fmt(d.denseContribution, 5)}</td>
          <td class="numeric">${fmt(d.total, 5)}</td>
        </tr>
      `
    )
    .join("");
  out.innerHTML = `
    <p class="note">${escapeHtml(data.note)}</p>
    <p class="note">${escapeHtml(data.params.lexical)} top-10: ${legChips(data.legs.lexical)}</p>
    <p class="note">${escapeHtml(data.params.dense)} top-10: ${legChips(data.legs.dense)}</p>
    <div class="explain-doc">
      <table class="explain-table">
        <thead>
          <tr>
            <th>#</th><th>problem</th>
            <th>${escapeHtml(data.params.lexical)} rank</th><th>dense rank</th>
            <th>1/(k+r) lex</th><th>1/(k+r) dense</th><th>total</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

loadProblems();
