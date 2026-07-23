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

// Returns live readings for a Tuya water flowmeter (e.g. "Bluetooth
// Flowmeter" battery-powered/BLE-gateway devices) — cumulative usage
// (liters), current flow rate, and battery level. Confirmed against a
// real device (category "slj"): the DP named "voltage_current" is
// actually the BATTERY PERCENTAGE (0-100%) for this device family —
// misleading DP name (Tuya's own generic naming), NOT actual voltage;
// verified via the device's own spec response (unit "%", range 0-100).
//
// **Real bug found + fixed (2026-07-23):** this device family's own
// `/specifications` response LIES about the scale for `water_use_data`/
// `water_once` — it reports `scale: 0` (i.e. divide by 1), but the raw
// values are actually in units of 0.1 L, not 1 L. Confirmed directly:
// the app's own "Single Use" readout showed 5.2 L for the exact same
// moment our raw `water_once` value was 52 (52 ÷ 10 = 5.2, not 52 ÷ 1 =
// 52). Hardcoding scale=10 for these two codes instead of trusting
// `findScale()`'s spec-derived value, which is safe for the general
// case (`cur_voltage`/`cur_current`/etc. in getElecReading above still
// use the spec-derived scale as before — only this water device family
// is known-wrong).
//
// **Known limitation, not fixed here:** `water_use_data` (meant to be
// the lifetime cumulative total, same role as the elec meter's
// `energy`) never actually updates on this device family — it stayed
// stuck at 0 with zero report-log entries over a 24h window, while the
// physical app's own "Total Use" (932.5 L) is clearly a real,
// continuously-growing number the app computes server-side from
// summing individual `water_once` session events, not from reading
// this DP. Reconstructing an exact match to that lifetime total from
// our side isn't reliable (Tuya's own accounting isn't fully exposed
// via this API). For billing, the app should track its own running
// total going forward (log every `water_once` session peak over time,
// same pattern as `ElectricityLog`) rather than trusting this `usage`
// field as a cumulative meter reading — do NOT wire `usage` from this
// function directly into invoice "baseline reading" math without that
// follow-up; flagged in CLAUDE.md.
async function getWaterReading(deviceId, creds) {
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
  return {
    // Cumulative liters used — see the big comment above: this DP is
    // effectively dead on this device family (never updates), kept
    // here as best-effort in case a future firmware/device does report
    // it, but NOT to be trusted as the real cumulative total.
    usage: map.water_use_data !== undefined ? Number(map.water_use_data) / 10 : null,
    // "ปริมาณการใช้น้ำครั้งล่าสุด" (single-use session amount) — the DP
    // that actually updates in real time. Hardcoded ÷10 (see comment
    // above), NOT the spec-reported scale.
    singleUse: map.water_once !== undefined ? Number(map.water_once) / 10 : null,
    flowRate: pick('flow_velocity', 1),
    // Battery percentage — despite the DP's confusing "voltage_current"
    // name, its actual meaning (per this device's own spec) is 0-100%.
    batteryPercent: pick('voltage_current', 1),
  };
}

// Sends a control command to the device. `code` is the DP code (e.g. 'switch'
// for the breaker's relay on/off), `value` is whatever type that DP expects.
async function sendCommand(deviceId, code, value, creds) {
  return tuyaRequest('POST', `/v1.0/devices/${deviceId}/commands`, {
    commands: [{ code, value }],
  }, creds);
}

// Tuya requires query-string params to be sorted alphabetically by key when
// building the signature (undocumented in the quick-start guide, found by
// trial and error 2026-07-23 — every existing caller of tuyaRequest above
// only ever used 0-1 query params so this never mattered before).
async function tuyaRequestSortedQuery(path, params, creds) {
  const keys = Object.keys(params).sort();
  const qs = keys.map((k) => `${k}=${encodeURIComponent(params[k])}`).join('&');
  return tuyaRequest('GET', qs ? `${path}?${qs}` : path, null, creds);
}

