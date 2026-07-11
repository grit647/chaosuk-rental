const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readTab, updateRow, appendRow } = require('../sheets');
const { coerceInvoices, coerceRooms, readIntegrationCredentials } = require('../coerce');
const { isConfigured, verifySignature, replyMessage, pushMessage, getMessageContent } = require('../line');
const { isConfigured: claudeConfigured, readPaymentSlip } = require('../claude');
const { isConfigured: cloudinaryConfigured, uploadBuffer: uploadToCloudinary } = require('../cloudinary');
const { notifyAdmin } = require('../adminNotify');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Same key/value upsert pattern as server/routes/settings.js's upsertKV —
// duplicated locally (not imported) to avoid pulling an Express router
// into this file just for one helper. Used only for the admin-PIN
// self-link case in the webhook below.
async function updateSettingKV(key, value) {
  const rows = await readTab('Settings');
  if (rows.some((r) => r.key === key)) {
    await updateRow('Settings', key, { value }, 'key');
  } else {
    await appendRow('Settings', { key, value });
  }
}

router.get('/status', async (req, res, next) => {
  try {
    const creds = await readIntegrationCredentials();
    res.json({ connected: isConfigured(creds.line) });
  } catch (err) { next(err); }
});

// Given a room and a freshly-read slip, files it against that room: adds to
// a mid-review invoice / amount-matches a pending invoice / falls back to
// room-level advance-payment credit if there's no bill open at all. Shared
// by the normal (already-linked LINE user) path below AND by the admin
// "assign this unmatched slip to a room" action (server/routes/
// unmatchedSlips.js), since both cases end up doing exactly the same filing
// once a room is known. Returns a short Thai note describing what happened,
// for whichever caller wants to report it back (LINE reply or admin toast).
async function attachSlipToRoom(roomId, newSlip) {
  const invoices = coerceInvoices(await readTab('Invoices'));
  const pending = invoices.filter((i) => i.room === roomId && i.status !== 'paid');
  const totalOf = (inv) => Number(inv.rent || 0) + Number(inv.water || 0) + Number(inv.elec || 0) + Number(inv.trash || 0) + Number(inv.internet || 0);

  if (!pending.length) {
    // No bill open for this room at all — most likely an advance payment
    // (tenant paying before the owner has issued next cycle's invoice yet).
    // Record it against the ROOM (not any invoice, since none exists) so the
    // owner can review and decide; if confirmed, it becomes creditBalance
    // and auto-applies the next time an invoice is created for this room.
    const roomFull = coerceRooms(await readTab('Rooms')).find((r) => r.id === roomId);
    const allCreditSlips = [...((roomFull && roomFull.creditSlips) || []), newSlip];
    await updateRow('Rooms', roomId, { creditSlipsJson: JSON.stringify(allCreditSlips) });
    return { kind: 'credit', note: `ยังไม่มีบิลค้างชำระของห้อง ${roomId} ในระบบ ระบบบันทึกไว้เป็นเงินที่จ่ายล่วงหน้าแล้ว` };
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
  } else if (newSlip.amount != null && pending.find((i) => Math.abs(totalOf(i) - Number(newSlip.amount)) < 1)) {
    matched = pending.find((i) => Math.abs(totalOf(i) - Number(newSlip.amount)) < 1);
  } else {
    // No exact match and nothing already in review — fall back to the
    // closest pending invoice by amount so something is always flagged for
    // the owner to look at, even if it's not a clean match.
    matched = pending.reduce((best, i) => {
      if (!best) return i;
      if (newSlip.amount == null) return best;
      return Math.abs(totalOf(i) - Number(newSlip.amount)) < Math.abs(totalOf(best) - Number(newSlip.amount)) ? i : best;
    }, null) || pending[0];
  }

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
  return { kind: 'invoice', invoiceId: matched.id, note: `${countNote}กำลังรอเจ้าของยืนยันครับ${note}` };
}

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
  // Note: unlike before, an unlinked LINE user is NOT rejected here anymore
  // — we still read the slip below and file it in UnmatchedSlips so the
  // owner can manually assign it to a room, instead of it vanishing with no
  // record at all (a real bug a user hit: they'd already typed something
  // that wasn't a room number earlier in the chat, which doesn't actually
  // link anything, so the bot has no way to identify which room a slip sent
  // afterward belongs to — but the payment itself is real and shouldn't be
  // silently dropped just because identity couldn't be auto-verified).

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

  // ocrFailed distinguishes "Claude Vision itself errored out" (network
  // hiccup, API error — a real slip we simply couldn't read this time) from
  // "Claude read the image fine and found nothing slip-like" (below) — the
  // two used to be handled identically (both just apologized and dropped
  // the photo with zero record), which was a real bug: a genuine payment
  // slip that hit a transient OCR error vanished with nothing for the owner
  // to follow up on. Now an OCR failure still gets filed (image + a note
  // that amount/date/sender couldn't be auto-read) instead of discarded —
  // the owner can open the photo themselves and fill in the details.
  let slip;
  let ocrFailed = false;
  try {
    const dataUrl = `data:image/jpeg;base64,${buffer.toString('base64')}`;
    slip = await readPaymentSlip(dataUrl);
  } catch (err) {
    console.error('[line] slip read failed', err.message);
    ocrFailed = true;
    slip = { amount: null, date: '', senderName: '' };
  }

  // If Claude successfully READ the image but found NONE of the fields a
  // real bank slip always has (amount, date, sender), the photo almost
  // certainly isn't a payment slip at all (screenshot of something else, a
  // random photo, etc.) — reject it outright instead of silently saving an
  // empty "advance payment" record, per explicit user feedback after
  // hitting exactly this with a test screenshot. Skipped when the OCR call
  // itself failed (ocrFailed) — that's a different situation (see above),
  // not evidence the photo isn't a real slip.
  if (!ocrFailed && slip.amount == null && !slip.date && !slip.senderName) {
    await replyMessage(event.replyToken, 'รูปที่ส่งมาไม่เหมือนสลิปโอนเงินครับ (อ่านยอด/วันที่/ชื่อผู้โอนไม่เจอเลย) กรุณาส่งรูปสลิปที่ถ่ายหรือแคปมาจากแอปธนาคารโดยตรงอีกครั้งนะครับ');
    return;
  }

  const newSlip = {
    amount: slip.amount != null ? Number(slip.amount) : null,
    date: slip.date || '', senderName: slip.senderName || '', imageUrl: publicUrl,
    uploadedAt: new Date().toISOString(),
  };
  const amountLabel = ocrFailed ? 'อ่านยอดอัตโนมัติไม่สำเร็จ (เจ้าของจะเปิดดูรูปเองครับ)' : `ยอด ${slip.amount ?? '-'} บาท`;

  if (!room) {
    // Identity unknown — file it for the owner to manually assign to a room
    // from the Bills page's slip queue, instead of dropping it.
    await appendRow('UnmatchedSlips', {
      id: 'UM-' + Date.now(), lineUserId: event.source.userId,
      amount: newSlip.amount != null ? newSlip.amount : '', date: newSlip.date,
      senderName: newSlip.senderName, imageUrl: newSlip.imageUrl, uploadedAt: newSlip.uploadedAt,
    });
    await replyMessage(event.replyToken, `ได้รับสลิปแล้วครับ ${amountLabel} — แต่ระบบยังไม่ทราบว่าเป็นห้องไหน (LINE นี้ยังไม่เชื่อมต่อกับห้อง) กรุณาพิมพ์เลขห้องของคุณครับ (เช่น 301) เจ้าของจะตรวจสอบและจับคู่ให้เร็วๆ นี้ครับ ขอบคุณครับ 🙏`);
    notifyAdmin('unmatchedSlip', `มีสลิปใหม่ที่ยังไม่ทราบว่าเป็นห้องไหนครับ (${amountLabel}) เข้าไปจับคู่ห้องได้ที่หน้า Bills → สลิปรอตรวจสอบ`).catch(() => {});
    return;
  }

  const result = await attachSlipToRoom(room.id, newSlip);
  await replyMessage(event.replyToken, `ได้รับสลิปแล้วครับ ${amountLabel} ${result.note} ขอบคุณครับ 🙏`);
  notifyAdmin('slipPending', `ห้อง ${room.id} ส่งสลิปเข้ามาแล้วครับ (${amountLabel}) รอตรวจสอบที่หน้า Bills → สลิปรอตรวจสอบ`).catch(() => {});
}

