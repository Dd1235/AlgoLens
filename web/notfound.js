// unbalanced — the 404 page's game.
//
// Openers land on a stack on a timer; you press the matching closer to pop
// them. It ends two ways, and both of them are the joke: the stack overflows,
// or the expression you have been building stops being valid. Valid
// Parentheses is one of the four anchor problems this corpus is benchmarked
// on, so the page you land on when nothing is found is playing the site's own
// greatest hit.
//
// The rules below are PURE — no DOM, no timers, every function takes a state
// and returns the next one. The painting half is at the bottom and does
// nothing else. That split is the only reason a browser game gets to have
// tests (web/notfound.test.js), and it's the same one web/sheets.js uses to
// make its layout logic testable.

const PAIRS = { "(": ")", "[": "]", "{": "}" };
const OPENERS = Object.keys(PAIRS);
const CLOSERS = Object.values(PAIRS);
const CAPACITY = 8;          // slots on the board; one more is an overflow
const START_MS = 1100;       // first drop interval
const FLOOR_MS = 320;        // as fast as it ever gets
const RAMP = 0.96;           // per matched pair
const BEST_KEY = "algolens_unbalanced_best_v1";

function newGame() {
  return {
    stack: [],       // openers, bottom first
    expr: "",        // every character in the order it happened
    pairs: 0,        // score
    interval: START_MS,
    over: null,      // null | { reason, message, at }
  };
}

// Every matched pair speeds the next drop up a little, so a run always ends —
// a game you can play forever is a game with no score worth keeping.
function intervalFor(pairs) {
  return Math.max(FLOOR_MS, Math.round(START_MS * Math.pow(RAMP, pairs)));
}

function push(state, opener) {
  if (state.over || !PAIRS[opener]) return state;
  const stack = state.stack.concat(opener);
  const expr = state.expr + opener;
  if (stack.length > CAPACITY) {
    return { ...state, stack, expr, over: {
      reason: "overflow",
      message: `stack overflow at depth ${stack.length}`,
      at: expr.length - 1,
    } };
  }
  return { ...state, stack, expr };
}

function press(state, closer) {
  if (state.over || !CLOSERS.includes(closer)) return state;
  const expr = state.expr + closer;
  const top = state.stack[state.stack.length - 1];

  // A closer with nothing open. This ENDS the run rather than being ignored:
  // if a wrong key were free, holding down all three would be the winning
  // strategy and there would be no game left.
  if (!top) {
    return { ...state, expr, over: {
      reason: "unmatched",
      message: `unmatched ${closer}`,
      at: expr.length - 1,
    } };
  }
  if (PAIRS[top] !== closer) {
    return { ...state, expr, over: {
      reason: "mismatch",
      message: `expected ${PAIRS[top]} got ${closer}`,
      at: expr.length - 1,
    } };
  }
  const pairs = state.pairs + 1;
  return {
    ...state,
    stack: state.stack.slice(0, -1),
    expr,
    pairs,
    interval: intervalFor(pairs),
  };
}

// Deterministic given a seed, so the test can assert on a sequence — and so
// the preview row can show what is coming without having decided it twice.
function nextOpener(rand) {
  return OPENERS[Math.floor((rand || Math.random)() * OPENERS.length)];
}

// The expression, trimmed to what fits, with a caret under the break. The
// game hands you a Valid Parentheses input and its verdict, which is the
// whole point of the joke.
function verdict(state, width = 40) {
  if (!state.over) return null;
  const at = state.over.at;
  const start = Math.max(0, at - width + 4);
  const shown = state.expr.slice(start, start + width);
  return {
    expr: (start ? "…" : "") + shown,
    caret: (start ? 1 : 0) + (at - start),
    message: state.over.message,
    pairs: state.pairs,
  };
}

// ── everything below here touches the DOM ────────────────────────────────────

