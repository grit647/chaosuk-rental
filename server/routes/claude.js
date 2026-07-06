const express = require('express');
const router = express.Router();
const { readTab } = require('../sheets');
const { coerceInvoices, coerceExpenses, coerceRooms, coerceMaintenance } = require('../coerce');
const { isConfigured, askClaude, askClaudeWithImage } = require('../claude');

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

router.post('/read-meters', async (req, res, next) => {
  try {
    if (!isConfigured()) return res.status(400).json({ error: 'ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY ใน server/.env' });
    const { dataUrl } = req.body;
    if (!dataUrl) return res.status(400).json({ error: 'กรุณาอัปโหลดรูปภาพ' });

    const prompt = `นี่คือภาพมิเตอร์น้ำแบบกลไก อาจมีหลายตัวในภาพเดียว แต่ละตัวมีป้ายเลขห้องกำกับอยู่ข้างมิเตอร์ (ตัวเลขใหญ่ เช่น 8, 9, 10, 11) และมีตัวเลขวัดปริมาณน้ำแสดงอยู่ในช่องหน้าปัดสีขาว (มักมี 4 หลัก อาจมีทศนิยมสีแดงต่อท้าย ให้ปัดเป็นจำนวนเต็ม)

อ่านค่าของมิเตอร์ทุกตัวที่เห็นในภาพ แล้วตอบกลับเป็น JSON array เท่านั้น ห้ามมีข้อความอื่นหรือ markdown code fence ปนมา รูปแบบต้องเป็นแบบนี้เป๊ะ:
[{"room":"8","reading":205},{"room":"9","reading":121}]

ถ้าตัวเลขบางหลักไม่ชัดเจน (เช่นเลขกำลังหมุนเปลี่ยน) ให้ใช้ค่าที่อ่านได้แน่นอนที่สุด (ปัดลง) ถ้าอ่านป้ายเลขห้องไม่ออกให้ข้ามมิเตอร์ตัวนั้นไป`;

    const raw = await askClaudeWithImage(prompt, dataUrl);
    let readings;
    try {
      const jsonText = raw.replace(/```json|```/g, '').trim();
      readings = JSON.parse(jsonText);
    } catch {
      return res.status(502).json({ error: 'อ่านผลลัพธ์จาก Claude ไม่สำเร็จ', raw });
    }
    res.json({ readings });
  } catch (err) { next(err); }
});

module.exports = router;