// "ปริมาณน้ำสะสมจริง" (2026-07-23) — see the big comment on getWaterReading:
// this device family's own `water_use_data` cumulative-total DP never
// actually updates (confirmed: zero report-log entries over 24h, stuck at
// 0), while the physical app's own "Total Use" is a real, continuously
// growing number computed server-side from summing individual `water_once`
// "single-use session" events. We can't retroactively reconstruct Tuya's
// own lifetime total, but we CAN build our own going forward by replaying
// the `water_once` event history via the Report Logs API and detecting
// completed sessions (a session's raw peak value = whatever it was right
// before the next log entry drops to a lower value, indicating a reset for
// a new session) — the exact technique validated by hand before building
// this: summing session peaks from real device history reconstructed a
// number in the right ballpark of the app's own Total Use.
//
// `sinceEventTimeMs` — only process events strictly after this watermark
// (pass 0 to process everything available, e.g. first-ever poll for a
// device). Returns { deltaLiters, lastProcessedEventTimeMs } — the caller
// (routes/tuya.js) is responsible for persisting lastProcessedEventTimeMs
// per room (so the NEXT poll only asks for what's new) and adding
// deltaLiters onto its own running cumulative total. Deliberately does
// NOT count a session that hasn't been confirmed complete yet (no reset
// seen after it within the fetched window) — its events are simply left
// unprocessed (lastProcessedEventTimeMs stops right before them), so the
// next poll re-fetches and can detect its true completion once a reset
// finally shows up in a later log entry.
async function getWaterUsageDeltaLiters(deviceId, sinceEventTimeMs, creds) {
  const startTime = sinceEventTimeMs || (Date.now() - 30 * 24 * 60 * 60 * 1000); // first poll: look back 30 days max
  const endTime = Date.now();
  let allLogs = [];
  let lastRowKey;
  // Tuya paginates report-logs at up to 100 rows/page — cap at 20 pages
  // (2000 events) per poll to bound worst-case request time; a device that
  // genuinely produces more than 2000 single-use events between 15-min
  // polls would need a shorter poll interval, not deeper pagination here.
  for (let i = 0; i < 20; i++) {
    const params = { codes: 'water_once', start_time: startTime, end_time: endTime, size: 100 };
    if (lastRowKey) params.last_row_key = lastRowKey;
    const result = await tuyaRequestSortedQuery(`/v2.0/cloud/thing/${deviceId}/report-logs`, params, creds);
    const logs = (result && result.logs) || [];
    allLogs = allLogs.concat(logs);
    if (!result || !result.has_more) break;
    lastRowKey = result.last_row_key;
  }
  // Only events strictly after the watermark, oldest first.
  const fresh = allLogs
    .filter((l) => l.event_time > sinceEventTimeMs)
    .sort((a, b) => a.event_time - b.event_time);
  if (!fresh.length) return { deltaLiters: 0, lastProcessedEventTimeMs: sinceEventTimeMs };

  let deltaRaw = 0;
  let lastProcessedEventTimeMs = sinceEventTimeMs;
  for (let i = 0; i < fresh.length; i++) {
    const cur = Number(fresh[i].value);
    const nextVal = i + 1 < fresh.length ? Number(fresh[i + 1].value) : null;
    if (nextVal !== null && nextVal < cur) {
      // Confirmed session end — this was the session's peak.
      deltaRaw += cur;
      lastProcessedEventTimeMs = fresh[i].event_time;
    }
    // else: either mid-session (next value is higher, not a peak yet) or
    // the very last fetched event with no confirmation of a reset after it
    // — leave unprocessed, watermark stays before it, next poll re-checks.
  }
  return { deltaLiters: deltaRaw / 10, lastProcessedEventTimeMs };
}

module.exports = { isConfigured, listDevices, getDeviceStatus, getDeviceSpec, getElecReading, getWaterReading, getWaterUsageDeltaLiters, sendCommand };
