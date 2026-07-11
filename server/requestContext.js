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

module.exports = { runWithSheetId, getCurrentSheetId };
