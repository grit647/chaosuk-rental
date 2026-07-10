const express = require('express');
const router = express.Router();
const { readTab, clearTab } = require('../sheets');

// Maps the checkbox keys the frontend sends to the actual Sheet tab name.
// Deliberately excludes Rooms/Settings — those are covered separately (see
// factory-reset below, which does include Rooms) so a partial "ล้างข้อมูล"
// pass can never accidentally wipe live tenant/lease records.
const CLEARABLE = {
  electricityLog: 'ElectricityLog',
  invoices: 'Invoices',
  expenses: 'Expenses',
  maintenance: 'Maintenance',
  calendar: 'CalendarEvents',
  unmatchedSlips: 'UnmatchedSlips',
  // Revenue ledger (server/routes/paymentLog.js) — added alongside the
  // other categories per explicit user request, after manually clearing
  // it via the Sheet UI directly (no in-app way to do that before this).
  paymentLog: 'PaymentLog',
};

// Partial clear — owner ticks which categories to wipe, confirmed by typing
// "ลบ" client-side before this is ever called (Rental Management.dc.html).
router.post('/clear', async (req, res, next) => {
  try {
    const categories = Array.isArray(req.body.categories) ? req.body.categories : [];
    const valid = categories.filter((c) => CLEARABLE[c]);
    if (!valid.length) return res.status(400).json({ error: 'กรุณาเลือกอย่างน้อย 1 หมวด' });
    for (const c of valid) {
      await clearTab(CLEARABLE[c]);
    }
    res.json({ ok: true, cleared: valid });
  } catch (err) { next(err); }
});

// Full factory reset — wipes everything including Rooms/tenants/leases, the
// most destructive action in the app. Gated behind a PIN the owner sets in
// advance (Settings page) specifically so this can't be triggered by a
// stray click or by anyone who doesn't know that PIN — Settings tab itself
// (rates, property profile, the PIN) is left intact on purpose, along with
// RecurringTasks/ScheduledMessages (automation config, not "data").
router.post('/factory-reset', async (req, res, next) => {
  try {
    const { pin } = req.body;
    const settingsRows = await readTab('Settings');
    const pinRow = settingsRows.find((r) => r.key === 'dataResetPin');
    const storedPin = pinRow && pinRow.value;
    if (!storedPin) return res.status(400).json({ error: 'ยังไม่ได้ตั้งรหัส PIN สำหรับล้างข้อมูลทั้งหมด — ไปตั้งที่หน้าตั้งค่าก่อน' });
    if (!pin || String(pin) !== String(storedPin)) return res.status(403).json({ error: 'รหัส PIN ไม่ถูกต้อง' });

    const tabs = ['Rooms', 'Invoices', 'Maintenance', 'Expenses', 'CalendarEvents', 'UnmatchedSlips', 'ElectricityLog', 'PaymentLog'];
    for (const t of tabs) {
      await clearTab(t);
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
