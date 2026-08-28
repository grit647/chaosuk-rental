// ONE-OFF READ-ONLY: gather real parameters (room count, tenant LINE-link
// count, admin count, notification toggles) for บ้านเลขที่1873 to build an
// accurate monthly LINE-quota usage estimate for the owner.
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
  const [rooms, admins, settings] = await Promise.all([
    readTab(sheets, 'Rooms'), readTab(sheets, 'Admins'), readTab(sheets, 'Settings'),
  ]);
  const occupied = rooms.filter((r) => r.tenant);
  const tenantsWithLine = occupied.filter((r) => r.lineUserId);
  const adminsWithLine = admins.filter((a) => a.lineUserId);
  const settingsMap = {};
  settings.forEach((r) => { settingsMap[r.key] = r.value; });
  console.log('Total rooms:', rooms.length);
  console.log('Occupied rooms (มีผู้เช่า):', occupied.length);
  console.log('Occupied rooms with LINE linked:', tenantsWithLine.length);
  console.log('Admins (ผู้ดูแล) total:', admins.length);
  console.log('Admins with LINE linked:', adminsWithLine.length);
  console.log('adminLineUserId (owner) set:', !!settingsMap.adminLineUserId);
  console.log('\n--- Notification toggle settings (raw) ---');
  ['dueReminder', 'cutoffWarning', 'leaseExpiring', 'wifiRequest'].forEach((k) => {
    const row = settings.find((r) => r.key === 'adminNotify');
    console.log(k, ':', row ? '(check adminNotify JSON below)' : '(no direct row)');
  });
  const adminNotifyRow = settings.find((r) => r.key === 'adminNotify');
  console.log('adminNotify raw value:', adminNotifyRow ? adminNotifyRow.value : '(not found)');
  const dueReminderRow = settings.find((r) => r.key === 'dueReminder');
  console.log('dueReminder raw value:', dueReminderRow ? dueReminderRow.value : '(not found)');
  const dueReminderDaysRow = settings.find((r) => r.key === 'dueReminderDays');
  console.log('dueReminderDays:', dueReminderDaysRow ? dueReminderDaysRow.value : '(default 3)');
  console.log('\n--- Actual notify* toggle keys ---');
  ['notifyTaskFailure', 'notifySlipPending', 'notifyOverdueBill', 'notifyUnmatchedSlip', 'notifyLeaseExpiring', 'notifyWifiRequest', 'notifyCutoffWarning'].forEach((k) => {
    const row = settings.find((r) => r.key === k);
    console.log(k, ':', row ? row.value : '(not set — using code default)');
  });
  const cutoffReminderDay = settings.find((r) => r.key === 'cutoffReminderDay');
  const cutoffFinalDay = settings.find((r) => r.key === 'cutoffFinalDay');
  const cutoffCancelWarningDay = settings.find((r) => r.key === 'cutoffCancelWarningDay');
  console.log('cutoffReminderDay:', cutoffReminderDay ? cutoffReminderDay.value : '(default 5)');
  console.log('cutoffFinalDay:', cutoffFinalDay ? cutoffFinalDay.value : '(default 15)');
  console.log('cutoffCancelWarningDay:', cutoffCancelWarningDay ? cutoffCancelWarningDay.value : '(default 25)');
  const leaseExpiringDays = settings.find((r) => r.key === 'leaseExpiringReminderDays');
  console.log('leaseExpiringReminderDays:', leaseExpiringDays ? leaseExpiringDays.value : '(default 7)');
  const enforceReceiptConfirm = rooms.length; // just to keep structure; real check below
  console.log('\nplatformVersion for this building (v6 receipt-confirm gate, v7 daily cutoff, v8 cutoff-full-payment):', 'see check-platform-versions.js output (was 9)');
}
main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
