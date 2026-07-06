const express = require('express');
const router = express.Router();
const { readTab } = require('../sheets');
const { isConfigured, listDevices, getElecReading } = require('../tuya');

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
  } catch (err) { next(err); }
});

module.exports = router;
