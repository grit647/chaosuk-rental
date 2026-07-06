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

async function pushMessage(to, text) {
  return callLineApi('push', { to, messages: [{ type: 'text', text }] });
}

module.exports = { isConfigured, verifySignature, replyMessage, pushMessage };
