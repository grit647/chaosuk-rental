const express = require('express');
const router = express.Router();
const { readTab, updateRow, appendRow } = require('../sheets');
const { readSettings } = require('../coerce');

// Permanent master/recovery code for the "ผู้ดูแลระบบ" card's PIN — per
// explicit user request, kept as a hardcoded server-side constant (NOT
// stored in the Settings Sheet like the regular adminEditPin) specifically
// so it doesn't show up in plain text next to the regular PIN if someone
// opens the Sheet. Purpose: if the actual owner/customer forgets their own
// PIN, this code always works as the "old PIN" step when setting a new
// one — see CLAUDE.md's security note on this for the full trade-off
// writeup (the regular PIN itself is still plain-text in the Sheet either
// way, since this app has no real auth system).
const MASTER_RECOVERY_PIN = 'werty1122';

async function upsertKV(key, value) {
  const rows = await readTab('Settings');
  const val = typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value);
  if (rows.some((r) => r.key === key)) {
    await updateRow('Settings', key, { value: val }, 'key');
  } else {
    await appendRow('Settings', { key, value: val });
  }
}

router.get('/', async (req, res, next) => {
  try { res.json(await readSettings()); }
  catch (err) { next(err); }
});

// Gate for editing the "ผู้ดูแลระบบ" card (name/phone/LINE User ID) — per
// explicit user request, since the LINE User ID field controls where
// system notifications go, so changing it shouldn't be a casual one-click
// edit. Defaults to "12345" if the owner hasn't set their own value yet
// (via PUT / with adminEditPin) — asked for by name as the initial value,
// with an explicit note to change it to something less guessable later.
router.post('/verify-admin-pin', async (req, res, next) => {
  try {
    const { pin } = req.body;
    const rows = await readTab('Settings');
    const row = rows.find((r) => r.key === 'adminEditPin');
    const storedPin = row ? row.value : '12345';
    if (!pin || String(pin) !== String(storedPin)) return res.status(403).json({ error: 'รหัสไม่ถูกต้อง' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Change the admin-card edit PIN — requires the current PIN (or the
// permanent master recovery code) before allowing a new one to be set.
router.post('/change-admin-pin', async (req, res, next) => {
  try {
    const { oldPin, newPin } = req.body;
    if (!newPin || String(newPin).length < 4) return res.status(400).json({ error: 'กรุณาตั้งรหัสใหม่อย่างน้อย 4 ตัวอักษร' });
    const rows = await readTab('Settings');
    const row = rows.find((r) => r.key === 'adminEditPin');
    const storedPin = row ? row.value : '12345';
    const oldPinValid = oldPin && (String(oldPin) === String(storedPin) || String(oldPin) === MASTER_RECOVERY_PIN);
    if (!oldPinValid) return res.status(403).json({ error: 'รหัสเดิมไม่ถูกต้อง' });
    await upsertKV('adminEditPin', newPin);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.put('/', async (req, res, next) => {
  try {
    const b = req.body;
    const kv = {
      propertyName: b.propertyProfile && b.propertyProfile.name,
      adminName: b.propertyProfile && b.propertyProfile.adminName,
      adminPhone: b.propertyProfile && b.propertyProfile.adminPhone,
      adminLineUserId: b.propertyProfile && b.propertyProfile.adminLineUserId,
      paymentQrUrl: b.propertyProfile && b.propertyProfile.paymentQrUrl,
      waterRate: b.waterRate,
      elecRate: b.elecRate,
      trashRate: b.trashRate,
      internetRate: b.internetRate,
      autoInvoice: b.settings && b.settings.autoInvoice,
      dueReminder: b.settings && b.settings.dueReminder,
      claudeAutomationEnabled: b.claudeAutomationEnabled,
      // Only written when the owner is actively setting/changing it (see
      // the "ตั้งรหัส PIN" field in Settings) — never sent as part of a
      // routine save, since readSettings() never sends the value back down
      // for the client to accidentally resubmit unchanged.
      dataResetPin: b.dataResetPin,
      // Same pattern — only written when the owner is actively changing
      // the admin-card edit PIN (not yet exposed in the UI, defaults to
      // "12345" server-side in POST /verify-admin-pin until they do).
      adminEditPin: b.adminEditPin,
      notifyTaskFailure: b.adminNotify && b.adminNotify.taskFailure,
      notifySlipPending: b.adminNotify && b.adminNotify.slipPending,
      notifyOverdueBill: b.adminNotify && b.adminNotify.overdueBill,
      notifyUnmatchedSlip: b.adminNotify && b.adminNotify.unmatchedSlip,
      notifyMaintenance: b.adminNotify && b.adminNotify.maintenance,
      notifyLeaseExpiring: b.adminNotify && b.adminNotify.leaseExpiring,
      // Per explicit user request: toggle whole nav sections on/off, PIN-
      // gated the same way as everything else in this route.
      featureWaterEnabled: b.featuresEnabled && b.featuresEnabled.water,
      featureElecEnabled: b.featuresEnabled && b.featuresEnabled.elec,
      featureEquipmentEnabled: b.featuresEnabled && b.featuresEnabled.equipment,
      featureStaffContractsEnabled: b.featuresEnabled && b.featuresEnabled.staffContracts,
      featureStaffMembersEnabled: b.featuresEnabled && b.featuresEnabled.staffMembers,
    };
    const entries = Object.entries(kv).filter(([, v]) => v !== undefined);
    for (const [k, v] of entries) {
      await upsertKV(k, v);
    }
    res.json(await readSettings());
  } catch (err) { next(err); }
});

module.exports = router;
