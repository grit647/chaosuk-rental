const express = require('express');
const router = express.Router();
const { appendRow, updateRow, deleteRow, readTab } = require('../sheets');
const { coerceRooms } = require('../coerce');

router.get('/', async (req, res, next) => {
  try { res.json(coerceRooms(await readTab('Rooms'))); }
  catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const b = req.body;
    const id = String(b.id || '').trim();
    if (!id) return res.status(400).json({ error: 'กรุณากรอกเลขห้อง' });
    const existing = await readTab('Rooms');
    if (existing.some((r) => r.id === id)) return res.status(409).json({ error: 'มีห้อง ' + id + ' อยู่แล้ว' });
    const rent = Number(b.rent) || 0;
    const room = {
      id,
      floor: Number(b.floor) || 1,
      status: 'vacant',
      tenant: '',
      phone: '',
      rent,
      moveIn: '',
      contractEnd: '',
      // 2026-07-24 — was `|| rent * 2` (auto-calc 2x rent when no deposit
      // given). Owner asked to change this default to 0 while the contract
      // form's own deposit input field is still hidden/broken (see the
      // "ค่ามัดจำห้อง input" bug notes in CLAUDE.md) — no auto-calculated
      // value gets silently baked in anymore; deposit only ever holds
      // whatever was explicitly passed in, defaulting to 0 otherwise.
      deposit: Number(b.deposit) || 0,
      waterMeterNo: 'W-' + id,
      elecMeterNo: 'E-' + id,
      waterPrev: 0,
      waterCurr: '0',
      elecPrev: 0,
      elecCurr: '0',
      wifiUsername: '',
      wifiPassword: '',
      dueDay: '',
      tenantIdImg: '',
      tenantIdExpiry: '',
      leaseDocName: '',
    };
    await appendRow('Rooms', room);
    res.json(room);
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const merged = await updateRow('Rooms', req.params.id, req.body);
    res.json(coerceRooms([merged])[0]);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try { await deleteRow('Rooms', req.params.id); res.json({ ok: true }); }
  catch (err) { next(err); }
});

module.exports = router;
