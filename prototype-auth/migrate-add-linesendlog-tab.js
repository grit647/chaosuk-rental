// One-time migration: creates a new "LineSendLog" tab — per explicit
// owner request ("การส่งข้อมูลของเราภายใน[เดือน]นี้ มันดูได้ไหมครับ
// ประวัติการส่ง" → chose "สรุปเร็วๆ" scope), 2026-08-13, right after
// building the LINE-quota self-tracking feature (server/line.js's
// incrementLineQuotaCounter). This tab is the sending-history log behind
// the Dashboard/Settings "ดูประวัติการส่ง" view — every real push-type
// LINE send (pushMessage/pushButtonMessage/pushMessageWithConfirmButton/
// pushLinkButton) appends one row here.
//
// Columns: id, timestamp (ISO), to (raw LINE user id — resolved to a
// readable room/admin name only when VIEWING the log, not at write time,
// to avoid an extra Sheets read on every single send), category (short
// Thai label, e.g. "ใบแจ้งหนี้", "แจ้งเตือนตัดไฟ", "WiFi").
//
// Per CLAUDE.md's "Permanent gotcha" — every customer building has its
// own SEPARATE spreadsheet, so this must be run against each one
// individually (pass the target spreadsheetId as the CLI arg), not just
// the main account.
const path = require('path');
require(path.join(__dirname, '..', 'server', 'node_modules', 'dotenv')).config({
  path: path.join(__dirname, '..', 'server', '.env'),
});
const { google } = require(path.join(__dirname, '..', 'server', 'node_modules', 'googleapis'));

const TAB_NAME = 'LineSendLog';
const HEADER = ['id', 'timestamp', 'to', 'category'];

async function main() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.argv[2] || process.env.GOOGLE_SHEET_ID;
  console.log('Target spreadsheet:', spreadsheetId);

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets.find((s) => s.properties.title === TAB_NAME);
  if (existing) {
    console.log(`Tab "${TAB_NAME}" already exists — nothing to do.`);
    return;
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: TAB_NAME } } }] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${TAB_NAME}!A1:D1`,
    valueInputOption: 'RAW',
    requestBody: { values: [HEADER] },
  });
  console.log(`Created "${TAB_NAME}" tab with header:`, HEADER.join(', '));
}

main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
