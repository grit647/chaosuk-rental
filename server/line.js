const crypto = require('crypto');

const LINE_API = 'https://api.line.me/v2/bot/message';

// "หลังคาลิเบตให้ตรงแล้ว การใช้ทุกครั้ง ต้องนับต่อให้ด้วยครับ จะได้รู้
// จำนวนการใช้จริง การคาลิเบต คือ การตั้งค่าให้ตรงกับ OA เพื่อให้การคำนวณ
// ใกล้เคียงครับ" (2026-08-13) — LINE's own /quota/consumption API (ดู
// getMessageQuotaConsumption ด้านล่าง) พิสูจน์แล้วว่าอัปเดตช้ามาก (ไม่
// เรียลไทม์ อาจค้างเป็นวันๆ) ทำให้ตัวเลขในเว็บเราตามหลังของจริงจาก LINE OA
// Manager เยอะ — แก้โดยเลิกพึ่ง LINE's API เป็นแหล่งข้อมูลหลักหลังจากที่
// คาลิเบรตครั้งแรกแล้ว (เจ้าของพิมพ์เลขจริงจาก OA Manager ให้ตรงกัน ณ
// จุดเริ่ม) แล้วให้แอปนี้เองนับต่อจากจุดนั้นทุกครั้งที่ส่งข้อความจริง
// (บวก 1 ทุกครั้งที่ callLineApi's push-type call สำเร็จ) แทน — Settings
// sheet's lineQuotaOverride (เดิมเป็นแค่ค่า override นิ่งๆ ที่เจ้าของพิมพ์
// เอง) ตอนนี้กลายเป็นตัวนับที่วิ่งต่อเนื่องเองตั้งแต่จุดคาลิเบรตไป — ไม่ทำ
// อะไรถ้ายังไม่เคยคาลิเบรตเลย (ไม่มีจุดเริ่มให้นับต่อ, GET /api/line/usage
// ยัง fallback ไปใช้เลขดิบจาก LINE ตามปกติในเคสนั้น) — เฉพาะ push-type
// เท่านั้น (pushMessage/pushButtonMessage/pushMessageWithConfirmButton/
// pushLinkButton) ไม่รวม replyMessage/replyLinkButton เพราะข้อความตอบกลับ
// ผ่าน replyToken ไม่หักโควตารายเดือนของ LINE จริง (นับเฉพาะ push/
// multicast/broadcast) — best-effort เสมอ (catch เงียบ) ไม่ให้การนับโควตา
// ไปบล็อกการส่งข้อความจริงได้ไม่ว่ากรณีใด
async function incrementLineQuotaCounter() {
  try {
    const { readTab, updateRow } = require('./sheets');
    const rows = await readTab('Settings');
    const row = rows.find((r) => r.key === 'lineQuotaOverride');
    if (!row || row.value === '' || row.value == null) return; // ยังไม่เคยคาลิเบรต — ไม่มีจุดเริ่มให้นับต่อ
    await updateRow('Settings', 'lineQuotaOverride', { value: String((Number(row.value) || 0) + 1) }, 'key');
  } catch (err) {
    console.error('[line] incrementLineQuotaCounter failed', err.message);
  }
}

// "การส่งข้อมูลของเราภายใน 1 [เดือน] มันดูได้ไหมครับ ประวัติการส่ง"
// (2026-08-13, เลือก "สรุปเร็วๆ") — บันทึกทุกการส่งจริง (push-type เท่านั้น
// เหตุผลเดียวกับ incrementLineQuotaCounter ด้านบน) ลงแท็บ LineSendLog ใหม่
// (id, timestamp, to, category — migrate-add-linesendlog-tab.js) เก็บแค่
// LINE user id ดิบ ("to") ไม่ resolve เป็นชื่อห้อง/เจ้าของตรงนี้ (ประหยัด
// ไม่ต้องอ่าน Rooms/Settings เพิ่มทุกครั้งที่ส่ง) — GET /api/line/send-log
// (routes/line.js) เป็นจุดเดียวที่ resolve ชื่อจริงตอนเปิดดูประวัติแทน
// best-effort เสมอ (catch เงียบ) เหมือนกัน ไม่ให้การบันทึกประวัติไปบล็อก
// การส่งข้อความจริงได้
async function logLineSend(to, category) {
  try {
    const { appendRow } = require('./sheets');
    await appendRow('LineSendLog', {
      id: 'LSL' + Date.now() + Math.random().toString(36).slice(2, 6),
      timestamp: new Date().toISOString(),
      to: to || '',
      category: category || 'อื่นๆ',
    });
  } catch (err) {
    console.error('[line] logLineSend failed (tab อาจยังไม่มี — รัน migrate-add-linesendlog-tab.js)', err.message);
  }
}

