// Shared helper for pushing a LINE message to the owner/admin's own linked
// LINE account (propertyProfile.adminLineUserId — see the "ผู้ดูแลหอพัก"
// card in Settings) — separate from the tenant-facing messaging in
// server/line.js. Every call is gated behind BOTH the owner having
// connected their LINE account AND having explicitly turned on that
// specific notification category (server/coerce.js's readSettings()
// adminNotify object) — per explicit user request, nothing gets sent
// unless deliberately opted into.
const { pushMessage, isConfigured: lineConfigured } = require('./line');
const { readSettings } = require('./coerce');

// category must match one of the keys in readSettings()'s adminNotify:
// taskFailure | slipPending | overdueBill | unmatchedSlip | maintenance | leaseExpiring | wifiRequest
// (wifiRequest is a special case — it fans out to the owner AND every
// linked ผู้ดูแล, not just the owner, so server/routes/line.js's
// action=wifi handler checks settings.adminNotify.wifiRequest directly
// and pushes to multiple recipients itself, rather than calling this
// single-recipient notifyAdmin() helper.)
async function notifyAdmin(category, message) {
  if (!lineConfigured()) return;
  try {
    const settings = await readSettings();
    const adminId = settings.propertyProfile && settings.propertyProfile.adminLineUserId;
    if (!adminId) return;
    if (!settings.adminNotify || !settings.adminNotify[category]) return;
    await pushMessage(adminId, message);
  } catch (err) {
    // Never let a notification failure break the caller's real work
    // (slip handling, scheduler run, etc.) — just log it.
    console.error('[adminNotify] failed to send', category, err.message);
  }
}

module.exports = { notifyAdmin };
