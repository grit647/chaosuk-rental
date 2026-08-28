// FULL SYSTEM AUDIT (2026-08-13) — per explicit owner request: "รันเทสระบบ
// ทั้งหมดครับ เพื่อดูความสมบูรณ์และจุดที่จะเป็นปัญหา...หลักๆ ดูว่าสถานะ
// ต่างๆ ทำงานได้ปรกติหรือเปล่า ตัดไฟ ขอใช้ไฟชั่วคราว" — read-only checks
// across all 3 known buildings:
//   1. Schema consistency for every migration run this session (permanent
//      "gotcha" — each building has its own separate spreadsheet).
//   2. Billing baseline consistency (elecPrev/waterPrev vs each pending
//      invoice's frozen reading) — the same class of bug found+fixed
//      earlier today for บ้านเลขที่1873, checked here for the OTHER 2
//      buildings too since the same fire-and-forget bug could have hit
//      them on any past bulk-invoice run.
//   3. Cutoff / ขอใช้ไฟชั่วคราว status snapshot — which rooms are
//      currently in either status, and whether their data looks
//      self-consistent (elecCutoffAt/elecRestoredAt present and sane).
//   4. Duplicate ScheduledMessages ids (same latent-collision class found
//      earlier).
//   5. Orphaned ScheduledMessages rows (room no longer has a pending
//      invoice at all, or invoice_receipt row pointing at a paid/deleted
//      invoice).
const path = require('path');
require(path.join(__dirname, '..', 'server', 'node_modules', 'dotenv')).config({
  path: path.join(__dirname, '..', 'server', '.env'),
});
const { google } = require(path.join(__dirname, '..', 'server', 'node_modules', 'googleapis'));

const BUILDINGS = {
  'ตึกหลัก (main account)': process.env.GOOGLE_SHEET_ID,
  'บ้านพักครูโจ': '1_018tkPfe3OLIyeA_lyek8o0H8esbi15-hBiuAqWzvA',
  'บ้านเลขที่1873': '1moUMiEhF2Ie76_Ep8_rgtefWenlQXx7vEUyaO0exk4E',
};

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
async function readTab(sheets, sheetId, tab) {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${tab}!A1:ZZ100000` });
    return rowsToObjects(res.data.values || [[]]);
  } catch (err) {
    return { __error: err.message };
  }
}
async function getHeader(sheets, sheetId, tab) {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${tab}!A1:ZZ1` });
    return (res.data.values || [[]])[0] || [];
  } catch (err) {
    return null; // tab doesn't exist
  }
}

