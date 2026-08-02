// Notes that live in the user's own Google Sheet — and nowhere else.
//
// The trust model, which every line here exists to preserve:
//
//   - The OAuth token is requested BY THE BROWSER (Google Identity Services
//     token client) and held in a variable in this closure. It is never
//     written to localStorage (XSS-stealable) and never sent to our server.
//   - Scope is drive.file: the narrowest that works. Google grants access
//     ONLY to files this app created — not the user's Drive. It also lets us
//     re-find our own spreadsheet via files.list if localStorage is wiped.
//   - Notes never transit our server and are never stored in our database.
//     The server's entire involvement is serving a public client id.
//
// The sheet is the EDITING surface; the site only displays. The app writes
// exactly one thing: its OWN columns (APP_HEADER, found by name in row 1) on
// rows whose problem is in your library, plus appending new such rows.
// Everything else in the spreadsheet is yours — the suggested note columns,
// any columns you add after them, any rows you add — and the app never
// writes, blanks, or deletes any of it.
// No cell has two writers, so there is nothing to merge, and no in-site
// editor means the token is only ever needed when YOU press sync.

// Exposed as ONE namespace (bottom of file) rather than bare globals: app.js
// calls these as cosineSheets.foo(), which also keeps the bundle lint honest —
// it checks bare calls per file, and a namespace makes the boundary explicit.

const SHEET_NAME = "cosine notes";
const SHEET_TAB = "problems";
const SHEET_ID_KEY = "algolens_sheet_v1";   // { userId, spreadsheetId }
const SHEET_ROWS_KEY = "algolens_sheet_rows_v1"; // { userId, rows } — notes, not credentials
// App-owned columns, in the order a NEW sheet gets them. Order and position
// are not load-bearing: every read and write below locates a column by this
// NAME in row 1, so a sheet made before `recall` existed (eight columns, user
// notes starting at I) keeps working untouched, and reordering the columns by
// hand keeps working too. Appending a name here is safe; renaming one orphans
// that column in sheets already out there.
const APP_HEADER = ["problem_id", "title", "link", "judge", "difficulty", "bookmarked", "done", "done_at", "recall"];
// Suggested columns, created once in the header. Free-form on purpose —
// "todo", "revise friday", whatever fits your system; the site renders what
// it finds and enforces nothing. Add your own columns after these.
const SHEET_USER_FIELDS = [
  { key: "solve_status", label: "status" },
  { key: "time_taken", label: "time taken" },
  { key: "concept", label: "concept" },
  { key: "tactics", label: "tactics" },
  { key: "solution_summary", label: "solution summary" },
  { key: "notes", label: "notes" },
];
const FULL_HEADER = APP_HEADER.concat(SHEET_USER_FIELDS.map((f) => f.key));

let sheetsClientId = null;   // from /api/rankers; feature hidden while null
let sheetsUserId = null;     // guards the localStorage envelope per account
let tokenClient = null;      // GIS token client, created after the script loads
let accessToken = null;      // memory only, ~1h lifetime
let tokenExpiresAt = 0;
let spreadsheetId = null;
let rowByProblem = new Map(); // problem_id -> { rowIndex (1-based), note fields }
let onStateChange = () => {};

function sheetsInit({ clientId, userId, onChange }) {
  onStateChange = onChange || (() => {});
  // Idempotent. This is called from BOTH the /api/rankers handler and the auth
  // bootstrap, which race — and the old version reset spreadsheetId and the
  // row cache every time, so whichever landed second wiped a live session's
  // notes and could leave `connected()` false, which sent the next sync
  // through connect() and its forced consent screen.
  if (clientId === sheetsClientId && (userId || null) === sheetsUserId) return;
  sheetsClientId = clientId || null;
  sheetsUserId = userId || null;
  spreadsheetId = null;
  rowByProblem = new Map();
  sheetLayout = null;
  if (!sheetsClientId || !sheetsUserId) return;
  try {
    const parsed = JSON.parse(localStorage.getItem(SHEET_ID_KEY) || "null");
    // The userId guard keeps two accounts on one machine out of each other's
    // sheets — same envelope pattern as the profile snapshot.
    if (parsed && parsed.userId === sheetsUserId) spreadsheetId = parsed.spreadsheetId || null;
  } catch (_e) {}
  // Notes survive a reload; only the token doesn't.
  if (spreadsheetId) restoreRows();
}

