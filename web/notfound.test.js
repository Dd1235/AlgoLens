// The rules of `unbalanced`, the game on the 404 page.
//
// It is a game, so nothing here is load-bearing for the site — but the rules
// are pure functions and testing them costs nothing, and a 404 page that
// throws is a worse look than no 404 page at all.
const assert = require("node:assert/strict");
const g = require("./notfound.js");

const play = (...steps) => steps.reduce(
  (s, ch) => (g.OPENERS.includes(ch) ? g.push(s, ch) : g.press(s, ch)),
  g.newGame()
);

// ── the happy path ──────────────────────────────────────────────────────────
{
  const s = play("(", "[", "]", ")");
  assert.equal(s.over, null, "a balanced expression survives");
  assert.deepEqual(s.stack, [], "and empties the stack");
  assert.equal(s.pairs, 2);
  assert.equal(s.expr, "([])");
}

// ── the wrong closer ────────────────────────────────────────────────────────
// The message has to name both characters: "expected ] got )" is the whole
// explanation of what just went wrong.
{
  const s = play("(", "[", ")");
  assert.equal(s.over.reason, "mismatch");
  assert.equal(s.over.message, "expected ] got )");
  assert.equal(s.over.at, 2, "the index of the character that broke it");
  assert.equal(s.pairs, 0, "a mismatch scores nothing");
}

// ── a closer with nothing open ──────────────────────────────────────────────
// Deliberately fatal. If pressing a wrong key were free, mashing all three
// would be the optimal strategy.
{
  const s = play(")");
  assert.equal(s.over.reason, "unmatched");
  assert.equal(s.over.message, "unmatched )");
  assert.equal(s.over.at, 0);
}
{
  const s = play("(", ")", "}");
  assert.equal(s.over.reason, "unmatched", "and after a good pair too");
  assert.equal(s.pairs, 1, "the pair before it still counted");
}

// ── overflow ────────────────────────────────────────────────────────────────
{
  const openers = Array(g.CAPACITY).fill("(");
  const full = play(...openers);
  assert.equal(full.over, null, `${g.CAPACITY} fits`);
  const spilled = g.push(full, "(");
  assert.equal(spilled.over.reason, "overflow");
  assert.match(spilled.over.message, /^stack overflow at depth 9$/);
}

// ── the ramp ────────────────────────────────────────────────────────────────
// Every run has to end, or the score means nothing.
{
  assert.equal(g.intervalFor(0), g.START_MS);
  assert.ok(g.intervalFor(5) < g.intervalFor(1), "it speeds up as you score");
  assert.equal(g.intervalFor(1000), g.FLOOR_MS, "and clamps rather than hitting zero");
  const s = play("(", ")");
  assert.ok(s.interval < g.START_MS, "a matched pair moves the clock");
}

// ── a finished game is finished ─────────────────────────────────────────────
// The timer and the keyboard can both arrive after the run ended.
{
  const dead = play("(", "]");
  assert.equal(g.press(dead, ")"), dead, "further presses change nothing");
  assert.equal(g.push(dead, "("), dead, "and neither does a pending drop");
}

// ── junk input ──────────────────────────────────────────────────────────────
{
  const s = g.newGame();
  for (const junk of ["a", "", "((", ">", null, undefined]) {
    assert.equal(g.press(s, junk), s, `press(${JSON.stringify(junk)}) is a no-op`);
    assert.equal(g.push(s, junk), s, `push(${JSON.stringify(junk)}) is a no-op`);
  }
}

// ── the verdict ─────────────────────────────────────────────────────────────
// The payoff: the game hands you the expression it built and marks the break.
{
  const s = play("(", "[", "{", "}", "]", ")", "(", "[", ")");
  const v = g.verdict(s);
  assert.equal(v.expr, "([{}])([)");
  assert.equal(v.expr[v.caret], ")", "the caret lands under the offending char");
  assert.equal(v.message, "expected ] got )");
  assert.equal(v.pairs, 3);
  assert.equal(g.verdict(g.newGame()), null, "a live game has no verdict");
}
{
  // A long run is trimmed from the left, and the caret follows.
  let s = g.newGame();
  for (let i = 0; i < 30; i++) s = g.press(g.push(s, "("), ")");
  s = g.press(g.push(s, "["), ")");
  const v = g.verdict(s, 20);
  assert.ok(v.expr.startsWith("…"), "trimmed expressions say so");
  assert.ok(v.expr.length <= 21, "and fit the width");
  assert.equal(v.expr[v.caret], ")", "the caret still points at the break");
}

// ── the generator ───────────────────────────────────────────────────────────
{
  const seq = [0, 0.4, 0.9].map((r) => g.nextOpener(() => r));
  assert.deepEqual(seq, ["(", "[", "{"], "each third of the range is one opener");
  for (let i = 0; i < 50; i++) assert.ok(g.OPENERS.includes(g.nextOpener()));
}

