const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { readTab, updateRow } = require('../sheets');
const { runWithSheetId } = require('../requestContext');
const { getSession, setSessionCookie, clearSessionCookie } = require('../auth');
const { readSettings } = require('../coerce');

// The "เช่าสุข - สมุดรายชื่อกลาง (ทดลอง)" sheet — completely separate from
// any customer's own data Sheet. Maps phone+PIN -> role + which
// customer's Sheet/room/staff row to scope this session to. Per explicit
// user request, prototyped and verified against real data (see
// prototype-auth/) before wiring in here.
const DIRECTORY_SHEET_ID = process.env.GOOGLE_DIRECTORY_SHEET_ID;

// Per explicit user request (multi-building-per-owner redesign): one
// person ("เจ้าของ") can own several buildings, all reachable with ONE
// shared login. `ownerId` (added by prototype-auth/migrate-add-owner-id.js)
// is the grouping key — every directory row belonging to the same owner
// shares the same ownerId, independent of phone/customerSheetId, so
// changing a phone number or adding a new building never breaks the
// grouping. NOT the same thing as a building's own adminEditPin (its
// in-app confirm-before-save PIN) or buildingKeyId (its reference label)
// — those stay fully independent per building, per explicit correction
// from the owner mid-design.
function genOwnerId() {
  return 'OWNER-' + crypto.randomBytes(6).toString('hex');
}

// Per explicit user request: whether this session belongs to the
// platform's own account (คุณต้น) — checked by OWNERSHIP (does any
// building under this session's ownerId match the server's own
// GOOGLE_SHEET_ID?), NOT by which building happens to be ACTIVE right
// now. That distinction matters: once the platform admin switches into
// another customer's building to configure it (see /my-buildings'
// allBuildings + /select-building's bypass below), the ACTIVE
// customerSheetId is no longer his own — a naive "session.customerSheetId
// === GOOGLE_SHEET_ID" check would incorrectly strip his admin
// privileges the moment he does the exact thing those privileges exist
// for. Falls back to the simple active-building check for sessions with
// no ownerId (pre-migration/legacy rows).
async function isPlatformAdminSession(session) {
  if (!session) return false;
  if (!DIRECTORY_SHEET_ID || !session.ownerId) return session.customerSheetId === process.env.GOOGLE_SHEET_ID;
  try {
    const users = await runWithSheetId(DIRECTORY_SHEET_ID, () => readTab('Users'));
    return users.some((u) => u.ownerId === session.ownerId && u.customerSheetId === process.env.GOOGLE_SHEET_ID);
  } catch { return false; }
}

// PINs are compared in plain text here — same accepted trade-off already
// documented in CLAUDE.md for this app's other PIN gates (dataResetPin,
// adminEditPin): no real auth system existed before this, so there's
// nowhere secure to hash against yet. Flagging again here since this one
// guards actual customer account access, a step up from the other PINs'
// "friction gate" purpose — worth hashing properly before this goes past
// prototype stage.
router.post('/login', async (req, res, next) => {
  try {
    const { phone, pin } = req.body;
    if (!phone || !pin) return res.status(400).json({ error: 'กรุณากรอกเบอร์โทรและรหัสผ่าน' });
    if (!DIRECTORY_SHEET_ID) return res.status(500).json({ error: 'ยังไม่ได้ตั้งค่า GOOGLE_DIRECTORY_SHEET_ID บนเซิร์ฟเวอร์' });

    const users = await runWithSheetId(DIRECTORY_SHEET_ID, () => readTab('Users'));
    const match = users.find((u) => u.phone === phone && u.pin === pin);
    if (!match) return res.status(401).json({ error: 'เบอร์โทรหรือรหัสผ่านไม่ถูกต้อง' });

    // Every building sharing this owner's ownerId — the session starts
    // with the FIRST one active (arbitrary but stable pick: array order
    // from the Sheet) and /my-buildings lets the owner switch to any
    // other one they have (POST /select-building below).
    const ownedBuildings = match.ownerId
      ? users.filter((u) => u.ownerId === match.ownerId)
      : [match]; // rows migrated/created before ownerId existed — treat as owning just themselves

    const session = {
      ownerId: match.ownerId || null,
      role: match.role,
      customerSheetId: match.customerSheetId || null,
      roomId: match.roomId || null,
      staffId: match.staffId || null,
    };
    setSessionCookie(res, session);
    res.json({ ok: true, ...session, buildingCount: ownedBuildings.length });
  } catch (err) { next(err); }
});