function sheetsConnected() {
  return Boolean(spreadsheetId);
}

// Whether a usable token is already in memory. The auto-sync gate: a token
// request needs a user gesture to be popup-blocker-safe and to never nag, so
// background syncs run only when this is true.
function sheetsHasToken() {
  return Boolean(accessToken && Date.now() < tokenExpiresAt - 60000);
}

function sheetsAvailable() {
  return Boolean(sheetsClientId && sheetsUserId);
}

function sheetsClearLocal() {
  forget();  // clears the sheet pointer AND the cached notes
  accessToken = null;
  spreadsheetId = null;
  rowByProblem = new Map();
  sheetLayout = null;
}

// ── Google plumbing ──────────────────────────────────────────────────────────

// The GSI script loads only when the user acts — everyone else never talks
// to a third party at all.
function loadGsi() {
  return new Promise((resolve, reject) => {
    if (window.google && window.google.accounts) return resolve();
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("could not load Google sign-in"));
    document.head.appendChild(s);
  });
}

async function getToken(interactive) {
  if (accessToken && Date.now() < tokenExpiresAt - 60000) return accessToken;
  await loadGsi();
  if (!tokenClient) {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: sheetsClientId,
      scope: "https://www.googleapis.com/auth/drive.file",
      callback: () => {},
    });
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
    // A closed or blocked popup otherwise leaves this pending forever.
    const timer = setTimeout(
      () => finish(reject, new Error("no response from Google — the popup may have been closed or blocked")),
      120000
    );
    tokenClient.error_callback = (err) => {
      clearTimeout(timer);
      finish(reject, new Error((err && (err.message || err.type)) || "Google sign-in was cancelled"));
    };
    tokenClient.callback = (resp) => {
      clearTimeout(timer);
      if (resp.error) return finish(reject, new Error(resp.error_description || resp.error));
      accessToken = resp.access_token;
      tokenExpiresAt = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
      finish(resolve, accessToken);
    };
    // prompt:"" re-uses an existing grant silently; the consent popup only
    // appears the very first time (or after the user revokes access).
    // Consent is forced only when connecting a sheet for the first time.
    // Every routine sync uses prompt:"" so an existing grant is re-used
    // silently. (A `hint` would also pre-select the account for people signed
    // into several, but that needs the account's email, which reading costs a
    // permission drive.file doesn't reliably grant.)
    tokenClient.requestAccessToken({ prompt: interactive && !spreadsheetId ? "consent" : "" });
  });
}

async function googleError(res) {
  // Google puts the useful part in the body: "Google Drive API has not been
  // used in project N before or it is disabled", "insufficient authentication
  // scopes", "File not found". Surfacing the status alone hides all of it.
  let detail = "";
  try {
    const body = await res.json();
    detail = ((body.error || {}).message) || "";
  } catch (_e) {}
  if (/has not been used in project|is disabled/i.test(detail)) {
    const which = /drive/i.test(detail) ? "Drive" : "Sheets";
    detail = `the Google ${which} API is not enabled for this project — enable it in the Google Cloud console`;
  }
  const err = new Error(detail ? `${detail} (${res.status})` : `google api ${res.status}`);
  err.status = res.status;
  return err;
}

async function gapi(url, options = {}) {
  const token = await getToken(false);
  const send = (t) => fetch(url, {
    ...options,
    headers: { authorization: `Bearer ${t}`, "content-type": "application/json", ...(options.headers || {}) },
  });
  let res = await send(token);
  if (res.status === 401) {
    // token expired mid-session — one silent retry, then give up loudly
    accessToken = null;
    res = await send(await getToken(false));
  }
  if (!res.ok) throw await googleError(res);
  return res.json();
}

