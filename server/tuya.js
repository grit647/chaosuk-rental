const crypto = require('crypto');

// Per explicit user request: Tuya credentials can now come from either the
// shared server/.env values (คุณต้น's current setup, unchanged) OR a
// per-customer override stored in that customer's own Settings sheet (see
// server/routes/settings.js's tuyaCredentials handling + the new
// gear-icon UI). Every exported function below takes an OPTIONAL trailing
// `creds` param `{ accessId, accessSecret, apiBase }` — when omitted,
// falls back to process.env exactly as before.
function resolveCreds(creds) {
  return {
    clientId: (creds && creds.accessId) || process.env.TUYA_ACCESS_ID,
    clientSecret: (creds && creds.accessSecret) || process.env.TUYA_ACCESS_SECRET,
    base: (creds && creds.apiBase) || process.env.TUYA_API_BASE || 'https://openapi.tuyaus.com',
  };
}

function isConfigured(creds) {
  const c = resolveCreds(creds);
  return !!(c.clientId && c.clientSecret && c.base);
}

function sha256Hex(str) {
  return crypto.createHash('sha256').update(str || '', 'utf8').digest('hex');
}

function hmacSha256Hex(str, secret) {
  return crypto.createHmac('sha256', secret).update(str, 'utf8').digest('hex').toUpperCase();
}

// Tuya's signing scheme: sign = HMAC-SHA256(client_id [+ access_token] + t + stringToSign, secret)
// stringToSign = METHOD + "\n" + sha256(body) + "\n" + "" (headers, unused here) + "\n" + url(path+query)
function buildStringToSign(method, body, url) {
  const bodyHash = sha256Hex(body || '');
  return `${method}\n${bodyHash}\n\n${url}`;
}

// Keyed by clientId — different customers have different Tuya Cloud
// Projects, each with its own access token (and, separately below, its own
// device-spec cache). A shared single-slot cache (the old design) would
// have silently served one customer's token to another's requests.
const tokenCacheByClient = new Map();

async function getAccessToken(creds) {
  const { clientId, clientSecret, base } = resolveCreds(creds);
  const cached = tokenCacheByClient.get(clientId);
  if (cached && Date.now() < cached.expiresAt) return cached.token;
  const t = Date.now().toString();
  const url = '/v1.0/token?grant_type=1';
  const stringToSign = buildStringToSign('GET', '', url);
  const sign = hmacSha256Hex(clientId + t + stringToSign, clientSecret);
  const res = await fetch(base + url, {
    method: 'GET',
    headers: { client_id: clientId, sign, t, sign_method: 'HMAC-SHA256' },
  });
  const data = await res.json();
  if (!data.success) throw new Error('Tuya token error: ' + (data.msg || JSON.stringify(data)));
  const entry = {
    token: data.result.access_token,
    expiresAt: Date.now() + (data.result.expire_time - 60) * 1000, // refresh a minute early
  };
  tokenCacheByClient.set(clientId, entry);
  return entry.token;
}

async function tuyaRequest(method, path, body, creds) {
  const { clientId, clientSecret, base } = resolveCreds(creds);
  const accessToken = await getAccessToken(creds);
  const t = Date.now().toString();
  const bodyStr = body ? JSON.stringify(body) : '';
  const stringToSign = buildStringToSign(method, bodyStr, path);
  const sign = hmacSha256Hex(clientId + accessToken + t + stringToSign, clientSecret);
  const res = await fetch(base + path, {
    method,
    headers: {
      client_id: clientId,
      access_token: accessToken,
      sign,
      t,
      sign_method: 'HMAC-SHA256',
      'Content-Type': 'application/json',
    },
    body: bodyStr || undefined,
  });
  const data = await res.json();
  if (!data.success) throw new Error(`Tuya API ${path} failed: ` + (data.msg || JSON.stringify(data)));
  return data.result;
}

async function listDevices(creds) {
  // Project-level device list — works because the Smart Life/Tuya Smart app
  // account has been linked to this Cloud Project (Devices > Link Tuya App Account).
  const result = await tuyaRequest('GET', '/v1.3/iot-03/devices?page_size=100', null, creds);
  const list = (result && result.list) || [];
  return list.map((d) => ({ id: d.id, name: d.name, online: !!d.online, productName: d.product_name }));
}

