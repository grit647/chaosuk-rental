const express = require('express');
const router = express.Router();
const { appendRow, updateRow, deleteRow, readTab } = require('../sheets');
const { coerceStaff } = require('../coerce');

router.get('/', async (req, res, next) => {
  try { res.json(coerceStaff(await readTab('Staff'))); }
  catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const b = req.body;
    if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'กรุณากรอกชื่อพนักงาน' });
    if (!b.position || !String(b.position).trim()) return res.status(400).json({ error: 'กรุณาเลือกตำแหน่ง' });
    const staff = {
      id: Date.now(),
      name: b.name,
      position: b.position,
      salary: Number(b.salary) || 0,
      workStart: b.workStart || '',
      workEnd: b.workEnd || '',
      workDays: b.workDays || '',
      startDate: b.startDate || '',
      endDate: b.endDate || '',
      phone: b.phone || '',
      status: b.status || 'active',
      notes: b.notes || '',
    };
    await appendRow('Staff', staff);
    res.json(staff);
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const merged = await updateRow('Staff', req.params.id, req.body);
    res.json(coerceStaff([merged])[0]);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try { await deleteRow('Staff', req.params.id); res.json({ ok: true }); }
  catch (err) { next(err); }
});

module.exports = router;
