// Per explicit user request: lets sheets.js resolve a DIFFERENT Google
// Sheet per request (customer #2's data instead of the owner's own),
// without threading a sheetId parameter through every single route file
// (~15 files) that currently calls readTab('Rooms') etc. the same way it
// always has.
//
// AsyncLocalStorage gives each incoming HTTP request its own private
// "context" that survives across all the awaits inside that request's
// handler chain, without leaking into other concurrent requests. The auth
// middleware (server/index.js) sets the logged-in user's customerSheetId
// here at the start of a request; sheets.js reads it back via
// getCurrentSheetId(). Requests with NO valid session (which is every
// single request today, since nothing requires login yet) fall through to
// undefined here, and sheets.js falls back to process.env.GOOGLE_SHEET_ID
// exactly as it always has — zero behavior change for the current owner
// until login actually gets wired up to require it.
const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

function runWithSheetId(sheetId, fn) {
  return storage.run({ sheetId }, fn);
}

function getCurrentSheetId() {
  const store = storage.getStore();
  return store ? store.sheetId : undefined;
}

// Per explicit user bug report: "ส่งข้อมูล (LINE)" on the Bills page
// started failing with "ยังไม่ได้ตั้งค่า LINE" for คุณต้น's own real
// account — even though his real LINE OA has been working fine this
// whole session (webhook, rich menus, slip photos, everything). Root
// cause: server/routes/line.js's POST /send and GET /status (and the
// equivalent Tuya routes) treat ANY session carrying a customerSheetId
// as "a multi-tenant customer who must have their OWN saved
// credentials, no falling back to the shared server/.env values" — a
// deliberate security fix for genuinely separate customers (so customer
// #2 never silently sends through คุณต้น's real LINE OA). But once the
// login wall went in (requireLogin on '/'), คุณต้น's OWN account ALSO
// always carries a session now — and he never saved his own
// lineChannelAccessToken/lineChannelSecret into HIS OWN Settings sheet,
// because server/.env already IS his real credentials (they always
// were, from before the login system existed). The fix: a session
// whose customerSheetId literally equals process.env.GOOGLE_SHEET_ID
// (i.e. this IS the main/original account, not some other customer's
// building) should still be allowed to fall back to the shared
// server/.env values — only a session pointing at a DIFFERENT sheet
// (an actual separate customer) needs its own saved credentials.
function isMainAccountSheetId(sheetId) {
  return !!sheetId && sheetId === process.env.GOOGLE_SHEET_ID;
}

module.exports = { runWithSheetId, getCurrentSheetId, isMainAccountSheetId };
