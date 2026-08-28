// ONE-OFF READ-ONLY DIAGNOSTIC (2026-08-13) — owner reported some rooms'
// bills don't show the "🕒 ตั้งเวลาส่ง 01/09/2569 09:00 น." badge even
// though they were (apparently) scheduled together with others that DO
// show it. Cross-references pending (non-paid) Invoices against
// ScheduledMessages rows (source: 'invoice_receipt', sent: FALSE) to see
// exactly which rooms have a matching scheduled row and which don't.
const path = require('path');
require(path.join(__dirname, '..', 'server', 'node_modules', 'dotenv')).config({
  path: path.join(__dirname, '..', 'server', '.env'),
});
const { google } = require(path.join(__dirname, '..', 'server', 'node_modules', 'googleapis'));

const SHEET_ID = process.argv[2] || '1moUMiEhF2Ie76_Ep8_rgtefWenlQXx7vEUyaO0exk4E'; // บ้านเลขที่1873 default

async function client() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets.readonly']
  );
  return google.sheets({ version: 'v4', auth });
}

function rowsToObjects(values) {
  const [header, ...rows] = values;
  return rows.map((row) => {
    const obj = {};
    header.forEach((h, i) => { obj[h] = row[i] !== undefined ? row[i] : ''; });
    return obj;
  });
}

async function readTab(sheets, tab) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tab}!A1:ZZ100000` });
  return rowsToObjects(res.data.values || [[]]);
}

async function main() {
  const sheets = await client();
  console.log('Reading spreadsheet:', SHEET_ID);
  const [invoices, scheduled, rooms] = await Promise.all([
    readTab(sheets, 'Invoices'),
    readTab(sheets, 'ScheduledMessages'),
    readTab(sheets, 'Rooms'),
  ]);
  const pending = invoices.filter((i) => i.status !== 'paid');
  console.log(`\nTotal non-paid invoices: ${pending.length}`);
  console.log(`Total ScheduledMessages rows: ${scheduled.length} (source=invoice_receipt, sent=FALSE: ${scheduled.filter((m) => m.source === 'invoice_receipt' && String(m.sent).toUpperCase() !== 'TRUE').length})`);

  // Check for duplicate ScheduledMessages ids (real latent bug candidate —
  // Date.now()+'-invoice' isn't guaranteed unique across a fast loop).
  const idCounts = {};
  scheduled.forEach((m) => { idCounts[m.id] = (idCounts[m.id] || 0) + 1; });
  const dupeIds = Object.entries(idCounts).filter(([, c]) => c > 1);
  if (dupeIds.length) {
    console.log('\n⚠️ DUPLICATE ScheduledMessages ids found:', dupeIds);
  } else {
    console.log('\nNo duplicate ScheduledMessages ids found.');
  }

  console.log('\n--- Per-room check ---');
  for (const inv of pending) {
    const room = rooms.find((r) => r.id === inv.room);
    const matches = scheduled.filter((m) => m.room === inv.room && m.source === 'invoice_receipt' && String(m.sent).toUpperCase() !== 'TRUE');
    const status = matches.length ? `HAS SCHEDULE (${matches.length}) -> ${matches.map((m) => m.sendAt).join(', ')}` : 'NO SCHEDULE FOUND';
    console.log(`ห้อง ${inv.room} (${room ? room.tenant : '?'}) — invoice ${inv.id} — receiptSent=${inv.receiptSent} — ${status}`);
  }
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
