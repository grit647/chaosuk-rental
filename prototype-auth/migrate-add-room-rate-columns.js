// ONE-TIME MIGRATION SCRIPT — adds "waterRate"/"elecRate" columns to the
// Rooms tab. Real bug found 2026-08-01 while trying to fill in per-room
// contract rates: `roomRate()` (Rental Management.dc.html) and
// `saveContractForm` have ALWAYS assumed a room-level "waterRate"/
// "elecRate" column exists (the "อัตราค่าบริการ" fields on the lease
// contract form, cf.waterRate/cf.elecRate) — but NEITHER column has ever
// actually existed on ANY building's Rooms tab, not even the main
// account's own spreadsheet. That means typing a per-room rate override
// into the contract form has been silently no-op'ing (save succeeds, HTTP
// 200, but there's no column to write the value into) for every building,
// this whole time — same root-cause class as the tuyaWaterDeviceId/
// advanceRent incidents documented in CLAUDE.md's "Permanent gotcha"
// section, except this one was never scoped to just the newer buildings.
//
// Backfills every existing row to '' (empty) — NOT a number. An empty
// value correctly means "no room-specific override, fall back to the
// shared property-wide rate" (see roomRate()'s `ownRate != null` check
// and coerceRooms' `r.waterRate === '' || r.waterRate == null ? null :
// ...` handling) — 0 would incorrectly mean "this room bills water/elec
// for free," which is never what's intended for a room that just hasn't
// had a contract-specific rate typed in yet.
//
// Safety: only touches THIS SHEET's Rooms tab (run once per building —
// pass a different customerSheetId as the CLI arg for another building).
// Refuses to run if the columns already exist (idempotency guard).
const path = require('path');
require(path.join(__dirname, '..', 'server', 'node_modules', 'dotenv')).config({
  path: path.join(__dirname, '..', 'server', '.env'),
});
const { google } = require(path.join(__dirname, '..', 'server', 'node_modules', 'googleapis'));

function colLetter(idx) {
  let s = '';
  let n = idx;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

async function client() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  return google.sheets({ version: 'v4', auth });
}

async function ensureColumn(sheets, spreadsheetId, header, colName) {
  if (header.includes(colName)) { console.log(`${colName} already exists — skipping.`); return header; }
  const newColIdx = header.length;
  const newColLetter = colLetter(newColIdx);
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const roomsSheet = meta.data.sheets.find((s) => s.properties.title === 'Rooms');
  const currentColCount = roomsSheet.properties.gridProperties.columnCount;
  if (newColIdx >= currentColCount) {
    console.log(`Sheet grid only has ${currentColCount} columns — widening by 10 first...`);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ appendDimension: { sheetId: roomsSheet.properties.sheetId, dimension: 'COLUMNS', length: 10 } }] },
    });
  }
  console.log(`Adding column "${newColLetter}1" = ${colName}...`);
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `Rooms!${newColLetter}1`, valueInputOption: 'RAW',
    requestBody: { values: [[colName]] },
  });

  const dataRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Rooms!A2:A1000' });
  const rowCount = (dataRes.data.values || []).length;
  if (rowCount) {
    console.log(`Backfilling ${newColLetter}2:${newColLetter}${rowCount + 1} = '' (empty — "no override yet", not 0)...`);
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: `Rooms!${newColLetter}2:${newColLetter}${rowCount + 1}`, valueInputOption: 'RAW',
      requestBody: { values: Array.from({ length: rowCount }, () => ['']) },
    });
  }
  return [...header, colName];
}

async function main() {
  const spreadsheetId = process.argv[2] || process.env.GOOGLE_SHEET_ID;
  console.log('Target spreadsheet (Rooms tab):', spreadsheetId);
  const sheets = await client();

  let headerRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Rooms!A1:ZZ1' });
  let header = (headerRes.data.values || [[]])[0] || [];

  header = await ensureColumn(sheets, spreadsheetId, header, 'waterRate');
  header = await ensureColumn(sheets, spreadsheetId, header, 'elecRate');

  console.log('\n✅ Done — waterRate/elecRate columns now exist on this Rooms tab. Contract-form "อัตราค่าบริการ" saves will actually persist from here on.');
}

main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
