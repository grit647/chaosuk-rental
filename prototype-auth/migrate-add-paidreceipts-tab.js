// One-time migration: creates a new "PaidReceipts" tab — permanent
// archive of confirmed payment slips, paired with which invoice (or
// room-level advance credit) they settled.
//
// Real gap found (2026-08-04): the owner asked for an "album" page to
// browse historical receipts/slips. Investigation found that confirming
// a slip (เต็มจำนวน/บางส่วน/เงินล่วงหน้า) always wipes `slipsJson` back
// to `[]` on the Invoice/Room — the slip image reference is discarded
// the instant it's confirmed, with no copy kept anywhere (PaymentLog
// only records room/amount/type, no image/date/sender). Even though
// slip images are already persisted forever on Cloudinary, the LINK to
// them was being thrown away right when a payment gets confirmed.
//
// Fix going forward: every confirm code path in Rental Management.dc.html
// now also POSTs the slip(s) being cleared to /api/paid-receipts BEFORE
// they're wiped, archiving them here permanently. Past confirmed slips
// (before this fix) are NOT recoverable — explicitly accepted by the
// owner, see CLAUDE.md/session notes.
//
// Columns: id, room, tenant, invoiceId, date, amount, imageUrl,
// senderName, paymentType (full|partial|advance), createdAt
//
// Per CLAUDE.md's "Permanent gotcha" — every customer building has its
// own SEPARATE spreadsheet, run this against each one (pass the target
// spreadsheetId as the CLI arg).
const path = require('path');
require(path.join(__dirname, '..', 'server', 'node_modules', 'dotenv')).config({
  path: path.join(__dirname, '..', 'server', '.env'),
});
const { google } = require(path.join(__dirname, '..', 'server', 'node_modules', 'googleapis'));

const TAB_NAME = 'PaidReceipts';
const HEADER = ['id', 'room', 'tenant', 'invoiceId', 'date', 'amount', 'imageUrl', 'senderName', 'paymentType', 'createdAt'];

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
    range: `${TAB_NAME}!A1:J1`,
    valueInputOption: 'RAW',
    requestBody: { values: [HEADER] },
  });
  console.log(`Created "${TAB_NAME}" tab with header:`, HEADER.join(', '));
}

main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
