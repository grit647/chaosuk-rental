const express = require('express');
const router = express.Router();
const { readTab, updateRow, appendRow } = require('../sheets');
const { readSettings } = require('../coerce');
const { runWithSheetId } = require('../requestContext');
const { cloneSchemaToNewSheet } = require('../setupBuilding');
const { genOwnerId } = require('./auth');

function isPlatformAdminReq(req) {
  return !!(req.session && req.session.customerSheetId && req.session.customerSheetId === process.env.GOOGLE_SHEET_ID);
}

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
// Streams live progress (Server-Sent Events) while cloning the schema
// (tab names + header rows) from คุณต้น's real production Sheet onto a
// brand-new customer's Sheet — per explicit user request, so the "+
// เพิ่มตึกใหม่" flow shows a real progress bar instead of a silent wait
// while ~2 dozen sequential Google Sheets API calls run. GET (not POST)
// because the browser's native EventSource API only supports GET —
// acceptable here since this is an in-house admin tool, not a public
// endpoint, and it's still gated behind the same platform-admin check
// as everything else in this file (cookie-based, not just "guessed the
// URL" obscurity).
router.get('/setup-building-stream', async (req, res) => {
  if (!isPlatformAdminReq(req)) return res.status(403).json({ error: 'ฟีเจอร์นี้ใช้ได้เฉพาะบัญชีแพลตฟอร์มเท่านั้น' });
  const targetSheetId = req.query.sheetId;
  if (!targetSheetId) return res.status(400).json({ error: 'ต้องระบุ sheetId' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  try {
    await cloneSchemaToNewSheet(targetSheetId, send);
  } catch (err) {
    send({ phase: 'error', message: err.message });
  }
  res.end();
});

router.post('/add-building', async (req, res, next) => {
  try {
    if (!DIRECTORY_SHEET_ID) return res.status(500).json({ error: 'ยังไม่ได้ตั้งค่า GOOGLE_DIRECTORY_SHEET_ID บนเซิร์ฟเวอร์' });
    if (!isPlatformAdminReq(req)) return res.status(403).json({ error: 'ฟีเจอร์นี้ใช้ได้เฉพาะบัญชีแพลตฟอร์มเท่านั้น' });

    const { phone, pin, customerSheetId } = req.body;
    if (!phone || !pin || !customerSheetId) return res.status(400).json({ error: 'กรุณากรอกเบอร์โทร รหัสผ่าน และ Sheet ID ให้ครบ' });
    if (String(pin).length < 4) return res.status(400).json({ error: 'รหัสผ่านต้องมีอย่างน้อย 4 ตัวอักษร' });

    const directoryRows = await runWithSheetId(DIRECTORY_SHEET_ID, () => readTab('Users'));
    if (directoryRows.some((u) => u.customerSheetId === customerSheetId)) {
      return res.status(409).json({ error: 'Sheet ID นี้มีอยู่ในสมุดรายชื่อกลางแล้ว (ตึกนี้เพิ่มไปแล้วหรือเปล่า?)' });
    }

    // Per explicit user request (multi-building-per-owner design): if this
    // phone already owns another building, this new one joins the SAME
    // owner — reuse their existing ownerId AND existing login PIN
    // (whatever was typed into the form is ignored in that case, so the
    // owner's one login always stays consistent across every building of
    // theirs, no manual syncing needed). A genuinely new phone gets a
    // fresh ownerId and uses the PIN typed in, which only needs to be
    // unique against OTHER owners (a different owner reusing the same PIN
    // string is fine — login always matches phone+pin together).
    const existingOwnerRow = directoryRows.find((u) => u.phone === phone);
    let ownerId, effectivePin, reusedExistingOwner;
    if (existingOwnerRow) {
      if (!existingOwnerRow.ownerId) return res.status(500).json({ error: `เบอร์นี้มีแถวเก่าที่ยังไม่มี ownerId (ต้องรัน migrate-add-owner-id.js ก่อน)` });
      ownerId = existingOwnerRow.ownerId;
      effectivePin = existingOwnerRow.pin;
      reusedExistingOwner = true;
    } else {
      const pinTakenByOtherOwner = directoryRows.some((u) => String(u.pin) === String(pin));
      if (pinTakenByOtherOwner) return res.status(409).json({ error: 'รหัสผ่านนี้มีเจ้าของอื่นใช้อยู่แล้ว กรุณาตั้งรหัสอื่น' });
      ownerId = genOwnerId();
      effectivePin = pin;
      reusedExistingOwner = false;
    }

    await runWithSheetId(DIRECTORY_SHEET_ID, () => appendRow('Users', {
      ownerId, phone, pin: effectivePin, role: 'owner', customerSheetId, roomId: '', staffId: '',
    }));

    // One-time bootstrap only (NOT an ongoing sync) — a brand-new building
    // starts with adminEditPin defaulted to "12345", which would leave the
    // owner unable to confirm-save their own "ข้อมูลหอพัก" card without
    // knowing that default. Seed it to match the login PIN they were just
    // given so their first save works with the PIN they already know —
    // completely independent from that point on (per explicit user
    // correction: adminEditPin and the login PIN never sync after this).
    await runWithSheetId(customerSheetId, () => upsertKV('adminEditPin', effectivePin));

    res.json({ ok: true, reusedExistingOwner, ownerId });
  } catch (err) { next(err); }
});

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
// Per explicit user correction: this is THIS BUILDING'S OWN security PIN
// only — fully independent from the multi-building LOGIN PIN (see
// server/routes/auth.js's change-login-pin). An earlier version of this
// route synced the two together; that was a design mistake corrected
// mid-session — a building's adminEditPin and the owner's login PIN are
// now two completely separate concepts that never touch each other.
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
      buildingKeyId: b.propertyProfile && b.propertyProfile.buildingKeyId,
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
