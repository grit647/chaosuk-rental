const { google } = require('googleapis');
const { getCurrentSheetId } = require('./requestContext');

// Per explicit user request (multi-tenant login prototype): resolves to
// the logged-in user's own customerSheetId if the current request is
// running inside a session context (see requestContext.js + the auth
// middleware in index.js), otherwise falls back to the single
// GOOGLE_SHEET_ID env var exactly as before. This is a FUNCTION now
// (not a constant computed once at module load) specifically so it can
// change per-request — every call site below already called it fresh
// each time it needed the id, so this is a drop-in replacement.
function SHEET_ID() {
  return getCurrentSheetId() || process.env.GOOGLE_SHEET_ID;
}

function getAuth() {
  return new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
}

async function client() {
  const authClient = getAuth();
  await authClient.authorize();
  return google.sheets({ version: 'v4', auth: authClient });
}

function rowsToObjects(rows) {
  if (!rows || rows.length === 0) return [];
  const [header, ...body] = rows;
  return body
    .filter((r) => r.some((c) => c !== undefined && c !== ''))
    .map((r) => {
      const obj = {};
      header.forEach((key, i) => { obj[key] = r[i] !== undefined ? r[i] : ''; });
      return obj;
    });
}

function objectToRow(header, obj) {
  return header.map((key) => {
    const v = obj[key];
    if (v === undefined || v === null) return '';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return v;
  });
}

// Real bug found while adding a 27th column (tuyaWaterDeviceId) to Rooms:
// every range below used to hardcode column Z (26) as the cap — a tab with
// MORE than 26 columns silently had its extra columns never read/written at
// all (Google's API just omits anything past the requested range, no error).
// Widened to ZZ (702 columns) everywhere, comfortably beyond anything this
// app is likely to ever need on one tab.
const MAX_COL = 'ZZ';

async function getHeader(sheets, tab) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID(), range: `${tab}!A1:${MAX_COL}1` });
  return (res.data.values || [[]])[0] || [];
}

async function readTab(tab) {
  const sheets = await client();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID(), range: `${tab}!A1:${MAX_COL}1000` });
  return rowsToObjects(res.data.values || []);
}

// Batch version of readTab — reads MULTIPLE tabs in a SINGLE Google Sheets
// API call (values.batchGet) instead of one HTTP request per tab. Google's
// read quota counts each HTTP request as one unit no matter how many ranges
// it covers, so this cuts quota usage roughly Nx for N tabs — added to fix
// a real "Quota exceeded for quota metric 'Read requests'" error hit in
// production (2026-07-24), traced to GET /api/bootstrap firing ~9 separate
// readTab calls on every single load (and every 30s while the dashboard's
// auto-refresh toggle is on) — all customer buildings share the same
// Google service account, so this quota pressure is platform-wide, not
// just one dashboard. Returns an object keyed by tab name, each value
// already parsed into row-objects via rowsToObjects (identical shape to
// what readTab returns, so existing coerce* functions work unchanged).
async function readTabs(tabs) {
  const sheets = await client();
  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: SHEET_ID(),
    ranges: tabs.map((tab) => `${tab}!A1:${MAX_COL}1000`),
  });
  const result = {};
  (res.data.valueRanges || []).forEach((vr, i) => {
    result[tabs[i]] = rowsToObjects(vr.values || []);
  });
  return result;
}

async function appendRow(tab, obj) {
  const sheets = await client();
  const header = await getHeader(sheets, tab);
  const row = objectToRow(header, obj);
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID(),
    range: `${tab}!A1`,
    valueInputOption: 'RAW', // store values literally — no auto number/date parsing (that's what strips leading zeros off phone numbers etc; we handle all type coercion ourselves in coerce.js)
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
  return obj;
}

