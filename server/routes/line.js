const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readTab, updateRow } = require('../sheets');
const { coerceInvoices, coerceRooms } = require('../coerce');
const { isConfigured, verifySignature, replyMessage, pushMessage, getMessageContent } = require('../line');
const { isConfigured: claudeConfigured, readPaymentSlip } = require('../claude');
const { isConfigured: cloudinaryConfigured, uploadBuffer: uploadToCloudinary } = require('../cloudinary');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

router.get('/status', (req, res) => {
  res.json({ connected: isConfigured() });
});

// A tenant sends a payment-slip photo directly to the bot (no menu/command —
// just an image). This is OCR only (Claude Vision reads what's printed on
// the slip), not real bank-side fraud verification — that trade-off was an
// explicit, deliberate choice (see readPaymentSlip's comment in
// server/claude.js) in exchange for zero extra cost/signup. Because of that,
// this NEVER marks an invoice paid by itself — it only sets a "รอตรวจสอบ"
// flag with the extracted amount for the owner to review and confirm
// manually on the Bills page, same as every other financially consequential
// action in this app requires a human's final say.
async function handleSlipImage(event, req) {
  const rooms = await readTab('Rooms');
  const room = rooms.find((r) => r.lineUserId === event.source.userId);
  if (!room) {
    await replyMessage(event.replyToken, 'ยังไม่ได้เชื่อมต่อห้องกับ LINE นี้ครับ กรุณาพิมพ์เลขห้องของคุณก่อน (เช่น 301) แล้วค่อยส่งสลิปใหม่อีกครั้งครับ');
    return;
  }

  let buffer;
  try {
    buffer = await getMessageContent(event.message.id);
  } catch (err) {
    console.error('[line] failed to fetch slip image', err.message);
    await replyMessage(event.replyToken, 'ขออภัยครับ รับรูปไม่สำเร็จ ลองส่งใหม่อีกครั้งครับ');
    return;
  }

  // Prefer Cloudinary (persistent, survives every deploy) — fall back to
  // local disk only if Cloudinary isn't configured, same as before. Local
  // disk is ephemeral on Render's free tier, which was a real problem: a
  // slip could sit "pending review" for a while, and any code deploy in
  // between silently deleted the image (the extracted data stayed intact,
  // just the picture itself vanished).
  let publicUrl;
  if (cloudinaryConfigured()) {
    try {
      publicUrl = await uploadToCloudinary(buffer, 'chaosuk-rental/slips');
    } catch (err) {
      console.error('[line] Cloudinary upload failed, falling back to local disk', err.message);
    }
  }
  if (!publicUrl) {
    const filename = `slip-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.jpg`;
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), buffer);
    publicUrl = `${req.protocol}://${req.get('host')}/uploads/${filename}`;
  }

  if (!claudeConfigured()) {
    await replyMessage(event.replyToken, 'ได้รับรูปสลิปแล้วครับ แต่ระบบอ่านสลิปอัตโนมัติยังไม่พร้อมใช้งาน รอเจ้าของตรวจสอบด้วยตนเองครับ');
    return;
  }

  let slip;
  try {
    const dataUrl = `data:image/jpeg;base64,${buffer.toString('base64')}`;
    slip = await readPaymentSlip(dataUrl);
  } catch (err) {
    console.error('[line] slip read failed', err.message);
    await replyMessage(event.replyToken, 'ได้รับรูปสลิปแล้วครับ แต่อ่านรายละเอียดไม่สำเร็จ รอเจ้าของตรวจสอบด้วยตนเองครับ');
    return;
  }

  // If Claude couldn't find ANY of the fields a real bank slip always has
  // (amount, date, sender), the photo almost certainly isn't a payment
  // slip at all (screenshot of something else, a random photo, etc.) —
  // reject it outright instead of silently saving an empty "advance
  // payment" record, per explicit user feedback after hitting exactly this
  // with a test screenshot.
  if (slip.amount == null && !slip.date && !slip.senderName) {
    await replyMessage(event.replyToken, 'รูปที่ส่งมาไม่เหมือนสลิปโอนเงินครับ (อ่านยอด/วันที่/ชื่อผู้โอนไม่เจอเลย) กรุณาส่งรูปสลิปที่ถ่ายหรือแคปมาจากแอปธนาคารโดยตรงอีกครั้งนะครับ');
    return;
  }

  const invoices = coerceInvoices(await readTab('Invoices'));
  const pending = invoices.filter((i) => i.room === room.id && i.status !== 'paid');
  const totalOf = (inv) => Number(inv.rent || 0) + Number(inv.water || 0) + Number(inv.elec || 0) + Number(inv.trash || 0) + Number(inv.internet || 0);

  if (!pending.length) {
    // No bill open for this room at all — most likely an advance payment
    // (tenant paying before the owner has issued next cycle's invoice yet).
    // Record it against the ROOM (not any invoice, since none exists) so the
    // owner can review and decide; if confirmed, it becomes creditBalance
    // and auto-applies the next time an invoice is created for this room.
    const roomFull = coerceRooms(await readTab('Rooms')).find((r) => r.id === room.id);
    const newSlip = {
      amount: slip.amount != null ? Number(slip.amount) : null,
      date: slip.date || '', senderName: slip.senderName || '', imageUrl: publicUrl,
      uploadedAt: new Date().toISOString(),
    };
    const allCreditSlips = [...((roomFull && roomFull.creditSlips) || []), newSlip];
    await updateRow('Rooms', room.id, { creditSlipsJson: JSON.stringify(allCreditSlips) });
    await replyMessage(event.replyToken, `ได้รับสลิปแล้วครับ ยอด ${slip.amount ?? '-'} บาท — ตอนนี้ยังไม่มีบิลค้างชำระของห้อง ${room.id} ในระบบ ระบบจะบันทึกไว้เป็นเงินที่จ่ายล่วงหน้า รอเจ้าของตรวจสอบและยืนยันก่อนนะครับ ขอบคุณครับ 🙏`);
    return;
  }

  // A tenant can send more than one slip before the owner ever reviews the
  // first one — most commonly because one account didn't have enough
  // balance, so they split the payment across two (or more) transfers. If
  // this room already has an invoice mid-review (slipPending), treat any new
  // slip as belonging to that SAME bill and add to it, rather than trying to
  // amount-match a partial payment against the wrong invoice. Only fall back
  // to amount-matching when nothing is currently pending review.
  const alreadyPending = pending.filter((i) => i.slipPending);
  let matched;
  if (alreadyPending.length === 1) {
    matched = alreadyPending[0];
  } else if (slip.amount != null && pending.find((i) => Math.abs(totalOf(i) - Number(slip.amount)) < 1)) {
    matched = pending.find((i) => Math.abs(totalOf(i) - Number(slip.amount)) < 1);
  } else {
    // No exact match and nothing already in review — fall back to the
    // closest pending invoice by amount so something is always flagged for
    // the owner to look at, even if it's not a clean match.
    matched = pending.reduce((best, i) => {
      if (!best) return i;
      if (slip.amount == null) return best;
      return Math.abs(totalOf(i) - Number(slip.amount)) < Math.abs(totalOf(best) - Number(slip.amount)) ? i : best;
    }, null) || pending[0];
  }

  const newSlip = {
    amount: slip.amount != null ? Number(slip.amount) : null,
    date: slip.date || '', senderName: slip.senderName || '', imageUrl: publicUrl,
    uploadedAt: new Date().toISOString(),
  };
  const allSlips = [...(matched.slips || []), newSlip];
  const combinedTotal = allSlips.reduce((a, s) => a + (Number(s.amount) || 0), 0);

  await updateRow('Invoices', matched.id, {
    slipPending: true,
    slipsJson: JSON.stringify(allSlips),
    // Keep the singular fields in sync with the latest slip, for any older
    // code path that still only reads those.
    slipAmount: newSlip.amount != null ? newSlip.amount : '',
    slipDate: newSlip.date,
    slipSenderName: newSlip.senderName,
    slipImageUrl: newSlip.imageUrl,
    slipUploadedAt: newSlip.uploadedAt,
  });

  const amountMatches = Math.abs(totalOf(matched) - combinedTotal) < 1;
  const countNote = allSlips.length > 1 ? `รวม ${allSlips.length} สลิป (${combinedTotal.toLocaleString()} บาท) ` : '';
  const note = amountMatches ? '' : ' (ยอดอาจไม่ตรงกับบิลเป๊ะๆ เจ้าของจะตรวจสอบอีกครั้ง)';
  await replyMessage(event.replyToken, `ได้รับสลิปแล้วครับ ${countNote}ยอด ${slip.amount ?? '-'} บาท กำลังรอเจ้าของยืนยันครับ ขอบคุณครับ 🙏${note}`);
}

