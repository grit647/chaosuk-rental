const crypto = require('crypto');

const LINE_API = 'https://api.line.me/v2/bot/message';

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
async function pushButtonMessage(to, bodyText, buttonLabel, postbackData, displayText, creds) {
  const message = {
    type: 'template',
    altText: bodyText,
    template: {
      type: 'buttons',
      text: bodyText.slice(0, 160),
      actions: [{ type: 'postback', label: buttonLabel.slice(0, 20), data: postbackData, displayText: (displayText || buttonLabel).slice(0, 300) }],
    },
  };
  return callLineApi('push', { to, messages: [message] }, creds);
}

// imageUrl (optional): a publicly reachable HTTPS URL — LINE fetches the
// image from it directly, it cannot take inline/base64 image data.
async function pushMessage(to, text, imageUrl, creds) {
  const messages = [];
  if (text) messages.push({ type: 'text', text });
  if (imageUrl) messages.push({ type: 'image', originalContentUrl: imageUrl, previewImageUrl: imageUrl });
  if (!messages.length) throw new Error('ไม่มีข้อความหรือรูปภาพให้ส่ง');
  return callLineApi('push', { to, messages }, creds);
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
  isConfigured, verifySignature, replyMessage, replyLinkButton, pushMessage, pushButtonMessage, getMessageContent,
  getMessageQuota, getMessageQuotaConsumption,
  createRichMenu, uploadRichMenuImage, setDefaultRichMenu, linkRichMenuToUser, listRichMenus, deleteRichMenu,
};
