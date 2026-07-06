const express = require('express');
const router = express.Router();
const { appendRow, updateRow, readTab } = require('../sheets');
const { coerceInvoices } = require('../coerce');

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

module.exports = router;
