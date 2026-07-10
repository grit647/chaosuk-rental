const express = require('express');
const router = express.Router();
const { readTab } = require('../sheets');
const {
  coerceRooms, coerceInvoices, coerceMaintenance, coerceExpenses, coerceCalendar, coerceUnmatchedSlips, coerceStaff, coercePaymentLog, readSettings,
} = require('../coerce');

// Uses allSettled (not all) on purpose: if one tab's request is briefly flaky,
// the others should still come back instead of one bad promise taking the
// whole response (and, worse, leaving an unhandled rejection lying around).
router.get('/', async (req, res, next) => {
  try {
    const [rooms, invoices, maintenance, expenses, calEvents, unmatchedSlips, staff, paymentLog, settingsData] = await Promise.allSettled([
      readTab('Rooms').then(coerceRooms),
      readTab('Invoices').then(coerceInvoices),
      readTab('Maintenance').then(coerceMaintenance),
      readTab('Expenses').then(coerceExpenses),
      readTab('CalendarEvents').then(coerceCalendar),
      readTab('UnmatchedSlips').then(coerceUnmatchedSlips),
      readTab('Staff').then(coerceStaff),
      readTab('PaymentLog').then(coercePaymentLog),
      readSettings(),
    ]);

    const errors = [];
    const pick = (result, label, fallback) => {
      if (result.status === 'fulfilled') return result.value;
      errors.push(label + ': ' + result.reason.message);
      return fallback;
    };

    const payload = {
      rooms: pick(rooms, 'rooms', []),
      invoices: pick(invoices, 'invoices', []),
      maintenance: pick(maintenance, 'maintenance', []),
      expenses: pick(expenses, 'expenses', []),
      calEvents: pick(calEvents, 'calEvents', []),
      unmatchedSlips: pick(unmatchedSlips, 'unmatchedSlips', []),
      staff: pick(staff, 'staff', []),
      paymentLog: pick(paymentLog, 'paymentLog', []),
      ...pick(settingsData, 'settings', {
        propertyProfile: { name: '', adminName: '', adminPhone: '' },
        waterRate: 18, elecRate: 8, trashRate: 40, internetRate: 200,
        settings: { autoInvoice: true, dueReminder: true },
      }),
    };
    if (errors.length) {
      console.error('[bootstrap] partial failure:', errors.join('; '));
      payload._partialErrors = errors;
    }
    res.json(payload);
  } catch (err) { next(err); }
});

module.exports = router;
