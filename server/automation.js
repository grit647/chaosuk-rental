// Runs one recurring-task's "actionSummary" instruction unattended (no human
// in the loop to click a confirm popup) — invoked by the scheduler when a
// task's day/time is due. Reuses the exact same tool list and read/write
// execution logic as the interactive Claude command box (claudeTools.js), so
// there is still no mechanical way to touch code/server/credentials, and the
// same room/invoice/etc. validation rules apply.
//
// The one thing this does differently from the interactive command box:
// write tools execute immediately instead of returning a { type: 'confirm' }
// for a popup. That's safe here specifically because the human already
// reviewed and approved the *exact* actionSummary text at task-creation time
// (see server/routes/recurringTasks.js's /parse + save flow) — this is the
// "confirm once, then it runs on schedule" model, the same one already used
// for scheduled LINE messages.
//
// FORM_ONLY_TOOLS is a hard stop: lease/contract data and opening new rooms
// both require the native form UI (some fields — ID photos, lease files —
// simply can't be filled via text), so those tools are never auto-executed
// here, unattended or not. If a recurring instruction would need one, the run
// just reports that it needs manual action instead.
const { callWithTools } = require('./claude');
const { TOOLS, READ_TOOL_NAMES, executeReadTool, executeWriteTool } = require('./claudeTools');

const FORM_ONLY_TOOLS = new Set(['create_room', 'open_contract_form']);

function buildAutomationSystemPrompt() {
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
  return `คุณเป็นระบบทำงานประจำอัตโนมัติของหอพัก "เช่าสุข" ทำงานโดยไม่มีคนคอยกดยืนยัน — งานนี้ถูกผู้ดูแลระบบตรวจสอบและอนุมัติข้อความคำสั่งนี้ไว้ล่วงหน้าแล้วตอนตั้งค่า ให้ทำตามคำสั่งที่ได้รับให้สำเร็จโดยเรียกเครื่องมือ (tools) ที่เกี่ยวข้องทันที ห้ามถามยืนยันซ้ำ (ไม่มีใครอ่านคำถามอยู่) ห้ามสมมติข้อมูลเอง ถ้าต้องการข้อมูลประกอบให้เรียกเครื่องมือดูข้อมูล (get_*) ก่อนเสมอ

วันนี้คือวันที่ ${todayStr} (ค.ศ.)

ข้อจำกัดสำคัญ: ห้ามเรียกเครื่องมือ create_room หรือ open_contract_form เด็ดขาดในบริบทนี้ (งานเหล่านี้มีข้อมูลบางส่วน เช่น รูปบัตรประชาชน/ไฟล์สัญญา ที่กรอกอัตโนมัติไม่ได้ ต้องให้ผู้ดูแลทำผ่านฟอร์มจริงเท่านั้น) ถ้าคำสั่งต้องใช้เครื่องมือเหล่านี้ ให้ตอบข้อความสั้นๆ อธิบายว่าส่วนนี้ต้องให้ผู้ดูแลทำเองแทน แล้วหยุด

คุณไม่มีเครื่องมือสำหรับตัดไฟหรือตัดน้ำเลย (ไม่มีเครื่องมือนี้อยู่จริง) — ถ้าคำสั่งพูดถึงการตัดไฟ/ตัดน้ำเมื่อค้างชำระ ให้ทำได้แค่: ส่งข้อความเตือนที่หนักแน่นไปยังผู้เช่าทาง LINE และเพิ่มรายการแจ้งเตือนลงปฏิทินของระบบ (add_calendar_event) ให้เจ้าของเห็นว่าห้องไหนค้างชำระและอาจต้องพิจารณาตัดไฟ/น้ำเอง — ห้ามพูดหรือทำเหมือนตัดไฟ/น้ำให้เองโดยเด็ดขาด การตัดไฟ/น้ำเป็นการตัดสินใจของเจ้าของหอพักเท่านั้น เจ้าของจะไปกดตัดเองในหน้า "Set อุปกรณ์" ของแอป

งานประจำนี้อาจต้องดูข้อมูลหลายอย่างประกอบกัน (เช่น "ตรวจสอบทั้งระบบ") — เรียกเครื่องมือดูข้อมูล (get_*) เท่าที่จำเป็นจริงๆ ก่อน อย่าเรียกดูข้อมูลที่ไม่เกี่ยวข้องกับคำสั่งเพิ่มเติมโดยไม่จำเป็น แล้วรีบไปถึงขั้นตอนลงมือทำจริง (เช่น ส่งข้อความ) ให้เร็วที่สุด — มีจำนวนรอบการเรียกเครื่องมือจำกัด ถ้าใช้หมดก่อนจะได้ลงมือทำจริง งานจะไม่สำเร็จในรอบนั้น

ทำงานที่ทำได้ให้ครบตามคำสั่ง แล้วสรุปผลเป็นภาษาไทยสั้นๆ ว่าทำอะไรไปบ้าง`;
}

