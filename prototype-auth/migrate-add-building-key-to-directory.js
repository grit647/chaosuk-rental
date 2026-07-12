// One-time migration: adds a `buildingKeyId` column to the central
// Directory sheet's "Users" tab, mirroring each building's own
// propertyProfile.buildingKeyId value (set on the "ข้อมูลหอพัก" card in
// Settings) so the new staff-login flow can look up "which building has
// this code" quickly (one Directory read) instead of opening every
// building's own Settings sheet to search.
//
// This is a purely ADDITIVE index column — buildingKeyId's actual source
// of truth stays each building's own Settings sheet; server/routes/
// settings.js syncs this Directory column whenever the owner saves it.
//
// Uses the same safe header-keyed-object rebuild pattern established in
// this session's other migrations (never assumes row array length,
// since Google Sheets silently trims trailing empty cells).
require('dotenv').config({ path: require('path').join(__dirname, '..', 'server', '.env') });
const { google } = require('googleapis');

const NEW_COLUMN = 'buildingKeyId';

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
  const spreadsheetId = process.env.GOOGLE_DIRECTORY_SHEET_ID;
  console.log('Target spreadsheet (Directory):', spreadsheetId);

  const headerRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Users!A1:BZ1' });
  const header = headerRes.data.values[0];
  if (header.includes(NEW_COLUMN)) {
    console.log(`Column "${NEW_COLUMN}" already exists — nothing to do.`);
    return;
  }

  const allRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Users!A2:BZ1000' });
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
    range: `Users!A1:${lastCol}1`,
    valueInputOption: 'RAW',
    requestBody: { values: [newHeader] },
  });
  if (newRows.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `Users!A2:${lastCol}${1 + newRows.length}`,
      valueInputOption: 'RAW',
      requestBody: { values: newRows },
    });
  }
  console.log('Done. New header:', newHeader.join(', '));
}

main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
