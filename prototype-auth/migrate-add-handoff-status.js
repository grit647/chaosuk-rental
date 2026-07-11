// ONE-TIME MIGRATION SCRIPT — adds a "handoffStatus" column to the master
// login directory's Users tab, defaulting every EXISTING row to "ready"
// (existing buildings — Server, บ้านพักครูโจ — are already live/handed
// off, so they shouldn't show as "still being configured"). Per explicit
// user request: a checklist marker so คุณต้น doesn't lose track of which
// NEW buildings still need setup before handing the login over to the
// real customer, vs which are done and safe to send. New buildings
// created after this migration default to "pending" instead (set in
// server/routes/settings.js's add-building).
//
// Safety: only touches the DIRECTORY sheet (GOOGLE_DIRECTORY_SHEET_ID),
// never any customer's own data Sheet. Refuses to run if a
// "handoffStatus" column already exists (idempotency guard).
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
  if (header.includes('handoffStatus')) {
    console.log('handoffStatus column already exists — nothing to do, exiting.');
    return;
  }

  const dataRes = await sheets.spreadsheets.values.get({ spreadsheetId: dirId, range: 'Users!A2:Z1000' });
  const rows = dataRes.data.values || [];
  console.log(`\nFound ${rows.length} existing row(s) — all will default to handoffStatus=ready (already live buildings):`);
  rows.forEach((r, i) => console.log(`  Row ${i + 1}:`, header.map((h, j) => `${h}=${r[j] || ''}`).join(', ')));

  console.log('\nWriting new header (handoffStatus appended)...');
  const newHeader = [...header, 'handoffStatus'];
  await sheets.spreadsheets.values.update({
    spreadsheetId: dirId, range: 'Users!A1', valueInputOption: 'RAW',
    requestBody: { values: [newHeader] },
  });

  if (rows.length) {
    console.log('Backfilling handoffStatus=ready for each existing row...');
    const newRows = rows.map((r) => [...r, 'ready']);
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
