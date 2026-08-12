// ONE-TIME MIGRATION SCRIPT — adds a "waterSetNewValue" column to the Rooms
// tab (per explicit owner request 2026-08-12: "เพิ่มอีก 1 ช่องครับ เป็น
// 'ค่า SET NEW' มันคือค่าที่ต้องเอาไปบวก ที่ทำให้ค่ารวมตรงกับ Tuya เพิ่ม
// ส่วนที่แสดงค่ารวมของมิเตอร์แต่ละตัวเข้าไปด้วยครับ ค่ารวมมาจากผลรวม
// ทั้งหมด กับ ค่า SET NEW").
//
// This is a DIFFERENT mechanism from the existing "🎯 คาลิเบรตมิเตอร์น้ำ"
// button (which overwrites the tracked WaterLog cumulative total directly)
// — waterSetNewValue is a persistent per-room CORRECTION OFFSET, manually
// typed in by the owner, added on top of whatever our own tracked total
// currently is when displaying the combined "ค่ารวมของมิเตอร์" figure —
// the underlying tracked total itself is untouched by this field.
//
// Blank/missing = no offset (0), combined total = just our own tracked
// total, unchanged from before this field existed.
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
  if (header.includes('waterSetNewValue')) {
    console.log(`[${tabName}] waterSetNewValue column already exists — skipping (safe to ignore).`);
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
    requestBody: { values: [['waterSetNewValue']] },
  });
  console.log(`[${tabName}] Added column "${newColLetter}1" = waterSetNewValue (existing rows left blank = no correction offset yet).`);
  console.log('\n✅ Done.');
}

main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
