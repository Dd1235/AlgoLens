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
// exactly one thing: columns A–H of rows whose problem is in your library
// (plus appending new such rows). Everything else in the spreadsheet is
// yours — the suggested note columns I–N, any columns you add after them,
// any rows you add — and the app never writes, blanks, or deletes any of it.
// No cell has two writers, so there is nothing to merge, and no in-site
// editor means the token is only ever needed when YOU press sync.

// Exposed as ONE namespace (bottom of file) rather than bare globals: app.js
// calls these as cosineSheets.foo(), which also keeps the bundle lint honest —
// it checks bare calls per file, and a namespace makes the boundary explicit.

const SHEET_NAME = "cosine notes";
const SHEET_TAB = "problems";
const SHEET_ID_KEY = "algolens_sheet_v1"; // localStorage: { userId, spreadsheetId }
const APP_HEADER = ["problem_id", "title", "link", "judge", "difficulty", "bookmarked", "done", "done_at"];
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
  sheetsClientId = clientId || null;
  sheetsUserId = userId || null;
  onStateChange = onChange || (() => {});
  spreadsheetId = null;
  rowByProblem = new Map();
  if (!sheetsClientId || !sheetsUserId) return;
  try {
    const parsed = JSON.parse(localStorage.getItem(SHEET_ID_KEY) || "null");
    // The userId guard keeps two accounts on one machine out of each other's
    // sheets — same envelope pattern as the profile snapshot.
    if (parsed && parsed.userId === sheetsUserId) spreadsheetId = parsed.spreadsheetId || null;
  } catch (_e) {}
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
  try { localStorage.removeItem(SHEET_ID_KEY); } catch (_e) {}
  accessToken = null;
  spreadsheetId = null;
  rowByProblem = new Map();
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
    tokenClient.callback = (resp) => {
      if (resp.error) return reject(new Error(resp.error));
      accessToken = resp.access_token;
      tokenExpiresAt = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
      resolve(accessToken);
    };
    // prompt:"" re-uses an existing grant silently; the consent popup only
    // appears the very first time (or after the user revokes access).
    tokenClient.requestAccessToken({ prompt: interactive ? "consent" : "" });
  });
}

async function gapi(url, options = {}) {
  const token = await getToken(false);
  const res = await fetch(url, {
    ...options,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(options.headers || {}) },
  });
  if (res.status === 401) {
    // token expired mid-session — one silent retry, then give up loudly
    accessToken = null;
    const fresh = await getToken(false);
    const retry = await fetch(url, {
      ...options,
      headers: { authorization: `Bearer ${fresh}`, "content-type": "application/json", ...(options.headers || {}) },
    });
    if (!retry.ok) throw new Error(`google api ${retry.status}`);
    return retry.json();
  }
  if (!res.ok) throw new Error(`google api ${res.status}`);
  return res.json();
}

const colLetter = (n) => String.fromCharCode(64 + n); // 1 -> A .. 14 -> N

// ── Connect: find our sheet or create it ────────────────────────────────────

async function sheetsConnect() {
  if (!sheetsAvailable()) throw new Error("sheet sync is not configured");
  await getToken(true); // first grant is interactive by definition

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

  try {
    localStorage.setItem(SHEET_ID_KEY, JSON.stringify({ userId: sheetsUserId, spreadsheetId }));
  } catch (_e) {}
  onStateChange();
  return spreadsheetId;
}

// ── Sync: app writes A–H, reads I–N, and never crosses the line ─────────────

async function readSheet() {
  const range = `${SHEET_TAB}!A2:${colLetter(FULL_HEADER.length)}`;
  const data = await gapi(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`
  );
  rowByProblem = new Map();
  (data.values || []).forEach((row, i) => {
    const id = row[0];
    if (!id) return;
    const entry = { rowIndex: i + 2 };
    SHEET_USER_FIELDS.forEach((f, j) => {
      entry[f.key] = row[APP_HEADER.length + j] || "";
    });
    rowByProblem.set(id, entry);
  });
  return rowByProblem;
}

function appRow(item) {
  const p = item.problem;
  return [
    p.id,
    p.title || "",
    p.source_url || "",
    p.platform || "",
    p.difficulty == null ? "" : String(p.difficulty),
    item.bookmarked ? "yes" : "",
    item.done ? "yes" : "",
    item.doneAt ? item.doneAt.slice(0, 10) : "",
  ];
}

// items: the /api/library?type=all payload. Returns {added, updated, total}.
async function sheetsSync(items) {
  if (!sheetsConnected()) throw new Error("no sheet connected");
  await readSheet();

  const updates = [];
  const appends = [];
  for (const item of items) {
    const existing = rowByProblem.get(item.problem.id);
    if (existing) {
      updates.push({
        range: `${SHEET_TAB}!A${existing.rowIndex}:${colLetter(APP_HEADER.length)}${existing.rowIndex}`,
        values: [appRow(item)],
      });
    } else {
      // A new row is A–H only. The append range is pinned to A:H so Sheets
      // can't shift the row into whatever columns the user added later.
      appends.push(appRow(item));
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
    await gapi(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${SHEET_TAB}!A1:H1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: "POST", body: JSON.stringify({ values: appends }) }
    );
  }
  await readSheet(); // pick up appended row indexes + any hand edits
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
