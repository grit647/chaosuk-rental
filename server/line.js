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

// imageUrl (optional): a publicly reachable HTTPS URL — LINE fetches the
// image from it directly, it cannot take inline/base64 image data.
async function pushMessage(to, text, imageUrl, creds) {
  const messages = [];
  if (text) messages.push({ type: 'text', text });
  if (imageUrl) messages.push({ type: 'image', originalContentUrl: imageUrl, previewImageUrl: imageUrl });
  if (!messages.length) throw new Error('ไม่มีข้อความหรือรูปภาพให้ส่ง');
  return callLineApi('push', { to, messages }, creds);
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

module.exports = { isConfigured, verifySignature, replyMessage, pushMessage, getMessageContent };
