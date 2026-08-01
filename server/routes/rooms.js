const express = require('express');
const router = express.Router();
const { appendRow, updateRow, deleteRow, readTab } = require('../sheets');
const { coerceRooms, coerceInvoices } = require('../coerce');

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
    // "งั้นเขียนให้ค่าในสัญญามาบันทึกในส่วนนี้ เดี๋ยวผมไปกดแก้ไขและบันทึก
    // ใหม่ครับ มันจะได้เอาค่ามาเก็บไว้ส่วนนี้ของแต่ละห้อง" (2026-08-01) —
    // ตอนบันทึกสัญญาเช่า (contract form) แล้วมีการตั้ง/แก้ waterRate หรือ
    // elecRate ของห้อง ให้เขียนค่าเดียวกันนี้ลง waterRatetrue/elecRatetrue
    // ของ "ทุกใบแจ้งหนี้" ของห้องนั้น (ไม่ใช่แค่ใบล่าสุด) — คอลัมน์นี้
    // แทน "อัตราที่แท้จริงตามสัญญา" ของห้อง ไม่ใช่ค่าที่คำนวณย้อนกลับจาก
    // บิลแต่ละใบแบบ waterRate/elecRate (ดู
    // fix-invoice-rate-columns-minrate-aware.js's comment สำหรับปัญหาที่
    // ทำให้ต้องแยก 2 แนวคิดนี้ออกจากกัน — ค่าคำนวณย้อนกลับผิดได้ถ้าโดน
    // ค่าขั้นต่ำครอบ ส่วนค่านี้มาจากสัญญาโดยตรงเสมอ ไม่มีทางผิด)
    const hasWaterRate = Object.prototype.hasOwnProperty.call(req.body, 'waterRate');
    const hasElecRate = Object.prototype.hasOwnProperty.call(req.body, 'elecRate');
    if (hasWaterRate || hasElecRate) {
      const invoices = coerceInvoices(await readTab('Invoices')).filter((i) => i.room === req.params.id);
      const patch = {};
      if (hasWaterRate) patch.waterRatetrue = req.body.waterRate === '' || req.body.waterRate == null ? '' : Number(req.body.waterRate);
      if (hasElecRate) patch.elecRatetrue = req.body.elecRate === '' || req.body.elecRate == null ? '' : Number(req.body.elecRate);
      for (const inv of invoices) {
        try { await updateRow('Invoices', inv.id, patch); }
        catch (err) { console.error('cascade waterRatetrue/elecRatetrue failed for invoice', inv.id, err.message); }
      }
    }
    res.json(coerceRooms([merged])[0]);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try { await deleteRow('Rooms', req.params.id); res.json({ ok: true }); }
  catch (err) { next(err); }
});

module.exports = router;