async function getDeviceStatus(deviceId, creds) {
  const result = await tuyaRequest('GET', `/v1.0/devices/${deviceId}/status`, null, creds);
  return result || [];
}

// Keyed by "clientId:deviceId" — same per-customer isolation reasoning as
// the token cache above (a device's spec doesn't change, but different
// customers' projects could theoretically reuse the same deviceId
// numbering scheme in principle, so keep them namespaced to be safe).
const specCache = new Map();
async function getDeviceSpec(deviceId, creds) {
  const cacheKey = `${(creds && creds.accessId) || process.env.TUYA_ACCESS_ID}:${deviceId}`;
  if (specCache.has(cacheKey)) return specCache.get(cacheKey);
  const result = await tuyaRequest('GET', `/v1.0/devices/${deviceId}/specifications`, null, creds);
  specCache.set(cacheKey, result);
  return result;
}

function findScale(spec, code) {
  try {
    const fields = [...((spec && spec.functions) || []), ...((spec && spec.status) || [])];
    const fn = fields.find((f) => f.code === code);
    if (!fn || !fn.values) return 1;
    const values = typeof fn.values === 'string' ? JSON.parse(fn.values) : fn.values;
    if (values && typeof values.scale === 'number') return Math.pow(10, values.scale);
  } catch { /* fall through to default scale */ }
  return 1;
}

// Some device categories (e.g. "dlq" smart circuit breakers/RCBOs with
// built-in metering) don't expose cur_voltage/cur_current/cur_power as
// separate DPs — instead they pack all three into a single base64 "raw" DP
// per phase (phase_a/phase_b/phase_c): 2 bytes voltage (÷10 for V), 3 bytes
// current (÷1000 for A), 3 bytes power in whole watts (no scaling), all
// big-endian. Verified against a real device's own LCD readout (voltage and
// current matched; power's ÷10 guess was wrong — the raw value is already W).
function decodePhaseRaw(base64Value) {
  if (!base64Value) return null;
  try {
    const buf = Buffer.from(base64Value, 'base64');
    if (buf.length < 8) return null;
    return {
      voltage: buf.readUInt16BE(0) / 10,
      current: buf.readUIntBE(2, 3) / 1000,
      power: buf.readUIntBE(5, 3),
    };
  } catch { return null; }
}

// Returns live voltage (V), current (A), power (W) for a device. Tries the
// simple-plug-style separate DP codes first (using the device's own DP
// schema scale factor when available), then falls back to decoding the
// packed phase_a raw DP used by circuit-breaker/RCBO-style meters.
async function getElecReading(deviceId, creds) {
  const [status, spec] = await Promise.all([
    getDeviceStatus(deviceId, creds),
    getDeviceSpec(deviceId, creds).catch(() => null),
  ]);
  const map = {};
  status.forEach((s) => { map[s.code] = s.value; });
  const pick = (code, fallbackScale) => {
    if (map[code] === undefined) return null;
    const scale = spec ? findScale(spec, code) : fallbackScale;
    return Number(map[code]) / scale;
  };
  // Cumulative energy ("หน่วย" / kWh) used for billing — separate from the
  // instantaneous V/A/W above. Different device families expose this under
  // different DP codes; try the common ones in order.
  const energy = pick('total_forward_energy', 100) ?? pick('add_ele', 100) ?? pick('cur_energy', 100);
  // Relay/breaker on-off state — used by the "จ่ายไฟ/ตัดไฟ" control button.
  const switchOn = typeof map.switch === 'boolean' ? map.switch : null;

  const direct = {
    voltage: pick('cur_voltage', 10),
    current: pick('cur_current', 1000),
    power: pick('cur_power', 10),
  };
  if (direct.voltage != null || direct.current != null || direct.power != null) {
    return { ...direct, energy, switchOn };
  }

  const phase = decodePhaseRaw(map.phase_a);
  if (phase) return { ...phase, energy, switchOn };

  return { voltage: null, current: null, power: null, energy, switchOn };
}

// Sends a control command to the device. `code` is the DP code (e.g. 'switch'
// for the breaker's relay on/off), `value` is whatever type that DP expects.
async function sendCommand(deviceId, code, value, creds) {
  return tuyaRequest('POST', `/v1.0/devices/${deviceId}/commands`, {
    commands: [{ code, value }],
  }, creds);
}

module.exports = { isConfigured, listDevices, getDeviceStatus, getDeviceSpec, getElecReading, sendCommand };