// ── and a whole run, driven headlessly ──────────────────────────────────────
//
// web/app.smoke.test.js says a fake DOM "is its own source of false
// confidence", and for that 2,400-line bundle it is. This game is 250 lines
// with eight elements and one state machine, and the fake DOM below caught
// two real bugs the moment it existed: the keypress that STARTED a run was
// also played against the empty stack it had just created (so your first
// press always died "unmatched )"), and `resume` fired the start handler as
// well, so coming back from a pause silently began a new game. Worth keeping.
//
// The element ids come out of 404.html, so renaming one there and not here
// fails the test rather than the page.
const vm = require("vm");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "notfound.js"), "utf8");
const ids = [...fs.readFileSync(path.join(__dirname, "404.html"), "utf8")
  .matchAll(/id="([a-z-]+)"/g)].map((m) => m[1]);

const mk = (id) => ({
  id, className: "", textContent: "", hidden: false, style: {}, dataset: {},
  childNodes: [], offsetWidth: 1, tagName: "DIV",
  set innerHTML(v) { if (!v) this.childNodes = []; },
  get innerHTML() { return ""; },
  appendChild(c) { this.childNodes.push(c); return c; },
  append(...c) { this.childNodes.push(...c); },
  addEventListener(t, fn) { (this._h ||= {})[t] = fn; },
  focus() {},
});
const nodes = Object.fromEntries(ids.map((id) => [id, mk(id)]));
const keys = [")", "]", "}"].map((k) => { const n = mk("k"); n.dataset.key = k; return n; });
const docH = {}, winH = {}, store = new Map();
let pending = null;
const ctx = {
  console, Math,
  setTimeout: (fn, ms) => { pending = { fn, ms }; return 1; },
  clearTimeout: () => { pending = null; },
  localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
  window: { addEventListener: (t, fn) => { winH[t] = fn; } },
  document: {
    hidden: false, activeElement: null,
    getElementById: (id) => nodes[id] || null,
    createElement: mk,
    querySelectorAll: (sel) => (sel === ".game-key" ? keys : []),
    addEventListener: (t, fn) => { docH[t] = fn; },
  },
};
vm.createContext(ctx);
vm.runInContext(src, ctx);

const press = (k) => docH.keydown({ key: k, preventDefault() {} });
const tick = () => { const p = pending; pending = null; p.fn(); };
const top = () => [...nodes["game-stack"].childNodes].reverse().find((c) => c.textContent)?.textContent;
const closerFor = { "(": ")", "[": "]", "{": "}" };
const score = () => Number(nodes["game-score"].textContent);

// idle: the board is drawn, nothing is running.
assert.equal(pending, null, "nothing is scheduled before you play");
assert.equal(nodes["game-stack"].childNodes.length, 8, "eight slots are drawn");

// The first closer STARTS a run and is not played against the empty stack.
press(")");
assert.equal(nodes["game-verdict"].hidden, true, "the first press does not end the game");
assert.equal(score(), 0);
assert.ok(top(), "a run starts with one opener already on the board");
assert.ok(pending, "and the next drop is scheduled");

// Play twenty pairs cleanly.
for (let i = 0; i < 20; i++) {
  press(closerFor[top()]);
  if (!nodes["game-verdict"].hidden) throw new Error(`died on a correct pop at ${i}`);
  tick();  // let the next opener land
}
assert.equal(score(), 20, "twenty correct pops score twenty");
const fast = pending.ms;
assert.ok(fast < 1100, `the drop interval ramped down to ${fast}ms`);

// Pause and resume must not restart the run.
winH.blur();
assert.equal(pending, null, "a blurred tab stops the clock");
assert.equal(nodes["game-start"].textContent, "resume");
nodes["game-start"]._h.click();
assert.equal(score(), 20, "resuming keeps the score");
assert.ok(pending, "and restarts the clock");

// Overflow: stop popping.
for (let i = 0; i < 9; i++) if (pending) tick();
assert.equal(nodes["game-verdict"].hidden, false, "the stack overflowed");
const lines = nodes["game-verdict"].childNodes.map((c) => c.textContent);
assert.match(lines[1], /stack overflow at depth 9/);
assert.match(lines[2], /20 pairs matched/);
assert.equal(store.get("algolens_unbalanced_best_v1"), "20", "best is remembered");

// A closer after game over starts a fresh run rather than doing nothing.
press("}");
assert.equal(nodes["game-verdict"].hidden, true, "and again means again");
assert.equal(score(), 0);

// A wrong closer prints the caret under the right character.
const wrong = top() === "(" ? "]" : ")";
press(wrong);
const v = nodes["game-verdict"].childNodes.map((c) => c.textContent);
assert.equal(v[1].indexOf("^"), v[0].length - 1, "the caret sits under the last character");
assert.match(v[1], /expected/);

// Typing in the search box is not a game input.
press("}");                       // restart
ctx.document.activeElement = { tagName: "INPUT" };
const before = score();
press(closerFor[top()]);
assert.equal(score(), before, "keys are ignored while you type your way out");

console.log("unbalanced (404 game) tests passed");
