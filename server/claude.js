const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-haiku-4-5'; // fast + cheap, plenty for a short text summary
const VISION_MODEL = 'claude-sonnet-5'; // stronger model for reading meter digits accurately

function isConfigured() {
  return !!ANTHROPIC_API_KEY;
}

async function callMessages(model, content, maxTokens) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content }],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Claude API failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  return (data.content || []).map((c) => c.text || '').join('');
}

async function askClaude(prompt, maxTokens = 800) {
  return callMessages(MODEL, prompt, maxTokens);
}

// dataUrl: a "data:image/jpeg;base64,...." string (same format the frontend
// already produces for uploads elsewhere in this app).
async function askClaudeWithImage(prompt, dataUrl, maxTokens = 1024) {
  const match = /^data:(image\/\w+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) throw new Error('รูปภาพไม่ถูกต้อง');
  const [, mediaType, base64Data] = match;
  const content = [
    { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
    { type: 'text', text: prompt },
  ];
  return callMessages(VISION_MODEL, content, maxTokens);
}

// Tool-use turn for the scoped "command box" assistant — system prompt +
// running message history + a fixed tool whitelist. Returns the raw parsed
// response so the caller can inspect stop_reason / tool_use blocks itself.
async function callWithTools(system, messages, tools, maxTokens = 1024) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: VISION_MODEL, // stronger model — better at staying within tool boundaries
      max_tokens: maxTokens,
      system,
      tools,
      messages,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Claude API failed (${res.status}): ${text}`);
  }
  return res.json();
}

// Reads a Thai bank transfer slip photo — used when a tenant sends a payment
// slip image directly to the LINE bot. This is text/OCR extraction only, NOT
// fraud verification: Claude reads what's printed/rendered on the slip, it
// cannot confirm the transaction actually happened against a real bank
// record, so a convincingly edited slip could still pass. That trade-off was
// discussed and accepted explicitly — the extracted amount only pre-fills a
// "รอตรวจสอบ" flag for the owner to manually confirm before it ever marks an
// invoice paid (see server/routes/line.js's slip handler + the Bills page
// review modal in Rental Management.dc.html).
async function readPaymentSlip(dataUrl) {
  const prompt = `นี่คือภาพสลิปโอนเงินจากแอปธนาคารไทย อ่านข้อมูลจากภาพแล้วตอบเป็น JSON เท่านั้น (ห้ามมีข้อความอื่นหรือ markdown code fence ปนมา) ตามรูปแบบนี้เป๊ะ:

{"amount":1000,"date":"2026-07-08","senderName":"...","recipientName":"...","refNumber":"..."}

- amount: จำนวนเงินที่โอน (ตัวเลขล้วน ไม่มีเครื่องหมายจุลภาคหรือสกุลเงิน) — คือยอดเงินหลักของรายการ (มักอยู่ตัวใหญ่ใกล้เครื่องหมายถูก/สถานะ "รายการสำเร็จ") ห้ามสับสนกับ "ค่าธรรมเนียม" (transaction fee) ซึ่งเป็นคนละช่องและมักเป็น 0.00 — ถ้าเจอทั้งสองช่องในภาพ ให้ใช้ตัวเลขของ "จำนวนเงิน" เท่านั้น ห้ามใช้ "ค่าธรรมเนียม"
- date: วันที่ทำรายการ แปลงเป็นรูปแบบ YYYY-MM-DD (ค.ศ. — ถ้าปีในสลิปเป็น พ.ศ. ให้ลบ 543 ก่อนแปลง)
- senderName: ชื่อผู้โอน (ฝั่ง "จาก")
- recipientName: ชื่อผู้รับโอน (ฝั่ง "ไปที่"/"ถึง")
- refNumber: หมายเลขอ้างอิงของรายการ ถ้ามี

ถ้าอ่านค่าไหนไม่ได้ชัดเจน ให้ใส่ null สำหรับค่านั้น ห้ามเดา`;

  const raw = await askClaudeWithImage(prompt, dataUrl, 400);
  const jsonText = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(jsonText);
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

function isWhisperConfigured() {
  return !!OPENAI_API_KEY;
}

// Transcribes a LINE voice message (an .m4a audio buffer, from
// getMessageContent in server/line.js) to Thai text — used so the owner
// can talk to the Claude command-box assistant via LINE's mic button, the
// same way the web command box already supports voice input. NOT built on
// Anthropic's API at all: the Messages API used everywhere else in this
// file has no audio content-block support, so this calls OpenAI's Whisper
// API instead (a separate provider/API key, per explicit owner request —
// OPENAI_API_KEY in server/.env). Uses Node's built-in fetch/FormData/Blob
// (Node 18+) rather than adding a new npm dependency.
async function transcribeAudio(buffer, mimeType = 'audio/m4a') {
  if (!OPENAI_API_KEY) throw new Error('ยังไม่ได้ตั้งค่า OPENAI_API_KEY บนเซิร์ฟเวอร์');
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType }), 'voice.m4a');
  form.append('model', 'whisper-1');
  form.append('language', 'th'); // owner speaks Thai — skip language auto-detection
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Whisper API failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  return (data.text || '').trim();
}

module.exports = { isConfigured, askClaude, askClaudeWithImage, callWithTools, readPaymentSlip, isWhisperConfigured, transcribeAudio };
