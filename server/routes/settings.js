const express = require('express');
const router = express.Router();
const { readTab, updateRow, appendRow, deleteRow, getCellUsage } = require('../sheets');
const { readSettings } = require('../coerce');
const { runWithSheetId } = require('../requestContext');
const { cloneSchemaToNewSheet } = require('../setupBuilding');
const { trashSheet } = require('../googleDrive');
const { genOwnerId, isPlatformAdminSession } = require('./auth');
const { CURRENT_PLATFORM_VERSION } = require('../platformVersion');

// Ownership-based (see auth.js's isPlatformAdminSession) — stays true
// even while the platform admin is browsing another customer's building
// (e.g. mid-setup for a new one), not just when their OWN building
// happens to be the active one.
async function isPlatformAdminReq(req) {
  return isPlatformAdminSession(req.session);
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

// "ทำส่วนกลูเกิลชีต ให้ด้วยครับ...ใช้ไปกี่%...สูงสุด 10ล้านเซลล์" (2026-07-26)
// — Dashboard status card's Google Sheet usage gauge, real number sourced
// from spreadsheets.get (see sheets.js's getCellUsage comment for why 10M
// cells is the right denominator). Session-scoped automatically the same
// way every other route here is (getCellUsage() calls SHEET_ID() which
// resolves the logged-in customer's own sheet via requestContext). Fetched
// once on mount by the frontend, same pattern as /api/line/usage — cell
// counts don't change fast enough to need it on the 30s auto-refresh poll.
router.get('/sheet-usage', async (req, res, next) => {
  try { res.json(await getCellUsage()); }
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
// Per explicit user request/real bug hit: the original design used
// Server-Sent Events (a held-open connection streaming live progress) —
// worked fine locally and when called directly, but repeatedly failed
// for the real owner going through the actual browser UI on Render's
// free tier, with a misleading "Requested entity was not found" error.
// Best working theory: Render's free-tier proxy doesn't reliably keep a
// long-lived streaming connection open, and the browser's native
// EventSource auto-reconnects on any hiccup — silently firing a SECOND,
// overlapping clone attempt against a target Sheet the first attempt was
// still mid-way through modifying, corrupting/confusing both. Switched
// to plain polling instead: one quick POST kicks off the job in the
// background (in-memory, no held-open connection at all), the browser
// asks "how's it going?" every 1.5s with an ordinary GET — much more
// robust against exactly this kind of free-tier proxy flakiness, and
// there's no auto-retry mechanism to accidentally double-fire the job.
const setupBuildingJobs = new Map(); // jobId -> { events: [...], done: bool, error: string|null }

router.post('/setup-building-start', async (req, res) => {
  if (!(await isPlatformAdminReq(req))) return res.status(403).json({ error: 'ฟีเจอร์นี้ใช้ได้เฉพาะบัญชีแพลตฟอร์มเท่านั้น' });
  const { sheetId } = req.body;
  if (!sheetId) return res.status(400).json({ error: 'ต้องระบุ sheetId' });

  const jobId = 'job-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const job = { events: [], done: false, error: null };
  setupBuildingJobs.set(jobId, job);
  // Auto-expire after 10 minutes so this Map never grows unbounded from
  // abandoned attempts (nobody polling a finished/orphaned job forever).
  setTimeout(() => setupBuildingJobs.delete(jobId), 10 * 60 * 1000);

  // Deliberately NOT awaited — runs in the background while this request
  // returns immediately with the jobId to start polling.
  cloneSchemaToNewSheet(sheetId, (event) => job.events.push(event))
    .then(() => { job.done = true; })
    .catch((err) => { job.done = true; job.error = err.message; });

  res.json({ ok: true, jobId });
});

router.get('/setup-building-progress', async (req, res) => {
  if (!(await isPlatformAdminReq(req))) return res.status(403).json({ error: 'ฟีเจอร์นี้ใช้ได้เฉพาะบัญชีแพลตฟอร์มเท่านั้น' });
  const job = setupBuildingJobs.get(req.query.jobId);
  if (!job) return res.status(404).json({ error: 'ไม่พบงานนี้ (อาจหมดเวลาไปแล้ว)' });
  res.json({ events: job.events, done: job.done, error: job.error });
});

router.post('/add-building', async (req, res, next) => {
  try {
    if (!DIRECTORY_SHEET_ID) return res.status(500).json({ error: 'ยังไม่ได้ตั้งค่า GOOGLE_DIRECTORY_SHEET_ID บนเซิร์ฟเวอร์' });
    if (!(await isPlatformAdminReq(req))) return res.status(403).json({ error: 'ฟีเจอร์นี้ใช้ได้เฉพาะบัญชีแพลตฟอร์มเท่านั้น' });

    const { phone, pin, customerSheetId } = req.body;
    if (!phone || !customerSheetId) return res.status(400).json({ error: 'กรุณากรอกเบอร์โทรและ Sheet ID ให้ครบ' });
    if (pin && String(pin).length < 4) return res.status(400).json({ error: 'รหัสผ่านต้องมีอย่างน้อย 4 ตัวอักษร (หรือเว้นว่างให้ลูกค้าตั้งเอง)' });

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
    // fresh ownerId; the PIN field is OPTIONAL for a new phone — per
    // explicit user request ("claim your account" flow), leaving it blank
    // creates the row with NO pin at all, and the real customer's first
    // login attempt (whatever they type as the pin, min 4 chars) claims
    // it as their own — see server/routes/auth.js's /login. คุณต้น only
    // ever needs to hand them a login link, never a password.
    const existingOwnerRow = directoryRows.find((u) => u.phone === phone);
    let ownerId, effectivePin, reusedExistingOwner;
    if (existingOwnerRow) {
      if (!existingOwnerRow.ownerId) return res.status(500).json({ error: `เบอร์นี้มีแถวเก่าที่ยังไม่มี ownerId (ต้องรัน migrate-add-owner-id.js ก่อน)` });
      ownerId = existingOwnerRow.ownerId;
      effectivePin = existingOwnerRow.pin;
      reusedExistingOwner = true;
    } else {
      if (pin) {
        const pinTakenByOtherOwner = directoryRows.some((u) => String(u.pin) === String(pin));
        if (pinTakenByOtherOwner) return res.status(409).json({ error: 'รหัสผ่านนี้มีเจ้าของอื่นใช้อยู่แล้ว กรุณาตั้งรหัสอื่น' });
      }
      ownerId = genOwnerId();
      effectivePin = pin || '';
      reusedExistingOwner = false;
    }

    // Per explicit user request: a "พร้อมส่งมอบแล้ว" checklist marker so
    // คุณต้น doesn't lose track of which new buildings still need setup
    // before handing the real login over, vs which are done — defaults to
    // "pending" for every new building, toggled via
    // POST /toggle-handoff-status once configuration is actually done.
    //
    // platformVersion starts at CURRENT_PLATFORM_VERSION (not 0) — see
    // server/platformVersion.js's staged-rollout gate: a brand-new
    // building has never used the app yet, so there's nothing to protect
    // it from by holding back new features the way an existing customer's
    // building is (they stay pinned until คุณต้น explicitly clicks "🆕
    // อัปเดต" for that specific building).
    await runWithSheetId(DIRECTORY_SHEET_ID, () => appendRow('Users', {
      ownerId, phone, pin: effectivePin, role: 'owner', customerSheetId, roomId: '', staffId: '', status: 'active', handoffStatus: 'pending', platformVersion: CURRENT_PLATFORM_VERSION,
    }));

    // One-time bootstrap only (NOT an ongoing sync), and only when we
    // actually HAVE a pin yet — a brand-new building starts with
    // adminEditPin defaulted to "12345", which would leave the owner
    // unable to confirm-save their own "ข้อมูลหอพัก" card without knowing
    // that default. Seed it to match the login PIN so their first save
    // works with a PIN they already know — completely independent from
    // that point on (adminEditPin and the login PIN never sync after
    // this). When the pin is claimed later instead (blank at creation),
    // /login's claim step does this same seeding at claim time.
    if (effectivePin) {
      await runWithSheetId(customerSheetId, () => upsertKV('adminEditPin', effectivePin));
    }

    res.json({ ok: true, reusedExistingOwner, ownerId, awaitingClaim: !effectivePin });
  } catch (err) { next(err); }
});

// Per explicit user request: lets the platform admin pause/reactivate a
// building — for a monthly-subscription customer who hasn't paid, say —
// without deleting anything. A suspended building's row and its Google
// Sheet data both stay completely intact; only server/routes/auth.js's
// select-building refuses to let anyone open it while suspended.
router.post('/toggle-building-status', async (req, res, next) => {
  try {
    if (!DIRECTORY_SHEET_ID) return res.status(500).json({ error: 'ยังไม่ได้ตั้งค่า GOOGLE_DIRECTORY_SHEET_ID บนเซิร์ฟเวอร์' });
    if (!(await isPlatformAdminReq(req))) return res.status(403).json({ error: 'ฟีเจอร์นี้ใช้ได้เฉพาะบัญชีแพลตฟอร์มเท่านั้น' });
    const { customerSheetId } = req.body;
    if (!customerSheetId) return res.status(400).json({ error: 'ต้องระบุตึกที่ต้องการเปลี่ยนสถานะ' });
    // Never let the platform admin lock themselves out of their own
    // account this way — pausing is meant for customer buildings only.
    if (customerSheetId === process.env.GOOGLE_SHEET_ID) return res.status(400).json({ error: 'ไม่สามารถพักการใช้งานบัญชีแพลตฟอร์มเองได้' });

    const rows = await runWithSheetId(DIRECTORY_SHEET_ID, () => readTab('Users'));
    const row = rows.find((u) => u.customerSheetId === customerSheetId);
    if (!row) return res.status(404).json({ error: 'ไม่พบตึกนี้ในสมุดรายชื่อกลาง' });
    const newStatus = row.status === 'suspended' ? 'active' : 'suspended';
    await runWithSheetId(DIRECTORY_SHEET_ID, () => updateRow('Users', customerSheetId, { status: newStatus }, 'customerSheetId'));
    res.json({ ok: true, status: newStatus });
  } catch (err) { next(err); }
});

// Per explicit user request: a simple checklist marker — "พร้อมส่งมอบแล้ว"
// (ready) vs "กำลังตั้งค่า" (pending) — so คุณต้น doesn't lose track of
// which new buildings still need configuring before the real login goes
// out to that customer. Purely informational (doesn't block login or
// anything else, unlike the active/suspended status above).
router.post('/toggle-handoff-status', async (req, res, next) => {
  try {
    if (!DIRECTORY_SHEET_ID) return res.status(500).json({ error: 'ยังไม่ได้ตั้งค่า GOOGLE_DIRECTORY_SHEET_ID บนเซิร์ฟเวอร์' });
    if (!(await isPlatformAdminReq(req))) return res.status(403).json({ error: 'ฟีเจอร์นี้ใช้ได้เฉพาะบัญชีแพลตฟอร์มเท่านั้น' });
    const { customerSheetId } = req.body;
    if (!customerSheetId) return res.status(400).json({ error: 'ต้องระบุตึกที่ต้องการเปลี่ยนสถานะ' });

    const rows = await runWithSheetId(DIRECTORY_SHEET_ID, () => readTab('Users'));
    const row = rows.find((u) => u.customerSheetId === customerSheetId);
    if (!row) return res.status(404).json({ error: 'ไม่พบตึกนี้ในสมุดรายชื่อกลาง' });
    const newStatus = row.handoffStatus === 'ready' ? 'pending' : 'ready';
    await runWithSheetId(DIRECTORY_SHEET_ID, () => updateRow('Users', customerSheetId, { handoffStatus: newStatus }, 'customerSheetId'));
    res.json({ ok: true, handoffStatus: newStatus });
  } catch (err) { next(err); }
});

// Per explicit owner request (staged-rollout gate — see server/
// platformVersion.js): bumps ONE building's platformVersion to the
// server's current CURRENT_PLATFORM_VERSION, so it starts seeing whatever
// new customer-facing features have shipped since it last accepted an
// update. One-way ratchet forward only — there's no "downgrade" button,
// since the server only ever runs ONE version of the code at a time (no
// separate staging environment); this just controls which buildings are
// ALLOWED to see features already live on that one running server.
router.post('/update-building-version', async (req, res, next) => {
  try {
    if (!DIRECTORY_SHEET_ID) return res.status(500).json({ error: 'ยังไม่ได้ตั้งค่า GOOGLE_DIRECTORY_SHEET_ID บนเซิร์ฟเวอร์' });
    if (!(await isPlatformAdminReq(req))) return res.status(403).json({ error: 'ฟีเจอร์นี้ใช้ได้เฉพาะบัญชีแพลตฟอร์มเท่านั้น' });
    const { customerSheetId } = req.body;
    if (!customerSheetId) return res.status(400).json({ error: 'ต้องระบุตึกที่ต้องการอัปเดต' });

    const rows = await runWithSheetId(DIRECTORY_SHEET_ID, () => readTab('Users'));
    const row = rows.find((u) => u.customerSheetId === customerSheetId);
    if (!row) return res.status(404).json({ error: 'ไม่พบตึกนี้ในสมุดรายชื่อกลาง' });
    await runWithSheetId(DIRECTORY_SHEET_ID, () => updateRow('Users', customerSheetId, { platformVersion: CURRENT_PLATFORM_VERSION }, 'customerSheetId'));
    res.json({ ok: true, platformVersion: CURRENT_PLATFORM_VERSION });
  } catch (err) { next(err); }
});

// Per explicit user request: removes a building's LOGIN ROW from the
// master directory only — its Google Sheet and all the data in it are
// completely untouched, this just revokes the ability to log into it.
// (Deliberately not a real Google Sheet deletion — that's a much bigger,
// harder-to-undo action the owner didn't ask for here.)
router.post('/delete-building', async (req, res, next) => {
  try {
    if (!DIRECTORY_SHEET_ID) return res.status(500).json({ error: 'ยังไม่ได้ตั้งค่า GOOGLE_DIRECTORY_SHEET_ID บนเซิร์ฟเวอร์' });
    if (!(await isPlatformAdminReq(req))) return res.status(403).json({ error: 'ฟีเจอร์นี้ใช้ได้เฉพาะบัญชีแพลตฟอร์มเท่านั้น' });
    const { customerSheetId } = req.body;
    if (!customerSheetId) return res.status(400).json({ error: 'ต้องระบุตึกที่ต้องการลบ' });
    if (customerSheetId === process.env.GOOGLE_SHEET_ID) return res.status(400).json({ error: 'ไม่สามารถลบบัญชีแพลตฟอร์มเองได้' });

    await runWithSheetId(DIRECTORY_SHEET_ID, () => deleteRow('Users', customerSheetId, 'customerSheetId'));

    // Per explicit user request: also move the building's actual Google
    // Sheet to Trash (recoverable ~30 days) — NOT a permanent delete.
    // Best-effort: the login row is already gone by this point (the more
    // important half of "delete" already succeeded), so a Drive API
    // hiccup here shouldn't be reported as a failure — just flagged back
    // so the admin knows to check/trash it manually if needed.
    let sheetTrashed = false;
    let trashError = null;
    try {
      await trashSheet(customerSheetId);
      sheetTrashed = true;
    } catch (err) {
      trashError = err.message;
      console.error('[settings] trashSheet failed for', customerSheetId, err.message);
    }

    res.json({ ok: true, sheetTrashed, trashError });
  } catch (err) { next(err); }
});

router.post('/verify-admin-pin', async (req, res, next) => {
  try {
    const { pin } = req.body;
    const rows = await readTab('Settings');
    const row = rows.find((r) => r.key === 'adminEditPin');
    const storedPin = row ? row.value : '12345';
    let ok = !!pin && String(pin) === String(storedPin);
    // Per explicit user request: the owner's own LOGIN PIN (the one used
    // at /login, phone+pin) should ALSO be accepted here as a fallback,
    // even when this building has its own separate adminEditPin set —
    // this endpoint gates every "are you sure" confirm across the app
    // (ข้อมูลหอพัก save, factory reset, จัดการผู้ดูแล add/edit/delete,
    // etc.), and the owner shouldn't get stuck just because they forgot
    // which of the two PINs applies here vs. at login. Looked up from the
    // shared Directory sheet (source of truth for the login PIN, see
    // server/routes/auth.js's POST /login), matched by this session's
    // customerSheetId — never checked against a DIFFERENT building's PIN.
    if (!ok && pin && DIRECTORY_SHEET_ID && req.session && req.session.customerSheetId) {
      try {
        const users = await runWithSheetId(DIRECTORY_SHEET_ID, () => readTab('Users'));
        const building = users.find((u) => u.customerSheetId === req.session.customerSheetId);
        if (building && building.pin && String(pin) === String(building.pin)) ok = true;
      } catch (err) {
        console.error('[settings] verify-admin-pin login-PIN fallback check failed', err.message);
      }
    }
    if (!ok) return res.status(403).json({ error: 'รหัสไม่ถูกต้อง' });
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
      lineOAShortUrl: b.propertyProfile && b.propertyProfile.lineOAShortUrl,
      waterRate: b.waterRate,
      elecRate: b.elecRate,
      trashRate: b.trashRate,
      internetRate: b.internetRate,
      // "แจ้งเตือน ตัดน้ำตัดไฟ...ทุกวันที่เท่าไร" (2026-07-26) — วันที่ของ
      // เดือน ใช้ร่วมกันทุกห้อง (ดู coerce.js's readSettings comment เต็ม)
      cutoffReminderDay: b.cutoffReminderDay,
      cutoffFinalDay: b.cutoffFinalDay,
      cutoffCancelWarningDay: b.cutoffCancelWarningDay,
      leaseExpiringReminderDays: b.leaseExpiringReminderDays,
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
      notifyWifiRequest: b.adminNotify && b.adminNotify.wifiRequest,
      notifyCutoffWarning: b.adminNotify && b.adminNotify.cutoffWarning,
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

    // Same sync pattern for buildingKeyId — per explicit user request, the
    // new staff-login flow (POST /api/auth/staff-login) needs to look up
    // "which building has this buildingKeyId" FAST (one Directory read)
    // instead of opening every building's own Settings sheet to search.
    // buildingKeyId's actual source of truth stays each building's own
    // Settings sheet (via propertyProfile above) — this Directory column
    // is purely a mirrored index, kept in sync here.
    if (DIRECTORY_SHEET_ID && sessionSheetId && kv.buildingKeyId !== undefined) {
      try {
        await runWithSheetId(DIRECTORY_SHEET_ID, () => updateRow('Users', sessionSheetId, { buildingKeyId: kv.buildingKeyId }, 'customerSheetId'));
      } catch (syncErr) {
        console.error('[settings] directory buildingKeyId sync failed for', sessionSheetId, syncErr.message);
      }
    }

    res.json(await readSettings());
  } catch (err) { next(err); }
});

module.exports = router;
