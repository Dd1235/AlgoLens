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

document.getElementById("explain-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = document.getElementById("explain-input").value.trim();
  const out = document.getElementById("explain-out");
  if (!q) {
    out.innerHTML = '<p class="note">enter a query.</p>';
    return;
  }
  out.innerHTML = '<p class="note">explaining...</p>';
  const res = await fetch(`/api/explain?q=${encodeURIComponent(q)}`);
  const data = await res.json();

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

loadProblems();
