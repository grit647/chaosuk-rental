// One-time migration: adds a `lineUserId` column to a building's own
// Admins tab (the "ผู้ดูแล" login-capable accounting-clerk role — NOT the
// separate Staff/สัญญาพนักงาน employment-contract tab, which already had
// its own unrelated lineUserId column added earlier). Lets each ผู้ดูแล
// self-link their own LINE account by typing their PIN into the shared
// LINE OA chat, same mechanism as the owner's adminEditPin self-link —
// see server/routes/line.js's webhook text-message handler.
//
// Accepts an optional Sheet ID CLI arg — run once per building's own
// Sheet, same pattern as the other per-building migrations this session.
const path = require('path');
const SERVER_MODULES = path.join(__dirname, '..', 'server', 'node_modules');
require(path.join(SERVER_MODULES, 'dotenv')).config({ path: path.join(__dirname, '..', 'server', '.env') });
const { google } = require(path.join(SERVER_MODULES, 'googleapis'));

const NEW_COLUMN = 'lineUserId';

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
  const spreadsheetId = process.argv[2] || process.env.GOOGLE_SHEET_ID;
  console.log('Target spreadsheet:', spreadsheetId);

  const headerRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Admins!A1:BZ1' });
  const header = headerRes.data.values[0];
  if (header.includes(NEW_COLUMN)) {
    console.log(`Column "${NEW_COLUMN}" already exists — nothing to do.`);
    return;
  }

  const allRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Admins!A2:BZ1000' });
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
    range: `Admins!A1:${lastCol}1`,
    valueInputOption: 'RAW',
    requestBody: { values: [newHeader] },
  });
  if (newRows.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `Admins!A2:${lastCol}${1 + newRows.length}`,
      valueInputOption: 'RAW',
      requestBody: { values: newRows },
    });
  }
  console.log('Done. New header:', newHeader.join(', '));
}

main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
