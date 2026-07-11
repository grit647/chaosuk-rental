const express = require('express');
const router = express.Router();
const { readTab, updateRow, appendRow } = require('../sheets');
const { readSettings } = require('../coerce');
const { runWithSheetId } = require('../requestContext');

// Master multi-tenant login directory (see server/routes/auth.js) — a
// separate Sheet from any customer's own data. Only set once the
// multi-tenant login system is actually deployed (see CLAUDE.md /
// GOOGLE_DIRECTORY_SHEET_ID in .env); undefined for now on the current
// single-tenant deploy, which every check below treats as "nothing to
// sync" rather than an error.
const DIRECTORY_SHEET_ID = process.env.GOOGLE_DIRECTORY_SHEET_ID;

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

// Real bug hit by a brand-new customer: they logged in with their directory
// PIN (e.g. "112233") for the first time, then tried to use that SAME PIN
// to confirm saving the "ข้อมูลหอพัก" card — but their customer Sheet is
// fresh (schema-cloned, empty Settings tab), so adminEditPin had never been
// set and still defaulted to "12345", rejecting their login PIN as "wrong".
// The PIN-syncing in change-admin-pin below only takes effect the FIRST
// TIME someone actively changes their admin PIN — it doesn't retroactively
// help a customer who's never done that yet. Fix: also accept the
// session's own login PIN (looked up fresh from the directory) as valid,
// everywhere the admin PIN is checked — matching what customers are told
// ("this is the same PIN as your login") from their very first login,
// not just after their first PIN change.
async function getSessionLoginPin(req) {
  const sessionSheetId = req.session && req.session.customerSheetId;
  if (!DIRECTORY_SHEET_ID || !sessionSheetId) return null;
  try {
    const directoryRows = await runWithSheetId(DIRECTORY_SHEET_ID, () => readTab('Users'));
    const row = directoryRows.find((u) => u.customerSheetId === sessionSheetId);
    return row ? row.pin : null;
  } catch { return null; }
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
// Per explicit user request: turning whole feature sections on/off (การใช้
// น้ำ/ไฟ, Set อุปกรณ์, สัญญาพนักงาน, พนักงานหอพัก) is a PLATFORM-level
// decision, not something each customer should be able to self-service —
// unlike adminEditPin (which every customer sets/owns themselves), this
// checks against the SAME hardcoded platform constant as the admin-PIN
// recovery code, known only to คุณต้น/the platform admin. Never touches
// the Sheet at all, so there's nothing here for a customer to read or
// override even if they inspected their own Sheet.
router.post('/verify-platform-pin', (req, res) => {
  const { pin } = req.body;
  if (!pin || String(pin) !== MASTER_RECOVERY_PIN) return res.status(403).json({ error: 'รหัสไม่ถูกต้อง' });
  res.json({ ok: true });
});

// Per explicit user request: lets the platform admin (คุณต้น only — see
// the server-side isPlatformAdmin check below, this is NOT reachable by
// a regular customer even if they guessed the URL) add a new building's
// row to the master login directory directly from the app, instead of
// hand-editing the Directory Sheet every time a new customer's building
// is set up. The Google Sheet itself still has to be created manually
// first (see prototype-auth/clone-schema.js) — this only automates the
// "add the login row" step of that process.
router.post('/add-building', async (req, res, next) => {
  try {
    if (!DIRECTORY_SHEET_ID) return res.status(500).json({ error: 'ยังไม่ได้ตั้งค่า GOOGLE_DIRECTORY_SHEET_ID บนเซิร์ฟเวอร์' });
    const isPlatformAdmin = !!(req.session && req.session.customerSheetId && req.session.customerSheetId === process.env.GOOGLE_SHEET_ID);
    if (!isPlatformAdmin) return res.status(403).json({ error: 'ฟีเจอร์นี้ใช้ได้เฉพาะบัญชีแพลตฟอร์มเท่านั้น' });

    const { phone, pin, customerSheetId } = req.body;
    if (!phone || !pin || !customerSheetId) return res.status(400).json({ error: 'กรุณากรอกเบอร์โทร รหัสผ่าน และ Sheet ID ให้ครบ' });
    if (String(pin).length < 4) return res.status(400).json({ error: 'รหัสผ่านต้องมีอย่างน้อย 4 ตัวอักษร' });

    const directoryRows = await runWithSheetId(DIRECTORY_SHEET_ID, () => readTab('Users'));
    // Same global PIN-uniqueness rule as change-admin-pin — one PIN can
    // only ever belong to one building across the whole directory, so
    // login can always tell which building a (phone, pin) pair means.
    if (directoryRows.some((u) => String(u.pin) === String(pin))) {
      return res.status(409).json({ error: 'รหัสผ่านนี้มีตึกอื่นใช้อยู่แล้ว กรุณาตั้งรหัสอื่น' });
    }
    if (directoryRows.some((u) => u.customerSheetId === customerSheetId)) {
      return res.status(409).json({ error: 'Sheet ID นี้มีอยู่ในสมุดรายชื่อกลางแล้ว (ตึกนี้เพิ่มไปแล้วหรือเปล่า?)' });
    }

    await runWithSheetId(DIRECTORY_SHEET_ID, () => appendRow('Users', {
      phone, pin, role: 'owner', customerSheetId, roomId: '', staffId: '',
    }));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/verify-admin-pin', async (req, res, next) => {
  try {
    const { pin } = req.body;
    const rows = await readTab('Settings');
    const row = rows.find((r) => r.key === 'adminEditPin');
    const storedPin = row ? row.value : '12345';
    const loginPin = await getSessionLoginPin(req);
    const valid = pin && (String(pin) === String(storedPin) || (loginPin != null && String(pin) === String(loginPin)));
    if (!valid) return res.status(403).json({ error: 'รหัสไม่ถูกต้อง' });
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
    const loginPin = await getSessionLoginPin(req);
    const oldPinValid = oldPin && (String(oldPin) === String(storedPin) || String(oldPin) === MASTER_RECOVERY_PIN || (loginPin != null && String(oldPin) === String(loginPin)));
    if (!oldPinValid) return res.status(403).json({ error: 'รหัสเดิมไม่ถูกต้อง' });

    // Per explicit user request: this same PIN doubles as the multi-tenant
    // LOGIN PIN (master "directory" Users sheet, server/routes/auth.js).
    // One person can own several buildings under the SAME phone number —
    // login resolves by matching (phone, pin) TOGETHER — so if two
    // buildings under one phone ever shared a PIN, login couldn't tell
    // which building to open. Enforce the new PIN is unique across the
    // WHOLE directory (every building, not just ones sharing this phone —
    // simplest rule that can never collide) before allowing the change,
    // except against this customer's own existing row (keeping the PIN you
    // already have is always fine). Only applies once logged in via the
    // multi-tenant system (req.session.customerSheetId set) — คุณต้น's own
    // current no-login usage has no directory row yet, so this is a no-op
    // for him and nothing changes about his existing flow.
    const sessionSheetId = req.session && req.session.customerSheetId;
    if (DIRECTORY_SHEET_ID && sessionSheetId) {
      const directoryRows = await runWithSheetId(DIRECTORY_SHEET_ID, () => readTab('Users'));
      const taken = directoryRows.find((u) => String(u.pin) === String(newPin) && u.customerSheetId !== sessionSheetId);
      if (taken) return res.status(409).json({ error: 'รหัสนี้มีผู้ใช้งานแล้วโดยตึกอื่น กรุณาตั้งรหัสอื่นครับ' });
    }

    await upsertKV('adminEditPin', newPin);

    // Sync the new PIN into this customer's own directory row too, so the
    // login PIN always matches the admin PIN just set above. Deliberately
    // NOT allowed to fail the whole request — the important write above
    // (this customer's own adminEditPin) already succeeded by this point;
    // if the directory sync hiccups (a second, separate Sheets API call,
    // more exposed to a transient error), the owner should still see
    // "changed successfully" rather than a confusing failure for a save
    // that partially went through. Logged server-side so a persistent
    // failure here is still visible to us, just not surfaced as a customer-
    // facing error for what is, from their side, a successful PIN change.
    let directorySyncFailed = false;
    if (DIRECTORY_SHEET_ID && sessionSheetId) {
      try {
        await runWithSheetId(DIRECTORY_SHEET_ID, () => updateRow('Users', sessionSheetId, { pin: newPin }, 'customerSheetId'));
      } catch (syncErr) {
        directorySyncFailed = true;
        console.error('[settings] directory PIN sync failed for', sessionSheetId, syncErr.message);
      }
    }

    res.json({ ok: true, directorySyncFailed });
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
      // Per explicit user request: per-customer LINE OA / Tuya Cloud
      // credentials, only written when the owner is actively setting/
      // changing them via the new gear-icon forms (never sent as part of
      // a routine save — readSettings() never sends these values back
      // down for the client to accidentally resubmit unchanged, matching
      // the PIN fields' pattern above).
      lineChannelAccessToken: b.lineCredentials && b.lineCredentials.accessToken,
      lineChannelSecret: b.lineCredentials && b.lineCredentials.channelSecret,
      tuyaAccessId: b.tuyaCredentials && b.tuyaCredentials.accessId,
      tuyaAccessSecret: b.tuyaCredentials && b.tuyaCredentials.accessSecret,
      tuyaApiBase: b.tuyaCredentials && b.tuyaCredentials.apiBase,
    };
    const entries = Object.entries(kv).filter(([, v]) => v !== undefined);
    for (const [k, v] of entries) {
      await upsertKV(k, v);
    }

    // Keep the multi-tenant login directory's phone number in sync with
    // the "ผู้ดูแลหอพัก" card's phone — per explicit user request, so a
    // customer who updates their contact phone here doesn't get locked out
    // of login (which looks up by phone+PIN together). Same no-op-for-
    // คุณต้น reasoning as the PIN sync above. Also best-effort/non-fatal —
    // see change-admin-pin's matching comment above for why.
    const sessionSheetId = req.session && req.session.customerSheetId;
    if (DIRECTORY_SHEET_ID && sessionSheetId && kv.adminPhone !== undefined) {
      try {
        await runWithSheetId(DIRECTORY_SHEET_ID, () => updateRow('Users', sessionSheetId, { phone: kv.adminPhone }, 'customerSheetId'));
      } catch (syncErr) {
        console.error('[settings] directory phone sync failed for', sessionSheetId, syncErr.message);
      }
    }

    res.json(await readSettings());
  } catch (err) { next(err); }
});

module.exports = router;