// 1 -> A, 26 -> Z, 27 -> AA. The sheet is the user's, so it can be as wide as
// they like; a single-letter version would silently address the wrong column
// the moment somebody added a 27th.
function colLetter(n) {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = (n - r - 1) / 26;
  }
  return s;
}

// ── Connect: find our sheet or create it ────────────────────────────────────

async function sheetsConnect() {
  if (!sheetsAvailable()) throw new Error("sheet sync is not configured");
  await getToken(true); // first grant is interactive by definition

  // A remembered sheet lives in ONE Google account. If the grant just came
  // from a different one, that sheet is invisible here (drive.file scope only
  // exposes files this app created for THIS account) — and silently creating
  // a second sheet in the new account is how notes get stranded. Check first,
  // and say which account owns it.
  if (spreadsheetId) {
    const reach = await sheetReachable(spreadsheetId);
    if (reach === "no") {
      // Definitely a different Google account: drive.file only exposes files
      // this app created for THIS account. Silently making a second sheet is
      // how notes get stranded, so stop and say so.
      spreadsheetId = null;
      forget();
      throw new Error(
        "your sheet lives in a different Google account — sign in with that one, " +
        "or press connect again to start a fresh sheet here"
      );
    }
    // "unknown" keeps the pointer: a disabled API or a flaky request must
    // never be mistaken for the wrong account.
  }

  // drive.file scope means files.list returns ONLY files this app created —
  // so this both recovers a lost localStorage pointer and can't see anything
  // else in the user's Drive.
  if (!spreadsheetId) {
    const q = encodeURIComponent(`name = '${SHEET_NAME}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`);
    const found = await gapi(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`);
    if (found.files && found.files.length) spreadsheetId = found.files[0].id;
  }

  if (!spreadsheetId) {
    const created = await gapi("https://sheets.googleapis.com/v4/spreadsheets", {
      method: "POST",
      body: JSON.stringify({
        properties: { title: SHEET_NAME },
        sheets: [{ properties: { title: SHEET_TAB, gridProperties: { frozenRowCount: 1 } } }],
      }),
    });
    spreadsheetId = created.spreadsheetId;
    await gapi(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${SHEET_TAB}!A1:${colLetter(FULL_HEADER.length)}1?valueInputOption=RAW`,
      { method: "PUT", body: JSON.stringify({ values: [FULL_HEADER] }) }
    );
  }

  remember();
  onStateChange();
  return spreadsheetId;
}

// Is the remembered sheet reachable from the account that just authorised?
// Returns "yes" | "no" | "unknown". `unknown` matters: a transient failure or
// a disabled API must NOT be read as "wrong account", because that path
// deletes the stored pointer. Only a definite 404 means "not this account".
//
// Deliberately asks for `id` alone. An earlier cut requested
// owners(emailAddress) to label the account, and reading an email address is a
// narrower permission than drive.file reliably grants — that call is what
// started returning 403.
async function sheetReachable(id) {
  try {
    await gapi(`https://www.googleapis.com/drive/v3/files/${id}?fields=id`);
    return "yes";
  } catch (err) {
    return err.status === 404 ? "no" : "unknown";
  }
}

function remember() {
  try {
    localStorage.setItem(SHEET_ID_KEY,
      JSON.stringify({ userId: sheetsUserId, spreadsheetId }));
  } catch (_e) {}
}

function rememberRows() {
  try {
    localStorage.setItem(SHEET_ROWS_KEY,
      JSON.stringify({ userId: sheetsUserId, rows: Object.fromEntries(rowByProblem) }));
  } catch (_e) {}  // quota or private mode: the cache is an optimisation, not state
}

function restoreRows() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SHEET_ROWS_KEY) || "null");
    if (parsed && parsed.userId === sheetsUserId && parsed.rows) {
      rowByProblem = new Map(Object.entries(parsed.rows));
    }
  } catch (_e) {}
}

function forget() {
  try {
    localStorage.removeItem(SHEET_ID_KEY);
    localStorage.removeItem(SHEET_ROWS_KEY);
  } catch (_e) {}
}

// ── Sync: the app writes its own columns, reads yours, never crosses over ────

