// "จัดการเชื่อมต่อกันเลยครับ เป็นระบบทำไว้หลังบ้าน โดยไม่ต้องเข้าไป
// setup" (2026-08-01) — real Gemini backend for the "Claude command box"'s
// Gemini picker option (see Rental Management.dc.html's aiEngine/
// setAiEngine, added earlier the same session). Uses **Vertex AI**
// (aiplatform.googleapis.com) authenticated via the SAME Google service
// account already configured for Sheets access (GOOGLE_SERVICE_ACCOUNT_EMAIL
// / GOOGLE_PRIVATE_KEY in server/.env) — this is the exact trick already
// proven working in wholesale-order's own server/gemini.js, chosen
// specifically so the owner never has to paste a separate Gemini/Google AI
// Studio API key anywhere ("ไม่ต้องเข้าไป setup"). Requires the Vertex AI
// API to be enabled + "Vertex AI User" role granted to the service account
// on the same GCP project — same one-time setup wholesale-order already
// needed, likely already done since it's the same underlying GCP project.
//
// DESIGN: rather than reimplementing routes/claude.js's tool-use loop (the
// safety-critical part — READ_TOOL_NAMES gating, write-tool confirm-before-
// execute, show_chart interception, message history threading) a second
// time for Gemini, this file exposes `callWithTools(system, messages, tools,
// maxTokens)` with the EXACT SAME call signature and EXACT SAME response
// shape (`{ stop_reason: 'tool_use'|'end_turn', content: [...] }`,
// Anthropic's own format) that server/claude.js's callWithTools already
// returns. routes/claude.js's /command handler picks whichever module's
// callWithTools to call based on the session's aiEngine setting — every
// other line of that route (and therefore every safety guarantee it
// enforces) is shared, unmodified, identical code for both engines. No
// separate "Gemini tool loop" exists to audit/drift out of sync.
const { google } = require('googleapis');
const { appendRow } = require('./sheets');

const LOCATION = 'us-central1';
const MODEL = 'gemini-2.5-flash';

// Pricing reference only, for GeminiUsageLog's costUsd column (see logUsage
// below) — same per-million-token rates wholesale-order's gemini.js uses
// for gemini-2.5-flash, current as of when this was written. Not used for
// any billing enforcement, purely a cost-visibility number for the future
// ช.นายท้าย usage-tracking platform (see the owner's own framing: "อนาคต
// เราจะเก็บค่าบริการผ่านแพลตฟอร์มใหม่ที่เราจะสร้าง...ใช้ AI 2 ช่วยดูแล
// แพลตฟอร์มของเราที่มี").
const PRICE_PER_MILLION_INPUT_TOKENS = 0.30;
const PRICE_PER_MILLION_OUTPUT_TOKENS = 2.50;

function isConfigured() {
  return !!(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY);
}

function getProjectId() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '';
  const match = email.match(/@([^.]+)\.iam\.gserviceaccount\.com$/);
  if (!match) throw new Error('อ่าน Google Cloud project id จาก GOOGLE_SERVICE_ACCOUNT_EMAIL ไม่ได้');
  return match[1];
}

let _cachedAuthClient = null;
async function getAccessToken() {
  if (!_cachedAuthClient) {
    _cachedAuthClient = new google.auth.JWT(
      process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, null,
      (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      ['https://www.googleapis.com/auth/cloud-platform'] // scope กว้างกว่า Sheets — ต้องใช้ scope นี้เรียก Vertex AI ได้
    );
  }
  const { token } = await _cachedAuthClient.getAccessToken();
  if (!token) throw new Error('ขอ access token จาก Service Account ไม่สำเร็จ');
  return token;
}

// --- Anthropic <-> Gemini format conversion --------------------------------
//
// Claude tool defs are { name, description, input_schema }. Gemini's
// functionDeclarations want { name, description, parameters } — same JSON-
// Schema-shaped object underneath (type/properties/required/enum/items all
// map directly), so this is a pure field-rename, not a schema rewrite.
function toolsToGeminiDeclarations(tools) {
  return (tools || []).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  }));
}

// Claude tool_use blocks carry an opaque `id` used later to pair up the
// matching tool_result. Gemini's functionCall parts carry no such id at
// all. Since THIS FILE is the only thing that ever generates these
// synthetic ids (both when converting a Gemini response INTO Claude shape,
// and later reading a tool_result's tool_use_id back OUT when converting
// the next request), embedding the real tool name inside the id itself
// (`${name}::${index}`) is enough to recover it for functionResponse's own
// required `name` field — no separate lookup table needed.
function makeToolUseId(name, index) {
  return `${name}::${index}`;
}
function toolNameFromId(id) {
  return String(id || '').split('::')[0];
}

// Converts ONE Claude-shaped message ({role, content}) into however many
// Gemini `contents` turns it represents. `content` can be:
//   - a plain string (simple text turn)
//   - an array of Anthropic content blocks: {type:'text'}, {type:'image',
//     source:{...}} (user turn with an attached photo — see routes/
//     claude.js's /command building this for the "+" attach menu),
//     {type:'tool_use', id, name, input} (Claude's own PAST tool calls,
//     replayed back as conversation history), or {type:'tool_result',
//     tool_use_id, content} (the result WE fed back after executing a
//     read-only tool).
function claudeMessageToGeminiContents(msg) {
  if (typeof msg.content === 'string') {
    return [{ role: msg.role === 'assistant' ? 'model' : 'user', parts: [{ text: msg.content }] }];
  }
  const blocks = Array.isArray(msg.content) ? msg.content : [];
  // tool_result blocks must become their OWN "function" role turn, separate
  // from any text/image the same logical "user turn" might otherwise carry
  // — Gemini expects functionResponse parts on their own turn.
  const toolResults = blocks.filter((b) => b.type === 'tool_result');
  if (toolResults.length) {
    return [{
      role: 'function',
      parts: toolResults.map((tr) => ({
        functionResponse: {
          name: toolNameFromId(tr.tool_use_id),
          response: { content: safeParseJson(tr.content) },
        },
      })),
    }];
  }
  const parts = [];
  blocks.forEach((b) => {
    if (b.type === 'text') parts.push({ text: b.text });
    else if (b.type === 'image') parts.push({ inline_data: { mime_type: b.source.media_type, data: b.source.data } });
    else if (b.type === 'tool_use') parts.push({ functionCall: { name: b.name, args: b.input } });
  });
  return [{ role: msg.role === 'assistant' ? 'model' : 'user', parts }];
}

