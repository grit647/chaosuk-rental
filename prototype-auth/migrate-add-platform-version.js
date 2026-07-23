// ONE-TIME MIGRATION SCRIPT — adds a "platformVersion" column to the
// master login directory's Users tab, and backfills EVERY existing row to
// CURRENT_PLATFORM_VERSION (server/platformVersion.js) — the whole point
// of the staged-rollout gate is that nothing already live today should
// show a false "🆕 อัปเดต" nag, only features shipped AFTER this migration
// runs get gated. See server/platformVersion.js for the full mechanism.
//
// Safety: only touches the DIRECTORY sheet (GOOGLE_DIRECTORY_SHEET_ID),
// never any customer's own data Sheet. Refuses to run if a
// "platformVersion" column already exists (idempotency guard against
// double-running). Existing rows are printed BEFORE any write happens.
const path = require('path');
require(path.join(__dirname, '..', 'server', 'node_modules', 'dotenv')).config({
  path: path.join(__dirname, '..', 'server', '.env'),
});
const { google } = require(path.join(__dirname, '..', 'server', 'node_modules', 'googleapis'));
const { CURRENT_PLATFORM_VERSION } = require(path.join(__dirname, '..', 'server', 'platformVersion'));

const DIRECTORY_SHEET_ID = process.env.GOOGLE_DIRECTORY_SHEET_ID;

async function client() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  return google.sheets({ version: 'v4', auth });
}

async function main() {
  if (!DIRECTORY_SHEET_ID) throw new Error('GOOGLE_DIRECTORY_SHEET_ID not set in server/.env');
  const sheets = await client();

  const headerRes = await sheets.spreadsheets.values.get({ spreadsheetId: DIRECTORY_SHEET_ID, range: 'Users!A1:ZZ1' });
  const header = (headerRes.data.values || [[]])[0] || [];
  if (header.includes('platformVersion')) {
    console.log('platformVersion column already exists — nothing to do (safe to ignore, already migrated).');
    return;
  }

  const dataRes = await sheets.spreadsheets.values.get({ spreadsheetId: DIRECTORY_SHEET_ID, range: 'Users!A2:ZZ1000' });
  const rows = dataRes.data.values || [];
  console.log(`Found ${rows.length} existing rows — will backfill platformVersion=${CURRENT_PLATFORM_VERSION} for all of them:`);
  rows.forEach((r, i) => console.log(`  row ${i + 2}:`, header.map((h, j) => `${h}=${r[j] || ''}`).join(' ')));

  const newColIdx = header.length; // append as the next column
  const newColLetter = String.fromCharCode(65 + newColIdx);

  console.log(`\nAdding column "${newColLetter}1" = platformVersion...`);
  await sheets.spreadsheets.values.update({
    spreadsheetId: DIRECTORY_SHEET_ID, range: `Users!${newColLetter}1`, valueInputOption: 'RAW',
    requestBody: { values: [['platformVersion']] },
  });

  if (rows.length) {
    console.log(`Backfilling ${newColLetter}2:${newColLetter}${rows.length + 1} = ${CURRENT_PLATFORM_VERSION}...`);
    const values = rows.map(() => [CURRENT_PLATFORM_VERSION]);
    await sheets.spreadsheets.values.update({
      spreadsheetId: DIRECTORY_SHEET_ID, range: `Users!${newColLetter}2:${newColLetter}${rows.length + 1}`, valueInputOption: 'RAW',
      requestBody: { values },
    });
  }

  console.log('\n✅ Done — every existing building is now pinned at platformVersion=' + CURRENT_PLATFORM_VERSION + '. New buildings added from now on should be created with this same value (see add-building routes/scripts).');
}

main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
