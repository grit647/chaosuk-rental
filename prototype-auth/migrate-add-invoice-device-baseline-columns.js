// One-time migration: adds 2 new columns to the "Invoices" tab —
// waterDeviceBaselineAfter, elecDeviceBaselineAfter — per explicit owner
// request (2026-08-28): "การกรอกเอง...เอาตัวเลขที่กรอกไปคำนวณ...ถูกต้อง
// ครับ ส่วนที่ 2 ที่ต้องมีการบันทึกข้อมูลอุปกรณ์...ถ้าเกิดการลบ ข้อมูลชุด
// ที่เราบันทึกไว้ ถึงจะไม่ใช้ จะต้องถูกลบด้วยครับ แล้วกลับไปใช้บิลก่อนหน้า
// ในการคำนวณเหมือนเดิม" — a room with a Tuya device linked always
// refreshes its device baseline (room.waterPrev/elecPrev) to the live
// device reading at invoice-creation time, REGARDLESS of which mode
// ("อุปกรณ์"/"กรอกเอง") actually billed this cycle (see the v9 "เริ่มนับ
// 1 ใหม่" fix from earlier today). But the old DELETE-revert safety check
// (room.X === invoice.XPrevReading + invoice.Xunits) only holds true when
// the SAME device delta was what got billed — for a manually-billed cycle
// on a device-linked room, invoice.waterUnits is an unrelated typed
// number, so that check silently fails and the device baseline never
// gets reverted on delete. These 2 new columns record exactly what the
// device baseline WAS SET TO right after this invoice was created (the
// live device reading, in the same unit room.waterPrev/elecPrev uses),
// giving DELETE an unambiguous, mode-independent way to know whether
// it's still safe to revert.
//
// Per CLAUDE.md's "Permanent gotcha" — every customer building has its
// own SEPARATE spreadsheet, so this must be run against each one
// individually (pass the target spreadsheetId as the CLI arg), not just
// the main account.
const path = require('path');
require(path.join(__dirname, '..', 'server', 'node_modules', 'dotenv')).config({
  path: path.join(__dirname, '..', 'server', '.env'),
});
const { google } = require(path.join(__dirname, '..', 'server', 'node_modules', 'googleapis'));

const TAB_NAME = 'Invoices';
const NEW_COLUMNS = ['waterDeviceBaselineAfter', 'elecDeviceBaselineAfter'];

async function main() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.argv[2] || process.env.GOOGLE_SHEET_ID;
  console.log('Target spreadsheet:', spreadsheetId);

  const headerRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${TAB_NAME}!A1:ZZ1` });
  const header = (headerRes.data.values || [[]])[0] || [];
  const missing = NEW_COLUMNS.filter((c) => !header.includes(c));
  if (!missing.length) {
    console.log(`All columns already exist on "${TAB_NAME}" — nothing to do.`);
    return;
  }
  const startCol = header.length;
  const colLetter = (n) => {
    let s = '';
    n += 1;
    while (n > 0) { const rem = (n - 1) % 26; s = String.fromCharCode(65 + rem) + s; n = Math.floor((n - 1) / 26); }
    return s;
  };
  // Some older sheets have a narrow physical grid (e.g. 36 columns) —
  // expand it first if the new columns would fall outside the current
  // grid, same lesson as this project's MAX_COL/MAX_ROW gotchas.
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const sheetMeta = meta.data.sheets.find((s) => s.properties.title === TAB_NAME);
  const neededCols = startCol + missing.length;
  if (sheetMeta && sheetMeta.properties.gridProperties.columnCount < neededCols) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          updateSheetProperties: {
            properties: { sheetId: sheetMeta.properties.sheetId, gridProperties: { columnCount: neededCols + 10 } },
            fields: 'gridProperties.columnCount',
          },
        }],
      },
    });
    console.log(`Expanded "${TAB_NAME}" grid to ${neededCols + 10} columns (was ${sheetMeta.properties.gridProperties.columnCount}).`);
  }
  const range = `${TAB_NAME}!${colLetter(startCol)}1:${colLetter(startCol + missing.length - 1)}1`;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'RAW',
    requestBody: { values: [missing] },
  });
  console.log(`Added columns to "${TAB_NAME}":`, missing.join(', '), 'at', range);
}

main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
