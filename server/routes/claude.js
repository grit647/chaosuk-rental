const express = require('express');
const router = express.Router();
const { readTab } = require('../sheets');
const { coerceInvoices, coerceExpenses, coerceRooms, coerceMaintenance } = require('../coerce');
const { isConfigured, askClaude, askClaudeWithImage, callWithTools } = require('../claude');
const { TOOLS, READ_TOOL_NAMES, executeReadTool, describeWriteTool, executeWriteTool } = require('../claudeTools');

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

const COMMAND_SYSTEM_PROMPT = `คุณเป็นผู้ช่วยจัดการหอพัก "เช่าสุข" สามารถทำได้เฉพาะงานที่มีเครื่องมือ (tools) ให้เท่านั้น ห้ามสมมติหรือแต่งข้อมูลขึ้นเอง ถ้าต้องการข้อมูลให้เรียกเครื่องมือที่เกี่ยวข้องก่อนเสมอ

ข้อจำกัดสำคัญ: คุณไม่มีความสามารถและไม่มีเครื่องมือใดๆ ที่เกี่ยวกับการแก้ไขโค้ด เซิร์ฟเวอร์ การตั้งค่าระบบ หรือข้อมูลลับ/รหัสผ่านใดๆ ทั้งสิ้น ถ้าผู้ใช้ขอสิ่งเหล่านี้ หรือขอสิ่งที่ไม่มีเครื่องมือรองรับ ให้ปฏิเสธอย่างสุภาพเป็นภาษาไทย อธิบายว่างานนี้อยู่นอกเหนือขอบเขตที่ทำได้ในระบบนี้ อย่าพยายามช่วยด้วยวิธีอื่น

สำคัญมาก — เรื่องการยืนยันก่อนทำรายการที่แก้ไข/เพิ่ม/ลบข้อมูล (เช่น mark_invoice_paid, create_invoice, add_expense, delete_expense, add_maintenance, set_maintenance_status, send_line_message, update_room_meter): ห้ามถามยืนยันเป็นข้อความเองเด็ดขาด (เช่น ห้ามพิมพ์ "ยืนยันไหมครับ?" แล้วรอคำตอบ) — ให้เรียกเครื่องมือ (tool) นั้นทันทีเมื่อมีข้อมูล/พารามิเตอร์ที่จำเป็นครบถ้วนแล้วเสมอ ระบบภายนอกจะเป็นผู้แสดง popup ยืนยันกับผู้ใช้เองโดยอัตโนมัติก่อนทำรายการจริง คุณไม่ต้องและห้ามถามซ้ำ — ถ้าข้อมูลที่จำเป็นยังไม่ครบ (เช่น ไม่รู้ว่าจะลบรายการไหน) ให้เรียกเครื่องมือประเภทดูข้อมูล (get_*) เพื่อหาให้เจอก่อน แล้วค่อยเรียกเครื่องมือทำรายการทันทีเมื่อรู้ค่าที่ถูกต้องแล้ว

ตอบเป็นภาษาไทยเสมอ กระชับ ตรงประเด็น`;

function extractText(resp) {
  return (resp.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
}

router.post('/command', async (req, res, next) => {
  try {
    if (!isConfigured()) return res.status(400).json({ error: 'ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY ใน server/.env' });
    const message = (req.body.message || '').trim();
    if (!message) return res.status(400).json({ error: 'กรุณาพิมพ์คำสั่ง' });

    let messages = [{ role: 'user', content: message }];
    for (let i = 0; i < 4; i++) {
      const resp = await callWithTools(COMMAND_SYSTEM_PROMPT, messages, TOOLS);
      if (resp.stop_reason !== 'tool_use') {
        const text = extractText(resp) || 'ขอโทษครับ ไม่เข้าใจคำสั่งนี้';
        return res.json({ type: 'answer', text });
      }
      const toolUse = resp.content.find((c) => c.type === 'tool_use');
      if (!toolUse) return res.json({ type: 'answer', text: extractText(resp) || 'ขอโทษครับ ไม่เข้าใจคำสั่งนี้' });

      if (!READ_TOOL_NAMES.has(toolUse.name)) {
        // Write/mutating action — never auto-execute. Hand back to the
        // frontend as a pending confirmation; nothing has happened yet.
        const description = extractText(resp) || await describeWriteTool(toolUse.name, toolUse.input);
        return res.json({ type: 'confirm', action: toolUse.name, params: toolUse.input, description });
      }

      // Read-only tool — safe to run immediately, then loop so Claude can
      // phrase a final natural-language answer from the real data.
      const result = await executeReadTool(toolUse.name, toolUse.input);
      messages = [
        ...messages,
        { role: 'assistant', content: resp.content },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(result) }] },
      ];
    }
    res.json({ type: 'answer', text: 'คำสั่งนี้ซับซ้อนเกินไป ลองถามให้ชัดเจนหรือแบ่งเป็นหลายคำสั่งครับ' });
  } catch (err) { next(err); }
});

router.post('/command/confirm', async (req, res, next) => {
  try {
    const { action, params } = req.body;
    if (!action || !params) return res.status(400).json({ error: 'คำขอไม่ถูกต้อง' });
    const result = await executeWriteTool(action, params);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || 'ทำรายการไม่สำเร็จ' });
  }
});

module.exports = router;
