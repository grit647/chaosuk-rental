const express = require('express');
const router = express.Router();
const { readTab, appendRow, updateRow, deleteRow } = require('../sheets');
const { coerceRecurringTasks } = require('../coerce');
const { isConfigured, askClaude } = require('../claude');

// Turns a freeform Thai instruction (e.g. "ออกบิลทุกวันที่ 1 ของเดือน") into
// structured schedule fields PLUS a human-readable confirmation sentence —
// this is the "AI writes it up like a form before saving" step the user
// asked for, so what actually gets saved (and later auto-executed by the
// scheduler, see server/automation.js) is something a human explicitly
// reviewed, not raw freeform text interpreted fresh every single run.
async function parseRecurringInstruction(instruction) {
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
  const prompt = `วันนี้คือ ${todayStr} (ค.ศ.) คุณคือระบบแปลคำสั่งงานประจำของหอพักให้เป็นข้อมูลโครงสร้าง ผู้ใช้พิมพ์คำสั่งเป็นภาษาธรรมชาติ ให้แปลงเป็น JSON เท่านั้น (ห้ามมีข้อความอื่นหรือ markdown code fence ปนมา) ตามรูปแบบนี้เป๊ะ:

{"scheduleType":"monthly","dayOfMonth":1,"dayOfWeek":null,"time":"09:00","actionSummary":"...","humanSummary":"..."}

คำอธิบายแต่ละฟิลด์:
- scheduleType: "monthly" (ทำทุกเดือนในวันที่กำหนด), "weekly" (ทำทุกสัปดาห์ในวันกำหนด), หรือ "daily" (ทำทุกวัน)
- dayOfMonth: วันที่ของเดือน 1-31 (ใส่เฉพาะตอน scheduleType เป็น monthly ไม่งั้นใส่ null)
- dayOfWeek: วันในสัปดาห์ 0-6 (0=อาทิตย์, 1=จันทร์, ... 6=เสาร์ — ใส่เฉพาะตอน scheduleType เป็น weekly ไม่งั้นใส่ null)
- time: เวลาที่จะทำงาน รูปแบบ HH:MM (ถ้าไม่ได้ระบุ ใช้ "09:00")
- actionSummary: คำสั่งที่จะให้ระบบ AI อีกตัวหนึ่งเอาไปทำตามจริงตอนถึงเวลา เขียนเป็นประโยคคำสั่งชัดเจน สมบูรณ์ในตัวเอง (ระบบนั้นเข้าถึงข้อมูลห้อง/บิล/รายจ่าย/ปฏิทินได้ผ่านเครื่องมือของมันเอง ไม่ต้องใส่ข้อมูลดิบมาให้ แค่บอกว่าให้ทำอะไร)
- humanSummary: สรุปสั้นๆ 1 ประโยคภาษาไทยอ่านง่าย สำหรับโชว์ให้เจ้าของหอพักอ่านทวนก่อนกดบันทึกจริง ระบุความถี่+เวลา+สิ่งที่จะทำให้ครบ เช่น "ทุกวันที่ 1 ของเดือน เวลา 09:00 น. จะออกใบแจ้งหนี้ให้ทุกห้องที่มีผู้เช่าอยู่โดยอัตโนมัติ"

คำสั่งจากผู้ใช้: "${instruction}"`;

  const raw = await askClaude(prompt, 600);
  const jsonText = raw.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(jsonText);
  if (!parsed.actionSummary || !parsed.humanSummary) throw new Error('รูปแบบผลลัพธ์ไม่ถูกต้อง');
  return parsed;
}

router.get('/', async (req, res, next) => {
  try {
    const rows = coerceRecurringTasks(await readTab('RecurringTasks'));
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/parse', async (req, res, next) => {
  try {
    if (!isConfigured()) return res.status(400).json({ error: 'ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY ใน server/.env' });
    const instruction = (req.body.instruction || '').trim();
    if (!instruction) return res.status(400).json({ error: 'กรุณาพิมพ์คำสั่ง' });
    const parsed = await parseRecurringInstruction(instruction);
    res.json({ instruction, ...parsed });
  } catch (err) {
    console.error('[recurringTasks/parse]', err.message);
    res.status(502).json({ error: 'แปลคำสั่งไม่สำเร็จ ลองพิมพ์ใหม่อีกครั้งให้ชัดเจนขึ้น' });
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { instruction, scheduleType, dayOfMonth, dayOfWeek, time, actionSummary, humanSummary } = req.body;
    if (!instruction || !actionSummary) return res.status(400).json({ error: 'ข้อมูลไม่ครบ — กรุณาแปลคำสั่งก่อนบันทึก' });
    const item = {
      id: String(Date.now()),
      instruction,
      scheduleType: scheduleType || 'monthly',
      dayOfMonth: dayOfMonth != null ? dayOfMonth : '',
      dayOfWeek: dayOfWeek != null ? dayOfWeek : '',
      time: time || '09:00',
      actionSummary,
      humanSummary: humanSummary || instruction,
      active: true,
      lastRunDate: '',
      lastRunResult: '',
      createdAt: new Date().toISOString(),
    };
    await appendRow('RecurringTasks', item);
    res.json(item);
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const patch = {};
    if (req.body.active !== undefined) patch.active = req.body.active;
    const updated = await updateRow('RecurringTasks', req.params.id, patch);
    res.json(updated);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await deleteRow('RecurringTasks', req.params.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
