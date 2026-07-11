// ONE-TIME MIGRATION SCRIPT — adds a "status" column to the master login
// directory's Users tab, defaulting every EXISTING row to "active". Per
// explicit user request: lets the platform admin pause/suspend a specific
// building (e.g. a monthly-subscription customer who hasn't paid) without
// deleting their data — a suspended building's row still exists, login
// still works for the owner, but that specific building can't be
// selected until reactivated. See server/routes/settings.js's
// toggle-building-status / delete-building routes for how this is used.
//
// Safety: only touches the DIRECTORY sheet (GOOGLE_DIRECTORY_SHEET_ID),
// never any customer's own data Sheet. Refuses to run if a "status"
// column already exists (idempotency guard against double-running).
const path = require('path');
require(path.join(__dirname, '..', 'server', 'node_modules', 'dotenv')).config({
  path: path.join(__dirname, '..', 'server', '.env'),
});
const { google } = require(path.join(__dirname, '..', 'server', 'node_modules', 'googleapis'));

async function client() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  return google.sheets({ version: 'v4', auth });
}

async function main() {
  const sheets = await client();
  const dirId = process.env.GOOGLE_DIRECTORY_SHEET_ID;
  if (!dirId) throw new Error('GOOGLE_DIRECTORY_SHEET_ID not set in server/.env');

  const headerRes = await sheets.spreadsheets.values.get({ spreadsheetId: dirId, range: 'Users!A1:Z1' });
  const header = headerRes.data.values[0];
  console.log('Current header:', header.join(', '));
  if (header.includes('status')) {
    console.log('status column already exists — nothing to do, exiting.');
    return;
  }

  const dataRes = await sheets.spreadsheets.values.get({ spreadsheetId: dirId, range: 'Users!A2:Z1000' });
  const rows = dataRes.data.values || [];
  console.log(`\nFound ${rows.length} existing row(s) to migrate — all will default to status=active:`);
  rows.forEach((r, i) => console.log(`  Row ${i + 1}:`, header.map((h, j) => `${h}=${r[j] || ''}`).join(', ')));

  console.log('\nWriting new header (status appended)...');
  const newHeader = [...header, 'status'];
  await sheets.spreadsheets.values.update({
    spreadsheetId: dirId, range: 'Users!A1', valueInputOption: 'RAW',
    requestBody: { values: [newHeader] },
  });

  if (rows.length) {
    console.log('Backfilling status=active for each existing row...');
    const newRows = rows.map((r) => [...r, 'active']);
    await sheets.spreadsheets.values.update({
      spreadsheetId: dirId, range: 'Users!A2', valueInputOption: 'RAW',
      requestBody: { values: newRows },
    });
  }

  console.log('\n✅ Migration complete.');
}

main().catch((err) => {
  console.error('เกิดข้อผิดพลาด:', err.message);
  process.exit(1);
});
