const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { appendRow, updateRow, readTab } = require('../sheets');
const { coerceInvoices, readSettings } = require('../coerce');
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
    const invoice = {
      id: 'INV-' + b.room + '-' + Date.now(),
      room: b.room,
      tenant: b.tenant || '',
      rent: Number(b.rent) || 0,
      water: Number(b.water) || 0,
      elec: Number(b.elec) || 0,
      trash: Number(b.trash) || 0,
      internet: Number(b.internet) || 0,
      due: b.due || '',
      status: 'pending',
      paidDate: '',
    };
    await appendRow('Invoices', invoice);
    res.json(invoice);
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const merged = await updateRow('Invoices', req.params.id, req.body);
    res.json(coerceInvoices([merged])[0]);
  } catch (err) { next(err); }
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
