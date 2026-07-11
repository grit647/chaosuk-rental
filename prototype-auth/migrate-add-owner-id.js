// ONE-TIME MIGRATION SCRIPT — adds an "ownerId" column to the master
// login directory's Users tab, and backfills a fresh random ID for each
// EXISTING row. Per explicit user request (multi-building-per-owner
// design): ownerId is a stable, phone-independent key that groups
// multiple buildings under the same person — see the conversation this
// came out of for the full reasoning.
//
// Safety: only touches the DIRECTORY sheet (GOOGLE_DIRECTORY_SHEET_ID),
// never any customer's own data Sheet. Refuses to run if an "ownerId"
// column already exists (idempotency guard against double-running).
// Existing rows are read first and printed BEFORE any write happens, so
// you can eyeball the exact data being migrated.
const path = require('path');
require(path.join(__dirname, '..', 'server', 'node_modules', 'dotenv')).config({
  path: path.join(__dirname, '..', 'server', '.env'),
});
const { google } = require(path.join(__dirname, '..', 'server', 'node_modules', 'googleapis'));
const crypto = require('crypto');

async function client() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  return google.sheets({ version: 'v4', auth });
}

function genOwnerId() {
  return 'OWNER-' + crypto.randomBytes(6).toString('hex');
}

async function main() {
  const sheets = await client();
  const dirId = process.env.GOOGLE_DIRECTORY_SHEET_ID;
  if (!dirId) throw new Error('GOOGLE_DIRECTORY_SHEET_ID not set in server/.env');

  const headerRes = await sheets.spreadsheets.values.get({ spreadsheetId: dirId, range: 'Users!A1:Z1' });
  const header = headerRes.data.values[0];
  console.log('Current header:', header.join(', '));
  if (header.includes('ownerId')) {
    console.log('ownerId column already exists — nothing to do, exiting.');
    return;
  }

  const dataRes = await sheets.spreadsheets.values.get({ spreadsheetId: dirId, range: 'Users!A2:Z1000' });
  const rows = dataRes.data.values || [];
  console.log(`\nFound ${rows.length} existing row(s) to migrate:`);
  rows.forEach((r, i) => console.log(`  Row ${i + 1}:`, header.map((h, j) => `${h}=${r[j] || ''}`).join(', ')));

  console.log('\nWriting new header (ownerId prepended)...');
  const newHeader = ['ownerId', ...header];
  await sheets.spreadsheets.values.update({
    spreadsheetId: dirId, range: 'Users!A1', valueInputOption: 'RAW',
    requestBody: { values: [newHeader] },
  });

  if (rows.length) {
    console.log('Backfilling a fresh ownerId for each existing row...');
    const newRows = rows.map((r) => [genOwnerId(), ...r]);
    await sheets.spreadsheets.values.update({
      spreadsheetId: dirId, range: 'Users!A2', valueInputOption: 'RAW',
      requestBody: { values: newRows },
    });
    newRows.forEach((r, i) => console.log(`  Row ${i + 1} -> ownerId=${r[0]}`));
  }

  console.log('\n✅ Migration complete.');
}

main().catch((err) => {
  console.error('เกิดข้อผิดพลาด:', err.message);
  process.exit(1);
});
