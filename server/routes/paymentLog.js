const express = require('express');
const router = express.Router();
const { appendRow, readTab } = require('../sheets');
const { coercePaymentLog } = require('../coerce');

// Real accounting bug the owner caught: the Dashboard's "รายรับเดือนนี้"
// figure only ever summed invoices with status === 'paid' — a tenant's
// advance-payment/credit confirmation (confirmCreditSlips, resolveSlip's
// 'credit' mode) is real money received but never touches an invoice at
// all (it only updates room.creditBalance), so it silently never showed
// up as revenue anywhere. A 'partial' payment had the same gap — only the
// FULL bill total counted, never the partial amount actually received.
//
// This is an append-only ledger of every real payment EVENT (not bill
// status) — one row per moment money actually arrived, regardless of
// whether it settled a bill, went to advance credit, or both. The
// Dashboard sums this log filtered to the current month instead of
// deriving revenue from invoice status. See Rental Management.dc.html's
// markInvoicePaid/resolveSlip/confirmCreditSlips for the 5 call sites
// that log to this, each logging only the amount NEWLY received in that
// specific action (never re-logging money already logged earlier, e.g.
// advance credit applied to a bill at creation time isn't logged again).
router.get('/', async (req, res, next) => {
  try { res.json(coercePaymentLog(await readTab('PaymentLog'))); }
  catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const b = req.body;
    const amount = Number(b.amount) || 0;
    if (!b.room || amount <= 0) return res.status(400).json({ error: 'กรุณาระบุห้องและจำนวนเงิน' });
    const entry = {
      id: 'PAY-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      // Bangkok-local date, not server/UTC time — same reasoning as
      // Rental Management.dc.html's _todayStr() helper, so "this month"
      // filtering on the Dashboard lines up with what the owner actually
      // considers "today" rather than drifting near midnight UTC.
      date: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' }),
      room: b.room,
      amount,
      type: b.type || '',
      note: b.note || '',
    };
    await appendRow('PaymentLog', entry);
    res.json(entry);
  } catch (err) { next(err); }
});

module.exports = router;
