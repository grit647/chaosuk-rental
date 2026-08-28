// ONE-OFF READ-ONLY: for every room, walk its FULL invoice history
// (chronological) and check whether each invoice's waterPrevReading/
// elecPrevReading correctly matches the PRIOR invoice's ending point
// (prevReading + units) — this is the real question behind the owner's
// report ("ลบบิลล่าสุดแล้ว เลขน้ำไฟกลายเป็น 0 ทั้งที่ควรกลับไปใช้ข้อมูล
// บิลก่อนหน้า"): if invoice N's own frozen "before" reading doesn't
// correctly reflect invoice N-1's true ending reading, then DELETE's
// revert-to-invoice.prevReading logic would revert to a WRONG number —
// this checks whether that capture is consistent across every room's
// whole history, not just the current pending bill.
const path = require('path');
require(path.join(__dirname, '..', 'server', 'node_modules', 'dotenv')).config({
  path: path.join(__dirname, '..', 'server', '.env'),
});
const { google } = require(path.join(__dirname, '..', 'server', 'node_modules', 'googleapis'));

const SHEET_ID = process.argv[2] || '1moUMiEhF2Ie76_Ep8_rgtefWenlQXx7vEUyaO0exk4E';

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
const n = (v) => (v === '' || v == null ? null : Number(v));

async function main() {
  const sheets = await client();
  const invoices = await readTab(sheets, 'Invoices');
  const byRoom = {};
  invoices.forEach((i) => {
    const ts = Number((/-(\d{13})$/.exec(i.id) || [])[1]) || 0;
    (byRoom[i.room] = byRoom[i.room] || []).push({ ...i, ts });
  });
  let anyMismatch = false;
  for (const [room, list] of Object.entries(byRoom)) {
    list.sort((a, b) => a.ts - b.ts);
    if (list.length < 2) continue;
    for (let idx = 1; idx < list.length; idx++) {
      const prev = list[idx - 1], curr = list[idx];
      // elec
      const prevElecEnd = n(prev.elecPrevReading) != null && n(prev.elecUnits) != null ? n(prev.elecPrevReading) + n(prev.elecUnits) : null;
      const currElecStart = n(curr.elecPrevReading);
      if (prevElecEnd != null && currElecStart != null && Math.abs(prevElecEnd - currElecStart) >= 0.5) {
        console.log(`⚠️ ห้อง ${room}: elec chain mismatch — ${prev.id} ended at ${prevElecEnd}, but ${curr.id} started at ${currElecStart}`);
        anyMismatch = true;
      }
      // water
      const prevWaterEnd = n(prev.waterPrevReading) != null && n(prev.waterUnits) != null ? Math.round((n(prev.waterPrevReading) + n(prev.waterUnits)) * 100) / 100 : null;
      const currWaterStart = n(curr.waterPrevReading);
      if (prevWaterEnd != null && currWaterStart != null && Math.abs(prevWaterEnd - currWaterStart) >= 0.5) {
        console.log(`⚠️ ห้อง ${room}: water chain mismatch — ${prev.id} ended at ${prevWaterEnd}, but ${curr.id} started at ${currWaterStart}`);
        anyMismatch = true;
      }
    }
  }
  if (!anyMismatch) console.log('No chain mismatches found — every invoice\'s "before" reading correctly matches the prior invoice\'s ending point, across all rooms with 2+ bills.');
}
main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
