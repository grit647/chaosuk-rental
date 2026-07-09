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
  return rows.map((r) => {
    // creditBalance: money the tenant has paid in advance, not tied to any
    // specific invoice (paid before a bill existed to match against).
    // creditSlipsJson: slips still awaiting the owner's decision on that —
    // same accumulation pattern as an invoice's slipsJson, just scoped to
    // the room since there's no invoice id to hang it off of yet.
    let creditSlips = [];
    if (r.creditSlipsJson) {
      try { creditSlips = JSON.parse(r.creditSlipsJson); if (!Array.isArray(creditSlips)) creditSlips = []; } catch { creditSlips = []; }
    }
    return {
      ...r,
      floor: num(r.floor, 1),
      rent: num(r.rent, 0),
      deposit: num(r.deposit, 0),
      waterPrev: num(r.waterPrev, 0),
      elecPrev: num(r.elecPrev, 0),
      creditBalance: num(r.creditBalance, 0),
      creditSlips,
      creditSlipCount: creditSlips.length,
      creditSlipsTotal: creditSlips.reduce((a, s) => a + (Number(s.amount) || 0), 0),
    };
  });
}

function coerceInvoices(rows) {
  return rows.map((r) => {
    // A tenant can send more than one slip for the same bill (e.g. not
    // enough balance in one account, split across transfers) — slipsJson
    // holds every slip received so far as an array; slipAmount/slipDate/
    // slipSenderName/slipImageUrl still get kept in sync with the LATEST
    // slip for any older code path that only reads those singular fields.
    let slips = [];
    if (r.slipsJson) {
      try { slips = JSON.parse(r.slipsJson); if (!Array.isArray(slips)) slips = []; } catch { slips = []; }
    }
    const rent = num(r.rent, 0), water = num(r.water, 0), elec = num(r.elec, 0), trash = num(r.trash, 0), internet = num(r.internet, 0);
    const total = rent + water + elec + trash + internet;
    // amountPaid: cumulative amount actually received against this specific
    // invoice — lets a bill be "partial" (some money in, not fully settled)
    // instead of the old binary pending/paid.
    const amountPaid = num(r.amountPaid, 0);
    return {
      ...r,
      rent, water, elec, trash, internet,
      receiptSent: bool(r.receiptSent, false),
      slipPending: bool(r.slipPending, false),
      slipAmount: r.slipAmount === '' || r.slipAmount == null ? null : num(r.slipAmount, null),
      slips,
      slipCount: slips.length,
      slipsTotal: slips.reduce((a, s) => a + (Number(s.amount) || 0), 0),
      amountPaid,
      remainingDue: Math.max(0, total - amountPaid),
      // Purely a display preference for the Dashboard's "การชำระเงินล่าสุด"
      // widget — hiding an entry here does NOT delete the invoice or affect
      // any totals/reports, per explicit user request after they initially
      // got the full-delete confirm popup and clarified they only wanted
      // to declutter that one widget, not remove real bill data.
      hiddenFromDashboard: bool(r.hiddenFromDashboard, false),
    };
  });
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

function coerceUnmatchedSlips(rows) {
  return rows.map((r) => ({ ...r, amount: r.amount === '' || r.amount == null ? null : num(r.amount, null) }));
}

function coerceRecurringTasks(rows) {
  return rows.map((r) => ({
    ...r,
    dayOfMonth: r.dayOfMonth === '' ? null : num(r.dayOfMonth, null),
    dayOfWeek: r.dayOfWeek === '' ? null : num(r.dayOfWeek, null),
    active: bool(r.active, true),
  }));
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
    claudeAutomationEnabled: bool(map.claudeAutomationEnabled, false),
    // Never expose the actual PIN value to the client — only whether one is
    // set, so the Settings page knows to show "ตั้งรหัส" vs "เปลี่ยนรหัส".
    // The real value is only ever read server-side, in
    // server/routes/systemData.js's factory-reset check.
    hasDataResetPin: !!map.dataResetPin,
  };
}

module.exports = {
  num, bool, coerceRooms, coerceInvoices, coerceMaintenance, coerceExpenses, coerceCalendar, coerceRecurringTasks, coerceUnmatchedSlips, readSettings,
};
