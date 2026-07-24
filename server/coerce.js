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
      // ค่าเช่าล่วงหน้า — advance rent collected at contract signing,
      // separate from เงินประกัน/deposit above (a different line item on
      // the lease, per explicit owner request). 0 means "none collected."
      advanceRent: num(r.advanceRent, 0),
      waterPrev: num(r.waterPrev, 0),
      elecPrev: num(r.elecPrev, 0),
      // Per-room water/elec rate, per explicit user request: rates used to
      // be a single property-wide value (server/routes/settings.js's
      // waterRate/elecRate), so saving one room's contract silently changed
      // every other room's rate too. 0 means "not set on this room" — the
      // frontend falls back to the global default rate for rooms that
      // never had their own rate saved (keeps old data working unchanged).
      waterRate: num(r.waterRate, 0),
      elecRate: num(r.elecRate, 0),
      // Minimum monthly charge per explicit user request — if a tenant's
      // actual usage-based charge (units × rate) comes out lower than
      // this, the bill charges the minimum instead (framed to the tenant
      // as ค่าดูแลมิเตอร์ — a meter-maintenance floor, not a real usage
      // number). 0 means "no minimum set" for this room.
      waterMinRate: num(r.waterMinRate, 0),
      elecMinRate: num(r.elecMinRate, 0),
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
      // Per explicit user request: the LINE receipt message needs to show
      // "X หน่วย × rate" for water/elec and the previous bill's reading —
      // neither survives past invoice-creation time otherwise, since the
      // room's own waterPrev/elecPrev baseline gets overwritten to THIS
      // bill's reading immediately on creation (submitInvoice). Captured
      // once at creation and frozen on the invoice itself so it stays
      // accurate no matter when the receipt is actually sent afterward.
      waterUnits: r.waterUnits === '' || r.waterUnits == null ? null : num(r.waterUnits, null),
      elecUnits: r.elecUnits === '' || r.elecUnits == null ? null : num(r.elecUnits, null),
      waterPrevReading: r.waterPrevReading === '' || r.waterPrevReading == null ? null : num(r.waterPrevReading, null),
      elecPrevReading: r.elecPrevReading === '' || r.elecPrevReading == null ? null : num(r.elecPrevReading, null),
      // The combined receipt-as-one-image actually sent via LINE (see
      // server/receiptImage.js + sendReceiptLine in Rental Management.dc.html)
      // — saved here so the owner can look it back up later (bill history
      // modal), since the image itself is only generated fresh at send time
      // and would otherwise be lost the moment the LINE push completes.
      receiptImageUrl: r.receiptImageUrl || '',
    };
  });
}

function coerceMaintenance(rows) {
  return rows.map((r) => ({ ...r, id: num(r.id) }));
}

function coerceExpenses(rows) {
  return rows.map((r) => ({ ...r, id: num(r.id), amount: num(r.amount, 0), hidden: bool(r.hidden, false) }));
}

// พนักงานหอพัก / สัญญาพนักงาน — per explicit user request for a staff
// management feature, separate from tenant leases (Rooms tab). payDay =
// day-of-month salary is paid (required — see server/routes/staff.js).
// lineUserId reserved for a future LINE-linking feature for staff
// notifications, same idea as Rooms' own lineUserId — owner added the
// column proactively even though nothing writes to it yet.
function coerceStaff(rows) {
  return rows.map((r) => ({
    ...r,
    id: num(r.id),
    salary: num(r.salary, 0),
    status: r.status || 'active',
    payDay: r.payDay || '',
    lineUserId: r.lineUserId || '',
  }));
}

function coerceCalendar(rows) {
  return rows.map((r) => ({ ...r, id: num(r.id), y: num(r.y), m: num(r.m), d: num(r.d) }));
}

function coerceUnmatchedSlips(rows) {
  return rows.map((r) => ({ ...r, amount: r.amount === '' || r.amount == null ? null : num(r.amount, null) }));
}

// See server/routes/paymentLog.js for what this ledger is for and why it
// exists (fixes the Dashboard's "รายรับเดือนนี้" missing advance-payment
// credit and partial payments — both real money that never touched an
// invoice's status).
function coercePaymentLog(rows) {
  return rows.map((r) => ({ ...r, amount: num(r.amount, 0) }));
}

function coerceRecurringTasks(rows) {
  return rows.map((r) => ({
    ...r,
    dayOfMonth: r.dayOfMonth === '' ? null : num(r.dayOfMonth, null),
    dayOfWeek: r.dayOfWeek === '' ? null : num(r.dayOfWeek, null),
    active: bool(r.active, true),
  }));
}

