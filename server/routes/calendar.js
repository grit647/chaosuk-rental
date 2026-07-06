const express = require('express');
const router = express.Router();
const { appendRow, deleteRow, readTab } = require('../sheets');
const { coerceCalendar } = require('../coerce');

router.get('/', async (req, res, next) => {
  try { res.json(coerceCalendar(await readTab('CalendarEvents'))); }
  catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const b = req.body;
    if (!b.title || !String(b.title).trim()) return res.status(400).json({ error: 'กรุณากรอกชื่อรายการ' });
    const item = {
      id: Date.now(),
      y: Number(b.y), m: Number(b.m), d: Number(b.d),
      time: b.time || '09:00',
      title: b.title,
      type: b.type || 'อื่นๆ',
    };
    await appendRow('CalendarEvents', item);
    res.json(item);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try { await deleteRow('CalendarEvents', req.params.id); res.json({ ok: true }); }
  catch (err) { next(err); }
});

module.exports = router;
