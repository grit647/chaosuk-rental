const { google } = require('googleapis');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

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

async function getHeader(sheets, tab) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tab}!A1:Z1` });
  return (res.data.values || [[]])[0] || [];
}

async function readTab(tab) {
  const sheets = await client();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tab}!A1:Z1000` });
  return rowsToObjects(res.data.values || []);
}

async function appendRow(tab, obj) {
  const sheets = await client();
  const header = await getHeader(sheets, tab);
  const row = objectToRow(header, obj);
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A1`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
  return obj;
}

async function findRowNumber(sheets, tab, header, matchCol, matchValue) {
  const colIdx = header.indexOf(matchCol);
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tab}!A2:Z1000` });
  const rows = res.data.values || [];
  const idx = rows.findIndex((r) => String(r[colIdx]) === String(matchValue));
  return idx === -1 ? -1 : idx + 2; // +1 for 1-based, +1 for header row
}

async function updateRow(tab, matchValue, patch, matchCol = 'id') {
  const sheets = await client();
  const header = await getHeader(sheets, tab);
  const rowNum = await findRowNumber(sheets, tab, header, matchCol, matchValue);
  if (rowNum === -1) throw new Error(`${tab}: row with ${matchCol}=${matchValue} not found`);
  const existingRes = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tab}!A${rowNum}:Z${rowNum}` });
  const existingRow = (existingRes.data.values || [[]])[0] || [];
  const existingObj = {};
  header.forEach((key, i) => { existingObj[key] = existingRow[i] !== undefined ? existingRow[i] : ''; });
  const merged = { ...existingObj, ...patch };
  const row = objectToRow(header, merged);
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A${rowNum}:Z${rowNum}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  });
  return merged;
}

async function deleteRow(tab, matchValue, matchCol = 'id') {
  const sheets = await client();
  const header = await getHeader(sheets, tab);
  const rowNum = await findRowNumber(sheets, tab, header, matchCol, matchValue);
  if (rowNum === -1) return;
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sheetMeta = meta.data.sheets.find((s) => s.properties.title === tab);
  if (!sheetMeta) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: { sheetId: sheetMeta.properties.sheetId, dimension: 'ROWS', startIndex: rowNum - 1, endIndex: rowNum },
        },
      }],
    },
  });
}

module.exports = { readTab, appendRow, updateRow, deleteRow };
