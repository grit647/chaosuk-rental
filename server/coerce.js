const { readTab } = require('./sheets');

function num(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function bool(v, def = false) {
  if (v === true || v === 'TRUE' || v === 'true') return true;
  if (v === false || v === 'FALSE' || v === 'false') return false;
  return def;
}

function coerceRooms(rows) {
  return rows.map((r) => ({
    ...r,
    floor: num(r.floor, 1),
    rent: num(r.rent, 0),
    deposit: num(r.deposit, 0),
    waterPrev: num(r.waterPrev, 0),
    elecPrev: num(r.elecPrev, 0),
  }));
}

function coerceInvoices(rows) {
  return rows.map((r) => ({
    ...r,
    rent: num(r.rent, 0),
    water: num(r.water, 0),
    elec: num(r.elec, 0),
    trash: num(r.trash, 0),
    internet: num(r.internet, 0),
  }));
}

function coerceMaintenance(rows) {
  return rows.map((r) => ({ ...r, id: num(r.id) }));
}

function coerceExpenses(rows) {
  return rows.map((r) => ({ ...r, id: num(r.id), amount: num(r.amount, 0) }));
}

function coerceCalendar(rows) {
  return rows.map((r) => ({ ...r, id: num(r.id), y: num(r.y), m: num(r.m), d: num(r.d) }));
}

async function readSettings() {
  const rows = await readTab('Settings');
  const map = {};
  rows.forEach((r) => { map[r.key] = r.value; });
  return {
    propertyProfile: {
      name: map.propertyName || '',
      adminName: map.adminName || '',
      adminPhone: map.adminPhone || '',
    },
    waterRate: num(map.waterRate, 18),
    elecRate: num(map.elecRate, 8),
    trashRate: num(map.trashRate, 40),
    internetRate: num(map.internetRate, 200),
    settings: {
      autoInvoice: bool(map.autoInvoice, true),
      dueReminder: bool(map.dueReminder, true),
    },
  };
}

module.exports = {
  num, bool, coerceRooms, coerceInvoices, coerceMaintenance, coerceExpenses, coerceCalendar, readSettings,
};
