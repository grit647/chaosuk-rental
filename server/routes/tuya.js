const express = require('express');
const router = express.Router();
const { readTab, appendRow } = require('../sheets');
const { isConfigured, listDevices, getElecReading, getWaterReading, sendCommand } = require('../tuya');
const { readIntegrationCredentials } = require('../coerce');

// ElectricityLog was writing a row on EVERY /status call — every 5-minute
// auto-refresh tick from the frontend, plus every manual "รีเฟรช" click,
// plus once per open browser tab if more than one — which piled up far more
// often than once an hour (a real user report after seeing near-duplicate
// rows minutes apart in the Sheet). Per explicit request, throttle logging
// to at most once per hour per room. Kept in-memory (not persisted) since
// this only needs to survive within a single server process; a restart
// just means the next status poll logs immediately, which is harmless.
const lastLoggedAt = new Map();
const LOG_INTERVAL_MS = 60 * 60 * 1000;

// Real bug a customer hit: a brand-new multi-tenant customer with no Tuya
// credentials of their own was shown "เชื่อมต่อแล้ว" and could have pulled
// live device data — because tuya.js's resolveCreds() falls back to the
// SHARED server/.env values (คุณต้น's own Tuya Cloud project) whenever no
// override is given, which is correct for คุณต้น's own no-login usage but
// wrong once someone is logged in via the multi-tenant system: it would
// silently show/act on someone ELSE's real devices under this customer's
// login. Once a session has its own customerSheetId, only THIS customer's
// own saved credentials count — no falling back to the shared server ones.
function isConfiguredForRequest(req, tuyaCreds) {
  const sessionScoped = !!(req.session && req.session.customerSheetId);
  if (sessionScoped) return !!tuyaCreds && isConfigured(tuyaCreds);
  return isConfigured(tuyaCreds);
}

router.get('/health', async (req, res) => {
  const creds = await readIntegrationCredentials();
  if (!isConfiguredForRequest(req, creds.tuya)) return res.json({ connected: false });
  try {
    await listDevices(creds.tuya); // exercises the full auth + signing flow
    res.json({ connected: true });
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

router.get('/devices', async (req, res, next) => {
  try {
    const creds = await readIntegrationCredentials();
    if (!isConfiguredForRequest(req, creds.tuya)) return res.status(400).json({ error: 'ยังไม่ได้ตั้งค่า Tuya (ใส่ Access ID/Secret ที่หน้าตั้งค่า หรือฝั่งเซิร์ฟเวอร์)' });
    res.json(await listDevices(creds.tuya));
  } catch (err) { next(err); }
});

router.get('/status', async (req, res, next) => {
  try {
    const creds = await readIntegrationCredentials();
    if (!isConfiguredForRequest(req, creds.tuya)) return res.status(400).json({ error: 'ยังไม่ได้ตั้งค่า Tuya (ใส่ Access ID/Secret ที่หน้าตั้งค่า หรือฝั่งเซิร์ฟเวอร์)' });
    const rooms = await readTab('Rooms');
    const linked = rooms.filter((r) => r.tuyaElecDeviceId);
    const entries = await Promise.all(linked.map(async (r) => {
      try {
        const reading = await getElecReading(r.tuyaElecDeviceId, creds.tuya);
        return [r.id, { ...reading, online: true }];
      } catch (err) {
        return [r.id, { voltage: null, current: null, power: null, online: false, error: err.message }];
      }
    }));
    const resultMap = Object.fromEntries(entries);

    // Per explicit user request: same live-reading treatment for water
    // flowmeters (battery-powered, BLE-gateway devices) — cumulative
    // usage + flow rate + battery %. Merged into the SAME per-room
    // object as the electricity reading above (a room can have either,
    // both, or neither device linked) rather than a separate response
    // shape, so the frontend only has to read one place per room.
    const waterLinked = rooms.filter((r) => r.tuyaWaterDeviceId);
    await Promise.all(waterLinked.map(async (r) => {
      try {
        const waterReading = await getWaterReading(r.tuyaWaterDeviceId, creds.tuya);
        resultMap[r.id] = { ...(resultMap[r.id] || {}), ...waterReading, waterOnline: true };
      } catch (err) {
        resultMap[r.id] = { ...(resultMap[r.id] || {}), waterOnline: false, waterError: err.message };
      }
    }));

    res.json(resultMap);

    // Fire-and-forget historical log for future usage analysis — never let a
    // logging hiccup affect the response above, which has already been sent.
    // Throttled to once per hour per room (see LOG_INTERVAL_MS above).
    const now = Date.now();
    entries.forEach(([roomId, reading]) => {
      if (reading.voltage == null) return; // device was offline/errored — nothing useful to log
      const last = lastLoggedAt.get(roomId) || 0;
      if (now - last < LOG_INTERVAL_MS) return;
      lastLoggedAt.set(roomId, now);
      appendRow('ElectricityLog', {
        id: Date.now() + '-' + roomId,
        timestamp: new Date().toISOString(),
        room: roomId,
        voltage: reading.voltage,
        current: reading.current,
        power: reading.power,
        energy: reading.energy,
      }).catch((err) => console.error('[tuya] ElectricityLog append failed:', err.message));
    });
  } catch (err) { next(err); }
});

router.post('/switch', async (req, res, next) => {
  try {
    const creds = await readIntegrationCredentials();
    if (!isConfiguredForRequest(req, creds.tuya)) return res.status(400).json({ error: 'ยังไม่ได้ตั้งค่า Tuya (ใส่ Access ID/Secret ที่หน้าตั้งค่า หรือฝั่งเซิร์ฟเวอร์)' });
    const { roomId, on } = req.body;
    if (!roomId || typeof on !== 'boolean') return res.status(400).json({ error: 'ต้องระบุห้องและสถานะเปิด/ปิด' });
    const rooms = await readTab('Rooms');
    const room = rooms.find((r) => r.id === roomId);
    if (!room || !room.tuyaElecDeviceId) return res.status(400).json({ error: `ห้อง ${roomId} ยังไม่ได้เชื่อมต่ออุปกรณ์ไฟฟ้า` });
    await sendCommand(room.tuyaElecDeviceId, 'switch', on, creds.tuya);
    const reading = await getElecReading(room.tuyaElecDeviceId, creds.tuya);
    res.json({ ok: true, ...reading });
  } catch (err) { next(err); }
});

module.exports = router;
