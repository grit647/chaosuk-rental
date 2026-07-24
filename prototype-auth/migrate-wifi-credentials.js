// ONE-TIME MIGRATION SCRIPT — replaces the single "wifiCode" column on the
// Rooms tab with two separate columns: "wifiUsername" and "wifiPassword"
// (per explicit owner request — the "รหัส WiFi ห้อง" field is really an
// internet/router login pair, e.g. matching a printed "บัตรใช้งาน
// อินเทอร์เน็ต" card with ชื่อผู้ใช้/รหัสผ่าน, not a single WiFi network
// password). Existing wifiCode values are copied into wifiUsername
// (owner's explicit choice — wifiPassword starts blank for every room,
// to be filled in later via the contract form).
//
// Safety: only touches THIS SHEET's Rooms tab (run once per building —
// pass a different customerSheetId as the CLI arg for another building,
// defaults to server/.env's GOOGLE_SHEET_ID). The old wifiCode column is
// left in place untouched (not deleted) — just no longer read/written by
// the app after this migration + the matching code deploy. Refuses to
// run if wifiUsername already exists (idempotency guard).
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
  console.log('Target spreadsheet (Rooms tab):', spreadsheetId);
  const sheets = await client();

  const headerRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Rooms!A1:ZZ1' });
  const header = (headerRes.data.values || [[]])[0] || [];
  if (header.includes('wifiUsername')) {
    console.log('wifiUsername column already exists — nothing to do (safe to ignore, already migrated).');
    return;
  }
  const wifiCodeIdx = header.indexOf('wifiCode');

  const dataRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Rooms!A2:ZZ1000' });
  const rows = dataRes.data.values || [];
  console.log(`Found ${rows.length} existing room rows.`);

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const roomsSheet = meta.data.sheets.find((s) => s.properties.title === 'Rooms');
  const currentColCount = roomsSheet.properties.gridProperties.columnCount;
  const neededCols = header.length + 2; // wifiUsername + wifiPassword
  if (neededCols > currentColCount) {
    console.log(`Sheet grid only has ${currentColCount} columns — widening by 10 first...`);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ appendDimension: { sheetId: roomsSheet.properties.sheetId, dimension: 'COLUMNS', length: 10 } }] },
    });
  }

  const userColIdx = header.length;
  const passColIdx = header.length + 1;
  const userColLetter = colLetter(userColIdx);
  const passColLetter = colLetter(passColIdx);

  console.log(`Adding columns "${userColLetter}1"=wifiUsername, "${passColLetter}1"=wifiPassword...`);
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `Rooms!${userColLetter}1:${passColLetter}1`, valueInputOption: 'RAW',
    requestBody: { values: [['wifiUsername', 'wifiPassword']] },
  });

  if (rows.length) {
    console.log(`Copying existing wifiCode -> wifiUsername for ${rows.length} rows (wifiPassword left blank)...`);
    const userValues = rows.map((r) => [wifiCodeIdx === -1 ? '' : (r[wifiCodeIdx] || '')]);
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: `Rooms!${userColLetter}2:${userColLetter}${rows.length + 1}`, valueInputOption: 'RAW',
      requestBody: { values: userValues },
    });
  }

  console.log('\n✅ Done — every existing room now has wifiUsername (copied from old wifiCode) and a blank wifiPassword.');
  console.log('The old wifiCode column is still there, untouched — safe to ignore, the app no longer reads/writes it after this.');
}

main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