// Where each column actually is in THIS sheet, read from row 1. Nothing below
// assumes a position — that assumption is what would let a new app column
// overwrite a user's note in a sheet created before it existed.
let sheetLayout = null; // { app: Map(name -> 0-based col), user: Map(key -> col), width }

function readLayout(values) {
  const headerRow = (values || [])[0] || [];
  const app = new Map();
  const user = new Map();
  const seen = new Map();
  (headerRow || []).forEach((cell, i) => {
    const name = String(cell == null ? "" : cell).trim().toLowerCase();
    if (name && !seen.has(name)) seen.set(name, i); // first wins if duplicated
  });
  APP_HEADER.forEach((name) => {
    if (seen.has(name)) app.set(name, seen.get(name));
  });
  SHEET_USER_FIELDS.forEach((f) => {
    if (seen.has(f.key)) user.set(f.key, seen.get(f.key));
  });
  // A sheet with no recognisable header (row 1 deleted, or a tab the app did
  // not create) falls back to the original fixed layout rather than writing
  // nothing — which is what every sheet in the wild looked like anyway.
  const derived = !app.size;
  if (derived) {
    APP_HEADER.slice(0, 8).forEach((name, i) => app.set(name, i));
    SHEET_USER_FIELDS.forEach((f, j) => user.set(f.key, 8 + j));
  }
  // Width is the widest ROW, not the header — a column with a blank header
  // still holds someone's data, and this number is where a new app column is
  // allowed to start.
  const widest = (values || []).reduce((m, row) => Math.max(m, (row || []).length), 0);
  const cols = [...app.values(), ...user.values(), widest - 1];
  return { app, user, derived, width: Math.max(...cols) + 1 };
}

// A sheet created before a column existed doesn't have it — the very case
// header-name mapping was built to survive. Rather than leave those sheets
// permanently missing the rating, claim the column PAST EVERY CELL THAT
// EXISTS and write its header there. Nothing is shifted and nothing of the
// user's is overwritten: the new column starts beyond the widest row in the
// sheet. Only ever runs on a real sync, which is a button the user pressed.
async function ensureAppColumns() {
  if (sheetLayout.derived) return; // row 1 isn't a header; don't invent one
  const missing = APP_HEADER.filter((name) => sheetLayout.app.get(name) == null);
  if (!missing.length) return;
  const start = sheetLayout.width;
  const range = `${SHEET_TAB}!${colLetter(start + 1)}1:${colLetter(start + missing.length)}1`;
  await gapi(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    { method: "PUT", body: JSON.stringify({ values: [missing] }) }
  );
  missing.forEach((name, i) => sheetLayout.app.set(name, start + i));
  sheetLayout.width = start + missing.length;
}

// App-owned columns grouped into contiguous runs, so the usual sheet costs one
// range per row instead of one per cell — but a reordered sheet still writes
// to the right places, just in more pieces.
function appRuns() {
  const cols = APP_HEADER
    .map((name) => ({ name, i: sheetLayout.app.get(name) }))
    .filter((c) => c.i != null)
    .sort((a, b) => a.i - b.i);
  const runs = [];
  for (const c of cols) {
    const last = runs[runs.length - 1];
    if (last && c.i === last.end + 1) {
      last.end = c.i;
      last.names.push(c.name);
    } else {
      runs.push({ start: c.i, end: c.i, names: [c.name] });
    }
  }
  return runs;
}

