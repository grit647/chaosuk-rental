// Per explicit owner request (2026-07-23): a staged-rollout gate so
// server-side work-in-progress can deploy to production (Render redeploys
// on every push, affecting every building at once — there's no separate
// staging environment) WITHOUT instantly changing what any live customer
// sees. Each building in the Directory sheet's Users tab carries its own
// `platformVersion` (an integer, defaults to 0 for legacy rows with no
// value yet) — a NEW customer-facing feature only renders for a building
// once building.platformVersion >= the version it shipped in.
//
// Bump CURRENT_PLATFORM_VERSION here every time a new customer-facing
// feature is added, and gate that feature's UI/behavior behind a check
// against the version it was introduced at (see the Dashboard's LINE OA
// usage card being the very first thing to use this, if it's ever
// retrofitted — nothing is gated retroactively as of v1, see below).
//
// Existing buildings stay pinned at whatever version they last accepted
// until คุณต้น explicitly clicks "🆕 อัปเดต" for that specific building (see
// the "ทุกตึกในระบบ (SERVER ONLY)" section of my-buildings.html — POST
// /api/settings/update-building-version bumps just that one building's
// row). A BRAND NEW building (added via "+ เพิ่มตึกใหม่" / prototype-auth/
// add-building.js) always starts at CURRENT_PLATFORM_VERSION instead of 0
// — there's nothing to protect a customer who hasn't started using the
// app yet from, so they should just get everything current immediately.
//
// v1 (2026-07-23): baseline version marking "everything shipped up to and
// including the Dashboard's LINE OA message-quota usage card" — that card
// was NOT gated behind this mechanism (it shipped before this system
// existed), so v1 is the starting point every existing building is
// backfilled to (see prototype-auth/migrate-add-platform-version.js).
//
// v2 (2026-07-23): first REAL use of this gate — adds "ค่ามัดจำห้อง"
// (deposit) and "ค่าเช่าล่วงหน้า" (advance rent, a brand-new
// `advanceRent` Rooms-tab column — see prototype-auth/
// migrate-add-advance-rent.js) fields to the "กรอกข้อมูลสัญญาเช่า"
// contract form. Gated in Rental Management.dc.html behind
// `authSession.platformVersion >= 2` (render var `cfShowDepositFields`).
// IMPORTANT: unlike the Directory-sheet platformVersion column (shared,
// migrated once), migrate-add-advance-rent.js writes to EACH building's
// OWN Rooms tab — it must be re-run (passing that building's
// customerSheetId as the CLI arg) for every building BEFORE clicking
// "🆕 อัปเดต" for it, or the new field will show in the UI but silently
// fail to persist (the sheet has no column to write into yet).
// v3 (2026-07-24): "คาลิเบรตมิเตอร์น้ำ" (water meter calibration) — a new
// input+button in the Equipment page's water device panel that lets an
// owner type a device's real "Total Use" reading from the Tuya mobile app
// and instantly correct the web's own pulse-reconstructed cumulative total
// to match (POST /api/tuya/calibrate-water, server/routes/tuya.js). Gated
// because it only works for buildings whose own spreadsheet already has the
// `WaterLog` tab (see the "Permanent gotcha" note above — not every
// customer Sheet has it) and are actually using Tuya water flowmeters; a
// building without either would see a button that silently errors on click.
// Gated in Rental Management.dc.html behind `authSession.platformVersion >=
// 3` (render var `cfShowWaterCalibrate`).
//
// v4 (2026-07-29): the FIRST gate on backend/server-side automation
// BEHAVIOR, not a frontend UI element — server/routes/scheduler.js's
// GET /run (external cron ping) used to only ever check the main
// account's spreadsheet, so every other building's automation switches
// (cutoffWarning, dueReminder, leaseExpiring, ตั้งเวลาส่งบิล, etc.) were
// silently no-ops even when a building's own owner had turned them on,
// believing they worked. Fixed to loop over every building in the
// Directory — but per the same "no surprise changes" reasoning as every
// other entry here, an existing building must not suddenly start
// receiving real LINE messages to its real tenants (cutoff/overdue/
// lease-expiring notices) it never got before, with zero warning. Gated
// in scheduler.js's route handler: a Directory row's own building only
// gets included in the per-building automation loop once its
// platformVersion >= 4 (the main account itself is exempt from this
// check — it already ran this exact logic before the fix, so nothing
// changes for it either way). คุณต้น clicks "🆕 อัปเดต" per building once
// he's ready for that building's automation to actually start firing.
// v5 (2026-08-01): the FIRST gate that can actively BLOCK an existing
// customer-facing action, not just add a new one — per owner request
// ("ต้องเอาราคาที่กำหนดจากสัญญาเช่าไปคิด...ถ้าไม่มี กำหนดให้เป็นข้อความ
// 'ยังไม่กรอกอัตราค่าบริการ'"), submitInvoice/submitBulkInvoice/
// chooseBulkInvoiceMode now REFUSE to bill a room's water/elec until that
// room has its own rate set in its lease contract (roomOwnRateMissing),
// instead of silently falling back to the shared property-wide rate.
// Deploying this ungated would have instantly stopped ANY building from
// issuing bills for rooms that never had a contract rate typed in —
// exactly the "no surprise changes" scenario this whole mechanism exists
// to prevent (see v4's note above, same reasoning, but this time the
// change is a restriction rather than a new capability). Gated behind
// `authSession.platformVersion >= 5` (render var `cfEnforceContractRate`).
const CURRENT_PLATFORM_VERSION = 5;

module.exports = { CURRENT_PLATFORM_VERSION };
