const express = require('express');
const router = express.Router();
const { appendRow, updateRow, deleteRow, readTab } = require('../sheets');
const { coerceMaintenance } = require('../coerce');

router.get('/', async (req, res, next) => {
  try { res.json(coerceMaintenance(await readTab('Maintenance'))); }
  catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const b = req.body;
    if (!b.room || !b.issue || !String(b.issue).trim()) {
      return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบ' });
    }
    const item = { id: Date.now(), room: b.room, issue: b.issue, status: 'pending', date: b.date || 'วันนี้' };
    await appendRow('Maintenance', item);
    res.json(item);
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const merged = await updateRow('Maintenance', req.params.id, req.body);
    res.json(coerceMaintenance([merged])[0]);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try { await deleteRow('Maintenance', req.params.id); res.json({ ok: true }); }
  catch (err) { next(err); }
});

module.exports = router;