async function readSheet() {
  // The whole tab, not a pinned A2:N — the width is the user's business, and
  // row 1 is how we learn the layout in the first place.
  const data = await gapi(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(SHEET_TAB)}`
  );
  const values = data.values || [];
  sheetLayout = readLayout(values);
  const idCol = sheetLayout.app.get("problem_id");
  rowByProblem = new Map();
  values.slice(1).forEach((row, i) => {
    const id = row[idCol];
    if (!id) return;
    const entry = { rowIndex: i + 2 };
    SHEET_USER_FIELDS.forEach((f) => {
      const col = sheetLayout.user.get(f.key);
      entry[f.key] = (col == null ? "" : row[col]) || "";
    });
    rowByProblem.set(id, entry);
  });
  return rowByProblem;
}

function appCells(item) {
  const p = item.problem;
  return {
    problem_id: p.id,
    title: p.title || "",
    link: p.source_url || "",
    judge: p.platform || "",
    difficulty: p.difficulty == null ? "" : String(p.difficulty),
    bookmarked: item.bookmarked ? "yes" : "",
    done: item.done ? "yes" : "",
    done_at: item.doneAt ? item.doneAt.slice(0, 10) : "",
    recall: item.recall || "",
  };
}

// A brand-new row, laid out for THIS sheet. User columns are sent as empty
// strings, which is only ever true here: the row did not exist a moment ago,
// so there is nothing of the user's to overwrite.
function appendRow(item) {
  const cells = appCells(item);
  const row = new Array(sheetLayout.width).fill("");
  sheetLayout.app.forEach((col, name) => { row[col] = cells[name]; });
  return row;
}

// items: the /api/library?type=all payload. Returns {added, updated, total}.
async function sheetsSync(items) {
  if (!sheetsConnected()) throw new Error("no sheet connected");
  try {
    await readSheet();
  } catch (err) {
    // The account that just authorised cannot see this sheet. drive.file only
    // exposes files the app created FOR THAT ACCOUNT, so this is what a second
    // Google account looks like — and saying "File not found" would send
    // someone hunting for a deleted spreadsheet that is sitting safely in
    // their other account.
    if (err.status === 404 || err.status === 403) {
      throw new Error(
        "this Google account can't see your sheet — it belongs to the account you " +
        "connected with first. Sign in with that one, or press connect to start a fresh sheet here"
      );
    }
    throw err;
  }

  await ensureAppColumns();
  const runs = appRuns();
  const updates = [];
  const appends = [];
  for (const item of items) {
    const existing = rowByProblem.get(item.problem.id);
    if (existing) {
      const cells = appCells(item);
      const r = existing.rowIndex;
      for (const run of runs) {
        updates.push({
          range: `${SHEET_TAB}!${colLetter(run.start + 1)}${r}:${colLetter(run.end + 1)}${r}`,
          values: [run.names.map((n) => cells[n])],
        });
      }
    } else {
      appends.push(appendRow(item));
    }
  }

  // Rows absent from the library are left COMPLETELY alone. An earlier cut
  // blanked their status cells, but the app can't tell its own old rows from
  // rows the user appended by hand — and "the app never touches your rows"
  // is worth more than a fresher mirror. An un-saved problem's row simply
  // keeps its last-synced status.

  if (updates.length) {
    await gapi(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({ valueInputOption: "RAW", data: updates }),
    });
  }
  if (appends.length) {
    // The append range names the header row, so Sheets appends beneath the
    // table it belongs to. Derived from the sheet's real width — a stale
    // literal here misfiles every appended row by however many columns it is
    // out of date, which is exactly what a hardcoded A1:H1 would now do.
    const range = `${SHEET_TAB}!A1:${colLetter(sheetLayout.width)}1`;
    await gapi(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: "POST", body: JSON.stringify({ values: appends }) }
    );
  }
  await readSheet(); // pick up appended row indexes + any hand edits
  rememberRows();
  onStateChange();
  return { added: appends.length, updated: updates.length, total: rowByProblem.size };
}

// ── Notes on a single problem ────────────────────────────────────────────────

function sheetsNoteFor(problemId) {
  return rowByProblem.get(problemId) || null;
}

function sheetsUrl() {
  return spreadsheetId ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}` : null;
}

// ── The public surface ───────────────────────────────────────────────────────
const cosineSheets = {
  init: sheetsInit,
  available: sheetsAvailable,
  connected: sheetsConnected,
  hasToken: sheetsHasToken,
  connect: sheetsConnect,
  sync: sheetsSync,
  noteFor: sheetsNoteFor,
  clearLocal: sheetsClearLocal,
  url: sheetsUrl,
  USER_FIELDS: SHEET_USER_FIELDS,
};
