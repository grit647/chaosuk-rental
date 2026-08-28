// ONE-OFF WRITE SCRIPT (2026-08-13) — per explicit owner request: "งั้นตั้ง
// ทุกห้องให้เป็น 🕒 ตั้งเวลาส่ง 01/09/2569 09:00 น. เลยครับ" — rooms 5, 11,
// 12, 13, 14 of บ้านเลขที่1873 never got a ScheduledMessages row created
// (diagnosed via diagnose-scheduled-sends.js — the "ส่งทันที/ตั้งเวลาส่ง"
// popup was likely dismissed without a choice for those). This appends a
// ScheduledMessages row for each, matching the SAME sendAt (2026-09-01T09:00)
// and message-building logic already used by the other rooms' successful
// schedules (Rental Management.dc.html's _buildReceiptMessage /
// sendChoiceSchedule — replicated here server-side since that function
// lives client-side only).
const path = require('path');
require(path.join(__dirname, '..', 'server', 'node_modules', 'dotenv')).config({
  path: path.join(__dirname, '..', 'server', '.env'),
});
const { runWithSheetId } = require(path.join(__dirname, '..', 'server', 'requestContext'));
const { readTab, appendRow } = require(path.join(__dirname, '..', 'server', 'sheets'));
const { coerceInvoices, coerceRooms, readSettings } = require(path.join(__dirname, '..', 'server', 'coerce'));

const SHEET_ID_1873 = '1moUMiEhF2Ie76_Ep8_rgtefWenlQXx7vEUyaO0exk4E';
const TARGET_ROOMS = ['5', '11', '12', '13', '14'];
const SEND_AT = '2026-09-01T09:00';

function fmt(n) { return Math.round(Number(n) || 0).toLocaleString('th-TH'); }
function fmtDateTh(dateStr) {
  if (!dateStr) return '-';
  const [y, m, d] = dateStr.split('-');
  if (!y || !m || !d) return dateStr;
  const months = ['', 'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
  return `${Number(d)} ${months[Number(m)]} ${Number(y) + 543}`;
}

function buildReceiptMessage(invoice, room, settings) {
  const rate = (kind) => {
    const roomField = kind === 'water' ? 'waterRate' : 'elecRate';
    const own = room && room[roomField];
    return own != null ? own : settings[roomField];
  };
  const lineFor = (label, amount, units, kind) => {
    if (amount == null) return null;
    const rawCharge = units != null ? Math.round(units * rate(kind)) : null;
    const minApplied = kind && rawCharge != null && amount > rawCharge;
    const detail = minApplied ? ' (ค่าดูแลมิเตอร์ขั้นต่ำ)' : (units != null ? ` (${units} หน่วย × ${rate(kind)})` : '');
    return label + ': ' + fmt(amount) + detail;
  };
  const rows = [
    lineFor('ค่าเช่า', invoice.rent, null, null),
    lineFor('ค่าน้ำ', invoice.water, invoice.waterUnits, 'water'),
    lineFor('ค่าไฟ', invoice.elec, invoice.elecUnits, 'elec'),
    lineFor('ค่าขยะ', invoice.trash, null, null),
    lineFor('ค่าอินเทอร์เน็ต', invoice.internet, null, null),
  ].filter(Boolean);
  const total = invoice.rent + invoice.water + invoice.elec + (invoice.trash || 0) + (invoice.internet || 0);
  const amountPaid = invoice.amountPaid || 0;
  const remaining = invoice.remainingDue != null ? invoice.remainingDue : Math.max(0, total - amountPaid);
  const creditLines = amountPaid > 0
    ? [`หักจากเงินล่วงหน้าที่ชำระไว้แล้ว: ${fmt(amountPaid)}`, `ยอดที่ต้องชำระจริง: ${fmt(remaining)}`]
    : [];
  const prevReadingLines = [];
  if (invoice.waterPrevReading != null) prevReadingLines.push(`หน่วยมิเตอร์น้ำบิลก่อนหน้า: ${invoice.waterPrevReading}`);
  if (invoice.waterPrevReading != null && invoice.waterUnits != null) prevReadingLines.push(`หน่วยมิเตอร์น้ำที่ออกบิล: ${invoice.waterPrevReading + invoice.waterUnits}`);
  if (invoice.elecPrevReading != null) prevReadingLines.push(`หน่วยมิเตอร์ไฟบิลก่อนหน้า: ${invoice.elecPrevReading}`);
  if (invoice.elecPrevReading != null && invoice.elecUnits != null) prevReadingLines.push(`หน่วยมิเตอร์ไฟที่ออกบิล: ${invoice.elecPrevReading + invoice.elecUnits}`);
  const bp = settings.propertyProfile || {};
  const bankLines = (bp.bankName || bp.bankAccountNumber || bp.bankAccountName)
    ? ['', 'โอนเงินเข้าบัญชี:', bp.bankName, bp.bankAccountNumber, bp.bankAccountName].filter(Boolean)
    : [];
  return [
    'ใบแจ้งหนี้ห้อง ' + invoice.room + ' (' + invoice.id + ')',
    ...rows,
    'รวม: ' + fmt(total),
    ...creditLines,
    ...prevReadingLines,
    'กรุณาชำระก่อน ' + fmtDateTh(invoice.due),
    ...bankLines,
  ].join('\n');
}

async function main() {
  await runWithSheetId(SHEET_ID_1873, async () => {
    const invoices = coerceInvoices(await readTab('Invoices'));
    const rooms = coerceRooms(await readTab('Rooms'));
    const settings = await readSettings();
    let count = 0;
    for (const roomId of TARGET_ROOMS) {
      const invoice = invoices.find((i) => i.room === roomId && i.status !== 'paid');
      if (!invoice) { console.log(`ห้อง ${roomId}: ไม่พบบิลที่ค้างชำระ ข้าม`); continue; }
      const room = rooms.find((r) => r.id === roomId);
      const message = buildReceiptMessage(invoice, room, settings);
      const row = { id: Date.now() + '-invoice-' + roomId, room: roomId, message, sendAt: SEND_AT, sent: 'FALSE', source: 'invoice_receipt' };
      await appendRow('ScheduledMessages', row);
      console.log(`ห้อง ${roomId}: ตั้งเวลาส่งสำเร็จ (${invoice.id}) -> ${SEND_AT}`);
      count++;
    }
    console.log(`\nรวมตั้งเวลาสำเร็จ ${count}/${TARGET_ROOMS.length} ห้อง`);
  });
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
