const express = require('express');
const router = express.Router();
const { readTab } = require('../sheets');
const { coerceInvoices, coerceExpenses, coerceRooms, coerceMaintenance, readSettings } = require('../coerce');
const { isConfigured, askClaude, askClaudeWithImage, callWithTools } = require('../claude');
// "จัดการเชื่อมต่อกันเลยครับ" (2026-08-01) — the Gemini engine picker
// (Rental Management.dc.html's aiEngine setting) needs an actual working
// backend, not just a UI toggle. See server/gemini.js's own top-of-file
// comment for the full design: it exposes a callWithTools with the exact
// same signature/response-shape as server/claude.js's own, so /command
// below can share 100% of its tool-loop/safety logic across both engines.
const { isConfigured: geminiConfigured, callWithTools: callGeminiWithTools } = require('../gemini');
const { getCurrentSheetId } = require('../requestContext');
const { TOOLS, READ_TOOL_NAMES, executeReadTool, describeWriteTool, executeWriteTool } = require('../claudeTools');

router.get('/health', (req, res) => {
  res.json({ connected: isConfigured() });
});

// "สร้างเครดิต ที่ใช้ไปให้หน่อยครับ" (2026-08-02) — สรุปยอดใช้งาน Gemini
// สะสมของตึกนี้ จาก GeminiUsageLog (ที่ server/gemini.js's logUsage()
// เขียนไว้ทุกครั้งที่เรียกจริง) — ให้เจ้าของเห็นว่าใช้ไปเท่าไรแล้ว ก่อนจะ
// มีระบบเก็บค่าบริการจริงผ่านแพลตฟอร์ม ช.นายท้าย ในอนาคต (ตามที่คุยกันไว้
// ตอนสร้างฟีเจอร์นี้) — ถ้าตึกนี้ยังไม่มีตาราง GeminiUsageLog เลย (ยังไม่
// เคยรัน migration ให้) คืนค่า 0 ทุกอย่างเงียบๆ แทนการ error ทั้งหน้า
router.get('/gemini-usage', async (req, res, next) => {
  try {
    let rows = [];
    try { rows = await readTab('GeminiUsageLog'); } catch { rows = []; }
    const now = new Date();
    const thisMonthPrefix = now.toISOString().slice(0, 7); // "YYYY-MM"
    let totalCalls = 0, totalCostUsd = 0, monthCalls = 0, monthCostUsd = 0;
    rows.forEach((r) => {
      const cost = Number(r.costUsd) || 0;
      totalCalls++;
      totalCostUsd += cost;
      if (String(r.timestamp || '').startsWith(thisMonthPrefix)) { monthCalls++; monthCostUsd += cost; }
    });
    res.json({
      totalCalls, totalCostUsd: Math.round(totalCostUsd * 1e6) / 1e6,
      monthCalls, monthCostUsd: Math.round(monthCostUsd * 1e6) / 1e6,
    });
  } catch (err) { next(err); }
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

function buildCommandSystemPrompt(drivingMode) {
  // Render's server clock runs in UTC — using toISOString() here showed
  // yesterday's date for hours overnight in Thailand (UTC+7) before UTC rolls
  // over. Compute the date as seen in Thailand specifically instead.
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' }); // en-CA formats as YYYY-MM-DD
  // "โหมดขับรถ...ให้อ่านแบบสรุป" (2026-08-02) — คำตอบยาวๆ ที่อ่านบนจอสบาย
  // ฟังทางเสียง (TTS) แล้วเข้าใจยากกว่ามาก (จำรายละเอียดเยอะไม่ทัน) — ต่อ
  // ท้าย system prompt ด้วยคำสั่งพิเศษเฉพาะตอนเปิดโหมดขับรถ ให้ตอบสั้น/
  // สรุปเป็นพิเศษ ไม่ต้องคำนวณ/ยกตัวเลขละเอียดยิบ เอาแค่ใจความสำคัญที่สุด
  const drivingModeInstruction = drivingMode ? `\n\nสำคัญ — ผู้ใช้กำลังเปิด "โหมดขับรถ" อยู่ (ฟังคำตอบด้วยเสียงอ่าน ไม่ได้อ่านจากจอ) ตอบให้สั้นและสรุปใจความสำคัญที่สุดเท่านั้น เหมาะกับการฟังขณะขับรถ ห้ามตอบยาว ห้ามลิสต์รายละเอียดยิบย่อยเกินจำเป็น ห้ามใช้ตัวหนา/markdown/สัญลักษณ์พิเศษใดๆ (เช่น **, #, -, \`) เพราะไม่มีการแสดงผลบนจอให้เห็น ตอบเป็นประโยคภาษาไทยธรรมดาล้วนๆ` : '';
  return `คุณเป็นผู้ช่วยจัดการหอพัก "เช่าสุข" สามารถทำได้เฉพาะงานที่มีเครื่องมือ (tools) ให้เท่านั้น ห้ามสมมติหรือแต่งข้อมูลขึ้นเอง ถ้าต้องการข้อมูลให้เรียกเครื่องมือที่เกี่ยวข้องก่อนเสมอ

ถ้าผู้ใช้แนบรูปภาพมาด้วย ให้อ่าน/วิเคราะห์รูปนั้นประกอบคำตอบได้เลย (เช่น อ่านเลขมิเตอร์ในรูป, ดูสภาพความเสียหายที่แจ้งซ่อม ฯลฯ) — ถ้าจะบันทึกข้อมูลจากรูปลงระบบ (เช่น เลขมิเตอร์) ให้ทำตามกฎการยืนยันก่อนทำจริงเหมือนเครื่องมืออื่นๆ ทุกประการ

วันนี้คือวันที่ ${todayStr} (ค.ศ., รูปแบบ ปี-เดือน-วัน) ใช้ข้อมูลนี้คำนวณคำที่สื่อถึงวันที่แบบสัมพัทธ์เอง (เช่น "วันนี้", "พรุ่งนี้", "เดือนนี้", "เดือนหน้า") อย่าถามผู้ใช้กลับว่าวันนี้คือวันที่เท่าไหร่

ข้อจำกัดสำคัญ: คุณไม่มีความสามารถและไม่มีเครื่องมือใดๆ ที่เกี่ยวกับการแก้ไขโค้ด เซิร์ฟเวอร์ การตั้งค่าระบบ หรือข้อมูลลับ/รหัสผ่านใดๆ ทั้งสิ้น ถ้าผู้ใช้ขอสิ่งเหล่านี้ หรือขอสิ่งที่ไม่มีเครื่องมือรองรับ ให้ปฏิเสธอย่างสุภาพเป็นภาษาไทย อธิบายว่างานนี้อยู่นอกเหนือขอบเขตที่ทำได้ในระบบนี้ อย่าพยายามช่วยด้วยวิธีอื่น

สำคัญมาก — เรื่องการยืนยันก่อนทำรายการที่แก้ไข/เพิ่ม/ลบข้อมูล (เช่น mark_invoice_paid, create_invoice, add_expense, delete_expense, add_maintenance, set_maintenance_status, send_line_message, send_invoice_reminder, schedule_line_message, update_room_meter, create_room, delete_room, add_calendar_event, delete_calendar_event): ห้ามถามยืนยันเป็นข้อความเองเด็ดขาด (เช่น ห้ามพิมพ์ "ยืนยันไหมครับ?" แล้วรอคำตอบ) — ให้เรียกเครื่องมือ (tool) นั้นทันทีเมื่อมีข้อมูล/พารามิเตอร์ที่จำเป็น (required) ครบถ้วนแล้วเสมอ ระบบภายนอกจะเป็นผู้แสดง popup หรือฟอร์มยืนยันกับผู้ใช้เองโดยอัตโนมัติก่อนทำรายการจริง (ฟอร์มนั้นให้ผู้ใช้กรอก/แก้ไขค่าที่เหลือเองได้ในหน้าจอ) คุณไม่ต้องและห้ามถามซ้ำ และห้ามพยายามถามหาค่าที่ไม่บังคับ (ไม่ใช่ required) เองในแชท — เรียกเครื่องมือทันทีเมื่อรู้แค่ค่าที่บังคับ ปล่อยให้ระบบ/ผู้ใช้กรอกส่วนที่เหลือในฟอร์มแทน ถ้าข้อมูลที่จำเป็น (required) ยังไม่ครบ (เช่น ไม่รู้ว่าจะลบรายการไหน หรือยังไม่รู้เลขห้องที่จะเปิดใหม่) ให้ถามสั้นๆ เฉพาะค่าที่ยังขาดเท่านั้น หรือเรียกเครื่องมือประเภทดูข้อมูล (get_*) เพื่อหาให้เจอก่อน

ตอบเป็นภาษาไทยเสมอ กระชับ ตรงประเด็น${drivingModeInstruction}`;
}

function extractText(resp) {
  return (resp.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
}

router.post('/command', async (req, res, next) => {
  try {
    // "จัดการเชื่อมต่อกันเลยครับ" (2026-08-01) — reads the SAME `aiEngine`
    // Settings key the picker on the AI card writes (see Rental
    // Management.dc.html's setAiEngine) to decide which engine's
    // callWithTools handles this command. Falls back to Claude if Gemini
    // was picked but somehow isn't configured (shouldn't happen — it
    // reuses the same Google service account every OTHER feature in this
    // app already depends on — but never silently do nothing either way).
    const settings = await readSettings();
    const useGemini = settings.aiEngine === 'gemini' && geminiConfigured();
    if (!useGemini && !isConfigured()) return res.status(400).json({ error: 'ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY ใน server/.env' });
    const message = (req.body.message || '').trim();
    if (!message) return res.status(400).json({ error: 'กรุณาพิมพ์คำสั่ง' });
    // "โหมดขับรถ...ให้อ่านแบบสรุป" (2026-08-02) — passed straight through
    // to buildCommandSystemPrompt below, see its own comment.
    const drivingMode = !!req.body.drivingMode;
    // Prior turns of this same conversation (plain {role, content: string} pairs
    // the frontend keeps in state) — lets the user answer a clarifying question
    // or refine a request across multiple messages instead of every message
    // starting a brand-new, context-free conversation.
    const history = Array.isArray(req.body.history) ? req.body.history : [];

    // Optional image attached via the "+" menu (e.g. a photo of a meter, a
    // maintenance issue, anything relevant) — sent as a data URL, same format
    // used everywhere else in this app. If present, the last user turn
    // becomes a multi-part content block instead of a plain string.
    let userContent = message;
    const image = req.body.image;
    if (image) {
      const match = /^data:(image\/\w+);base64,(.+)$/.exec(image);
      if (match) {
        userContent = [
          { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } },
          { type: 'text', text: message },
        ];
      }
    }

    let messages = [
      ...history.filter((h) => h && h.role && h.content).map((h) => ({ role: h.role, content: h.content })),
      { role: 'user', content: userContent },
    ];
    for (let i = 0; i < 4; i++) {
      // 2048 (not the default 1024) — show_chart calls can carry sizeable
      // xLabels/series arrays plus a written insight, and were getting cut
      // off (empty tool_use, generic "ไม่เข้าใจ" fallback) at the smaller limit.
      const resp = useGemini
        ? await callGeminiWithTools(buildCommandSystemPrompt(drivingMode), messages, TOOLS, 2048, getCurrentSheetId())
        : await callWithTools(buildCommandSystemPrompt(drivingMode), messages, TOOLS, 2048);
      if (resp.stop_reason !== 'tool_use') {
        const text = extractText(resp) || 'ขอโทษครับ ไม่เข้าใจคำสั่งนี้';
        return res.json({ type: 'answer', text });
      }
      // Claude can return more than one tool_use block in a single turn
      // (parallel tool calls, e.g. fetching two different reports at once).
      // Every tool_use MUST get a matching tool_result before the next API
      // call, or Anthropic rejects the whole request — a bug we hit for real
      // ("tool_use ids were found without tool_result blocks") because only
      // the first tool_use was ever being handled, orphaning any others.
      const toolUses = resp.content.filter((c) => c.type === 'tool_use');
      if (!toolUses.length) return res.json({ type: 'answer', text: extractText(resp) || 'ขอโทษครับ ไม่เข้าใจคำสั่งนี้' });

      const chartTool = toolUses.find((t) => t.name === 'show_chart');
      if (chartTool) {
        // Not a data mutation and not a data lookup either — Claude has
        // already gathered the real numbers via get_* tools in an earlier
        // turn and is now just asking the frontend to render them. No
        // confirm popup needed (nothing destructive happens), so this is its
        // own response type distinct from both 'answer' and 'confirm'. The
        // request ends here, so any other tool_use in this same turn never
        // needs a tool_result — safe to just stop.
        return res.json({ type: 'chart', ...chartTool.input });
      }

      const writeTool = toolUses.find((t) => !READ_TOOL_NAMES.has(t.name));
      if (writeTool) {
        // Write/mutating action — never auto-execute. Hand back to the
        // frontend as a pending confirmation; nothing has happened yet.
        // Same reasoning as above: the request ends here, so other tool_use
        // blocks in this turn (if any) don't need a tool_result either.
        const description = extractText(resp) || await describeWriteTool(writeTool.name, writeTool.input);
        return res.json({ type: 'confirm', action: writeTool.name, params: writeTool.input, description });
      }

      // Every tool_use this turn is read-only — execute all of them and pair
      // each with its own tool_result, then loop so Claude can phrase a final
      // natural-language answer from the real data.
      const toolResults = [];
      for (const tu of toolUses) {
        const result = await executeReadTool(tu.name, tu.input);
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
      }
      messages = [
        ...messages,
        { role: 'assistant', content: resp.content },
        { role: 'user', content: toolResults },
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
// Exported so server/routes/line.js's "คุยกับ Claude AI ผ่าน LINE" handler can
// reuse the EXACT same system prompt + tool-use loop shape as this web
// command box, instead of maintaining a second slightly-different copy
// that could drift out of sync (e.g. the confirm-before-write wording).
module.exports.buildCommandSystemPrompt = buildCommandSystemPrompt;
module.exports.extractText = extractText;