// Optional preloadedRows param (2026-07-24) — lets a caller that already
// fetched the 'Settings' tab as part of a batched readTabs() call (see
// server/sheets.js's readTabs, added to fix a real "Quota exceeded" error)
// pass those rows in directly instead of triggering a second separate
// Google Sheets API read. Every existing call site keeps working unchanged
// (still calls readTab('Settings') itself if no rows are passed in).
async function readSettings(preloadedRows) {
  const rows = preloadedRows || await readTab('Settings');
  const map = {};
  rows.forEach((r) => { map[r.key] = r.value; });
  return {
    propertyProfile: {
      name: map.propertyName || '',
      adminName: map.adminName || '',
      adminPhone: map.adminPhone || '',
      // The owner's own LINE User ID — lets the system push notifications
      // (overdue bills, slips awaiting review, recurring-task summaries)
      // straight to the owner's LINE, separate from the tenant-facing
      // messaging that already exists via server/line.js.
      adminLineUserId: map.adminLineUserId || '',
      // QR code for tenants to scan-and-pay — per explicit user request,
      // stored on Cloudinary (see server/cloudinary.js) so it survives
      // deploys, unlike the ephemeral local-disk uploads used for one-off
      // slip photos. Attached to the end of every outgoing LINE bill.
      paymentQrUrl: map.paymentQrUrl || '',
      // Per explicit user request: a short reference/ID code identifying
      // THIS specific building — separate from (and simpler to read/quote
      // over the phone than) the long Google Sheet ID. Purely a display/
      // reference field the owner sets themselves, no system logic reads
      // it yet.
      buildingKeyId: map.buildingKeyId || '',
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
    // Per-category admin LINE notification toggles — all default OFF
    // (per explicit user request, to avoid spamming/wasting resources
    // until the owner deliberately opts into each one). Only meaningful
    // once adminLineUserId is set; the UI disables these switches
    // entirely until then.
    adminNotify: {
      taskFailure: bool(map.notifyTaskFailure, false),
      slipPending: bool(map.notifySlipPending, false),
      overdueBill: bool(map.notifyOverdueBill, false),
      unmatchedSlip: bool(map.notifyUnmatchedSlip, false),
      maintenance: bool(map.notifyMaintenance, false),
      leaseExpiring: bool(map.notifyLeaseExpiring, false),
      // Default TRUE (unlike every other category above, which default
      // OFF) — per explicit owner request, this notification shipped as
      // always-on first, then the owner asked for a toggle to be added
      // afterward; defaulting it OFF here would have silently turned off
      // behavior that was already live in production the moment this
      // code deployed. New installs get it on by default; the owner can
      // still turn it off from Settings like any other category.
      wifiRequest: bool(map.notifyWifiRequest, true),
    },
    // Per explicit user request: lets the owner turn whole nav sections
    // on/off (e.g. selling this app to another building that doesn't use
    // Tuya devices or has no staff to track) — gated behind the same admin
    // PIN as the ข้อมูลหอพัก card (POST /api/settings/verify-admin-pin).
    // All default TRUE (on) so nothing changes for the current owner, who
    // already actively uses every one of these.
    featuresEnabled: {
      water: bool(map.featureWaterEnabled, true),
      elec: bool(map.featureElecEnabled, true),
      equipment: bool(map.featureEquipmentEnabled, true),
      staffContracts: bool(map.featureStaffContractsEnabled, true),
      staffMembers: bool(map.featureStaffMembersEnabled, true),
    },
    // Per explicit user request: each customer can now enter their OWN
    // LINE OA / Tuya Cloud credentials (see server/routes/settings.js's
    // lineCredentials/tuyaCredentials handling + the gear-icon UI) instead
    // of everyone sharing the values in server/.env. Only exposes WHETHER
    // one is set, never the actual secret — same pattern as
    // hasDataResetPin above. The real values are only ever read
    // server-side via readIntegrationCredentials() below, by the route
    // handlers that actually call out to LINE/Tuya.
    hasLineCredentials: !!(map.lineChannelAccessToken && map.lineChannelSecret),
    hasTuyaCredentials: !!(map.tuyaAccessId && map.tuyaAccessSecret),
  };
}

// Server-side only — NEVER returned from an API route directly to the
// client (unlike readSettings() above, which several routes send as-is).
// Reads this customer's own LINE/Tuya credentials (from whichever Sheet
// the current request is scoped to — see requestContext.js) for
// server/line.js and server/tuya.js to use, falling back to undefined
// fields when not set, which those modules' resolveCreds() then falls
// back to process.env for.
async function readIntegrationCredentials() {
  const rows = await readTab('Settings');
  const map = {};
  rows.forEach((r) => { map[r.key] = r.value; });
  return {
    line: (map.lineChannelAccessToken || map.lineChannelSecret) ? {
      accessToken: map.lineChannelAccessToken || '',
      channelSecret: map.lineChannelSecret || '',
    } : null,
    tuya: (map.tuyaAccessId || map.tuyaAccessSecret) ? {
      accessId: map.tuyaAccessId || '',
      accessSecret: map.tuyaAccessSecret || '',
      apiBase: map.tuyaApiBase || '',
    } : null,
  };
}

module.exports = {
  num, bool, coerceRooms, coerceInvoices, coerceMaintenance, coerceExpenses, coerceCalendar, coerceRecurringTasks, coerceUnmatchedSlips, coerceStaff, coercePaymentLog, readSettings, readIntegrationCredentials,
};