async function runAutomatedInstruction(instructionText) {
  let messages = [{ role: 'user', content: instructionText }];
  const log = [];
  // 10 (not the original 6) — a broad instruction like "ตรวจสอบทั้งระบบ" can
  // legitimately need several get_* calls (rooms, invoices, maintenance,
  // expenses, calendar...) before Claude ever reaches the actual write/send
  // step. At 6 it was hitting the cap mid-investigation and silently
  // reporting "ไม่มีการเปลี่ยนแปลง" even though nothing had actually failed —
  // just run out of headroom. finishedNormally distinguishes that real
  // "hit the cap without finishing" case from a genuine no-op.
  let finishedNormally = false;
  for (let i = 0; i < 10; i++) {
    const resp = await callWithTools(buildAutomationSystemPrompt(), messages, TOOLS, 2048);
    if (resp.stop_reason !== 'tool_use') {
      const text = (resp.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
      if (text) log.push(text);
      finishedNormally = true;
      break;
    }
    const toolUses = resp.content.filter((c) => c.type === 'tool_use');
    if (!toolUses.length) { finishedNormally = true; break; }

    // A recurring task asking for a chart makes no sense unattended (nowhere
    // to display it) — treat it as a dead end rather than looping forever.
    if (toolUses.some((t) => t.name === 'show_chart')) {
      log.push('คำสั่งนี้ขอให้แสดงกราฟ ซึ่งใช้ไม่ได้กับงานอัตโนมัติ — ข้ามไป');
      finishedNormally = true;
      break;
    }

    const toolResults = [];
    for (const tu of toolUses) {
      try {
        if (READ_TOOL_NAMES.has(tu.name)) {
          const result = await executeReadTool(tu.name, tu.input);
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
        } else if (FORM_ONLY_TOOLS.has(tu.name)) {
          log.push(`ต้องทำผ่านฟอร์มเอง (${tu.name}) — ข้ามไป`);
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify({ ok: false, message: 'งานนี้ต้องให้ผู้ดูแลทำผ่านฟอร์มจริงเอง ระบบอัตโนมัติทำแทนไม่ได้' }) });
        } else {
          const result = await executeWriteTool(tu.name, tu.input);
          log.push(result.message || tu.name);
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
        }
      } catch (err) {
        log.push(`ผิดพลาด (${tu.name}): ${err.message}`);
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify({ ok: false, error: err.message }), is_error: true });
      }
    }
    messages = [...messages, { role: 'assistant', content: resp.content }, { role: 'user', content: toolResults }];
  }
  if (!finishedNormally) log.push('หยุดกลางคันเพราะครบจำนวนรอบสูงสุดก่อนทำงานเสร็จ (คำสั่งอาจกว้างเกินไป ลองแบ่งเป็นคำสั่งย่อยๆ)');
  return { ok: log.length > 0, log: log.join(' · ') || 'ไม่มีการเปลี่ยนแปลง' };
}

module.exports = { runAutomatedInstruction };
