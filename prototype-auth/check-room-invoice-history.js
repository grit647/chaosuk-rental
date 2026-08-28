// ONE-OFF READ-ONLY: full invoice history (paid + pending) for a specific
// room, to check whether waterPrevReading/elecPrevReading progression
// makes sense across bills over time (owner reported deleting the latest
// bill reverts water/elec to 0 instead of the prior bill's real reading).
const path = require('path');
require(path.join(__dirname, '..', 'server', 'node_modules', 'dotenv')).config({
  path: path.join(__dirname, '..', 'server', '.env'),
});
const { google } = require(path.join(__dirname, '..', 'server', 'node_modules', 'googleapis'));

const SHEET_ID = process.argv[3] || '1moUMiEhF2Ie76_Ep8_rgtefWenlQXx7vEUyaO0exk4E';
const ROOM_ID = process.argv[2] || '5';

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
  if (!header) return [];
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
  const invoices = await readTab(sheets, 'Invoices');
  const roomInvoices = invoices.filter((i) => i.room === ROOM_ID);
  console.log(`Total invoices ever for ห้อง ${ROOM_ID}:`, roomInvoices.length);
  roomInvoices
    .map((i) => ({ ...i, ts: Number((/-(\d{13})$/.exec(i.id) || [])[1]) || 0 }))
    .sort((a, b) => a.ts - b.ts)
    .forEach((i) => {
      console.log(`${i.id} (${new Date(i.ts).toISOString()}) status=${i.status} — waterPrevReading=${i.waterPrevReading} waterUnits=${i.waterUnits} -> water charged=${i.water} | elecPrevReading=${i.elecPrevReading} elecUnits=${i.elecUnits} -> elec charged=${i.elec}`);
    });
}
main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