function safeParseJson(text) {
  try { return JSON.parse(text); } catch { return text; }
}

// Converts a Vertex AI generateContent response into the EXACT shape
// server/claude.js's callWithTools already returns, so routes/claude.js's
// /command handler can treat both engines identically.
function geminiResponseToClaudeShape(data) {
  const candidate = (data.candidates || [])[0];
  const parts = (candidate && candidate.content && candidate.content.parts) || [];
  let toolIndex = 0;
  const content = parts.map((p) => {
    if (p.functionCall) {
      return { type: 'tool_use', id: makeToolUseId(p.functionCall.name, toolIndex++), name: p.functionCall.name, input: p.functionCall.args || {} };
    }
    return { type: 'text', text: p.text || '' };
  }).filter((c) => c.type !== 'text' || c.text); // drop empty text-only parts
  const hasToolUse = content.some((c) => c.type === 'tool_use');
  return { stop_reason: hasToolUse ? 'tool_use' : 'end_turn', content, _usageMetadata: data.usageMetadata };
}

// Same call signature + same return shape as server/claude.js's
// callWithTools — see the big design comment at the top of this file for
// why. `buildingLabel` (optional, e.g. a customerSheetId or building name)
// is threaded through purely for GeminiUsageLog's own record-keeping.
async function callWithTools(system, messages, tools, maxTokens = 1024, buildingLabel) {
  if (!isConfigured()) throw new Error('ยังไม่ได้ตั้งค่า Google Service Account บนเซิร์ฟเวอร์ (ใช้ตัวเดียวกับ Google Sheets)');
  const projectId = getProjectId();
  const accessToken = await getAccessToken();
  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;

  const contents = messages.flatMap(claudeMessageToGeminiContents);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      tools: [{ functionDeclarations: toolsToGeminiDeclarations(tools) }],
      // "Gemini ชอบอธิบายยาวเกิน เปลืองเครดิต...ใช้ Gemini โหมดนี้เปลือง
      // กว่าการใช้ในร้านค้าปลีกส่ง" (2026-08-02) — real bug found: gemini-
      // 2.5-flash เปิด "extended thinking" เป็นค่าเริ่มต้น (เห็นชัดจากผล
      // ทดสอบตอนสร้างฟีเจอร์นี้ครั้งแรก มี thoughtsTokenCount ติดมาด้วย
      // ทุกครั้ง) เพิ่ม token ที่ไม่จำเป็นสำหรับงานประเภทนี้ (เลือก tool /
      // ตอบคำถามข้อมูล ไม่ใช่งานที่ต้องให้เหตุผลหลายขั้นตอน) — wholesale-
      // order's server/gemini.js ปิดค่านี้มาตั้งแต่แรกด้วยเหตุผลเดียวกัน
      // แต่ตอนสร้างไฟล์นี้ลืมใส่ตาม แก้ให้ตรงกันแล้ว ไม่กระทบความแม่นยำ
      generationConfig: { maxOutputTokens: maxTokens, thinkingConfig: { thinkingBudget: 0 } },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Gemini API failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  const shaped = geminiResponseToClaudeShape(data);
  logUsage('command', shaped._usageMetadata, buildingLabel).catch(() => {});
  return shaped;
}

// Fire-and-forget cost/usage log — same TAB NAME as wholesale-order's own
// GeminiUsageLog (a deliberate naming match so a future ช.นายท้าย oversight
// platform can find "the Gemini usage tab" by the same name across
// different projects), though the columns here are chaosuk-rental-specific
// (adds a `building` field, since THIS app is genuinely multi-tenant via
// separate spreadsheets per building — unlike wholesale-order's single
// shared sheet — so usage needs to be attributable per building even
// within one project). Never blocks or throws into the caller — a logging
// hiccup must never break an actual command response.
async function logUsage(feature, usageMetadata, buildingLabel) {
  if (!usageMetadata) return;
  const inputTokens = usageMetadata.promptTokenCount || 0;
  const outputTokens = usageMetadata.candidatesTokenCount || 0;
  const costUsd = (inputTokens / 1e6) * PRICE_PER_MILLION_INPUT_TOKENS + (outputTokens / 1e6) * PRICE_PER_MILLION_OUTPUT_TOKENS;
  try {
    await appendRow('GeminiUsageLog', {
      id: 'GU' + Date.now(), timestamp: new Date().toISOString(), feature,
      building: buildingLabel || '', model: MODEL,
      inputTokens, outputTokens, costUsd: Math.round(costUsd * 1e6) / 1e6,
    });
  } catch (err) {
    // Sheet may not have a GeminiUsageLog tab yet on this building — see
    // prototype-auth/migrate-add-gemini-usage-log.js. Non-fatal.
    console.error('[gemini] usage log failed', err.message);
  }
}

module.exports = { isConfigured, callWithTools };
