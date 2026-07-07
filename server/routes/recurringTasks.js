const express = require('express');
const router = express.Router();
const { readTab, appendRow, updateRow, deleteRow } = require('../sheets');
const { coerceRecurringTasks } = require('../coerce');
const { isConfigured, askClaude } = require('../claude');

// Turns a freeform Thai instruction into an ARRAY of structured schedule
// tasks PLUS a human-readable confirmation sentence per task — this is the
// "AI writes it up like a form before saving" step the user asked for, so
// what actually gets saved (and later auto-executed by the scheduler, see
// server/automation.js) is something a human explicitly reviewed, not raw
// freeform text interpreted fresh every single run.
//
// Real billing policies are rarely "1 instruction = 1 schedule" — a full
// rent-collection cycle (bill on day 28, remind before day 7, check unpaid
// on day 7, remind again on day 12, check unpaid on day 15...) bundles
// several distinct day/time triggers together. Asking for one JSON object
// forced Claude to either mangle everything into a single trigger or refuse
// with prose (which broke JSON.parse and surfaced as a generic "แปลคำสั่งไม่
// สำเร็จ" 502 — a real failure a user hit). Returning an array lets each
// day/time in the policy become its own independently-schedulable task.
async function parseRecurringInstruction(instruction) {
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
  const prompt = `วันนี้คือ ${todayStr} (ค.ศ.) คุณคือระบบแปลคำสั่งงานประจำของหอพักให้เป็นข้อมูลโครงสร้าง ผู้ใช้พิมพ์คำสั่งเป็นภาษาธรรมชาติ ซึ่งอาจมีหลายกฎ/หลายวันที่ปนกันอยู่ในข้อความเดียว (เช่น นโยบายเก็บค่าเช่าทั้งรอบที่มีทั้งวันแจ้งบิล วันเตือน วันตรวจสอบ) ให้แยกแต่ละวันที่/เงื่อนไขที่ต้องทำงานแยกกันออกเป็นรายการย่อย แล้วแปลงเป็น JSON เท่านั้น (ห้ามมีข้อความอื่นหรือ markdown code fence ปนมา) ตามรูปแบบนี้เป๊ะ:

{"tasks":[{"scheduleType":"monthly","dayOfMonth":1,"dayOfWeek":null,"time":"09:00","actionSummary":"...","humanSummary":"..."}]}

คำอธิบายแต่ละฟิลด์ (ในแต่ละรายการของ tasks):
- scheduleType: "monthly" (ทำทุกเดือนในวันที่กำหนด), "weekly" (ทำทุกสัปดาห์ในวันกำหนด), หรือ "daily" (ทำทุกวัน)
- dayOfMonth: วันที่ของเดือน 1-31 (ใส่เฉพาะตอน scheduleType เป็น monthly ไม่งั้นใส่ null)
- dayOfWeek: วันในสัปดาห์ 0-6 (0=อาทิตย์, 1=จันทร์, ... 6=เสาร์ — ใส่เฉพาะตอน scheduleType เป็น weekly ไม่งั้นใส่ null)
- time: เวลาที่จะทำงาน รูปแบบ HH:MM (ถ้าไม่ได้ระบุ ใช้ "09:00")
- actionSummary: คำสั่งที่จะให้ระบบ AI อีกตัวหนึ่งเอาไปทำตามจริงตอนถึงเวลา เขียนเป็นประโยคคำสั่งชัดเจน สมบูรณ์ในตัวเอง (ระบบนั้นเข้าถึงข้อมูลห้อง/บิล/รายจ่าย/ปฏิทินได้ผ่านเครื่องมือของมันเอง ไม่ต้องใส่ข้อมูลดิบมาให้ แค่บอกว่าให้ทำอะไร)
- humanSummary: สรุปสั้นๆ 1 ประโยคภาษาไทยอ่านง่าย สำหรับโชว์ให้เจ้าของหอพักอ่านทวนก่อนกดบันทึกจริง ระบุความถี่+เวลา+สิ่งที่จะทำให้ครบ เช่น "ทุกวันที่ 1 ของเดือน เวลา 09:00 น. จะออกใบแจ้งหนี้ให้ทุกห้องที่มีผู้เช่าอยู่โดยอัตโนมัติ"

กฎสำคัญเรื่องการ "ตัดไฟ/ตัดน้ำ": ระบบอัตโนมัตินี้ไม่มีความสามารถตัดไฟ/ตัดน้ำเองได้จริงๆ (ไม่มีเครื่องมือให้เรียกใช้) และการตัดสินใจตัดไฟต้องเป็นของเจ้าของหอพักเท่านั้น เสมอ ถ้าคำสั่งของผู้ใช้มีเรื่องตัดไฟ/ตัดน้ำเมื่อไม่จ่ายเงิน ให้เขียน actionSummary ของรายการนั้นเป็น: ตรวจสอบห้องที่ยังไม่ชำระเงินตามกำหนด ส่งข้อความเตือนที่หนักแน่นไปยังผู้เช่าทาง LINE และเพิ่มรายการแจ้งเตือนลงปฏิทินของระบบให้เจ้าของหอพักเห็นว่าห้องไหนค้างชำระและอาจต้องพิจารณาตัดไฟ/น้ำ (เจ้าของจะไปกดตัดไฟเองในหน้า "Set อุปกรณ์" ซึ่งมีการยืนยันก่อนตัดอยู่แล้ว) — ห้ามเขียนราวกับว่าระบบจะตัดไฟให้เองอัตโนมัติ

คำสั่งจากผู้ใช้: "${instruction}"`;

  const raw = await askClaude(prompt, 1400);
  const jsonText = raw.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(jsonText);
  const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : (parsed.actionSummary ? [parsed] : null);
  if (!tasks || !tasks.length) throw new Error('รูปแบบผลลัพธ์ไม่ถูกต้อง');
  for (const t of tasks) {
    if (!t.actionSummary || !t.humanSummary) throw new Error('รูปแบบผลลัพธ์ไม่ถูกต้อง');
  }
  return tasks;
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
    const tasks = await parseRecurringInstruction(instruction);
    res.json({ instruction, tasks });
  } catch (err) {
    console.error('[recurringTasks/parse]', err.message);
    res.status(502).json({ error: 'แปลคำสั่งไม่สำเร็จ ลองพิมพ์ใหม่อีกครั้งให้ชัดเจนขึ้น หรือลองแยกพิมพ์ทีละกฎ' });
  }
});

