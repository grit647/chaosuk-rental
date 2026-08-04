const express = require('express');
const router = express.Router();
const { readTabs } = require('../sheets');
const {
  coerceRooms, coerceInvoices, coerceMaintenance, coerceExpenses, coerceCalendar, coerceUnmatchedSlips, coerceStaff, coercePaymentLog, coercePaidReceipts, coerceScheduledMessages, readSettings,
} = require('../coerce');

// ScheduledMessages เพิ่มเข้ามา (2026-07-29) ให้หน้าบิลโชว์ป้าย "ตั้งเวลา
// ส่งไว้แล้ว" ได้ — เพิ่มเป็นแท็บที่ 10 ใน batchGet เดียวกัน (ไม่ใช่ readTab
// แยก) ตามเหตุผลเดียวกับ comment ด้านล่าง (กัน quota เกิน)
// PaidReceipts เพิ่มเข้ามา (2026-08-04) — อัลบั้มใบเสร็จ/สลิปย้อนหลัง
// เหตุผลเดียวกัน (แท็บที่ 11 ใน batchGet เดียวกัน ไม่ใช่ readTab แยก)
const TABS = ['Rooms', 'Invoices', 'Maintenance', 'Expenses', 'CalendarEvents', 'UnmatchedSlips', 'Staff', 'PaymentLog', 'Settings', 'ScheduledMessages', 'PaidReceipts'];

// 2026-07-24 — was 9 separate readTab() calls via Promise.allSettled (one
// per tab, kept independent on purpose so one flaky tab's request couldn't
// take the whole response down with it). Real "Quota exceeded for quota
// metric 'Read requests'" errors hit production, traced to this endpoint
// firing ~9 separate Google Sheets API requests EVERY single load — worse,
// every 30 seconds while the dashboard's auto-refresh toggle is on. All
// customer buildings share the same Google service account, so this quota
// pressure is platform-wide, not just one dashboard's problem. Switched to
// ONE batched values.batchGet call (readTabs, server/sheets.js) covering
// all 9 tabs at once — cuts this endpoint's Google API footprint ~9x.
//
// Trade-off: batchGet either succeeds or fails as a whole (can't have one
// tab fail independently the way 9 separate calls could). Handled with a
// try/catch that falls back to the same graceful empty-array/default
// values as before instead of a hard 500 — batchGet is one atomic HTTP
// call to Google, much less likely to fail in a way the old individual
// calls wouldn't also have failed together anyway (same network, same
// auth, same spreadsheet).
router.get('/', async (req, res, next) => {
  try {
    let data = {};
    try {
      data = await readTabs(TABS);
    } catch (err) {
      console.error('[bootstrap] batch read failed:', err.message);
    }

    const payload = {
      rooms: coerceRooms(data.Rooms || []),
      invoices: coerceInvoices(data.Invoices || []),
      maintenance: coerceMaintenance(data.Maintenance || []),
      expenses: coerceExpenses(data.Expenses || []),
      calEvents: coerceCalendar(data.CalendarEvents || []),
      unmatchedSlips: coerceUnmatchedSlips(data.UnmatchedSlips || []),
      staff: coerceStaff(data.Staff || []),
      paymentLog: coercePaymentLog(data.PaymentLog || []),
      scheduledMessages: coerceScheduledMessages(data.ScheduledMessages || []),
      paidReceipts: coercePaidReceipts(data.PaidReceipts || []),
      ...(await readSettings(data.Settings || [])),
    };
    res.json(payload);
  } catch (err) { next(err); }
});

module.exports = router;
