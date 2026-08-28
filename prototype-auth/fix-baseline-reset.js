// ONE-OFF WRITE FIX (2026-08-13) — real bug found via diagnose-baseline-
// reset.js: submitBulkInvoice's baseline-reset PATCH (Rental Management.
// dc.html, resets room.elecPrev/waterPrev to the reading THIS invoice was
// billed against, so the NEXT bill's usage calc starts fresh instead of
// double-counting) is fire-and-forget (never awaited, errors silently
// swallowed via .catch(() => {})). Dispatching ~9-15 of these PATCH
// requests near-simultaneously for one bulk-invoice batch very likely hit
// Google Sheets API's write-rate quota — most silently failed, leaving
// most rooms' baseline stuck at the OLD (pre-this-bill) reading. Left
// uncorrected, the NEXT bill for these rooms would double-count every
// unit already billed on the CURRENT pending invoice.
//
// This repairs every room whose CURRENT pending invoice's frozen
// waterPrevReading/elecPrevReading + waterUnits/elecUnits doesn't match
// the room's current waterPrev/elecPrev — sets it to the correct value
// (prevReading + units), matching exactly what a successful reset would
// have written.
const path = require('path');
require(path.join(__dirname, '..', 'server', 'node_modules', 'dotenv')).config({
  path: path.join(__dirname, '..', 'server', '.env'),
});
const { runWithSheetId } = require(path.join(__dirname, '..', 'server', 'requestContext'));
const { readTab, updateRow } = require(path.join(__dirname, '..', 'server', 'sheets'));
const { coerceInvoices, coerceRooms } = require(path.join(__dirname, '..', 'server', 'coerce'));

const DRY_RUN = process.argv.includes('--dry-run');
const SHEET_ID = process.argv.slice(2).find((a) => !a.startsWith('--')) || '1moUMiEhF2Ie76_Ep8_rgtefWenlQXx7vEUyaO0exk4E';

async function main() {
  await runWithSheetId(SHEET_ID, async () => {
    const invoices = coerceInvoices(await readTab('Invoices'));
    const rooms = coerceRooms(await readTab('Rooms'));
    const pending = invoices.filter((i) => i.status !== 'paid');
    let fixedElec = 0, fixedWater = 0;
    for (const inv of pending) {
      const room = rooms.find((r) => r.id === inv.room);
      if (!room) continue;
      const patch = {};
      if (room.tuyaElecDeviceId && inv.elecPrevReading != null && inv.elecUnits != null) {
        const expected = Math.round((inv.elecPrevReading + inv.elecUnits) * 100) / 100;
        const actual = room.elecPrev != null ? Math.round(Number(room.elecPrev) * 100) / 100 : null;
        if (actual == null || Math.abs(actual - expected) >= 0.5) {
          patch.elecPrev = expected;
          console.log(`ห้อง ${inv.room}: elecPrev ${actual} -> ${expected}`);
          fixedElec++;
        }
      }
      if (room.tuyaWaterDeviceId && inv.waterPrevReading != null && inv.waterUnits != null) {
        const expected = Math.round((inv.waterPrevReading + inv.waterUnits) * 100) / 100;
        const actual = room.waterPrev != null ? Math.round(Number(room.waterPrev) * 100) / 100 : null;
        if (actual == null || Math.abs(actual - expected) >= 0.5) {
          patch.waterPrev = expected;
          console.log(`ห้อง ${inv.room}: waterPrev ${actual} -> ${expected}`);
          fixedWater++;
        }
      }
      if (Object.keys(patch).length && !DRY_RUN) {
        await updateRow('Rooms', inv.room, patch);
      }
    }
    console.log(`\n${DRY_RUN ? '[DRY RUN] จะแก้' : 'แก้แล้ว'}: elecPrev ${fixedElec} ห้อง, waterPrev ${fixedWater} ห้อง`);
  });
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
