// One-time migration: adds a `tuyaWaterDeviceId` column to the Rooms tab so
// Equipment page's "อุปกรณ์น้ำ" tab can save/read a real Tuya water flowmeter
// device ID per room (previously mock-only, never persisted).
//
// IMPORTANT — learned the hard way earlier this session: Google Sheets'
// values.get API silently omits TRAILING empty cells from returned row
// arrays. Blindly doing [...existingRow, newValue] corrupted real data
// when earlier columns were legitimately blank. This script avoids that
// entirely by reading each row as a header-keyed OBJECT (padding missing
// trailing cells with '' explicitly) and re-serializing by header name,
// so column position is always correct regardless of how many trailing
// cells a given row happened to have.
require('dotenv').config({ path: require('path').join(__dirname, '..', 'server', '.env') });
const { google } = require('googleapis');

const NEW_COLUMN = 'tuyaWaterDeviceId';

async function main() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  const headerRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Rooms!A1:Z1' });
  const header = headerRes.data.values[0];
  if (header.includes(NEW_COLUMN)) {
    console.log(`Column "${NEW_COLUMN}" already exists — nothing to do.`);
    return;
  }

  const allRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Rooms!A2:Z1000' });
  const rows = allRes.data.values || [];
  console.log(`Found ${rows.length} data row(s). Adding column "${NEW_COLUMN}" at position ${header.length + 1}.`);

  const newHeader = [...header, NEW_COLUMN];
  const newRows = rows.map((row) => {
    // Rebuild as a header-keyed object first (pad missing trailing cells),
    // THEN serialize in newHeader order — never assume array length.
    const obj = {};
    header.forEach((key, i) => { obj[key] = row[i] !== undefined ? row[i] : ''; });
    obj[NEW_COLUMN] = '';
    return newHeader.map((key) => obj[key]);
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'Rooms!A1:' + String.fromCharCode(65 + newHeader.length - 1) + '1',
    valueInputOption: 'RAW',
    requestBody: { values: [newHeader] },
  });
  if (newRows.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `Rooms!A2:${String.fromCharCode(65 + newHeader.length - 1)}${1 + newRows.length}`,
      valueInputOption: 'RAW',
      requestBody: { values: newRows },
    });
  }
  console.log('Done. New header:', newHeader.join(', '));
}

main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
