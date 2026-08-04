// One-time migration: creates a new "NotifyLog" tab — replaces the old
// in-memory `_cutoffNotifiedDates` Map in server/routes/scheduler.js that
// was used to prevent sending the same daily reminder more than once.
//
// Real bug found (2026-08-04): the owner reported a room getting the
// same "ค่าเช่าห้องของท่านใกล้ถึงกำหนดชำระแล้ว" LINE message repeatedly,
// roughly every 20-70 minutes, all within one day. Root cause: Render's
// free tier sleeps after ~15 min idle, but UptimeRobot only pings every
// 20 min (longer than the sleep threshold) — so every ping cold-starts
// the server, wiping the in-memory dedup Map. The scheduler then thinks
// "never sent today" on every single run and re-sends. This affected
// every notification type sharing that Map: cutoff warnings (owner +
// tenant), due-date reminders, and lease/ID-expiring notices.
//
// Fix: persist "already notified today" state to this Sheet tab instead
// of RAM, so a server restart never loses it. Columns: id, key, date
// (date = YYYY-MM-DD, Bangkok time — matches the format already used
// throughout scheduler.js's dedup keys).
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

const TAB_NAME = 'NotifyLog';
const HEADER = ['id', 'key', 'date'];

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
    range: `${TAB_NAME}!A1:C1`,
    valueInputOption: 'RAW',
    requestBody: { values: [HEADER] },
  });
  console.log(`Created "${TAB_NAME}" tab with header:`, HEADER.join(', '));
}

main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
