// ONE-OFF READ-ONLY: owner asked "how did we exceed 300 LINE messages this
// month when the whole app was down/unusable for several days?" — check
// NotifyLog (dedup log for scheduler-driven notifications: cutoffWarning,
// dueReminder, leaseExpiring, postCutoff) to see the DATE DISTRIBUTION of
// notifications actually fired this month — looking for a "burst" pattern
// right after the Render outage ended (per user memory: outage was around
// 2026-08-22/23), which would explain a sudden spike in LINE sends once
// the scheduler resumed and found many rooms simultaneously overdue.
const path = require('path');
require(path.join(__dirname, '..', 'server', 'node_modules', 'dotenv')).config({
  path: path.join(__dirname, '..', 'server', '.env'),
});
const { google } = require(path.join(__dirname, '..', 'server', 'node_modules', 'googleapis'));

const SHEET_ID = '1moUMiEhF2Ie76_Ep8_rgtefWenlQXx7vEUyaO0exk4E';

async function client() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets.readonly']
  );
  return google.sheets({ version: 'v4', auth });
}
function rowsToObjects(values) {
  const [header, ...rows] = values;
  if (!header) return [];
  return rows.map((row) => {
    const obj = {};
    header.forEach((h, i) => { obj[h] = row[i] !== undefined ? row[i] : ''; });
    return obj;
  });
}
async function readTab(sheets, tab) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tab}!A1:ZZ100000` });
  return rowsToObjects(res.data.values || [[]]);
}

async function main() {
  const sheets = await client();
  const notifyLog = await readTab(sheets, 'NotifyLog');
  console.log('Total NotifyLog rows:', notifyLog.length);
  const byDate = {};
  notifyLog.forEach((r) => { byDate[r.date] = (byDate[r.date] || 0) + 1; });
  const dates = Object.keys(byDate).sort();
  console.log('\n--- Notifications per date ---');
  dates.forEach((d) => console.log(d, ':', byDate[d]));
  console.log('\n(Note: NotifyLog is pruned after 3 days per its own retention policy, so old dates may already be gone — this only shows what still remains.)');
}
main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