if (typeof document !== "undefined") {
  const $ = (id) => document.getElementById(id);
  const board = $("game-stack");
  const nextRow = $("game-next");
  const scoreEl = $("game-score");
  const bestEl = $("game-best");
  const statusEl = $("game-status");
  const verdictEl = $("game-verdict");
  const startBtn = $("game-start");
  const fuse = $("game-fuse");

  if (board) {
    // idle → running ⇄ paused → over → idle. One flag, because the two bugs
    // this replaced were both about not having one: the keypress that started
    // a run was ALSO played against the empty stack it had just created (an
    // instant "unmatched )"), and `resume` ran the start handler as well as
    // the resume one, so coming back from a pause silently began a new game.
    let phase = "idle";
    let state = newGame();
    let queue = [];
    let timer = null;
    let best = 0;
    try { best = Number(localStorage.getItem(BEST_KEY)) || 0; } catch (_e) {}

    const refill = () => { while (queue.length < 4) queue.push(nextOpener()); };

    function paint() {
      board.innerHTML = "";
      // Top slot first, so the stack grows upward toward the marked one.
      for (let i = CAPACITY - 1; i >= 0; i--) {
        const cell = document.createElement("div");
        const ch = state.stack[i];
        cell.className = `game-cell${ch ? " filled" : ""}${i === CAPACITY - 1 ? " danger" : ""}`;
        cell.textContent = ch || "";
        board.appendChild(cell);
      }
      nextRow.textContent = `next  ${queue.join("  ")}`;
      scoreEl.textContent = String(state.pairs);
      bestEl.textContent = best ? `best ${best}` : "";
    }

    // The bar is the only clock on the board: it drains for exactly as long
    // as you have before the next opener lands.
    function armFuse(ms) {
      fuse.style.transition = "none";
      fuse.style.width = "100%";
      void fuse.offsetWidth;   // reflow, or both writes collapse into one paint
      fuse.style.transition = `width ${ms}ms linear`;
      fuse.style.width = "0%";
    }

    function stopFuse() {
      fuse.style.transition = "none";
      fuse.style.width = "0%";
    }

    function schedule() {
      clearTimeout(timer);
      if (phase !== "running") return;
      armFuse(state.interval);
      timer = setTimeout(drop, state.interval);
    }

    function drop() {
      refill();
      state = push(state, queue.shift());
      refill();
      paint();
      if (state.over) return end();
      schedule();
    }

    function setButton(label, hidden) {
      startBtn.textContent = label;
      startBtn.hidden = hidden;
    }

    function start() {
      state = newGame();
      queue = [];
      refill();
      phase = "running";
      setButton("again", true);
      verdictEl.hidden = true;
      verdictEl.innerHTML = "";
      statusEl.textContent = "pop the top before the stack fills";
      // Seed one immediately: an empty board with a full second before
      // anything happens reads as broken, and every key pressed into it would
      // be an unmatched closer.
      drop();
    }

    function pause() {
      if (phase !== "running") return;
      phase = "paused";
      clearTimeout(timer);
      stopFuse();
      setButton("resume", false);
      statusEl.textContent = "paused — press a closer to carry on";
    }

    function resume() {
      if (phase !== "paused") return;
      phase = "running";
      setButton("again", true);
      statusEl.textContent = "pop the top before the stack fills";
      schedule();
    }

    function end() {
      phase = "over";
      clearTimeout(timer);
      stopFuse();
      const v = verdict(state);
      verdictEl.hidden = false;
      verdictEl.innerHTML = "";
      const line = document.createElement("div");
      line.className = "game-expr";
      line.textContent = v.expr;
      const caret = document.createElement("div");
      caret.className = "game-caret";
      caret.textContent = `${" ".repeat(v.caret)}^ ${v.message}`;
      const tally = document.createElement("div");
      tally.className = "game-tally";
      let tail = "";
      if (state.pairs > best) {
        best = state.pairs;
        try { localStorage.setItem(BEST_KEY, String(best)); } catch (_e) {}
        tail = " · a new best";
      }
      tally.textContent = `invalid at index ${state.over.at} · ${v.pairs} pairs matched${tail}`;
      verdictEl.append(line, caret, tally);
      setButton("again", false);
      statusEl.textContent = "press a closer, or the button, to go again";
      paint();
    }

    function handleKey(ch) {
      if (!CLOSERS.includes(ch)) return;
      // A closer pressed when nothing is running is a decision to play, not a
      // move — it must not also be played against an empty stack.
      if (phase === "idle" || phase === "over") return start();
      if (phase === "paused") return resume();
      state = press(state, ch);
      paint();
      if (state.over) return end();
      schedule();   // popping fast buys you time: the fuse restarts
    }

    document.addEventListener("keydown", (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Not while someone is typing their way out of here.
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      if (CLOSERS.includes(e.key)) {
        e.preventDefault();
        handleKey(e.key);
      }
    });

    // Phones have no keyboard, and these three keys are the whole game.
    document.querySelectorAll(".game-key").forEach((btn) => {
      btn.addEventListener("click", () => handleKey(btn.dataset.key));
    });

    startBtn.addEventListener("click", () => {
      if (phase === "paused") resume();
      else start();
    });

    // Coming back to a tab you left five minutes ago should not mean coming
    // back to a run that overflowed without you.
    document.addEventListener("visibilitychange", () => { if (document.hidden) pause(); });
    window.addEventListener("blur", pause);

    refill();
    paint();
  }
}

// Exported for the test; harmless in a browser, where nothing reads it.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { newGame, push, press, verdict, intervalFor, nextOpener,
    PAIRS, OPENERS, CLOSERS, CAPACITY, START_MS, FLOOR_MS };
}
