// ONE-TIME MIGRATION SCRIPT — adds receipt-delivery-confirmation columns
// to the Invoices tab, per explicit owner request (2026-08-02): every
// receipt send now attaches a "✅ ยืนยันได้รับแล้ว" LINE button for the
// tenant, auto-retries once after 24h if unconfirmed, and escalates to
// the owner after a 2nd unconfirmed send. See server/routes/line.js's
// POST /api/invoices/:id/send-with-confirm and server/routes/
// scheduler.js's receipt-confirmation retry loop for where these are
// read/written.
//
// New columns:
//   receiptDeliveryConfirmed — bool, tenant tapped the confirm button
//   receiptSendCount         — number, how many times this invoice's
//                              receipt has gone out (1 = first send, 2 =
//                              the 24h auto-retry — capped there)
//   receiptLastSentAt        — ISO timestamp of the most recent send
//   receiptOwnerNotified     — bool, whether the owner has already been
//                              escalated to for THIS invoice (stops the
//                              scheduler from re-notifying every run)
//
// Safety: only touches THIS SHEET's Invoices tab (run once per building —
// pass a different customerSheetId as the CLI arg for another building,
// per the "Permanent gotcha" note in CLAUDE.md). Refuses to re-add a
// column that already exists (idempotency guard).
const path = require('path');
require(path.join(__dirname, '..', 'server', 'node_modules', 'dotenv')).config({
  path: path.join(__dirname, '..', 'server', '.env'),
});
const { google } = require(path.join(__dirname, '..', 'server', 'node_modules', 'googleapis'));

function colLetter(idx) {
  let s = '';
  let n = idx;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

async function client() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  return google.sheets({ version: 'v4', auth });
}

async function ensureColumn(sheets, spreadsheetId, tab, header, colName) {
  if (header.includes(colName)) { console.log(`${colName} already exists — skipping.`); return header; }
  const newColIdx = header.length;
  const newColLetter = colLetter(newColIdx);
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetMeta = meta.data.sheets.find((s) => s.properties.title === tab);
  const currentColCount = sheetMeta.properties.gridProperties.columnCount;
  if (newColIdx >= currentColCount) {
    console.log(`Sheet grid only has ${currentColCount} columns — widening by 10 first...`);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ appendDimension: { sheetId: sheetMeta.properties.sheetId, dimension: 'COLUMNS', length: 10 } }] },
    });
  }
  console.log(`Adding column "${newColLetter}1" = ${colName}...`);
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `${tab}!${newColLetter}1`, valueInputOption: 'RAW',
    requestBody: { values: [[colName]] },
  });
  return [...header, colName];
}

async function main() {
  const spreadsheetId = process.argv[2] || process.env.GOOGLE_SHEET_ID;
  console.log('Target spreadsheet (Invoices tab):', spreadsheetId);
  const sheets = await client();

  let headerRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Invoices!A1:ZZ1' });
  let header = (headerRes.data.values || [[]])[0] || [];

  for (const col of ['receiptDeliveryConfirmed', 'receiptSendCount', 'receiptLastSentAt', 'receiptOwnerNotified']) {
    header = await ensureColumn(sheets, spreadsheetId, 'Invoices', header, col);
  }

  console.log('\n✅ Done — receipt-confirmation columns now exist on this Invoices tab.');
}

main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
