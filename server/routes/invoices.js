const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { appendRow, updateRow, deleteRow, readTab } = require('../sheets');
const { coerceInvoices, coerceRooms, readSettings } = require('../coerce');
const { generateInvoicePdf } = require('../pdf');

const INVOICE_PDF_DIR = path.join(__dirname, '..', 'uploads', 'invoices');
fs.mkdirSync(INVOICE_PDF_DIR, { recursive: true });

router.get('/', async (req, res, next) => {
  try { res.json(coerceInvoices(await readTab('Invoices'))); }
  catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const b = req.body;
    if (!b.room) return res.status(400).json({ error: 'กรุณาเลือกห้อง' });

    // Refuse to issue a second bill for a room that already has one
    // outstanding (anything not 'paid') — this endpoint is reachable both
    // from this form AND from the Claude automation tools
    // (server/claudeTools.js's create_invoice), so the check needs to live
    // here, not just as a client-side guard, per explicit user request
    // after duplicate/overlapping bills showed up for the same room.
    const existingInvoices = coerceInvoices(await readTab('Invoices'));
    const alreadyPending = existingInvoices.find((i) => i.room === b.room && i.status !== 'paid');
    if (alreadyPending) {
      return res.status(400).json({ error: `ห้อง ${b.room} มีใบแจ้งหนี้ค้างอยู่แล้ว (${alreadyPending.id}) กรุณาจัดการบิลเดิมให้เสร็จก่อน (แก้ไข/ลบ/ยืนยันชำระ) จึงจะออกบิลใหม่ได้` });
    }

    const rent = Number(b.rent) || 0, water = Number(b.water) || 0, elec = Number(b.elec) || 0, trash = Number(b.trash) || 0, internet = Number(b.internet) || 0;
    const total = rent + water + elec + trash + internet;

    // Auto-apply any advance payment the tenant already made (creditBalance,
    // built up from slips that arrived with no bill open to match against —
    // see server/routes/line.js's handleSlipImage) — the owner already
    // confirmed that credit is real money when they reviewed it, so applying
    // it here needs no separate confirmation.
    const rooms = coerceRooms(await readTab('Rooms'));
    const room = rooms.find((r) => r.id === b.room);
    const credit = room ? room.creditBalance || 0 : 0;
    const applied = Math.min(credit, total);
    const status = applied >= total && total > 0 ? 'paid' : (applied > 0 ? 'partial' : 'pending');

    const invoice = {
      id: 'INV-' + b.room + '-' + Date.now(),
      room: b.room,
      tenant: b.tenant || '',
      rent, water, elec, trash, internet,
      due: b.due || '',
      status,
      paidDate: status === 'paid' ? new Date().toISOString().slice(0, 10) : '',
      amountPaid: applied,
    };
    await appendRow('Invoices', invoice);
    if (applied > 0) {
      await updateRow('Rooms', b.room, { creditBalance: credit - applied });
    }
    // Run through coerceInvoices before responding — the raw object above is
    // missing fields (receiptSent, slipPending, slips, remainingDue, etc.)
    // that every OTHER invoice in the frontend's state already has (loaded
    // via GET /api/bootstrap, which does coerce). Skipping this made a
    // freshly-created invoice's row look inconsistent (e.g. the "ส่งข้อมูล
    // (LINE)" status) until the next manual page refresh re-fetched it
    // through the coerced path — a real bug a user hit.
    res.json({ ...coerceInvoices([invoice])[0], creditApplied: applied });
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const merged = await updateRow('Invoices', req.params.id, req.body);
    res.json(coerceInvoices([merged])[0]);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try { await deleteRow('Invoices', req.params.id); res.json({ ok: true }); }
  catch (err) { next(err); }
});

router.post('/:id/pdf', async (req, res, next) => {
  try {
    const [invoices, rooms, settingsData] = await Promise.all([
      readTab('Invoices'), readTab('Rooms'), readSettings(),
    ]);
    const invoice = coerceInvoices(invoices).find((i) => i.id === req.params.id);
    if (!invoice) return res.status(404).json({ error: 'ไม่พบใบแจ้งหนี้นี้' });
    const room = rooms.find((r) => r.id === invoice.room);

    const buffer = await generateInvoicePdf(invoice, room, settingsData.propertyProfile);
    const filename = invoice.id.replace(/[^a-zA-Z0-9-]/g, '_') + '.pdf';
    fs.writeFileSync(path.join(INVOICE_PDF_DIR, filename), buffer);

    const url = `${req.protocol}://${req.get('host')}/uploads/invoices/${filename}`;
    res.json({ url });
  } catch (err) { next(err); }
});

module.exports = router;
