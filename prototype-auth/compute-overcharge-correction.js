// ONE-OFF READ-ONLY DIAGNOSTIC (2026-08-28) — following up on the owner's
// question about delete-then-revert behavior, found a much bigger issue:
// the CURRENTLY PENDING invoices for ~12-14 rooms were created using a
// STALE water/elec baseline (room.waterPrev/elecPrev, before today's
// fix-baseline-reset.js repair) — meaning their billed water/elec units
// double-count usage that should have already been billed on a PRIOR
// (already-paid) cycle. This computes the CORRECTED units/charge for
// each affected room's current pending invoice, comparing against what
// was actually billed, WITHOUT changing anything yet.
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
  const [invoices, rooms, settingsRows] = await Promise.all([readTab(sheets, 'Invoices'), readTab(sheets, 'Rooms'), readTab(sheets, 'Settings')]);
  const settingsMap = {};
  settingsRows.forEach((r) => { settingsMap[r.key] = r.value; });
  const globalWaterRate = Number(settingsMap.waterRate) || 0;
  const globalElecRate = Number(settingsMap.elecRate) || 0;

  const byRoom = {};
  invoices.forEach((i) => {
    const ts = Number((/-(\d{13})$/.exec(i.id) || [])[1]) || 0;
    (byRoom[i.room] = byRoom[i.room] || []).push({ ...i, ts });
  });

  const pending = invoices.filter((i) => i.status !== 'paid');
  console.log('Room | kind | old units (billed) | old charge | TRUE correct units | TRUE correct charge | difference (overcharge if positive)\n');

  for (const inv of pending) {
    const room = rooms.find((r) => r.id === inv.room);
    if (!room) continue;
    const list = byRoom[inv.room].slice().sort((a, b) => a.ts - b.ts);
    const idx = list.findIndex((x) => x.id === inv.id);
    const prev = idx > 0 ? list[idx - 1] : null;

    const waterRate = room.waterRate !== '' && room.waterRate != null ? Number(room.waterRate) : globalWaterRate;
    const elecRate = room.elecRate !== '' && room.elecRate != null ? Number(room.elecRate) : globalElecRate;
    const waterMinRate = Number(room.waterMinRate) || 0;
    const elecMinRate = Number(room.elecMinRate) || 0;
    const applyMin = (raw, minRate) => (minRate > 0 && raw < minRate) ? minRate : raw;

    // --- Water ---
    if (prev && n(prev.waterPrevReading) != null && n(prev.waterUnits) != null && n(inv.waterPrevReading) != null && n(inv.waterUnits) != null) {
      const correctPriorEnd = Math.round((n(prev.waterPrevReading) + n(prev.waterUnits)) * 100) / 100;
      const staleStart = n(inv.waterPrevReading);
      if (Math.abs(correctPriorEnd - staleStart) >= 0.5) {
        // X = true absolute current reading, derivable from the (wrong) invoice as staleStart + billedUnits
        const X = staleStart + n(inv.waterUnits);
        const correctUnits = Math.max(0, Math.round(X - correctPriorEnd));
        const correctRawCharge = Math.round(correctUnits * waterRate);
        const correctCharge = applyMin(correctRawCharge, waterMinRate);
        console.log(`ห้อง ${inv.room} | water | ${inv.waterUnits} | ${inv.water} | ${correctUnits} | ${correctCharge} | diff=${Number(inv.water) - correctCharge} baht (invoice=${inv.id})`);
      }
    }
    // --- Elec ---
    if (prev && n(prev.elecPrevReading) != null && n(prev.elecUnits) != null && n(inv.elecPrevReading) != null && n(inv.elecUnits) != null) {
      const correctPriorEnd = Math.round((n(prev.elecPrevReading) + n(prev.elecUnits)) * 100) / 100;
      const staleStart = n(inv.elecPrevReading);
      if (Math.abs(correctPriorEnd - staleStart) >= 0.5) {
        const X = staleStart + n(inv.elecUnits);
        const correctUnits = Math.max(0, Math.round(X - correctPriorEnd));
        const correctRawCharge = Math.round(correctUnits * elecRate);
        const correctCharge = applyMin(correctRawCharge, elecMinRate);
        console.log(`ห้อง ${inv.room} | elec | ${inv.elecUnits} | ${inv.elec} | ${correctUnits} | ${correctCharge} | diff=${Number(inv.elec) - correctCharge} baht (invoice=${inv.id})`);
      }
    }
  }
}
main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
