// Seeds (or re-seeds) baseline demo data into the dedicated Demo Sheet —
// per explicit user request, focused first on making the "บิล & ใบแจ้งหนี้"
// page meaningful (a few rooms in different billing states: paid,
// pending, overdue, plus one vacant room). This same script is what the
// hourly reset cron (server/routes/demoReset.js) re-runs to restore a
// fresh baseline — CLEARS every data tab first, so it's always safe to
// re-run, never accumulates leftover visitor data.
//
// Deliberately NOT touching Settings' adminEditPin/dataResetPin here —
// those get a fixed simple demo value so the "ข้อมูลหอพัก" card's PIN
// gate is trivially discoverable by a demo visitor (no real security
// needed on throwaway data that resets hourly anyway).
require('dotenv').config({ path: require('path').join(__dirname, '..', 'server', '.env') });
const { google } = require('googleapis');

const DEMO_SHEET_ID = process.argv[2] || process.env.DEMO_SHEET_ID;

async function client() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  return google.sheets({ version: 'v4', auth });
}

async function getHeader(sheets, tab) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: DEMO_SHEET_ID, range: `${tab}!A1:ZZ1` });
  return (res.data.values || [[]])[0] || [];
}

function objectToRow(header, obj) {
  return header.map((key) => {
    const v = obj[key];
    if (v === undefined || v === null) return '';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return v;
  });
}

async function clearAndWrite(sheets, tab, rows) {
  await sheets.spreadsheets.values.clear({ spreadsheetId: DEMO_SHEET_ID, range: `${tab}!A2:ZZ100000` });
  if (!rows.length) return;
  const header = await getHeader(sheets, tab);
  const values = rows.map((r) => objectToRow(header, r));
  await sheets.spreadsheets.values.update({
    spreadsheetId: DEMO_SHEET_ID,
    range: `${tab}!A2`,
    valueInputOption: 'RAW',
    requestBody: { values },
  });
}

async function main() {
  if (!DEMO_SHEET_ID) throw new Error('DEMO_SHEET_ID not set (pass as arg or env var)');
  console.log('Seeding demo data into:', DEMO_SHEET_ID);
  const sheets = await client();

  const today = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const addDays = (base, n) => { const d = new Date(base); d.setDate(d.getDate() + n); return d; };

  const rooms = [
    { id: '101', floor: 1, status: 'occupied', tenant: 'สมชาย ใจดี (ตัวอย่าง)', phone: '081-234-5671', rent: 3500, moveIn: iso(addDays(today, -180)), contractEnd: iso(addDays(today, 185)), deposit: 7000, waterMeterNo: 'W-101', elecMeterNo: 'E-101', waterPrev: 120, waterCurr: '125', elecPrev: 300, elecCurr: '320', wifiCode: 'demo1234', dueDay: '5' },
    { id: '102', floor: 1, status: 'overdue', tenant: 'สายฝน รุ่งเรือง (ตัวอย่าง)', phone: '081-234-5672', rent: 4000, moveIn: iso(addDays(today, -90)), contractEnd: iso(addDays(today, 275)), deposit: 8000, waterMeterNo: 'W-102', elecMeterNo: 'E-102', waterPrev: 80, waterCurr: '86', elecPrev: 210, elecCurr: '235', wifiCode: 'demo1234', dueDay: '1' },
    { id: '103', floor: 2, status: 'occupied', tenant: 'ประยุทธ มั่งมี (ตัวอย่าง)', phone: '081-234-5673', rent: 4500, moveIn: iso(addDays(today, -30)), contractEnd: iso(addDays(today, 335)), deposit: 9000, waterMeterNo: 'W-103', elecMeterNo: 'E-103', waterPrev: 40, waterCurr: '44', elecPrev: 150, elecCurr: '168', wifiCode: 'demo1234', dueDay: '10' },
    { id: '104', floor: 2, status: 'vacant', tenant: '', phone: '', rent: 3800, moveIn: '', contractEnd: '', deposit: 7600, waterMeterNo: 'W-104', elecMeterNo: 'E-104', waterPrev: 0, waterCurr: '0', elecPrev: 0, elecCurr: '0', wifiCode: '', dueDay: '' },
  ];

  const invoices = [
    // 101 — pending, due soon (shows the "รอชำระ" state)
    { id: 'DEMO-INV-101-1', room: '101', tenant: 'สมชาย ใจดี (ตัวอย่าง)', rent: 3500, water: 90, elec: 160, trash: 40, internet: 5, due: iso(addDays(today, 6)), status: 'pending', waterUnits: 5, elecUnits: 20 },
    // 102 — overdue (shows the "เกินกำหนด" state)
    { id: 'DEMO-INV-102-1', room: '102', tenant: 'สายฝน รุ่งเรือง (ตัวอย่าง)', rent: 4000, water: 108, elec: 200, trash: 40, internet: 5, due: iso(addDays(today, -4)), status: 'overdue', waterUnits: 6, elecUnits: 25 },
    // 103 — already paid last cycle (shows the "จ่ายแล้ว" / history state)
    { id: 'DEMO-INV-103-1', room: '103', tenant: 'ประยุทธ มั่งมี (ตัวอย่าง)', rent: 4500, water: 72, elec: 144, trash: 40, internet: 5, due: iso(addDays(today, -20)), status: 'paid', paidDate: iso(addDays(today, -21)), waterUnits: 4, elecUnits: 18, amountPaid: 4761 },
  ];

  const settingsRows = [
    { key: 'propertyName', value: 'เช่าสุข — เดโม' },
    { key: 'adminName', value: 'ผู้ดูแลเดโม' },
    { key: 'adminPhone', value: '080-000-0000' },
    { key: 'waterRate', value: '18' },
    { key: 'elecRate', value: '8' },
    { key: 'trashRate', value: '40' },
    { key: 'internetRate', value: '5' },
    // Trivially simple — this is throwaway data that resets hourly, no
    // real security value in a hard-to-guess PIN here.
    { key: 'adminEditPin', value: '1234' },
    { key: 'dataResetPin', value: '1234' },
  ];

  await clearAndWrite(sheets, 'Rooms', rooms);
  await clearAndWrite(sheets, 'Invoices', invoices);
  await clearAndWrite(sheets, 'Settings', settingsRows);
  // Everything else (Staff, PaymentLog, Maintenance, Expenses,
  // CalendarEvents, ElectricityLog, ScheduledMessages, RecurringTasks,
  // UnmatchedSlips, Admins) starts empty — nothing needed there for the
  // billing-page demo specifically, other pages will get their own seed
  // data when their tour gets built later.
  for (const tab of ['Staff', 'PaymentLog', 'Maintenance', 'Expenses', 'CalendarEvents', 'ElectricityLog', 'ScheduledMessages', 'RecurringTasks', 'UnmatchedSlips', 'Admins']) {
    await clearAndWrite(sheets, tab, []);
  }

  console.log('Demo data seeded: 4 rooms (1 pending, 1 overdue, 1 paid history, 1 vacant), matching invoices, basic settings.');
}

main().catch((err) => { console.error('Seed failed:', err.message); process.exit(1); });
