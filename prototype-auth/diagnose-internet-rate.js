// ONE-OFF READ-ONLY DIAGNOSTIC (2026-08-13) — owner reported room 11 has
// internetRate=200 set on its contract, but its currently-pending
// invoice's stored `internet` line item shows 0 — asked to check EVERY
// room for the same mismatch. Cross-references each pending invoice's
// stored internet/trash amount against that room's CURRENT
// internetRate/trashRate.
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
  const [invoices, rooms] = await Promise.all([
    readTab(sheets, 'Invoices'),
    readTab(sheets, 'Rooms'),
  ]);
  const pending = invoices.filter((i) => i.status !== 'paid');
  console.log(`\nTotal non-paid invoices: ${pending.length}\n--- Per-room internet/trash check ---`);
  for (const inv of pending) {
    const room = rooms.find((r) => r.id === inv.room);
    const roomInternetRate = room && room.internetRate !== '' ? Number(room.internetRate) : null;
    const roomTrashRate = room && room.trashRate !== '' ? Number(room.trashRate) : null;
    const invInternet = Number(inv.internet) || 0;
    const invTrash = Number(inv.trash) || 0;
    const internetMismatch = roomInternetRate != null && roomInternetRate !== invInternet;
    const trashMismatch = roomTrashRate != null && roomTrashRate !== invTrash;
    const flag = (internetMismatch || trashMismatch) ? '  <<<< MISMATCH' : '';
    console.log(`ห้อง ${inv.room} (${room ? room.tenant : '?'}) — invoice ${inv.id} — room.internetRate=${roomInternetRate} invoice.internet=${invInternet} | room.trashRate=${roomTrashRate} invoice.trash=${invTrash}${flag}`);
  }
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
