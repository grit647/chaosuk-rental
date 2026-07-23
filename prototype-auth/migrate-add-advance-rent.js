// ONE-TIME MIGRATION SCRIPT — adds an "advanceRent" column to the Rooms
// tab (ค่าเช่าล่วงหน้า, distinct from the existing "deposit" / เงินประกัน
// column), per explicit owner request while adding both fields to the
// "กรอกข้อมูลสัญญาเช่า" contract form. Backfills every existing row to 0
// (nothing had this concept before — 0 correctly means "no advance rent
// collected," not "not set yet").
//
// Safety: only touches THIS SHEET's Rooms tab (run once per building —
// see server/.env's GOOGLE_SHEET_ID, or pass a different customerSheetId
// as the CLI arg for another building). Refuses to run if the column
// already exists (idempotency guard against double-running).
const path = require('path');
require(path.join(__dirname, '..', 'server', 'node_modules', 'dotenv')).config({
  path: path.join(__dirname, '..', 'server', '.env'),
});
const { google } = require(path.join(__dirname, '..', 'server', 'node_modules', 'googleapis'));

// 0-based column index -> spreadsheet column letter(s) (A, B, ... Z, AA,
// AB, ...) — needed because the Rooms tab already has 28+ columns, well
// past single-letter range; a naive String.fromCharCode(65+idx) breaks
// silently past 'Z' (this bit the first version of this script).
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
  if (header.includes('advanceRent')) {
    console.log('advanceRent column already exists — nothing to do (safe to ignore, already migrated).');
    return;
  }

  const dataRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Rooms!A2:ZZ1000' });
  const rows = dataRes.data.values || [];
  console.log(`Found ${rows.length} existing room rows — will backfill advanceRent=0 for all of them.`);

  const newColIdx = header.length;
  const newColLetter = colLetter(newColIdx);

  // The sheet's grid itself may not have enough columns provisioned yet
  // (Google Sheets tabs start with a fixed grid size, e.g. 28 columns —
  // writing to column 29 fails with "exceeds grid limits" until the grid
  // is explicitly widened first). appendDimension adds columns to the END
  // of the existing grid, exactly where this new column needs to go.
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

  console.log(`Adding column "${newColLetter}1" = advanceRent...`);
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `Rooms!${newColLetter}1`, valueInputOption: 'RAW',
    requestBody: { values: [['advanceRent']] },
  });

  if (rows.length) {
    console.log(`Backfilling ${newColLetter}2:${newColLetter}${rows.length + 1} = 0...`);
    const values = rows.map(() => [0]);
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: `Rooms!${newColLetter}2:${newColLetter}${rows.length + 1}`, valueInputOption: 'RAW',
      requestBody: { values },
    });
  }

  console.log('\n✅ Done — every existing room now has advanceRent=0.');
}

main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
