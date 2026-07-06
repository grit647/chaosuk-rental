const express = require('express');
const router = express.Router();
const { readTab } = require('../sheets');
const { coerceInvoices, coerceExpenses, coerceRooms, coerceMaintenance } = require('../coerce');
const { isConfigured, askClaude } = require('../claude');

router.get('/health', (req, res) => {
  res.json({ connected: isConfigured() });
});

router.get('/monthly-summary', async (req, res, next) => {
  try {
    if (!isConfigured()) return res.status(400).json({ error: 'ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY ใน server/.env' });

    const [invoices, expenses, rooms, maintenance] = await Promise.all([
      readTab('Invoices').then(coerceInvoices),
      readTab('Expenses').then(coerceExpenses),
      readTab('Rooms').then(coerceRooms),
      readTab('Maintenance').then(coerceMaintenance),
    ]);

    const paid = invoices.filter((i) => i.status === 'paid');
    const pending = invoices.filter((i) => i.status !== 'paid');
    const totalRevenue = paid.reduce((a, i) => a + i.rent + i.water + i.elec + (i.trash || 0) + (i.internet || 0), 0);
    const totalExpense = expenses.reduce((a, e) => a + e.amount, 0);
    const vacant = rooms.filter((r) => r.status === 'vacant').length;
    const openMaint = maintenance.filter((m) => m.status !== 'done').length;

    const prompt = `คุณเป็นผู้ช่วยสรุปรายงานการเงินหอพักให้เจ้าของอ่าน ตอบเป็นภาษาไทย กระชับ ไม่เกิน 6-8 บรรทัด ห้ามใช้ markdown/bullet พิเศษ ใช้ข้อมูลต่อไปนี้เท่านั้น (ห้ามสมมติตัวเลขเพิ่ม):

รายรับที่ชำระแล้ว: ${totalRevenue} บาท (${paid.length} รายการ)
บิลค้าง/รอชำระ: ${pending.length} รายการ
รายจ่ายรวม: ${totalExpense} บาท
ห้องว่าง: ${vacant} จาก ${rooms.length} ห้อง
งานซ่อมค้าง: ${openMaint} รายการ

สรุปสถานการณ์โดยรวมให้เจ้าของหอพักเข้าใจง่าย พร้อมข้อสังเกตหรือคำแนะนำสั้นๆ ถ้ามีจุดที่ควรระวัง (เช่น บิลค้างเยอะ หรือห้องว่างเยอะ)`;

    const summary = await askClaude(prompt);
    res.json({ summary, stats: { totalRevenue, totalExpense, pendingCount: pending.length, vacant, totalRooms: rooms.length, openMaint } });
  } catch (err) { next(err); }
});

module.exports = router;
