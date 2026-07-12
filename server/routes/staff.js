const express = require('express');
const router = express.Router();
const { appendRow, updateRow, deleteRow, readTab } = require('../sheets');
const { coerceStaff } = require('../coerce');

// Per explicit user design: staff login PINs (added for the new
// /staff-login flow — see server/routes/auth.js) must NEVER round-trip
// back to the browser in a routine GET/PATCH response, same principle
// already applied to adminEditPin/dataResetPin in settings.js — anyone
// with access to the owner's session/devtools could otherwise read every
// staff member's login PIN straight out of the network tab. The frontend
// only needs to know WHETHER a PIN is set (to show "🔑 เปิดใช้งานแล้ว" vs
// "🔒 ยังไม่เปิดใช้งาน"), never the actual value — auth.js's staff-login
// route reads the raw pin directly via readTab('Staff'), bypassing this
// redaction entirely, since that's server-side only.
function redactPin(staff) {
  return staff.map(({ pin, ...rest }) => ({ ...rest, hasPin: !!(pin && String(pin).trim()) }));
}

router.get('/', async (req, res, next) => {
  try { res.json(redactPin(coerceStaff(await readTab('Staff')))); }
  catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const b = req.body;
    if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'กรุณากรอกชื่อพนักงาน' });
    if (!b.position || !String(b.position).trim()) return res.status(400).json({ error: 'กรุณาเลือกตำแหน่ง' });
    // Per explicit user request: วันที่รับเงินเดือน is required — payroll
    // data the owner said must exist before a staff record can be saved.
    if (!b.payDay || !String(b.payDay).trim()) return res.status(400).json({ error: 'กรุณากรอกวันที่รับเงินเดือน' });
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
      payDay: b.payDay,
      lineUserId: b.lineUserId || '',
    };
    await appendRow('Staff', staff);
    res.json(staff);
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const merged = await updateRow('Staff', req.params.id, req.body);
    res.json(redactPin(coerceStaff([merged]))[0]);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try { await deleteRow('Staff', req.params.id); res.json({ ok: true }); }
  catch (err) { next(err); }
});

module.exports = router;
