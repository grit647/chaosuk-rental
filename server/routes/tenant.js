const express = require('express');
const router = express.Router();
const { readTab, appendRow } = require('../sheets');
const { coerceRooms, coerceInvoices } = require('../coerce');

// Per explicit user request: a tenant session (see server/routes/auth.js's
// POST /tenant-login) must only ever see THEIR OWN room's data — never
// another tenant's, never the building's overall financials, never
// anything an owner/staff session can do. Every route below re-checks
// req.session.role === 'tenant' server-side (never trusts a client-side
// flag) and scopes every query to req.session.roomId.
function requireTenant(req, res, next) {
  if (!req.session || req.session.role !== 'tenant' || !req.session.roomId) {
    return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบก่อน' });
  }
  next();
}

router.get('/me', requireTenant, async (req, res, next) => {
  try {
    const rooms = coerceRooms(await readTab('Rooms'));
    const room = rooms.find((r) => r.id === req.session.roomId);
    if (!room) return res.status(404).json({ error: 'ไม่พบข้อมูลห้อง' });
    // Only the fields a tenant actually needs to see about their own
    // room — deliberately excludes tenantIdImg/leaseDocName (owner-side
    // document references) and any other-room-adjacent internals.
    res.json({
      id: room.id, tenant: room.tenant, phone: room.phone, rent: room.rent,
      deposit: room.deposit, moveIn: room.moveIn, contractEnd: room.contractEnd,
      dueDay: room.dueDay, wifiCode: room.wifiCode,
      creditBalance: room.creditBalance,
    });
  } catch (err) { next(err); }
});

router.get('/invoices', requireTenant, async (req, res, next) => {
  try {
    const invoices = coerceInvoices(await readTab('Invoices')).filter((i) => i.room === req.session.roomId);
    // Newest first — most useful order for both "current amount owed"
    // (frontend picks the first non-paid one) and "ประวัติบิลย้อนหลัง".
    invoices.sort((a, b) => (b.id > a.id ? 1 : -1));
    res.json(invoices);
  } catch (err) { next(err); }
});

router.post('/maintenance', requireTenant, async (req, res, next) => {
  try {
    const issue = req.body && req.body.issue;
    if (!issue || !String(issue).trim()) return res.status(400).json({ error: 'กรุณากรอกรายละเอียดปัญหา' });
    const item = { id: Date.now(), room: req.session.roomId, issue: String(issue).trim(), status: 'pending', date: 'วันนี้' };
    await appendRow('Maintenance', item);
    res.json({ ok: true, message: 'ส่งคำขอแจ้งซ่อมแล้ว เจ้าของ/ผู้ดูแลจะรับเรื่องและดำเนินการให้ครับ' });
  } catch (err) { next(err); }
});

module.exports = router;