router.post('/webhook', async (req, res) => {
  // Always ack quickly so LINE doesn't retry/disable the webhook, even if something
  // downstream fails — we log failures instead of surfacing them to LINE.
  res.status(200).json({ ok: true });

  try {
    const signature = req.headers['x-line-signature'];
    if (!verifySignature(req.rawBody || Buffer.from(''), signature)) {
      console.error('[line] invalid webhook signature — ignoring payload');
      return;
    }
    const events = (req.body && req.body.events) || [];
    for (const event of events) {
      try {
        if (event.type === 'follow') {
          await replyMessage(event.replyToken, 'ยินดีต้อนรับสู่เช่าสุข! กรุณาพิมพ์เลขห้องของคุณ (เช่น 301) เพื่อเชื่อมต่อระบบแจ้งเตือนครับ');
          continue;
        }
        if (event.type === 'message' && event.message && event.message.type === 'text') {
          const text = String(event.message.text || '').trim();
          const rooms = await readTab('Rooms');
          const room = rooms.find((r) => r.id === text);
          if (room) {
            await updateRow('Rooms', room.id, { lineUserId: event.source.userId });
            await replyMessage(event.replyToken, `เชื่อมต่อห้อง ${room.id} เรียบร้อยแล้วครับ จะแจ้งเตือนบิล/ข่าวสารมาทางไลน์นี้`);
          } else {
            await replyMessage(event.replyToken, 'ไม่พบเลขห้องนี้ครับ กรุณาพิมพ์เลขห้องของคุณให้ถูกต้อง (เช่น 301)');
          }
          continue;
        }
        if (event.type === 'message' && event.message && event.message.type === 'image') {
          await handleSlipImage(event, req);
          continue;
        }
      } catch (err) {
        console.error('[line] error handling event', err.message);
      }
    }
  } catch (err) {
    console.error('[line] webhook error', err.message);
  }
});

router.post('/send', async (req, res, next) => {
  try {
    if (!isConfigured()) return res.status(400).json({ error: 'ยังไม่ได้ตั้งค่า LINE บนเซิร์ฟเวอร์ (server/.env)' });
    const { roomId, message, imageUrl } = req.body;
    if (!roomId || (!message || !String(message).trim()) && !imageUrl) {
      return res.status(400).json({ error: 'กรุณาระบุห้องและข้อความหรือรูปภาพ' });
    }
    const rooms = await readTab('Rooms');
    const room = rooms.find((r) => r.id === roomId);
    if (!room || !room.lineUserId) {
      return res.status(400).json({ error: `ห้อง ${roomId} ยังไม่ได้เชื่อมต่อ LINE` });
    }
    await pushMessage(room.lineUserId, message, imageUrl);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
