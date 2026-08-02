// "สร้างกรอบของเนื้อหาที่คนถามแค่ในแพลตฟอร์ม สร้าง keyword การค้นหาให้มัน
// ด้วยจะได้ประหยัดการค้นหาครับ...สร้างคำถามสำเร็จรูป/FAQ ลัด ตอบเร็วโดย
// ไม่ต้องเรียก AI เลย" (2026-08-02) — คำถามข้อมูลพื้นฐานที่ถามซ้ำๆ บ่อยๆ
// (ห้องว่างกี่ห้อง, บิลค้างกี่ใบ ฯลฯ) ไม่จำเป็นต้องเสียเครดิตเรียก Claude/
// Gemini API เลย — เช็คคำที่พิมพ์/พูดมาก่อน (ทั้ง 2 ทางเข้าเส้นทางเดียวกัน
// คือ /api/claude/command เพราะเสียงถูกแปลงเป็นข้อความก่อนส่งเข้ามาอยู่
// แล้ว — "การพิมพ์หรือการพูด มันถูกกรองด้วย FAQ อยู่แล้วครับ") ถ้าตรง
// รูปแบบคำถามที่รู้จัก ตอบทันทีจากข้อมูลจริงในชีต ไม่ยิง API เลย
//
// จงใจให้ FAQ ทำงานเฉพาะคำถาม "เดี่ยวๆ" ไม่มีบริบทก่อนหน้า (ไม่มี history,
// ไม่มีรูปแนบ) — คำถามที่ต่อเนื่องจากบทสนทนาก่อนหน้า หรือแนบรูปมาด้วย
// ต้องผ่าน AI จริงเสมอ กัน FAQ ตอบผิดบริบท
const { readTab } = require('./sheets');
const { coerceRooms, coerceInvoices, coerceMaintenance } = require('./coerce');

function fmt(n) { return Math.round(Number(n) || 0).toLocaleString('th-TH'); }

const FAQ_ENTRIES = [
  {
    id: 'vacant_rooms',
    patterns: [/ห้องว่าง/, /ห้องไหนว่าง/, /มีห้องว่างไหม/],
    handler: async () => {
      const rooms = coerceRooms(await readTab('Rooms'));
      const vacant = rooms.filter((r) => r.status === 'vacant');
      if (!vacant.length) return 'ตอนนี้ไม่มีห้องว่างเลยครับ';
      return `ตอนนี้มีห้องว่าง ${vacant.length} ห้อง ได้แก่ห้อง ${vacant.map((r) => r.id).join(', ')} ครับ`;
    },
  },
  {
    id: 'pending_bills_count',
    patterns: [/บิลค้าง/, /ค้างชำระ.*กี่/, /ยังไม่ได้ชำระ.*กี่/],
    handler: async () => {
      const invoices = coerceInvoices(await readTab('Invoices'));
      const pending = invoices.filter((i) => i.status !== 'paid');
      if (!pending.length) return 'ตอนนี้ไม่มีบิลค้างชำระเลยครับ';
      const total = pending.reduce((a, i) => a + (i.remainingDue != null ? i.remainingDue : (i.rent + i.water + i.elec + (i.trash || 0) + (i.internet || 0))), 0);
      return `ตอนนี้มีบิลค้างชำระ ${pending.length} ใบ รวม ${fmt(total)} บาทครับ`;
    },
  },
  {
    id: 'paid_bills_count',
    patterns: [/บิล.*ชำระแล้ว/, /บิล.*จ่ายแล้ว/, /บิลที่ปิดยอด/],
    handler: async () => {
      const invoices = coerceInvoices(await readTab('Invoices'));
      const paid = invoices.filter((i) => i.status === 'paid');
      if (!paid.length) return 'ยังไม่มีบิลที่ชำระแล้วเลยครับ';
      const total = paid.reduce((a, i) => a + i.rent + i.water + i.elec + (i.trash || 0) + (i.internet || 0), 0);
      return `มีบิลที่ชำระแล้วทั้งหมด ${paid.length} ใบ รวม ${fmt(total)} บาทครับ`;
    },
  },
  {
    id: 'pending_maintenance_count',
    patterns: [/แจ้งซ่อม.*ค้าง/, /งานซ่อม.*กี่/, /ซ่อมค้าง/],
    handler: async () => {
      const list = coerceMaintenance(await readTab('Maintenance'));
      const pending = list.filter((m) => m.status !== 'done');
      if (!pending.length) return 'ตอนนี้ไม่มีงานแจ้งซ่อมค้างเลยครับ';
      return `ตอนนี้มีงานแจ้งซ่อมค้างอยู่ ${pending.length} รายการครับ`;
    },
  },
];

// คืนค่า Promise<string|null> — null แปลว่าไม่ตรง FAQ ไหนเลย ให้ผ่านไป AI
// จริงต่อ (ไม่ throw แม้ FAQ handler เอง error — fall back ให้ AI ตอบแทน
// เงียบๆ ดีกว่าทำทั้งคำขอพังเพราะ FAQ shortcut พลาด)
async function matchFaq(message, { hasHistory, hasImage }) {
  if (hasHistory || hasImage) return null;
  const text = String(message || '').trim();
  if (!text) return null;
  for (const entry of FAQ_ENTRIES) {
    if (entry.patterns.some((p) => p.test(text))) {
      try { return await entry.handler(); }
      catch (err) { console.error('[commandFaq] handler failed for', entry.id, err.message); return null; }
    }
  }
  return null;
}

module.exports = { matchFaq };
