// อัลบั้มใบเสร็จ/สลิปย้อนหลัง (2026-08-04) — archive-only endpoint, เขียน
// อย่างเดียว (การอ่านทำผ่าน /api/bootstrap แล้ว เป็น tab ที่ 11 ใน
// batchGet เดียวกัน — ดู server/routes/bootstrap.js — ไม่ต้องมี GET แยก
// ตรงนี้ เพื่อไม่ให้เพิ่มคำขอ Sheets API เกินจำเป็น เหมือน tab อื่นๆ)
//
// เรียกจาก Rental Management.dc.html ทุกจุดที่ยืนยันสลิป (ก่อน slipsJson/
// creditSlipsJson จะถูกเคลียร์ทิ้ง — ดู migrate-add-paidreceipts-tab.js
// สำหรับเหตุผลเต็ม) — ส่งเป็น array เดียว รองรับกรณีมีหลายสลิปต่อการ
// ยืนยัน 1 ครั้ง (เช่น ผู้เช่าโอนแยกหลายรอบเพื่อให้ครบยอด)
const express = require('express');
const router = express.Router();
const { appendRows } = require('../sheets');

router.post('/', async (req, res, next) => {
  try {
    const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    if (!items.length) return res.json({ ok: true, saved: 0 });
    const rows = items
      .filter((it) => it && it.room && it.amount)
      .map((it) => ({
        id: 'PR-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        room: it.room,
        tenant: it.tenant || '',
        invoiceId: it.invoiceId || '',
        date: it.date || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' }),
        amount: Number(it.amount) || 0,
        imageUrl: it.imageUrl || '',
        senderName: it.senderName || '',
        paymentType: it.paymentType || 'full', // full | partial | advance
        // "ปุ่มมีการส่งสลิปเข้ามาแต่เป็นการชำระด้วยเงินสด" (2026-08-05,
        // ดู migrate-add-payment-method.js) — blank = สลิปโอนเงินปกติ
        // (ความหมายเดิมของทุกแถวก่อนหน้านี้ ไม่เปลี่ยน), 'cash' = เจ้าของ
        // กรอกรับเงินสดเองผ่าน popup ใหม่
        paymentMethod: it.paymentMethod || '',
        createdAt: new Date().toISOString(),
      }));
    if (!rows.length) return res.json({ ok: true, saved: 0 });
    await appendRows('PaidReceipts', rows);
    res.json({ ok: true, saved: rows.length });
  } catch (err) { next(err); }
});

module.exports = router;
