// ONE-OFF READ-ONLY DIAGNOSTIC (2026-08-13) — owner asked: after issuing
// these bills, did the device's water/elec baseline (room.waterPrev/
// elecPrev) actually get reset like it's supposed to (submitInvoice/
// submitBulkInvoice's prevPatch)? Compares each pending invoice's FROZEN
// baseline (invoice.waterPrevReading/elecPrevReading + waterUnits/
// elecUnits — captured at invoice-creation time) against the room's
// CURRENT waterPrev/elecPrev. If the reset worked, room.elecPrev should
// equal (invoice.elecPrevReading + invoice.elecUnits) — the exact reading
// this invoice was billed against.
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
  const [invoices, rooms] = await Promise.all([readTab(sheets, 'Invoices'), readTab(sheets, 'Rooms')]);
  const pending = invoices.filter((i) => i.status !== 'paid');
  console.log(`\nTotal non-paid invoices: ${pending.length}\n--- Baseline reset check (elec) ---`);
  for (const inv of pending) {
    const room = rooms.find((r) => r.id === inv.room);
    if (!room || !room.tuyaElecDeviceId) continue;
    const prevReading = inv.elecPrevReading !== '' ? Number(inv.elecPrevReading) : null;
    const units = inv.elecUnits !== '' ? Number(inv.elecUnits) : null;
    if (prevReading == null || units == null) { console.log(`ห้อง ${inv.room}: บิลนี้ไม่มี elecPrevReading/elecUnits บันทึกไว้ (บิลเก่า?) ข้าม`); continue; }
    const expectedNewPrev = prevReading + units;
    const actualPrev = room.elecPrev !== '' ? Number(room.elecPrev) : null;
    const match = actualPrev != null && Math.abs(actualPrev - expectedNewPrev) < 0.5;
    console.log(`ห้อง ${inv.room} — บิลนี้ตัดที่ ${expectedNewPrev} (${prevReading}+${units}) | room.elecPrev ปัจจุบัน = ${actualPrev} ${match ? 'OK (reset สำเร็จ)' : '<<<< MISMATCH — reset ไม่สำเร็จ หรือมีการใช้ไฟเพิ่มหลังบิลจริง'}`);
  }
  console.log(`\n--- Baseline reset check (water) ---`);
  for (const inv of pending) {
    const room = rooms.find((r) => r.id === inv.room);
    if (!room || !room.tuyaWaterDeviceId) continue;
    const prevReading = inv.waterPrevReading !== '' ? Number(inv.waterPrevReading) : null;
    const units = inv.waterUnits !== '' ? Number(inv.waterUnits) : null;
    if (prevReading == null || units == null) { console.log(`ห้อง ${inv.room}: บิลนี้ไม่มี waterPrevReading/waterUnits บันทึกไว้ (บิลเก่า?) ข้าม`); continue; }
    const expectedNewPrev = prevReading + units;
    const actualPrev = room.waterPrev !== '' ? Number(room.waterPrev) : null;
    const match = actualPrev != null && Math.abs(actualPrev - expectedNewPrev) < 0.5;
    console.log(`ห้อง ${inv.room} — บิลนี้ตัดที่ ${expectedNewPrev} (${prevReading}+${units}) | room.waterPrev ปัจจุบัน = ${actualPrev} ${match ? 'OK (reset สำเร็จ)' : '<<<< MISMATCH — reset ไม่สำเร็จ หรือมีการใช้น้ำเพิ่มหลังบิลจริง'}`);
  }
}
main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