router.post('/webhook', async (req, res) => {
  // Always ack quickly so LINE doesn't retry/disable the webhook, even if something
  // downstream fails — we log failures instead of surfacing them to LINE.
  res.status(200).json({ ok: true });

  // KNOWN LIMITATION, flagged per explicit user follow-up discussion:
  // this webhook still only uses the SHARED server/.env LINE credentials
  // (no `creds` passed to verifySignature/replyMessage below), unlike the
  // outgoing /send route and /status check, which now resolve each
  // customer's own credentials. LINE calls this ONE webhook URL with no
  // way for us to know in advance which customer's Channel Secret to
  // verify against, since there's no session cookie on an incoming
  // webhook call the way there is on a browser request — routing this
  // per-customer needs either per-customer webhook URLs or trying every
  // customer's secret until one's signature matches, neither of which is
  // built yet. For now, a second customer's own LINE OA (if they set one
  // up via the new Settings form) can only SEND messages through this
  // app; tenants replying/sending slips to THAT OA won't be received
  // here until this gets built out further.

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

          // Owner self-links by typing their admin PIN instead of a room
          // number — per explicit user request, avoids having to hunt down
          // and manually paste their own opaque LINE User ID into Settings.
          // Same PIN as the "ผู้ดูแลระบบ" card's save-confirmation gate
          // (server/routes/settings.js's verify-admin-pin), defaults to
          // "12345" until the owner sets their own adminEditPin.
          const settingsRows = await readTab('Settings');
          const pinRow = settingsRows.find((r) => r.key === 'adminEditPin');
          const adminPin = pinRow ? pinRow.value : '12345';
          if (text === adminPin) {
            const nameRow = settingsRows.find((r) => r.key === 'adminName');
            await updateSettingKV('adminLineUserId', event.source.userId);
            await replyMessage(event.replyToken, `เชื่อมต่อบัญชีผู้ดูแลระบบเรียบร้อยแล้วครับ${nameRow && nameRow.value ? ' (' + nameRow.value + ')' : ''} ระบบจะส่งการแจ้งเตือนมาทางไลน์นี้ครับ`);
            continue;
          }

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
    // Resolves THIS customer's own LINE credentials (from whichever Sheet
    // the current request/session is scoped to) if they've set any via
    // the Settings gear-icon form, otherwise falls back to server/.env
    // exactly as before — see server/line.js's resolveCreds().
    const creds = await readIntegrationCredentials();
    if (!isConfigured(creds.line)) return res.status(400).json({ error: 'ยังไม่ได้ตั้งค่า LINE (ใส่ Token/Secret ที่หน้าตั้งค่า หรือฝั่งเซิร์ฟเวอร์)' });
    const { roomId, message, imageUrl } = req.body;
    if (!roomId || (!message || !String(message).trim()) && !imageUrl) {
      return res.status(400).json({ error: 'กรุณาระบุห้องและข้อความหรือรูปภาพ' });
    }
    const rooms = await readTab('Rooms');
    const room = rooms.find((r) => r.id === roomId);
    if (!room || !room.lineUserId) {
      return res.status(400).json({ error: `ห้อง ${roomId} ยังไม่ได้เชื่อมต่อ LINE` });
    }
    await pushMessage(room.lineUserId, message, imageUrl, creds.line);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.attachSlipToRoom = attachSlipToRoom;
