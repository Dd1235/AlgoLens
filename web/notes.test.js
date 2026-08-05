// Notes: the markdown renderer and the local-first store.
//
// Two things are worth pinning. The renderer builds DOM nodes rather than
// HTML strings, and the reason is security — the text comes out of a
// spreadsheet cell anyone with the link could have typed into — so the test
// feeds it a `<script>` and checks it stays text. The store has to survive a
// page reload with nothing written to Google, because that is the whole
// point of writing notes on the site at all.
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// ── a DOM small enough to read, big enough for these two functions ──────────
function makeDom() {
  const mk = (tag) => ({
    tagName: tag.toUpperCase(),
    className: "",
    dataset: {},
    childNodes: [],
    get textContent() {
      return this._text != null ? this._text : this.childNodes.map((c) => c.textContent).join("");
    },
    set textContent(v) { this._text = String(v); this.childNodes = []; },
    appendChild(c) { this._text = null; this.childNodes.push(c); return c; },
  });
  return {
    createElement: mk,
    createTextNode: (t) => ({ tagName: "#text", textContent: String(t), childNodes: [] }),
  };
}

const src = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
const start = src.indexOf("function renderNoteMarkdown(");
const end = src.indexOf("\n}", src.indexOf("function inlineNoteMarkdown(")) + 2;
assert.ok(start > -1 && end > start, "could not find the note renderer in app.js");
const ctx = vm.createContext({ document: makeDom(), console });
vm.runInContext(src.slice(start, end) + "\n;this.renderNoteMarkdown = renderNoteMarkdown;", ctx);
const render = ctx.renderNoteMarkdown;

// Walk the tree the way a browser would, so assertions read like the output.
const kinds = (node) => node.childNodes.map((c) => c.tagName);
const texts = (node) => node.childNodes.map((c) => c.textContent);
function find(node, tag, out = []) {
  for (const c of node.childNodes || []) {
    if (c.tagName === tag) out.push(c);
    find(c, tag, out);
  }
  return out;
}

// ── code blocks ─────────────────────────────────────────────────────────────
// The reason this format exists: a solution note is mostly code.
{
  const out = render("the trick:\n```cpp\nfor (int i = 0; i < n; i++)\n  sum += a[i];\n```\ndone");
  const pre = find(out, "PRE");
  assert.equal(pre.length, 1, "one code block");
  assert.equal(pre[0].textContent, "for (int i = 0; i < n; i++)\n  sum += a[i];");
  assert.equal(pre[0].dataset.lang, "cpp", "the fence language is kept");
  assert.deepEqual(texts(out).filter((t) => !t.startsWith("for")), ["the trick:", "done"]);
}

// An unterminated fence is a note someone was in the middle of writing. It
// must render, not swallow the rest of the note or loop forever.
{
  const out = render("start\n```\nint x = 1;");
  assert.equal(find(out, "PRE")[0].textContent, "int x = 1;");
}

// ── inline ──────────────────────────────────────────────────────────────────
{
  const out = render("use a **monotonic** stack, see `push_back`");
  assert.deepEqual(find(out, "STRONG").map((n) => n.textContent), ["monotonic"]);
  assert.deepEqual(find(out, "CODE").map((n) => n.textContent), ["push_back"]);
  assert.equal(out.textContent, "use a monotonic stack, see push_back", "markers are consumed");
}

// ** must win over *, or bold renders as two stray asterisks.
{
  const out = render("**both** ends");
  assert.deepEqual(find(out, "STRONG").map((n) => n.textContent), ["both"]);
}

// ── lists and headings ──────────────────────────────────────────────────────
{
  const out = render("## idea\n- sort first\n- two pointers\n\nthen sweep");
  assert.equal(find(out, "UL").length, 1, "consecutive bullets are one list");
  assert.deepEqual(find(out, "LI").map((n) => n.textContent), ["sort first", "two pointers"]);
  assert.equal(find(out, "STRONG")[0].textContent, "idea");
  assert.ok(out.textContent.includes("then sweep"));
}

// ── the security property ───────────────────────────────────────────────────
// Nothing here ever becomes markup. The note came from a spreadsheet cell.
{
  const nasty = '<script>alert(1)</script> <img src=x onerror=alert(2)> **b**';
  const out = render(nasty);
  assert.equal(find(out, "SCRIPT").length, 0, "no script element is ever created");
  assert.equal(find(out, "IMG").length, 0, "no img element either");
  assert.ok(out.textContent.includes("<script>alert(1)</script>"), "it stays text");
  assert.equal(find(out, "STRONG")[0].textContent, "b", "and the real markers still work");
}

// ── empty ───────────────────────────────────────────────────────────────────
for (const empty of ["", null, undefined, "\n\n"]) {
  assert.equal(render(empty).childNodes.length, 0, `${JSON.stringify(empty)} renders nothing`);
}

// ── the store survives a reload with nothing synced ─────────────────────────
// A fresh vm context per load, sharing one localStorage — which is exactly
// what a page reload is: new globals, same storage, no token.
{
  const store = new Map();
  const sheetsSrc = fs.readFileSync(path.join(__dirname, "sheets.js"), "utf8");
  const load = () => {
    const sctx = vm.createContext({
      window: {}, console, setTimeout, clearTimeout,
      document: { head: { appendChild() {} }, createElement: () => ({}) },
      localStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
      },
      fetch: async () => { throw new Error("no network in this test"); },
    });
    vm.runInContext(sheetsSrc + "\n;this.s = cosineSheets;", sctx);
    return sctx.s;
  };

  const first = load();
  first.init({ clientId: "cid", userId: "u1", onChange: () => {} });
  first.saveNote("leetcode-two-sum", "hash map of complements");
  assert.equal(first.noteText("leetcode-two-sum"), "hash map of complements", "readable immediately");
  assert.equal(first.pendingCount(), 1, "and queued for the sheet");

  const reloaded = load();
  reloaded.init({ clientId: "cid", userId: "u1", onChange: () => {} });
  assert.equal(reloaded.noteText("leetcode-two-sum"), "hash map of complements", "survived the reload");
  assert.equal(reloaded.pendingCount(), 1, "still queued — nothing reached Google");

  // Disconnecting the sheet must not discard writing that exists nowhere else.
  reloaded.clearLocal();
  assert.equal(reloaded.noteText("leetcode-two-sum"), "hash map of complements", "kept through a disconnect");

  // Another account on the same machine sees none of it.
  const other = load();
  other.init({ clientId: "cid", userId: "u2", onChange: () => {} });
  assert.equal(other.noteText("leetcode-two-sum"), "", "notes are per user");
  assert.equal(other.pendingCount(), 0);
}

console.log("note tests passed");
