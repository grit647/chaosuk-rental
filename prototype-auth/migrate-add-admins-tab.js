// One-time migration: creates a new "Admins" tab, per explicit user
// request to fully separate "ผู้ดูแล" (accounting-clerk login access,
// full access same as the owner, just a separate credential) from
// "Staff"/สัญญาพนักงาน (employment contract data — salary, hours,
// position — no login concept at all). Yesterday's design had briefly
// bolted a login PIN onto the Staff tab; today's explicit correction:
// keep them as two completely separate tables, never mixed again.
//
// Columns: id, name, phone, pin — deliberately minimal, no employment
// fields (no salary/position/workHours — this isn't a job record).
require('dotenv').config({ path: require('path').join(__dirname, '..', 'server', '.env') });
const { google } = require('googleapis');

const TAB_NAME = 'Admins';
const HEADER = ['id', 'name', 'phone', 'pin'];

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

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets.find((s) => s.properties.title === TAB_NAME);
  if (existing) {
    console.log(`Tab "${TAB_NAME}" already exists — nothing to do.`);
    return;
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: TAB_NAME } } }] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${TAB_NAME}!A1:D1`,
    valueInputOption: 'RAW',
    requestBody: { values: [HEADER] },
  });
  console.log(`Created "${TAB_NAME}" tab with header:`, HEADER.join(', '));
}

main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
