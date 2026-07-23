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
// backfilled to (see prototype-auth/migrate-add-platform-version.js),
// not something anyone needs to click "อัปเดต" to unlock. The NEXT new
// feature after this is the first one that should actually bump this to
// 2 and gate behind `platformVersion >= 2`.
const CURRENT_PLATFORM_VERSION = 1;

module.exports = { CURRENT_PLATFORM_VERSION };
