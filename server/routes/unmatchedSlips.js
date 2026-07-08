const express = require('express');
const router = express.Router();
const { readTab, updateRow, deleteRow } = require('../sheets');
const { coerceUnmatchedSlips, coerceRooms } = require('../coerce');
const { attachSlipToRoom } = require('./line');

router.get('/', async (req, res, next) => {
  try { res.json(coerceUnmatchedSlips(await readTab('UnmatchedSlips'))); }
  catch (err) { next(err); }
});

// Owner manually assigns a slip that arrived from a LINE user we couldn't
// identify (they never linked a room number) to the correct room. Files it
// through the same attachSlipToRoom logic the normal linked-user path uses
// (match against a pending invoice, or fall back to room-level advance-
// payment credit if none is open), then also links that LINE user id to the
// room going forward — the owner just manually verified who this tenant is,
// so future messages/slips from them should auto-match without needing this
// manual step again.
router.patch('/:id/assign', async (req, res, next) => {
  try {
    const { roomId } = req.body;
    if (!roomId) return res.status(400).json({ error: 'กรุณาเลือกห้อง' });
    const slips = await readTab('UnmatchedSlips');
    const slip = slips.find((s) => s.id === req.params.id);
    if (!slip) return res.status(404).json({ error: 'ไม่พบสลิปนี้ (อาจถูกจัดการไปแล้ว)' });
    const rooms = coerceRooms(await readTab('Rooms'));
    const room = rooms.find((r) => r.id === roomId);
    if (!room) return res.status(400).json({ error: 'ไม่พบห้อง ' + roomId });

    const newSlip = {
      amount: slip.amount === '' || slip.amount == null ? null : Number(slip.amount),
      date: slip.date || '', senderName: slip.senderName || '', imageUrl: slip.imageUrl || '', uploadedAt: slip.uploadedAt || '',
    };
    const result = await attachSlipToRoom(roomId, newSlip);
    if (!room.lineUserId && slip.lineUserId) {
      await updateRow('Rooms', roomId, { lineUserId: slip.lineUserId });
    }
    await deleteRow('UnmatchedSlips', req.params.id);
    res.json({ ok: true, ...result });
  } catch (err) { next(err); }
});

// Owner manually corrects a field on an unmatched slip (currently only
// `amount` is used, from the queue's inline "OCR failed, type it yourself"
// input) before assigning it to a room — needs its own plain PATCH since
// /:id/assign both files AND deletes the row in one step.
router.patch('/:id', async (req, res, next) => {
  try {
    const updated = await updateRow('UnmatchedSlips', req.params.id, req.body);
    res.json(coerceUnmatchedSlips([updated])[0]);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try { await deleteRow('UnmatchedSlips', req.params.id); res.json({ ok: true }); }
  catch (err) { next(err); }
});

module.exports = router;
