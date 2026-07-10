const express = require('express');
const router = express.Router();
const { appendRow, updateRow, deleteRow, readTab } = require('../sheets');
const { coerceExpenses } = require('../coerce');

router.get('/', async (req, res, next) => {
  try { res.json(coerceExpenses(await readTab('Expenses'))); }
  catch (err) { next(err); }
});

// Per explicit user request: a "ซ่อน" (hide) toggle, distinct from ลบ
// (delete) — same display-only-preference pattern already used for
// invoices' hiddenFromDashboard. Lets the owner declutter the main list
// (e.g. old one-off repairs) without losing the record or its amount
// (still counts toward รายจ่ายรวมเดือนนี้ either way — hiding is purely
// visual, never touches the totals).
router.patch('/:id', async (req, res, next) => {
  try {
    const merged = await updateRow('Expenses', req.params.id, { hidden: !!req.body.hidden });
    res.json(coerceExpenses([merged])[0]);
  } catch (err) { next(err); }
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
