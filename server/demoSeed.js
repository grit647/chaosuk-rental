// Reusable demo-data seeding logic — shared by prototype-auth/seed-demo-
// data.js (one-time manual run) and server/routes/demoReset.js (the
// hourly cron re-run). Per explicit user request: resets the dedicated
// Demo Sheet (never real customer data — see DEMO_SHEET_ID) back to a
// fresh baseline, discarding anything a visitor typed/saved. Scoped
// first to making the "บิล & ใบแจ้งหนี้" page meaningful — a few rooms
// in different billing states (paid, pending, overdue, vacant).
const { runWithSheetId } = require('./requestContext');
const { clearTab, appendRow } = require('./sheets');

async function seedDemoData(demoSheetId) {
  return runWithSheetId(demoSheetId, async () => {
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
      { id: 'DEMO-INV-101-1', room: '101', tenant: 'สมชาย ใจดี (ตัวอย่าง)', rent: 3500, water: 90, elec: 160, trash: 40, internet: 5, due: iso(addDays(today, 6)), status: 'pending', waterUnits: 5, elecUnits: 20 },
      { id: 'DEMO-INV-102-1', room: '102', tenant: 'สายฝน รุ่งเรือง (ตัวอย่าง)', rent: 4000, water: 108, elec: 200, trash: 40, internet: 5, due: iso(addDays(today, -4)), status: 'overdue', waterUnits: 6, elecUnits: 25 },
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
      { key: 'adminEditPin', value: '1234' },
      { key: 'dataResetPin', value: '1234' },
    ];

    const allTabs = ['Rooms', 'Staff', 'Invoices', 'PaymentLog', 'Maintenance', 'Expenses', 'CalendarEvents', 'Settings', 'ElectricityLog', 'ScheduledMessages', 'RecurringTasks', 'UnmatchedSlips', 'Admins'];
    for (const tab of allTabs) await clearTab(tab);

    for (const r of rooms) await appendRow('Rooms', r);
    for (const i of invoices) await appendRow('Invoices', i);
    for (const s of settingsRows) await appendRow('Settings', s);

    return { rooms: rooms.length, invoices: invoices.length };
  });
}

module.exports = { seedDemoData };
