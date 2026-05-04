const form = document.getElementById("search-form");
const input = document.getElementById("search-input");
const resultsEl = document.getElementById("results");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = input.value.trim();
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
  const data = await res.json();
  render(data.hits);
});

function render(hits) {
  resultsEl.innerHTML = "";
  for (const hit of hits) {
    const li = document.createElement("li");
    const tags = (hit.problem.tags || []).join(", ");
    li.textContent = `${hit.problem.title} [${hit.problem.difficulty}] — ${tags}`;
    resultsEl.appendChild(li);
  }
}
