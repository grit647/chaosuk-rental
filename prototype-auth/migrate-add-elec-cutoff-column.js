// ONE-TIME MIGRATION SCRIPT — adds an "elecCutoffAt" column to the Rooms
// tab (per explicit owner request 2026-08-10: "ส่งข้อความการยืนยันการตัด
// ไฟ...ถ้ามีการยืนยันการตัดไฟ น้ำ ให้แสดงตรงนี้ด้วย" — the Bills page's
// status badge should show "🔌 ตัดไฟแล้ว" once a room's power has actually
// been cut off due to non-payment, not just a generic "เกินกำหนด").
//
// Blank/missing = normal (power on, or never cut off for this reason).
// An ISO timestamp = the last time this room's power was confirmed cut,
// written by BOTH server/routes/line.js's "ยืนยันตัดไฟ" LINE-button
// handler AND server/routes/tuya.js's POST /switch (the "Set อุปกรณ์"
// page's own manual toggle) — cleared back to blank the moment either path
// turns the power back ON, so a stale cutoff marker from a past billing
// cycle never bleeds into a brand-new one.
//
// Safety: only touches THIS SHEET's Rooms tab (run once per building —
// pass a different customerSheetId as the CLI arg for another building,
// defaults to server/.env's GOOGLE_SHEET_ID). Refuses to run if the tab
// already has the column (idempotency guard).
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

async function main() {
  const spreadsheetId = process.argv[2] || process.env.GOOGLE_SHEET_ID;
  console.log('Target spreadsheet:', spreadsheetId);
  const sheets = await client();

  const tabName = 'Rooms';
  const headerRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tabName}!A1:ZZ1` });
  const header = (headerRes.data.values || [[]])[0] || [];
  if (header.includes('elecCutoffAt')) {
    console.log(`[${tabName}] elecCutoffAt column already exists — skipping (safe to ignore).`);
    return;
  }

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetMeta = meta.data.sheets.find((s) => s.properties.title === tabName);
  const currentColCount = sheetMeta.properties.gridProperties.columnCount;
  const newColIdx = header.length;
  if (newColIdx >= currentColCount) {
    console.log(`[${tabName}] Sheet grid only has ${currentColCount} columns — widening by 10 first...`);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ appendDimension: { sheetId: sheetMeta.properties.sheetId, dimension: 'COLUMNS', length: 10 } }] },
    });
  }

  const newColLetter = colLetter(newColIdx);
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `${tabName}!${newColLetter}1`, valueInputOption: 'RAW',
    requestBody: { values: [['elecCutoffAt']] },
  });
  console.log(`[${tabName}] Added column "${newColLetter}1" = elecCutoffAt (existing rows left blank = power on / never cut off for non-payment).`);
  console.log('\n✅ Done.');
}

main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