async function main() {
  const sheets = await client();
  for (const [name, sheetId] of Object.entries(BUILDINGS)) {
    console.log('\n' + '='.repeat(70));
    console.log('BUILDING:', name, '(', sheetId, ')');
    console.log('='.repeat(70));

    // 1. Schema consistency checks
    console.log('\n--- 1. Schema consistency ---');
    const invHeader = await getHeader(sheets, sheetId, 'Invoices');
    if (invHeader) {
      const missing = ['lastSendFailedAt', 'lastSendFailReason'].filter((c) => !invHeader.includes(c));
      console.log('Invoices missing columns:', missing.length ? missing.join(', ') : 'none');
    } else {
      console.log('Invoices tab: ERROR reading header');
    }
    const lineSendLogHeader = await getHeader(sheets, sheetId, 'LineSendLog');
    console.log('LineSendLog tab:', lineSendLogHeader ? 'exists (' + lineSendLogHeader.join(',') + ')' : 'MISSING');
    const roomsHeader = await getHeader(sheets, sheetId, 'Rooms');
    if (roomsHeader) {
      const roomCols = ['waterSetNewValue', 'tuyaWaterMaxLiters', 'tuyaWaterDeviceId', 'tuyaElecDeviceId', 'elecCutoffAt', 'elecRestoredAt', 'advanceRent', 'ownerIdImg', 'lineQrImg'];
      const missingRoomCols = roomCols.filter((c) => !roomsHeader.includes(c));
      console.log('Rooms missing columns:', missingRoomCols.length ? missingRoomCols.join(', ') : 'none');
    }
    const settingsHeader = await getHeader(sheets, sheetId, 'Settings');
    console.log('Settings tab:', settingsHeader ? 'exists' : 'MISSING');
    const waterLogHeader = await getHeader(sheets, sheetId, 'WaterLog');
    console.log('WaterLog tab:', waterLogHeader ? 'exists' : 'MISSING (ok if this building has no Tuya water devices)');
    const notifyLogHeader = await getHeader(sheets, sheetId, 'NotifyLog');
    console.log('NotifyLog tab:', notifyLogHeader ? 'exists' : 'MISSING');
    const scheduledHeader = await getHeader(sheets, sheetId, 'ScheduledMessages');
    console.log('ScheduledMessages tab:', scheduledHeader ? 'exists' : 'MISSING');

    // Load data for the rest of the checks
    const [invoicesRaw, roomsRaw, scheduledRaw] = await Promise.all([
      readTab(sheets, sheetId, 'Invoices'),
      readTab(sheets, sheetId, 'Rooms'),
      readTab(sheets, sheetId, 'ScheduledMessages'),
    ]);
    if (invoicesRaw.__error || roomsRaw.__error) {
      console.log('Could not read Invoices/Rooms — skipping remaining checks for this building.');
      continue;
    }
    const invoices = invoicesRaw;
    const rooms = roomsRaw;
    const scheduled = Array.isArray(scheduledRaw) ? scheduledRaw : [];
    const pending = invoices.filter((i) => i.status !== 'paid');

    // 2. Billing baseline consistency
    console.log(`\n--- 2. Billing baseline consistency (${pending.length} pending invoices) ---`);
    let baselineMismatches = 0;
    for (const inv of pending) {
      const room = rooms.find((r) => r.id === inv.room);
      if (!room) continue;
      if (room.tuyaElecDeviceId && inv.elecPrevReading !== '' && inv.elecUnits !== '') {
        const expected = Math.round((Number(inv.elecPrevReading) + Number(inv.elecUnits)) * 100) / 100;
        const actual = room.elecPrev !== '' ? Math.round(Number(room.elecPrev) * 100) / 100 : null;
        if (actual == null || Math.abs(actual - expected) >= 0.5) {
          console.log(`  ⚠️ ห้อง ${inv.room}: elecPrev mismatch (expected ${expected}, actual ${actual})`);
          baselineMismatches++;
        }
      }
      if (room.tuyaWaterDeviceId && inv.waterPrevReading !== '' && inv.waterUnits !== '') {
        const expected = Math.round((Number(inv.waterPrevReading) + Number(inv.waterUnits)) * 100) / 100;
        const actual = room.waterPrev !== '' ? Math.round(Number(room.waterPrev) * 100) / 100 : null;
        if (actual == null || Math.abs(actual - expected) >= 0.5) {
          console.log(`  ⚠️ ห้อง ${inv.room}: waterPrev mismatch (expected ${expected}, actual ${actual})`);
          baselineMismatches++;
        }
      }
    }
    console.log(baselineMismatches ? `TOTAL MISMATCHES: ${baselineMismatches}` : 'All baselines consistent.');

    // 3. Cutoff / temp-power status snapshot
    console.log('\n--- 3. Cutoff / ขอใช้ไฟชั่วคราว status ---');
    let cutoffCount = 0, tempPowerCount = 0;
    for (const room of rooms) {
      if (!room.elecCutoffAt) continue;
      const currentlyOff = !room.elecRestoredAt || room.elecRestoredAt < room.elecCutoffAt;
      const label = currentlyOff ? 'ตัดไฟแล้ว' : 'ขอใช้ไฟชั่วคราว';
      if (currentlyOff) cutoffCount++; else tempPowerCount++;
      const hasPendingInvoice = pending.some((i) => i.room === room.id);
      console.log(`  ห้อง ${room.id} (${room.tenant || '-'}): ${label} — elecCutoffAt=${room.elecCutoffAt}, elecRestoredAt=${room.elecRestoredAt || '(ไม่มี)'} — มีบิลค้างอยู่จริง: ${hasPendingInvoice ? 'ใช่' : '⚠️ ไม่มี (ผิดปกติ — สถานะควรถูกล้างไปแล้วตอนออกบิลใหม่)'}`);
    }
    console.log(`สรุป: ตัดไฟแล้ว ${cutoffCount} ห้อง, ขอใช้ไฟชั่วคราว ${tempPowerCount} ห้อง`);

    // 4. Duplicate ScheduledMessages ids
    console.log('\n--- 4. Duplicate ScheduledMessages ids ---');
    const idCounts = {};
    scheduled.forEach((m) => { idCounts[m.id] = (idCounts[m.id] || 0) + 1; });
    const dupes = Object.entries(idCounts).filter(([, c]) => c > 1);
    console.log(dupes.length ? `⚠️ พบ id ซ้ำ: ${JSON.stringify(dupes)}` : 'ไม่มี id ซ้ำ');

    // 5. Orphaned ScheduledMessages rows
    console.log('\n--- 5. Orphaned ScheduledMessages rows (source=invoice_receipt, sent=FALSE, room ไม่มีบิลค้างแล้ว) ---');
    const orphaned = scheduled.filter((m) => {
      if (m.source !== 'invoice_receipt' || String(m.sent).toUpperCase() === 'TRUE') return false;
      return !pending.some((i) => i.room === m.room);
    });
    console.log(orphaned.length ? `⚠️ พบ ${orphaned.length} แถวค้าง (ห้อง: ${orphaned.map((m) => m.room).join(', ')})` : 'ไม่มีแถวค้าง');
  }
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
