// Per explicit user request: session/login support for the multi-tenant
// prototype. No new npm dependency — a signed cookie using Node's built-in
// crypto (HMAC-SHA256) is enough for this scale, avoids pulling in a JWT
// library or session store just for a handful of fields.
//
// The cookie payload is NOT encrypted, only signed — anyone can read what's
// in it (role/customerSheetId/roomId/staffId), but can't forge or tamper
// with it without knowing SESSION_SECRET (server-side only, never sent to
// the browser). That's an acceptable trade-off here since none of those
// fields are secret by themselves; what matters is the server trusting the
// COOKIE'S INTEGRITY (that a tenant couldn't edit their own cookie to claim
// customerSheetId belongs to a different building).
const crypto = require('crypto');

const COOKIE_NAME = 'chaosuk_session';
const SECRET = process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-in-render-env';

function sign(payloadObj) {
  const json = JSON.stringify(payloadObj);
  const b64 = Buffer.from(json).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

function verify(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [b64, sig] = token.split('.');
  const expectedSig = crypto.createHmac('sha256', SECRET).update(b64).digest('base64url');
  // Constant-time comparison — avoids a timing-attack side channel on the
  // signature check (a real, if narrow, concern for anything auth-related).
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')); }
  catch { return null; }
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

function getSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  return verify(cookies[COOKIE_NAME]);
}

function setSessionCookie(res, session) {
  const token = sign(session);
  // httpOnly (JS on the page can't read/steal it), Secure (HTTPS only — fine,
  // both local dev over plain http AND Render's https work since browsers
  // only enforce Secure over actual https connections, and Render always
  // terminates https), SameSite=Lax (sent on normal navigation, blocks most
  // cross-site request forgery vectors).
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
}

// sign/verify exported too — reused by server/routes/line.js for the
// short-lived LINE Rich Menu "auto-login" tokens (a rich menu tap fires a
// postback webhook event, not a normal browser request, so it can't carry
// a session cookie — a signed, expiring token embedded in a reply link
// stands in for one instead). Same HMAC-signed base64url scheme as the
// session cookie itself, just with a different payload shape and a short
// expiry baked into the payload by the caller.
module.exports = { getSession, setSessionCookie, clearSessionCookie, sign, verify };
