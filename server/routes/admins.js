const express = require('express');
const router = express.Router();
const { appendRow, updateRow, deleteRow, readTab } = require('../sheets');
const { readSettings } = require('../coerce');

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
    // Per explicit user request: block creating a "ผู้ดูแล" login account
    // entirely if this building's "ID / รหัสประจำตึก" isn't set yet (ตั้งค่า
    // → ข้อมูลหอพัก). Real bug risk otherwise — POST /api/auth/staff-login
    // resolves WHICH building to check phone+pin against by matching
    // buildingKeyId in the shared Directory sheet (see server/routes/
    // auth.js line ~189); an empty buildingKeyId means that lookup can
    // never match, so the admin account would be created successfully but
    // could never actually log in — a silent dead end with no obvious
    // cause from the staff-login error message alone. Checked server-side
    // (not just hidden/warned in the UI) so this can't be bypassed by a
    // stale page or a direct API call.
    const settings = await readSettings();
    if (!settings.propertyProfile.buildingKeyId || !settings.propertyProfile.buildingKeyId.trim()) {
      return res.status(400).json({ error: 'ยังไม่ได้ตั้งค่า "ID / รหัสประจำตึก" — ไปที่หน้าตั้งค่า > ข้อมูลหอพัก เพื่อตั้งค่าก่อน ไม่งั้นผู้ดูแลคนนี้จะเข้าสู่ระบบไม่ได้' });
    }
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
