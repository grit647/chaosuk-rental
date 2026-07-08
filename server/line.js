const crypto = require('crypto');

const LINE_API = 'https://api.line.me/v2/bot/message';

function isConfigured() {
  return !!(process.env.LINE_CHANNEL_ACCESS_TOKEN && process.env.LINE_CHANNEL_SECRET);
}

function verifySignature(rawBody, signature) {
  if (!process.env.LINE_CHANNEL_SECRET || !signature) return false;
  const hmac = crypto.createHmac('sha256', process.env.LINE_CHANNEL_SECRET);
  hmac.update(rawBody);
  const expected = hmac.digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

async function callLineApi(path, body) {
  const res = await fetch(`${LINE_API}/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LINE API ${path} failed (${res.status}): ${text}`);
  }
  return res;
}

async function replyMessage(replyToken, text) {
  return callLineApi('reply', { replyToken, messages: [{ type: 'text', text }] });
}

// imageUrl (optional): a publicly reachable HTTPS URL — LINE fetches the
// image from it directly, it cannot take inline/base64 image data.
async function pushMessage(to, text, imageUrl) {
  const messages = [];
  if (text) messages.push({ type: 'text', text });
  if (imageUrl) messages.push({ type: 'image', originalContentUrl: imageUrl, previewImageUrl: imageUrl });
  if (!messages.length) throw new Error('ไม่มีข้อความหรือรูปภาพให้ส่ง');
  return callLineApi('push', { to, messages });
}

// Fetches the actual binary content of an image/video/audio message a user
// sent to the bot — LINE's webhook payload only carries a message id, the
// content itself lives on a separate "data" API (different host) and needs
// the same bearer token. Used for reading payment slip photos tenants send.
async function getMessageContent(messageId) {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
  });
  if (!res.ok) throw new Error(`LINE content fetch failed (${res.status})`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

module.exports = { isConfigured, verifySignature, replyMessage, pushMessage, getMessageContent };
