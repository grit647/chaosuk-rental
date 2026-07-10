const express = require('express');
const router = express.Router();
const { appendRow, deleteRow, readTab } = require('../sheets');
const { coerceExpenses } = require('../coerce');

router.get('/', async (req, res, next) => {
  try { res.json(coerceExpenses(await readTab('Expenses'))); }
  catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const b = req.body;
    const amount = Number(b.amount) || 0;
    if (!b.desc || !String(b.desc).trim() || amount <= 0) {
      return res.status(400).json({ error: 'กรุณากรอกรายละเอียดและจำนวนเงิน' });
    }
    // room: only meaningful for ค่าซ่อมบำรุง (owner tags a repair to a
    // specific room, or "ส่วนกลาง" for shared areas) — empty string for
    // every other category, per explicit user request.
    const item = { id: Date.now(), date: b.date || '', category: b.category || '', desc: b.desc, amount, room: b.room || '' };
    await appendRow('Expenses', item);
    res.json(item);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try { await deleteRow('Expenses', req.params.id); res.json({ ok: true }); }
  catch (err) { next(err); }
});

module.exports = router;
