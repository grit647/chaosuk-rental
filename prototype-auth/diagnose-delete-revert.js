// ONE-OFF READ-ONLY DIAGNOSTIC (2026-08-28) — owner reports: after
// deleting the LATEST bill, the water/elec meter numbers become 0
// instead of reverting to the PREVIOUS bill's reading. Simulate exactly
// what DELETE /api/invoices/:id's revert logic (server/routes/
// invoices.js) would do for each currently-pending invoice, WITHOUT
// actually deleting anything — just printing what room.waterPrev/
// elecPrev would become if that invoice were deleted right now.
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
  const [invoices, rooms] = await Promise.all([readTab(sheets, 'Invoices'), readTab(sheets, 'Rooms')]);
  const pending = invoices.filter((i) => i.status !== 'paid');
  console.log('Simulating DELETE for each pending invoice (read-only, nothing actually changed):\n');
  for (const inv of pending) {
    const room = rooms.find((r) => r.id === inv.room);
    if (!room) continue;
    console.log(`--- ห้อง ${inv.room} (${room.tenant || '-'}) — invoice ${inv.id} ---`);
    // Elec
    const elecPrevReading = n(inv.elecPrevReading), elecUnits = n(inv.elecUnits);
    const roomElecPrev = n(room.elecPrev);
    if (elecPrevReading != null && elecUnits != null) {
      const expectedCurrent = elecPrevReading + elecUnits;
      const willRevert = roomElecPrev === expectedCurrent;
      console.log(`  elec: invoice.elecPrevReading=${elecPrevReading}, invoice.elecUnits=${elecUnits}, expectedCurrent=${expectedCurrent}, room.elecPrev NOW=${roomElecPrev} -> ${willRevert ? `WOULD REVERT to ${elecPrevReading}` : 'condition NOT met, room.elecPrev stays UNCHANGED (not reverted, not zeroed)'}`);
    } else {
      console.log(`  elec: invoice has no elecPrevReading/elecUnits recorded (null) -> revert logic SKIPPED entirely, room.elecPrev stays UNCHANGED at ${roomElecPrev}`);
    }
    // Water
    const waterPrevReading = n(inv.waterPrevReading), waterUnits = n(inv.waterUnits);
    const roomWaterPrev = n(room.waterPrev);
    if (waterPrevReading != null && waterUnits != null) {
      const expectedCurrent = Math.round((waterPrevReading + waterUnits) * 100) / 100;
      const willRevert = Math.abs((roomWaterPrev || 0) - expectedCurrent) < 0.5;
      console.log(`  water: invoice.waterPrevReading=${waterPrevReading}, invoice.waterUnits=${waterUnits}, expectedCurrent=${expectedCurrent}, room.waterPrev NOW=${roomWaterPrev} -> ${willRevert ? `WOULD REVERT to ${waterPrevReading}` : 'condition NOT met, room.waterPrev stays UNCHANGED (not reverted, not zeroed)'}`);
    } else {
      console.log(`  water: invoice has no waterPrevReading/waterUnits recorded (null) -> revert logic SKIPPED entirely, room.waterPrev stays UNCHANGED at ${roomWaterPrev}`);
    }
    console.log('');
  }
}
main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