// Per explicit user request: lets an owner with multiple buildings (same
// ownerId) switch which one the session is actively scoped to — called
// from /my-buildings when picking a building card. Re-verifies the
// target customerSheetId genuinely belongs to THIS session's ownerId
// server-side (never trusts the client blindly) before switching, so a
// tampered request can't hop into a building that isn't this owner's.
router.post('/select-building', async (req, res, next) => {
  try {
    const session = getSession(req);
    if (!session || !session.ownerId) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบก่อน' });
    const { customerSheetId } = req.body;
    if (!customerSheetId) return res.status(400).json({ error: 'ต้องระบุตึกที่ต้องการเข้า' });
    if (!DIRECTORY_SHEET_ID) return res.status(500).json({ error: 'ยังไม่ได้ตั้งค่า GOOGLE_DIRECTORY_SHEET_ID บนเซิร์ฟเวอร์' });

    const users = await runWithSheetId(DIRECTORY_SHEET_ID, () => readTab('Users'));
    let target = users.find((u) => u.ownerId === session.ownerId && u.customerSheetId === customerSheetId);
    // Per explicit user request: the platform admin can switch into ANY
    // building (e.g. to configure a brand-new one right after "+
    // เพิ่มตึกใหม่", before handing the real login to that customer) — not
    // just ones under their own ownerId. Re-checked server-side via
    // isPlatformAdminSession (ownership-based, not "currently active
    // building"), never trusts a client-side admin flag.
    if (!target && (await isPlatformAdminSession(session))) {
      target = users.find((u) => u.customerSheetId === customerSheetId);
    }
    if (!target) return res.status(403).json({ error: 'ตึกนี้ไม่ได้เป็นของบัญชีนี้' });
    // Per explicit user request: a paused/suspended building (see
    // server/routes/settings.js's toggle-building-status — for a
    // monthly-subscription customer who hasn't paid, say) can't be
    // entered until reactivated — the row and all its data stay intact,
    // just not selectable. Login itself still succeeds (an owner with
    // other active buildings shouldn't be locked out entirely).
    if (target.status === 'suspended') return res.status(403).json({ error: 'ตึกนี้ถูกพักการใช้งานชั่วคราว กรุณาติดต่อผู้ดูแลระบบ' });

    const newSession = { ...session, customerSheetId: target.customerSheetId, role: target.role, roomId: target.roomId || null, staffId: target.staffId || null };
    setSessionCookie(res, newSession);
    res.json({ ok: true, ...newSession });
  } catch (err) { next(err); }
});

// Per explicit user request: powers the /my-buildings picker — every
// building sharing the current session's ownerId, each resolved to its
// own display name (reads propertyProfile.name FROM that specific
// building's own Sheet, via runWithSheetId scoping each lookup — a
// small N+1 read, acceptable for the realistically small number of
// buildings one owner has).
async function resolveBuildingNames(rows, session) {
  return Promise.all(rows.map(async (u) => {
    let name = 'ตึกของคุณ';
    try {
      const settings = await runWithSheetId(u.customerSheetId, () => readSettings());
      if (settings.propertyProfile && settings.propertyProfile.name) name = settings.propertyProfile.name;
    } catch { /* fall back to the generic label above */ }
    return { customerSheetId: u.customerSheetId, name, isActive: u.customerSheetId === session.customerSheetId, status: u.status || 'active' };
  }));
}

router.get('/my-buildings', async (req, res, next) => {
  try {
    const session = getSession(req);
    if (!session) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบก่อน' });
    if (!DIRECTORY_SHEET_ID) return res.status(500).json({ error: 'ยังไม่ได้ตั้งค่า GOOGLE_DIRECTORY_SHEET_ID บนเซิร์ฟเวอร์' });

    const users = await runWithSheetId(DIRECTORY_SHEET_ID, () => readTab('Users'));
    const owned = session.ownerId
      ? users.filter((u) => u.ownerId === session.ownerId && u.customerSheetId)
      : users.filter((u) => u.customerSheetId === session.customerSheetId);
    const buildings = await resolveBuildingNames(owned, session);

    // Per explicit user request: the platform's own account (คุณต้น) needs
    // a way to open ANY building — most importantly a brand-new one, right
    // after "+ เพิ่มตึกใหม่" creates it — to configure rates/rooms/property
    // name BEFORE handing the real login over to that customer. Only ever
    // populated for the platform admin's own session (see isPlatformAdmin
    // elsewhere) — a regular customer's /my-buildings response never
    // includes this, so they can never see another customer's building
    // list this way.
    let allBuildings;
    if (await isPlatformAdminSession(session)) {
      const seen = new Set();
      const everyBuildingRow = users.filter((u) => {
        if (!u.customerSheetId || seen.has(u.customerSheetId)) return false;
        seen.add(u.customerSheetId);
        return true;
      });
      allBuildings = await resolveBuildingNames(everyBuildingRow, session);
    }

    res.json({ buildings, allBuildings });
  } catch (err) { next(err); }
});

