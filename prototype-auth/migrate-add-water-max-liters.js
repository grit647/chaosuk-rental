// One-time migration: adds a `tuyaWaterMaxLiters` column to Rooms so the
// Equipment page's water tab can save an optional per-room rollover value
// (see Rental Management.dc.html's _waterRolloverUnits()). Same safe
// header-keyed-object rebuild pattern as migrate-add-water-device-column.js
// — never assumes row array length/position, since Google Sheets silently
// trims trailing empty cells from values.get responses.
require('dotenv').config({ path: require('path').join(__dirname, '..', 'server', '.env') });
const { google } = require('googleapis');

const NEW_COLUMN = 'tuyaWaterMaxLiters';

function colLetter(n) {
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

async function main() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  const sheets = google.sheets({ version: 'v4', auth });
  // Accepts an optional Sheet ID as a CLI arg so it can be run against any
  // customer's own Rooms sheet in this multi-tenant system, not just the
  // main property's (per explicit user request — this same migration ran
  // against บ้านพักครูโจ's own separate sheet too, since that's where the
  // real water device actually lives).
  const spreadsheetId = process.argv[2] || process.env.GOOGLE_SHEET_ID;
  console.log('Target spreadsheet:', spreadsheetId);

  const headerRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Rooms!A1:BZ1' });
  const header = headerRes.data.values[0];
  if (header.includes(NEW_COLUMN)) {
    console.log(`Column "${NEW_COLUMN}" already exists — nothing to do.`);
    return;
  }

  const allRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Rooms!A2:BZ1000' });
  const rows = allRes.data.values || [];
  console.log(`Found ${rows.length} data row(s). Adding column "${NEW_COLUMN}" at position ${header.length + 1}.`);

  const newHeader = [...header, NEW_COLUMN];
  const newRows = rows.map((row) => {
    const obj = {};
    header.forEach((key, i) => { obj[key] = row[i] !== undefined ? row[i] : ''; });
    obj[NEW_COLUMN] = '';
    return newHeader.map((key) => obj[key]);
  });

  const lastCol = colLetter(newHeader.length);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `Rooms!A1:${lastCol}1`,
    valueInputOption: 'RAW',
    requestBody: { values: [newHeader] },
  });
  if (newRows.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `Rooms!A2:${lastCol}${1 + newRows.length}`,
      valueInputOption: 'RAW',
      requestBody: { values: newRows },
    });
  }
  console.log('Done. New header:', newHeader.join(', '));
}

main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
