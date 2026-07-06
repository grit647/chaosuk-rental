const crypto = require('crypto');

const BASE = process.env.TUYA_API_BASE || 'https://openapi.tuyaus.com';
const CLIENT_ID = process.env.TUYA_ACCESS_ID;
const CLIENT_SECRET = process.env.TUYA_ACCESS_SECRET;

function isConfigured() {
  return !!(CLIENT_ID && CLIENT_SECRET && BASE);
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

let tokenCache = { token: null, expiresAt: 0 };

async function getAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const t = Date.now().toString();
  const url = '/v1.0/token?grant_type=1';
  const stringToSign = buildStringToSign('GET', '', url);
  const sign = hmacSha256Hex(CLIENT_ID + t + stringToSign, CLIENT_SECRET);
  const res = await fetch(BASE + url, {
    method: 'GET',
    headers: { client_id: CLIENT_ID, sign, t, sign_method: 'HMAC-SHA256' },
  });
  const data = await res.json();
  if (!data.success) throw new Error('Tuya token error: ' + (data.msg || JSON.stringify(data)));
  tokenCache = {
    token: data.result.access_token,
    expiresAt: Date.now() + (data.result.expire_time - 60) * 1000, // refresh a minute early
  };
  return tokenCache.token;
}

async function tuyaRequest(method, path, body) {
  const accessToken = await getAccessToken();
  const t = Date.now().toString();
  const bodyStr = body ? JSON.stringify(body) : '';
  const stringToSign = buildStringToSign(method, bodyStr, path);
  const sign = hmacSha256Hex(CLIENT_ID + accessToken + t + stringToSign, CLIENT_SECRET);
  const res = await fetch(BASE + path, {
    method,
    headers: {
      client_id: CLIENT_ID,
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

async function listDevices() {
  // Project-level device list — works because the Smart Life/Tuya Smart app
  // account has been linked to this Cloud Project (Devices > Link Tuya App Account).
  const result = await tuyaRequest('GET', '/v1.3/iot-03/devices?page_size=100');
  const list = (result && result.list) || [];
  return list.map((d) => ({ id: d.id, name: d.name, online: !!d.online, productName: d.product_name }));
}

async function getDeviceStatus(deviceId) {
  const result = await tuyaRequest('GET', `/v1.0/devices/${deviceId}/status`);
  return result || [];
}

const specCache = new Map();
async function getDeviceSpec(deviceId) {
  if (specCache.has(deviceId)) return specCache.get(deviceId);
  const result = await tuyaRequest('GET', `/v1.0/devices/${deviceId}/specifications`);
  specCache.set(deviceId, result);
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
async function getElecReading(deviceId) {
  const [status, spec] = await Promise.all([
    getDeviceStatus(deviceId),
    getDeviceSpec(deviceId).catch(() => null),
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
async function sendCommand(deviceId, code, value) {
  return tuyaRequest('POST', `/v1.0/devices/${deviceId}/commands`, {
    commands: [{ code, value }],
  });
}

module.exports = { isConfigured, listDevices, getDeviceStatus, getDeviceSpec, getElecReading, sendCommand };
