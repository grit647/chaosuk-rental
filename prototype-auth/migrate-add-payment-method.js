// ONE-TIME MIGRATION SCRIPT — adds a "paymentMethod" column to BOTH the
// Invoices tab and the PaidReceipts tab (per explicit owner request:
// เจ้าของ can now confirm a bill as paid with CASH received directly,
// separate from the existing bank-transfer-slip flow — see the new
// "ชำระเงินสด" popup in Rental Management.dc.html's confirmCashPayment).
// Blank/missing = the original bank-transfer/slip flow (unchanged
// meaning for every existing row); 'cash' = confirmed via this new flow.
//
// Safety: only touches THIS SHEET's Invoices/PaidReceipts tabs (run once
// per building — pass a different customerSheetId as the CLI arg for
// another building, defaults to server/.env's GOOGLE_SHEET_ID). Refuses
// to run per-tab if that tab already has the column (idempotency guard).
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

async function addColumnToTab(sheets, spreadsheetId, tabName) {
  const headerRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tabName}!A1:ZZ1` });
  const header = (headerRes.data.values || [[]])[0] || [];
  if (header.includes('paymentMethod')) {
    console.log(`[${tabName}] paymentMethod column already exists — skipping (safe to ignore).`);
    return;
  }

  const dataRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tabName}!A2:ZZ10000` });
  const rows = dataRes.data.values || [];
  console.log(`[${tabName}] Found ${rows.length} existing rows — adding blank paymentMethod for all.`);

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetMeta = meta.data.sheets.find((s) => s.properties.title === tabName);
  const currentColCount = sheetMeta.properties.gridProperties.columnCount;
  const newColIdx = header.length;
  if (newColIdx >= currentColCount) {
    console.log(`[${tabName}] Sheet grid only has ${currentColCount} columns — widening by 10 first...`);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ appendDimension: { sheetId: sheetMeta.properties.sheetId, dimension: 'COLUMNS', length: 10 } }] },
    });
  }

  const newColLetter = colLetter(newColIdx);
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `${tabName}!${newColLetter}1`, valueInputOption: 'RAW',
    requestBody: { values: [['paymentMethod']] },
  });
  console.log(`[${tabName}] Added column "${newColLetter}1" = paymentMethod (existing rows left blank = bank transfer/slip, unchanged meaning).`);
}

async function main() {
  const spreadsheetId = process.argv[2] || process.env.GOOGLE_SHEET_ID;
  console.log('Target spreadsheet:', spreadsheetId);
  const sheets = await client();
  await addColumnToTab(sheets, spreadsheetId, 'Invoices');
  await addColumnToTab(sheets, spreadsheetId, 'PaidReceipts');
  console.log('\n✅ Done.');
}

main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