// Per explicit user request: LINE credentials can now come from either the
// shared server/.env values (คุณต้น's current setup, unchanged) OR a
// per-customer override stored in that customer's own Settings sheet
// (see server/routes/settings.js's lineCredentials handling + the new
// gear-icon UI). Every function below takes an OPTIONAL `creds` param —
// when omitted, falls back to process.env exactly as before, so nothing
// about the existing single-tenant usage changes unless a route
// explicitly resolves and passes a customer's own credentials.
function resolveCreds(creds) {
  return {
    accessToken: (creds && creds.accessToken) || process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: (creds && creds.channelSecret) || process.env.LINE_CHANNEL_SECRET,
  };
}

function isConfigured(creds) {
  const c = resolveCreds(creds);
  return !!(c.accessToken && c.channelSecret);
}

function verifySignature(rawBody, signature, creds) {
  const c = resolveCreds(creds);
  if (!c.channelSecret || !signature) return false;
  const hmac = crypto.createHmac('sha256', c.channelSecret);
  hmac.update(rawBody);
  const expected = hmac.digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

async function callLineApi(path, body, creds) {
  const c = resolveCreds(creds);
  const res = await fetch(`${LINE_API}/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${c.accessToken}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LINE API ${path} failed (${res.status}): ${text}`);
  }
  return res;
}

async function replyMessage(replyToken, text, creds) {
  return callLineApi('reply', { replyToken, messages: [{ type: 'text', text }] }, creds);
}

// Per explicit user request: the auto-login links this app replies with
// (bill/contract/maintenance/dashboard buttons on the tenant/owner/staff
// Rich Menus) used to show the raw long URL as plain chat text — the
// owner asked for that to be hidden behind a real tappable button
// instead, using LINE's "Buttons Template" message type (a single body
// text + one action button, rendered as a proper button in the chat
// bubble rather than a wall of URL text). Same short-lived signed link
// underneath — this only changes how it's PRESENTED, not the 5-minute
// expiry or any other security property. LINE constraints: template
// `text` caps at 160 chars, button `label` caps at 20 chars — callers
// should keep both short (they already are, these are one-line status
// messages).
async function replyLinkButton(replyToken, bodyText, buttonLabel, url, creds) {
  const message = {
    type: 'template',
    altText: bodyText, // shown in push notifications / chat list preview, where templates can't render
    template: {
      type: 'buttons',
      text: bodyText.slice(0, 160),
      actions: [{ type: 'uri', label: buttonLabel.slice(0, 20), uri: url }],
    },
  };
  return callLineApi('reply', { replyToken, messages: [message] }, creds);
}

// "ฝั่งเจ้าของเปลี่ยนรูปแบบลิงก์เป็นแบบนี้ให้หน่อยครับ" (2026-08-02) —
// เหมือน replyLinkButton ข้างบนเป๊ะ (ปุ่ม "uri" แบบเดียวกับปุ่มดูบิล/
// สัญญา/แจ้งซ่อมที่ tenant ใช้อยู่แล้ว) แค่ส่งแบบ push แทน reply — จำเป็น
// เพราะข้อความแจ้งสลิปใหม่/แจ้งเจ้าของเป็นการ "แจ้งเตือนเชิงรุก" (push)
// ไม่ใช่การตอบกลับข้อความที่เพิ่งได้รับ (ไม่มี replyToken ให้ใช้) —
// เดิมส่งเป็นข้อความ URL ดิบยาวๆ ปนกับข้อความ ดูรกและไม่เป็นมืออาชีพ
// เท่าปุ่มจริง
async function pushLinkButton(to, bodyText, buttonLabel, url, creds, category) {
  const message = {
    type: 'template',
    altText: bodyText,
    template: {
      type: 'buttons',
      text: bodyText.slice(0, 160),
      actions: [{ type: 'uri', label: buttonLabel.slice(0, 20), uri: url }],
    },
  };
  const result = await callLineApi('push', { to, messages: [message] }, creds);
  incrementLineQuotaCounter().catch(() => {});
  logLineSend(to, category).catch(() => {});
  return result;
}