function buildTaskRow(instruction, t) {
  return {
    id: String(Date.now()) + '-' + Math.random().toString(36).slice(2, 7),
    instruction,
    scheduleType: t.scheduleType || 'monthly',
    dayOfMonth: t.dayOfMonth != null ? t.dayOfMonth : '',
    dayOfWeek: t.dayOfWeek != null ? t.dayOfWeek : '',
    time: t.time || '09:00',
    actionSummary: t.actionSummary,
    humanSummary: t.humanSummary || t.actionSummary,
    active: true,
    lastRunDate: '',
    lastRunResult: '',
    createdAt: new Date().toISOString(),
  };
}

// Saves one or more confirmed tasks at once — a single freeform instruction
// can expand into several independently-scheduled sub-tasks (see
// parseRecurringInstruction above), so the frontend always posts an array
// here, even for a single-task result.
router.post('/', async (req, res, next) => {
  try {
    const { instruction, tasks } = req.body;
    const list = Array.isArray(tasks) ? tasks : (req.body.actionSummary ? [req.body] : null);
    if (!instruction || !list || !list.length) return res.status(400).json({ error: 'ข้อมูลไม่ครบ — กรุณาแปลคำสั่งก่อนบันทึก' });
    const saved = [];
    for (const t of list) {
      if (!t.actionSummary) continue;
      const item = buildTaskRow(instruction, t);
      await appendRow('RecurringTasks', item);
      saved.push(item);
    }
    if (!saved.length) return res.status(400).json({ error: 'ไม่มีรายการที่บันทึกได้' });
    res.json({ saved });
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
