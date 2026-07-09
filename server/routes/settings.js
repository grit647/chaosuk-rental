const express = require('express');
const router = express.Router();
const { readTab, updateRow, appendRow } = require('../sheets');
const { readSettings } = require('../coerce');

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

router.put('/', async (req, res, next) => {
  try {
    const b = req.body;
    const kv = {
      propertyName: b.propertyProfile && b.propertyProfile.name,
      adminName: b.propertyProfile && b.propertyProfile.adminName,
      adminPhone: b.propertyProfile && b.propertyProfile.adminPhone,
      adminLineUserId: b.propertyProfile && b.propertyProfile.adminLineUserId,
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
    };
    const entries = Object.entries(kv).filter(([, v]) => v !== undefined);
    for (const [k, v] of entries) {
      await upsertKV(k, v);
    }
    res.json(await readSettings());
  } catch (err) { next(err); }
});

module.exports = router;
