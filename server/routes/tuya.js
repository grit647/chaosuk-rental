const express = require('express');
const router = express.Router();
const { readTab, appendRow } = require('../sheets');
const { isConfigured, listDevices, getElecReading, sendCommand } = require('../tuya');

router.get('/health', async (req, res) => {
  if (!isConfigured()) return res.json({ connected: false });
  try {
    await listDevices(); // exercises the full auth + signing flow
    res.json({ connected: true });
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

router.get('/devices', async (req, res, next) => {
  try {
    if (!isConfigured()) return res.status(400).json({ error: 'ยังไม่ได้ตั้งค่า Tuya บนเซิร์ฟเวอร์ (server/.env)' });
    res.json(await listDevices());
  } catch (err) { next(err); }
});

router.get('/status', async (req, res, next) => {
  try {
    if (!isConfigured()) return res.status(400).json({ error: 'ยังไม่ได้ตั้งค่า Tuya บนเซิร์ฟเวอร์ (server/.env)' });
    const rooms = await readTab('Rooms');
    const linked = rooms.filter((r) => r.tuyaElecDeviceId);
    const entries = await Promise.all(linked.map(async (r) => {
      try {
        const reading = await getElecReading(r.tuyaElecDeviceId);
        return [r.id, { ...reading, online: true }];
      } catch (err) {
        return [r.id, { voltage: null, current: null, power: null, online: false, error: err.message }];
      }
    }));
    res.json(Object.fromEntries(entries));

    // Fire-and-forget historical log for future usage analysis — never let a
    // logging hiccup affect the response above, which has already been sent.
    entries.forEach(([roomId, reading]) => {
      if (reading.voltage == null) return; // device was offline/errored — nothing useful to log
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
    if (!isConfigured()) return res.status(400).json({ error: 'ยังไม่ได้ตั้งค่า Tuya บนเซิร์ฟเวอร์ (server/.env)' });
    const { roomId, on } = req.body;
    if (!roomId || typeof on !== 'boolean') return res.status(400).json({ error: 'ต้องระบุห้องและสถานะเปิด/ปิด' });
    const rooms = await readTab('Rooms');
    const room = rooms.find((r) => r.id === roomId);
    if (!room || !room.tuyaElecDeviceId) return res.status(400).json({ error: `ห้อง ${roomId} ยังไม่ได้เชื่อมต่ออุปกรณ์ไฟฟ้า` });
    await sendCommand(room.tuyaElecDeviceId, 'switch', on);
    const reading = await getElecReading(room.tuyaElecDeviceId);
    res.json({ ok: true, ...reading });
  } catch (err) { next(err); }
});

module.exports = router;