// "กดปุ่ม ยืนยันที่หน้าไลน์เจ้าของเพื่อให้กดยืนยันเองได้เลย" (2026-07-26) —
// used for the "🔌 ยืนยันตัดไฟ" button on the cutoff-warning owner push
// (server/routes/scheduler.js). Uses a POSTBACK action (not `uri` like
// replyLinkButton above) so tapping it fires our own webhook instead of
// opening a URL — the postback handler (routes/line.js) is what actually
// calls sendCommand to cut power, only after this explicit tap. Same
// permanent-rule reasoning as everywhere else in this app: the owner must
// take a real, deliberate action for a cutoff to happen — this button IS
// that action, just reachable from LINE chat instead of requiring the web
// dashboard to be open. `displayText` is what shows in the chat history as
// if the owner had typed it themselves (LINE's own UX convention for
// postback buttons), so the confirmation is visible/auditable in-chat too.
// "เพิ่มเป็น 2 ปุ่มครับ ยืนยันกับ รอภายหลัง" (2026-08-10) — เดิมรับปุ่ม
// เดียว (buttonLabel/postbackData/displayText string เดี่ยวๆ) ตอนนี้รับ
// เป็น array ของปุ่ม `[{ label, data, displayText }, ...]` แทน (LINE's
// buttons template รองรับได้ถึง 4 ปุ่มอยู่แล้ว ไม่ต้องเปลี่ยนโครงสร้าง
// message) — เช็คจุดเรียกทั้งหมดในโปรเจกต์แล้วมีแค่ scheduler.js's cutoff-
// warning ที่เดียวที่ใช้ฟังก์ชันนี้ ปลอดภัยที่จะเปลี่ยน signature ตรงๆ
async function pushButtonMessage(to, bodyText, buttons, creds, category) {
  const message = {
    type: 'template',
    altText: bodyText,
    template: {
      type: 'buttons',
      text: bodyText.slice(0, 160),
      actions: buttons.map((b) => ({ type: 'postback', label: b.label.slice(0, 20), data: b.data, displayText: (b.displayText || b.label).slice(0, 300) })),
    },
  };
  const result = await callLineApi('push', { to, messages: [message] }, creds);
  incrementLineQuotaCounter().catch(() => {});
  logLineSend(to, category).catch(() => {});
  return result;
}

// imageUrl (optional): a publicly reachable HTTPS URL — LINE fetches the
// image from it directly, it cannot take inline/base64 image data.
async function pushMessage(to, text, imageUrl, creds, category) {
  const messages = [];
  if (text) messages.push({ type: 'text', text });
  if (imageUrl) messages.push({ type: 'image', originalContentUrl: imageUrl, previewImageUrl: imageUrl });
  if (!messages.length) throw new Error('ไม่มีข้อความหรือรูปภาพให้ส่ง');
  const result = await callLineApi('push', { to, messages }, creds);
  incrementLineQuotaCounter().catch(() => {});
  logLineSend(to, category).catch(() => {});
  return result;
}

// "ทุกครั้งที่ส่งใบเสร็จไป ให้แนบปุ่มยืนยันฝั่งผู้เช่าไปด้วยครับ เราจะได้
// รู้ว่าระบบส่งข้อความไปจริง" (2026-08-02) — เหมือน pushMessage ข้างบน
// เป๊ะ (text/image เป็น array เดียวกัน ประหยัดโควต้า ส่งครั้งเดียวจบ) แค่
// เพิ่ม buttons-template message ต่อท้ายเสมอ ถามให้ผู้เช่ากดยืนยันว่าได้
// รับแล้ว — postback data เก็บแค่ invoiceId (routes/line.js's postback
// handler อ่านคืนแล้วตั้ง receiptDeliveryConfirmed=true ให้)
async function pushMessageWithConfirmButton(to, text, imageUrl, invoiceId, creds, category) {
  const messages = [];
  if (text) messages.push({ type: 'text', text });
  if (imageUrl) messages.push({ type: 'image', originalContentUrl: imageUrl, previewImageUrl: imageUrl });
  messages.push({
    type: 'template',
    altText: 'กรุณายืนยันว่าได้รับใบแจ้งหนี้นี้แล้วครับ',
    template: {
      type: 'buttons',
      text: 'กรุณากดยืนยันว่าได้รับใบแจ้งหนี้นี้แล้วนะครับ',
      actions: [{ type: 'postback', label: '✅ ยืนยันได้รับแล้ว', data: `action=confirmReceipt&invoiceId=${invoiceId}`, displayText: 'ยืนยันได้รับใบแจ้งหนี้แล้วครับ' }],
    },
  });
  const result = await callLineApi('push', { to, messages }, creds);
  incrementLineQuotaCounter().catch(() => {});
  logLineSend(to, category || 'ใบแจ้งหนี้').catch(() => {});
  return result;
}