// Per explicit user request: the shared LOGIN PIN for this owner's
// account (the "keycard" — separate from any single building's own
// adminEditPin, see server/routes/settings.js's change-admin-pin for
// that unrelated one). Updates EVERY directory row sharing this
// session's ownerId at once, so all of the owner's buildings keep using
// the same login PIN — that's the whole point of grouping by ownerId.
router.post('/change-login-pin', async (req, res, next) => {
  try {
    const session = getSession(req);
    if (!session || !session.ownerId) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบก่อน' });
    if (!DIRECTORY_SHEET_ID) return res.status(500).json({ error: 'ยังไม่ได้ตั้งค่า GOOGLE_DIRECTORY_SHEET_ID บนเซิร์ฟเวอร์' });
    const { oldPin, newPin } = req.body;
    if (!newPin || String(newPin).length < 4) return res.status(400).json({ error: 'กรุณาตั้งรหัสใหม่อย่างน้อย 4 ตัวอักษร' });

    const users = await runWithSheetId(DIRECTORY_SHEET_ID, () => readTab('Users'));
    const ownedRows = users.filter((u) => u.ownerId === session.ownerId);
    if (!ownedRows.length) return res.status(404).json({ error: 'ไม่พบบัญชีนี้ในสมุดรายชื่อกลาง' });
    const currentPin = ownedRows[0].pin;
    if (!oldPin || String(oldPin) !== String(currentPin)) return res.status(403).json({ error: 'รหัสเดิมไม่ถูกต้อง' });

    // Different OWNERS must not collide on the same PIN (login matches by
    // phone+pin together, so this only matters cross-owner — another row
    // belonging to THIS SAME owner already using newPin is a non-issue,
    // it's what we're about to set them all to anyway).
    const takenByOtherOwner = users.some((u) => u.ownerId !== session.ownerId && String(u.pin) === String(newPin));
    if (takenByOtherOwner) return res.status(409).json({ error: 'รหัสนี้มีบัญชีอื่นใช้งานอยู่แล้ว กรุณาตั้งรหัสอื่นครับ' });

    await Promise.all(ownedRows.map((u) =>
      runWithSheetId(DIRECTORY_SHEET_ID, () => updateRow('Users', u.customerSheetId, { pin: newPin }, 'customerSheetId'))
    ));
    res.json({ ok: true, buildingsUpdated: ownedRows.length });
  } catch (err) { next(err); }
});

router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// Plain clickable-link version of the same thing, purely for convenience
// during local testing (so a non-technical tester can clear a stray test
// session by clicking a link instead of needing dev tools / clearing
// browser cookies manually). Same effect as POST /logout above, just
// reachable by typing/clicking a URL, then bounces back to the dashboard.
router.get('/logout-link', (req, res) => {
  clearSessionCookie(res);
  res.redirect('/');
});

router.get('/me', async (req, res) => {
  const session = getSession(req);
  if (!session) return res.json({ role: null });
  // Per explicit user request: flags whether THIS session is the
  // platform's own account (คุณต้น's real production Sheet — the same
  // one the no-session fallback in sheets.js uses) vs a regular
  // customer's own building. Used to show admin-only tools (e.g. the
  // "+ เพิ่มตึกใหม่" directory-row form in Settings) only to us, never to
  // a customer, even though both log in through the exact same flow.
  // Ownership-based (see isPlatformAdminSession) so this stays true even
  // while the admin is browsing another customer's building.
  const isPlatformAdmin = await isPlatformAdminSession(session);
  // Per explicit user request (real bug hit): whether the CURRENTLY
  // ACTIVE building is the platform's own — needed to correctly show/hide
  // the sidebar's "กำลังดูข้อมูลของ..." warning badge. Login is now
  // mandatory for everyone including คุณต้น, so a session existing at all
  // is no longer a reliable "you're viewing someone else's data" signal
  // (his own session always has one too) — the badge should only ever
  // appear when the platform admin has switched INTO another customer's
  // building, never for his own or for a regular customer's own login.
  const isOwnBuildingActive = session.customerSheetId === process.env.GOOGLE_SHEET_ID;
  res.json({ ...session, isPlatformAdmin, isOwnBuildingActive });
});

module.exports = router;
module.exports.genOwnerId = genOwnerId;
module.exports.isPlatformAdminSession = isPlatformAdminSession;
