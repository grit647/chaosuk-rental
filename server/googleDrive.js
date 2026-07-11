// Per explicit user request: "ลบ" for a building now also moves its
// actual Google Sheet to the Trash (NOT permanent delete) — recoverable
// for ~30 days from Google Drive's own trash, same safety net as
// deleting any file normally. Deliberately NOT a hard/permanent delete
// (files.delete) — a misclick on the wrong building would otherwise
// destroy a real customer's rooms/tenants/bills with zero way to
// recover, which is too severe a risk for a single button click.
//
// Uses a SEPARATE, narrower-scoped auth client than server/sheets.js's
// (Drive API, not just Sheets API) so the broader Drive scope is only
// requested for this one specific action, not for every Sheets read/
// write the app does everywhere else.
const { google } = require('googleapis');

async function driveClient() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/drive']
  );
  return google.drive({ version: 'v3', auth });
}

async function trashSheet(sheetId) {
  const drive = await driveClient();
  await drive.files.update({ fileId: sheetId, requestBody: { trashed: true } });
}

module.exports = { trashSheet };
