// ONE-TIME MIGRATION SCRIPT — adds an "elecRestoredAt" column to the Rooms
// tab (per explicit owner request 2026-08-10 follow-up: "การจ่ายไฟอาจมี 2
// กรณี คือ 1 ชำระบิลทั้งหมด แล้วจ่ายไฟให้ กับ 2 การขอใช้ไฟชั่วคราว คือ
// การที่บิลยังไม่ชำระแต่ขอให้เปิดการใช้ไฟให้ครับ" — restoring power after a
// non-payment cutoff needs its own timestamp, separate from elecCutoffAt
// (which now stays as "last time this room was cut" and is NO LONGER
// cleared on restore — see migrate-add-elec-cutoff-column.js). Comparing
// the two timestamps tells the Bills page whether the room is currently
// OFF (elecCutoffAt is the more recent of the two) or was given a
// TEMPORARY restore while still unpaid (elecRestoredAt is more recent —
// shows "⚡ ขอใช้ไฟชั่วคราว" instead of "🔌 ตัดไฟแล้ว").
//
// Blank/missing = never restored after a cutoff (or nothing to restore
// from). Written by BOTH server/routes/tuya.js's POST /switch (on:true)
// and any future LINE-side "restore power" action if one gets added.
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
  if (header.includes('elecRestoredAt')) {
    console.log(`[${tabName}] elecRestoredAt column already exists — skipping (safe to ignore).`);
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
    requestBody: { values: [['elecRestoredAt']] },
  });
  console.log(`[${tabName}] Added column "${newColLetter}1" = elecRestoredAt (existing rows left blank = never restored after a cutoff).`);
  console.log('\n✅ Done.');
}

main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
