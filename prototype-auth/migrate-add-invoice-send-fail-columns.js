// One-time migration: adds 2 new columns to the "Invoices" tab —
// lastSendFailedAt (ISO timestamp), lastSendFailReason (short error text,
// e.g. a LINE API error message like quota-exceeded) — per explicit owner
// request (2026-08-13) after discovering some rooms' "ส่งทันที"/scheduled
// LINE sends had silently failed with no lasting trace, only a toast that
// was easy to miss ("กันปัญหาเรื่องของโควต้า ถ้าการส่งไม่สำเร็จ ขึ้นเตือน
// ไว้ให้หน่อยครับ"). Both fields get set by sendReceiptLine (Rental
// Management.dc.html) and the scheduled-message send loop
// (server/routes/scheduler.js) whenever a real send attempt throws, and
// cleared back to '' the next time a send for that invoice succeeds — so
// the Bills page can show a persistent "⚠️ ส่งไม่สำเร็จล่าสุด" badge
// instead of relying on a toast the owner might not see in time.
//
// Per CLAUDE.md's "Permanent gotcha" — every customer building has its
// own SEPARATE spreadsheet, so this must be run against each one
// individually (pass the target spreadsheetId as the CLI arg), not just
// the main account.
const path = require('path');
require(path.join(__dirname, '..', 'server', 'node_modules', 'dotenv')).config({
  path: path.join(__dirname, '..', 'server', '.env'),
});
const { google } = require(path.join(__dirname, '..', 'server', 'node_modules', 'googleapis'));

const TAB_NAME = 'Invoices';
const NEW_COLUMNS = ['lastSendFailedAt', 'lastSendFailReason'];

async function main() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.argv[2] || process.env.GOOGLE_SHEET_ID;
  console.log('Target spreadsheet:', spreadsheetId);

  const headerRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${TAB_NAME}!A1:ZZ1` });
  const header = (headerRes.data.values || [[]])[0] || [];
  const missing = NEW_COLUMNS.filter((c) => !header.includes(c));
  if (!missing.length) {
    console.log(`All columns already exist on "${TAB_NAME}" — nothing to do.`);
    return;
  }
  const startCol = header.length; // 0-indexed next free column
  const colLetter = (n) => {
    let s = '';
    n += 1;
    while (n > 0) { const rem = (n - 1) % 26; s = String.fromCharCode(65 + rem) + s; n = Math.floor((n - 1) / 26); }
    return s;
  };
  const range = `${TAB_NAME}!${colLetter(startCol)}1:${colLetter(startCol + missing.length - 1)}1`;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'RAW',
    requestBody: { values: [missing] },
  });
  console.log(`Added columns to "${TAB_NAME}":`, missing.join(', '), 'at', range);
}

main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