// เพิ่มหลายแถวในคำขอเดียว — ใช้ตอน scheduler.js เขียน NotifyLog หลายรายการ
// ต่อรอบ (กันแจ้งเตือนซ้ำ, ดู scheduler.js's comment เต็ม) ถ้าใช้ appendRow
// ทีละแถวจะเป็น N คำขอแยกกัน ซึ่งเป็นบทเรียนเดียวกับที่เจอมาแล้วครั้งก่อน
// (bootstrap 9 คำขอ → รวมเป็น 1 ด้วย readTabs/batchGet) — ฝั่งเขียนก็ควร
// รวมเป็นคำขอเดียวเหมือนกันถ้าเขียนหลายแถวพร้อมกันได้
async function appendRows(tab, objs) {
  if (!objs || !objs.length) return [];
  const sheets = await client();
  const header = await getHeader(sheets, tab);
  const rows = objs.map((obj) => objectToRow(header, obj));
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID(),
    range: `${tab}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
  return objs;
}

async function findRowNumber(sheets, tab, header, matchCol, matchValue) {
  const colIdx = header.indexOf(matchCol);
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID(), range: `${tab}!A2:${MAX_COL}1000` });
  const rows = res.data.values || [];
  const idx = rows.findIndex((r) => String(r[colIdx]) === String(matchValue));
  return idx === -1 ? -1 : idx + 2; // +1 for 1-based, +1 for header row
}

async function updateRow(tab, matchValue, patch, matchCol = 'id') {
  const sheets = await client();
  const header = await getHeader(sheets, tab);
  const rowNum = await findRowNumber(sheets, tab, header, matchCol, matchValue);
  if (rowNum === -1) throw new Error(`${tab}: row with ${matchCol}=${matchValue} not found`);
  const existingRes = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID(), range: `${tab}!A${rowNum}:${MAX_COL}${rowNum}` });
  const existingRow = (existingRes.data.values || [[]])[0] || [];
  const existingObj = {};
  header.forEach((key, i) => { existingObj[key] = existingRow[i] !== undefined ? existingRow[i] : ''; });
  const merged = { ...existingObj, ...patch };
  const row = objectToRow(header, merged);
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID(),
    range: `${tab}!A${rowNum}:${MAX_COL}${rowNum}`,
    valueInputOption: 'RAW', // store values literally — no auto number/date parsing (that's what strips leading zeros off phone numbers etc; we handle all type coercion ourselves in coerce.js)
    requestBody: { values: [row] },
  });
  return merged;
}

async function deleteRow(tab, matchValue, matchCol = 'id') {
  const sheets = await client();
  const header = await getHeader(sheets, tab);
  const rowNum = await findRowNumber(sheets, tab, header, matchCol, matchValue);
  if (rowNum === -1) return;
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID() });
  const sheetMeta = meta.data.sheets.find((s) => s.properties.title === tab);
  if (!sheetMeta) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID(),
    requestBody: {
      requests: [{
        deleteDimension: {
          range: { sheetId: sheetMeta.properties.sheetId, dimension: 'ROWS', startIndex: rowNum - 1, endIndex: rowNum },
        },
      }],
    },
  });
}

// Wipes every data row in a tab, keeping the header row (row 1) intact.
// Uses values.clear (blanks cells) rather than deleting the rows/dimension
// outright — simpler, no sheetId lookup needed, and rowsToObjects already
// filters out fully-blank rows so a cleared tab reads back as empty either
// way. Used by the "ล้างข้อมูล" system-data feature (server/routes/
// systemData.js) — irreversible, gated behind explicit owner confirmation
// (and a PIN for the full factory-reset case) at the route level.
async function clearTab(tab) {
  const sheets = await client();
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID(),
    range: `${tab}!A2:${MAX_COL}100000`,
  });
}

// "ทำส่วนกลูเกิลชีต ให้ด้วยครับ...ใช้ไปกี่%...สูงสุด 10ล้านเซลล์" (2026-07-26)
// — Dashboard status card wants a real (not fake) usage number for the
// Google Sheet card, mirroring the LINE OA card's message-quota gauge.
// Google Sheets has no per-month API quota comparable to LINE's — the only
// real, persistent limit a spreadsheet actually has is Google's own hard
// cap of 10,000,000 CELLS total across every tab in one spreadsheet file
// (this is the same number Google Sheets' own UI warns about when a sheet
// gets too big). That cap is based on each tab's ALLOCATED grid size
// (gridProperties.rowCount * columnCount), not how many cells actually
// have data in them — same definition Google uses, so this stays accurate
// even though most of those allocated cells are blank.
async function getCellUsage() {
  const sheets = await client();
  const resp = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID(),
    fields: 'sheets.properties.gridProperties',
  });
  const list = resp.data.sheets || [];
  const usedCells = list.reduce((sum, sh) => {
    const gp = sh.properties && sh.properties.gridProperties;
    if (!gp) return sum;
    return sum + (gp.rowCount || 0) * (gp.columnCount || 0);
  }, 0);
  const totalCells = 10000000;
  return { usedCells, totalCells, percent: Math.min(100, (usedCells / totalCells) * 100) };
}

// "เก็บข้อมูลไว้สูงสุด 5 ปีเลยครับ" (2026-07-26) — retention cleanup for
// high-volume log tabs (ElectricityLog/WaterLog, see server/routes/tuya.js
// — up to 1 row/room/hour forever, no expiry until now). Deletes rows
// whose dateField is older than cutoffDate, keyed by matching column name
// (e.g. 'timestamp'). Rows with a missing/unparseable date are KEPT rather
// than guessed-deleted (safer default — better to over-keep than silently
// lose data from a row this function doesn't understand).
//
// Deliberately does ONE clear + ONE rewrite of the whole tab instead of
// calling deleteRow() per old row — deleteRow does its own
// getHeader+spreadsheets.get+batchUpdate round trip EVERY call, which would
// mean hundreds/thousands of separate Sheets API calls to prune a year of
// hourly logs (guaranteed to blow through the per-minute read/write quota
// documented elsewhere in this codebase). This way it's always exactly 2
// API calls total (one values.clear, one values.update) no matter how many
// rows are being pruned.
async function pruneOldRows(tab, dateField, cutoffDate) {
  const sheets = await client();
  const header = await getHeader(sheets, tab);
  const range = `${tab}!A2:${MAX_COL}100000`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID(), range });
  const rows = res.data.values || [];
  if (rows.length === 0) return { removedCount: 0, keptCount: 0 };
  const objs = rowsToObjects([header, ...rows]);
  const kept = objs.filter((r) => {
    const v = r[dateField];
    if (!v) return true;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) || d >= cutoffDate;
  });
  const removedCount = objs.length - kept.length;
  if (removedCount === 0) return { removedCount: 0, keptCount: kept.length };
  await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID(), range });
  if (kept.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID(),
      range: `${tab}!A2`,
      valueInputOption: 'RAW',
      requestBody: { values: kept.map((obj) => objectToRow(header, obj)) },
    });
  }
  return { removedCount, keptCount: kept.length };
}

module.exports = { readTab, readTabs, appendRow, appendRows, updateRow, deleteRow, clearTab, getCellUsage, pruneOldRows };
