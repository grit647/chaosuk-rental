// ONE-OFF READ-ONLY INVESTIGATION (2026-08-13) — owner asked to check
// whether the huge LINE-message spikes on 02/08 (146 msgs) and 04/08
// (93 msgs) — confirmed from LINE OA Manager's own real analytics —
// were caused by duplicate sends (matching the ScheduledMessages id-
// collision class of bug found+fixed today). Looks for concrete evidence
// still present in the Sheet: receiptSendCount on invoices (paid or not)
// created/due around early August, and any ScheduledMessages rows using
// the OLD collision-prone id format (`<timestamp>-invoice` with no room/
// randomness) that might still be lingering from before today's fix.
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
  const [invoices, scheduled] = await Promise.all([readTab(sheets, 'Invoices'), readTab(sheets, 'ScheduledMessages')]);

  console.log('--- 1. receiptSendCount across ALL invoices (paid + pending) ---');
  const withSendCount = invoices.filter((i) => i.receiptSendCount !== '' && Number(i.receiptSendCount) > 0);
  withSendCount
    .sort((a, b) => Number(b.receiptSendCount) - Number(a.receiptSendCount))
    .forEach((i) => console.log(`ห้อง ${i.room} — ${i.id} — status=${i.status} — receiptSendCount=${i.receiptSendCount} — receiptDeliveryConfirmed=${i.receiptDeliveryConfirmed}`));
  console.log('Total invoices with receiptSendCount > 0:', withSendCount.length);
  console.log('Invoices with receiptSendCount >= 2 (retried at least once):', invoices.filter((i) => Number(i.receiptSendCount) >= 2).length);

  console.log('\n--- 2. Invoice ids created in early August (timestamp-based ids embed creation time) ---');
  // INV-<room>-<epochMillis> — filter for epoch corresponding to Aug 1-5, 2026
  const aug1 = new Date('2026-08-01T00:00:00+07:00').getTime();
  const aug6 = new Date('2026-08-06T00:00:00+07:00').getTime();
  invoices.forEach((i) => {
    const m = /INV-.+-(\d{13})$/.exec(i.id);
    if (!m) return;
    const ts = Number(m[1]);
    if (ts >= aug1 && ts < aug6) {
      console.log(`ห้อง ${i.room} — ${i.id} — created ${new Date(ts).toISOString()} — status=${i.status} — receiptSendCount=${i.receiptSendCount || 0}`);
    }
  });

  console.log('\n--- 3. ScheduledMessages rows using the OLD collision-prone id format (no room/random suffix) ---');
  const oldFormatIds = scheduled.filter((m) => /^\d{13}-invoice$/.test(m.id));
  console.log('Rows with old-format id (`<timestamp>-invoice`, no room/random suffix):', oldFormatIds.length);
  oldFormatIds.forEach((m) => console.log(`  id=${m.id} room=${m.room} sent=${m.sent} sendAt=${m.sendAt} source=${m.source}`));

  console.log('\n--- 4. All ScheduledMessages rows sorted by id (chronological) — look for tight clusters ---');
  scheduled
    .map((m) => ({ ...m, ts: Number((/^(\d{10,13})/.exec(m.id) || [])[1]) || 0 }))
    .filter((m) => m.ts > 0)
    .sort((a, b) => a.ts - b.ts)
    .forEach((m) => console.log(`${new Date(m.ts).toISOString()} — room=${m.room} sent=${m.sent} source=${m.source} sendAt=${m.sendAt}`));
}
main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
