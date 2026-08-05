// Static smoke test for the browser bundles: every function they call must
// actually exist in the file.
//
// The browser scripts have no build step and no module system, so nothing ever
// checks them — `node --check` only proves they parse, and a call to a function
// that was deleted parses perfectly. That exact bug shipped twice: reverting a
// feature by slicing between two source markers removed `activeFacets()` while
// two call sites survived, and :bookmarks / :done / :all threw a ReferenceError
// and silently rendered nothing.
//
// This is deliberately a lint, not a runtime harness. Driving these files needs
// a DOM, and a fake one is its own source of false confidence.
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const WEB = __dirname;
const FILES = ["app.js", "sheets.js", "profile.js", "patterns.js", "stats.js", "debug.js", "theme.js"];

// Things that exist without being declared in the file itself.
const GLOBALS = new Set([
  "fetch", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent",
  "String", "Number", "Boolean", "Array", "Object", "Set", "Map", "Date", "Math", "JSON",
  "Promise", "Error", "RegExp", "URL", "URLSearchParams", "Blob", "AbortController", "Intl",
  "console", "alert", "confirm", "structuredClone", "queueMicrotask", "btoa", "atob",
  "matchMedia", "getComputedStyle", "scrollTo",
  // control flow and operators that look like calls to a naive regex
  "if", "for", "while", "switch", "catch", "return", "typeof", "function", "await", "new",
  "of", "in", "do", "else", "try", "throw", "case", "delete", "void", "yield", "async",
]);

// Replaces comments and string/template/regex literals with spaces, preserving
// newlines so reported line numbers stay true.
function stripNonCode(src) {
  const out = [];
  let i = 0;
  let prevSignificant = "";
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") { out.push(" "); i++; }
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (; i < stop; i++) out.push(src[i] === "\n" ? "\n" : " ");
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out.push(" ");
      i++;
      while (i < src.length) {
        if (src[i] === "\\") { out.push(" ", " "); i += 2; continue; }
        if (src[i] === quote) { out.push(" "); i++; break; }
        out.push(src[i] === "\n" ? "\n" : " ");
        i++;
      }
      prevSignificant = "lit";
      continue;
    }
    // A regex literal, distinguished from division by what precedes it.
    if (c === "/" && !["lit", "word", ")", "]"].includes(prevSignificant)) {
      let j = i + 1;
      let closed = false;
      while (j < src.length && src[j] !== "\n") {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "[") { while (j < src.length && src[j] !== "]") j++; }
        if (src[j] === "/") { closed = true; break; }
        j++;
      }
      if (closed) {
        while (j + 1 < src.length && /[gimsuyd]/.test(src[j + 1])) j++;
        for (; i <= j; i++) out.push(" ");
        prevSignificant = "lit";
        continue;
      }
    }
    if (/\S/.test(c)) prevSignificant = /[\w$]/.test(c) ? "word" : c;
    out.push(c);
    i++;
  }
  return out.join("");
}

let checked = 0;
for (const file of FILES) {
  const full = path.join(WEB, file);
  if (!fs.existsSync(full)) continue;
  const src = fs.readFileSync(full, "utf8");

  // Blank out comments and literals in ONE pass. Two regex passes cannot do
  // this in either order, and both failures are instructive: comments-first
  // strips the "//" inside the HELP_TEXT template and eats its closing
  // backtick; literals-first treats the apostrophe in "// Don't" as an opening
  // quote and swallows the code after it. A three-state scanner is the only
  // correct version.
  const code = stripNonCode(src);

  const declared = new Set(GLOBALS);
  for (const re of [
    /\bfunction\s+([A-Za-z_$][\w$]*)/g,           // function foo()
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,  // const foo = ...
    /\bclass\s+([A-Za-z_$][\w$]*)/g,
  ]) {
    for (const m of code.matchAll(re)) declared.add(m[1]);
  }
  // Destructured bindings: const { a, b } = ...
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const name = part.split(":").pop().trim().replace(/^\.\.\./, "");
      if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
    }
  }
  // Named function parameters, so callbacks calling their own args are fine.
  for (const m of code.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
    for (const part of m[1].split(",")) {
      const name = part.split("=")[0].trim().replace(/^\.\.\./, "");
      if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
    }
  }

  // Bare calls only — `foo(`, never `x.foo(` — since methods belong to objects
  // we can't resolve statically.
  const missing = new Map();
  for (const m of code.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[2];
    if (declared.has(name)) continue;
    const line = code.slice(0, m.index).split("\n").length;
    if (!missing.has(name)) missing.set(name, line);
  }

  assert.equal(
    missing.size,
    0,
    `${file} calls ${missing.size} function(s) it never declares: ` +
      [...missing].map(([n, l]) => `${n}() at line ~${l}`).join(", ")
  );
  checked++;
}

assert.ok(checked >= 4, `expected to check several bundles, only saw ${checked}`);

// Every beacon the client fires must be a type the server allows.
//
// Nine weren't, for weeks: /api/track 400s an unknown type, and track() uses
// sendBeacon with no way to observe the response — so every filter chip, the
// difficulty controls and the recall rating were being dropped on arrival
// with nothing but a console error to show for it. The two lists are edited
// in different files by different reflexes; this is the thing that notices.
{
  const app = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
  const sent = new Set([...app.matchAll(/\btrack\(\s*"([a-z_]+)"/g)].map((m) => m[1]));
  const routerSrc = fs.readFileSync(
    path.join(WEB, "..", "server", "routes", "track.js"), "utf8");
  const block = routerSrc.match(/const TYPES = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(block, "could not find the TYPES allowlist in server/routes/track.js");
  const allowed = new Set([...block[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));
  const missing = [...sent].filter((t) => !allowed.has(t)).sort();
  assert.deepEqual(missing, [], `app.js sends event types /api/track would reject: ${missing.join(", ")}`);
  assert.ok(sent.size >= 10, `expected the client to send many event types, saw ${sent.size}`);
  const unused = [...allowed].filter((t) => !sent.has(t));
  console.log(`track allowlist covers ${sent.size} client event types` +
    (unused.length ? ` (${unused.length} allowed but unused: ${unused.join(", ")})` : ""));
}

console.log(`web bundle smoke test passed (${checked} files)`);
