const express = require('express');
const router = express.Router();
const { appendRow, updateRow, deleteRow, readTab } = require('../sheets');

// "ผู้ดูแล" (accounting-clerk login access, full access same as the
// owner, just a separate credential) — per explicit user request, kept
// in a completely SEPARATE Sheet tab from "Staff"/สัญญาพนักงาน
// (employment contract data), never mixed. See server/routes/auth.js's
// POST /staff-login, which checks phone+pin against THIS tab.

// Same redaction principle as staff.js's redactPin — the PIN must never
// round-trip back to the browser in a routine response.
function redactPin(admins) {
  return admins.map(({ pin, ...rest }) => ({ ...rest, hasPin: !!(pin && String(pin).trim()) }));
}

router.get('/', async (req, res, next) => {
  try { res.json(redactPin(await readTab('Admins'))); }
  catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const b = req.body;
    if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'กรุณากรอกชื่อผู้ดูแล' });
    if (!b.phone || !String(b.phone).trim()) return res.status(400).json({ error: 'กรุณากรอกเบอร์โทร' });
    if (!b.pin || String(b.pin).length < 4) return res.status(400).json({ error: 'กรุณาตั้งรหัสผ่านอย่างน้อย 4 ตัวอักษร' });
    const admin = { id: Date.now(), name: b.name, phone: b.phone, pin: b.pin };
    await appendRow('Admins', admin);
    res.json(redactPin([admin])[0]);
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const merged = await updateRow('Admins', req.params.id, req.body);
    res.json(redactPin([merged])[0]);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try { await deleteRow('Admins', req.params.id); res.json({ ok: true }); }
  catch (err) { next(err); }
});

module.exports = router;