// Per explicit user request: a Dashboard card showing "how much of this
// month's free LINE message quota has been used" as a donut chart. LINE
// exposes this as two separate read-only GET endpoints (different from
// everything else in this file, which are all POSTs) — quota is the PLAN's
// monthly cap ({ type: 'limited', value } for a free/light plan, or
// { type: 'none' } for an unlimited paid plan), consumption is how many
// push+reply+multicast messages have actually gone out so far this month
// (LINE resets this counter itself on the 1st, nothing this app needs to
// track). Both are per-channel, so each building's own credentials show
// only THEIR OWN usage — never คุณต้น's or another customer's.
async function getMessageQuota(creds) {
  const c = resolveCreds(creds);
  const res = await fetch(`${LINE_API}/quota`, {
    headers: { Authorization: `Bearer ${c.accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LINE quota fetch failed (${res.status}): ${text}`);
  }
  return res.json(); // { type: 'limited'|'none', value? }
}

async function getMessageQuotaConsumption(creds) {
  const c = resolveCreds(creds);
  const res = await fetch(`${LINE_API}/quota/consumption`, {
    headers: { Authorization: `Bearer ${c.accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LINE quota consumption fetch failed (${res.status}): ${text}`);
  }
  return res.json(); // { totalUsage }
}

// Fetches the actual binary content of an image/video/audio message a user
// sent to the bot — LINE's webhook payload only carries a message id, the
// content itself lives on a separate "data" API (different host) and needs
// the same bearer token. Used for reading payment slip photos tenants send.
async function getMessageContent(messageId, creds) {
  const c = resolveCreds(creds);
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${c.accessToken}` },
  });
  if (!res.ok) throw new Error(`LINE content fetch failed (${res.status})`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// --- Rich Menu management ---
// Per explicit user request: a persistent, tappable image menu shown at
// the bottom of the LINE chat (see the "ทดสอบ เมนูฝั่งผู้เช่าก่อนครับ"
// conversation) — separate API family from the message-sending ones
// above, uses api.line.me/v2/bot/richmenu (+ api-data.line.me for the
// image itself). Every action here is tap-zone → postback data, so the
// webhook handler (see routes/line.js's postback event handling) always
// learns WHICH zone was tapped and WHO tapped it (event.source.userId),
// without needing LIFF or any browser-side auth at all.
const RICHMENU_API = 'https://api.line.me/v2/bot/richmenu';

async function callLineGetOrDelete(method, path, creds) {
  const c = resolveCreds(creds);
  const res = await fetch(`${RICHMENU_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${c.accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LINE richmenu ${method} ${path} failed (${res.status}): ${text}`);
  }
  return res.status === 204 ? null : res.json();
}

// richMenuObject: { size: {width,height}, selected, name, chatBarText, areas: [{bounds:{x,y,width,height}, action:{type:'postback', data, displayText}}] }
async function createRichMenu(richMenuObject, creds) {
  const c = resolveCreds(creds);
  const res = await fetch(RICHMENU_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.accessToken}` },
    body: JSON.stringify(richMenuObject),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LINE richmenu create failed (${res.status}): ${text}`);
  }
  return (await res.json()).richMenuId;
}

// imageBuffer must be PNG or JPEG, exact pixel size matching the richMenuObject's `size` used at creation (2500x1686 for a full menu).
async function uploadRichMenuImage(richMenuId, imageBuffer, contentType, creds) {
  const c = resolveCreds(creds);
  const res = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
    method: 'POST',
    headers: { 'Content-Type': contentType || 'image/png', Authorization: `Bearer ${c.accessToken}` },
    body: imageBuffer,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LINE richmenu image upload failed (${res.status}): ${text}`);
  }
}

// Sets this rich menu as the DEFAULT shown to every follower who doesn't
// have a per-user rich menu explicitly linked (see linkRichMenuToUser) —
// used as a fallback (e.g. before a tenant's own room-specific menu gets
// linked, or for anyone we haven't identified a role for at all).
async function setDefaultRichMenu(richMenuId, creds) {
  const c = resolveCreds(creds);
  const res = await fetch(`https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LINE richmenu set-default failed (${res.status}): ${text}`);
  }
}

// Links a specific rich menu to ONE LINE user — this is the actual
// mechanism behind "different menu per role" (owner/staff/tenant) even
// though everyone messages the same shared LINE OA: called right after a
// self-link succeeds (tenant types phone number, owner types PIN — see
// routes/line.js) so each person gets the menu matching their own role
// from that point on, overriding the default menu for just that user.
async function linkRichMenuToUser(userId, richMenuId, creds) {
  const c = resolveCreds(creds);
  const res = await fetch(`https://api.line.me/v2/bot/user/${userId}/richmenu/${richMenuId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LINE richmenu link-to-user failed (${res.status}): ${text}`);
  }
}

async function listRichMenus(creds) {
  return (await callLineGetOrDelete('GET', '/list', creds)).richmenus;
}

async function deleteRichMenu(richMenuId, creds) {
  await callLineGetOrDelete('DELETE', `/${richMenuId}`, creds);
}

module.exports = {
  isConfigured, verifySignature, replyMessage, replyLinkButton, pushLinkButton, pushMessage, pushMessageWithConfirmButton, pushButtonMessage, getMessageContent,
  getMessageQuota, getMessageQuotaConsumption,
  createRichMenu, uploadRichMenuImage, setDefaultRichMenu, linkRichMenuToUser, listRichMenus, deleteRichMenu,
};
