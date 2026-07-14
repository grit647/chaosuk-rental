const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readTab, updateRow, appendRow } = require('../sheets');
const { coerceInvoices, coerceRooms, readSettings, readIntegrationCredentials } = require('../coerce');
const { isConfigured, verifySignature, replyMessage, pushMessage, getMessageContent, linkRichMenuToUser } = require('../line');
const { isConfigured: claudeConfigured, readPaymentSlip } = require('../claude');
const { isConfigured: cloudinaryConfigured, uploadBuffer: uploadToCloudinary } = require('../cloudinary');
const { notifyAdmin } = require('../adminNotify');
const { sign, verify, setSessionCookie } = require('../auth');
const { computeTenantUsage } = require('./tenant');
const { runWithSheetId, getCurrentSheetId, isMainAccountSheetId } = require('../requestContext');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Per explicit owner request: ผู้ดูแล self-link is a real, stateful TWO-STEP
// chat flow now — type the PIN first, THEN (in a separate message) the
// phone number to confirm — rather than one "phone pin" message. Reasoning
// given: a tenant might be standing right there when the admin types, and
// a single combined message risks visually reading like "just a phone
// number" if misread/miscopied — splitting into two distinct steps makes
// each step unambiguous, and critically, the FIRST message (a bare PIN)
// can never accidentally match the tenant phone-number self-link path
// below (a PIN and a phone number look nothing alike), whereas a
// combined "phone pin" message text is more easily fumbled by a user
// mid-conversation. In-memory only (module-level Map, not persisted to
// the Sheet) — a short-lived (2 min) pending-confirmation state is exactly
// the kind of thing that SHOULD reset on a server restart; the self-link
// flow is idempotent (re-typing the PIN just restarts it), so there's no
// real downside to it not surviving a redeploy. Keyed by
// "<customerSheetId>:<lineUserId>" so two different buildings' webhooks
// (see the per-customerSheetId route below) never collide in this shared
// Map even though they share one Node process.
const pendingAdminLinks = new Map();
const ADMIN_LINK_CONFIRM_WINDOW_MS = 2 * 60 * 1000;

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
    // Real bug a customer hit: a brand-new multi-tenant customer with NO
    // LINE credentials of their own was shown "เชื่อมต่อแล้ว" — because
    // line.js's resolveCreds() falls back to the SHARED server/.env values
    // (คุณต้น's own LINE OA) whenever no override is given, which is
    // correct for คุณต้น's own no-login usage but wrong once someone is
    // logged in via the multi-tenant system: it made it look like THEIR
    // LINE OA was connected when it was actually silently using someone
    // else's. Once a session has its own customerSheetId, only THIS
    // customer's own saved credentials count — no falling back to the
    // shared server ones for the status check. EXCEPT when that
    // customerSheetId is the main account's own sheet (see
    // isMainAccountSheetId in requestContext.js) — คุณต้น's own account
    // always carries a session too now that login is required, and
    // server/.env genuinely ARE his own credentials, always were.
    const sessionScoped = !!(req.session && req.session.customerSheetId) && !isMainAccountSheetId(req.session.customerSheetId);
    const connected = sessionScoped ? !!creds.line && isConfigured(creds.line) : isConfigured(creds.line);
    res.json({ connected });
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
async function handleSlipImage(event, req, lineCreds) {
  // Per-customer-webhook-URL support: every reply below goes through THIS
  // building's own LINE credentials (see the /webhook/:customerSheetId?
  // route below for how lineCreds gets resolved and threaded down here).
  const reply = (text) => replyMessage(event.replyToken, text, lineCreds);
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
    buffer = await getMessageContent(event.message.id, lineCreds);
  } catch (err) {
    console.error('[line] failed to fetch slip image', err.message);
    await reply('ขออภัยครับ รับรูปไม่สำเร็จ ลองส่งใหม่อีกครั้งครับ');
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
    await reply('ได้รับรูปสลิปแล้วครับ แต่ระบบอ่านสลิปอัตโนมัติยังไม่พร้อมใช้งาน รอเจ้าของตรวจสอบด้วยตนเองครับ');
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
    await reply('รูปที่ส่งมาไม่เหมือนสลิปโอนเงินครับ (อ่านยอด/วันที่/ชื่อผู้โอนไม่เจอเลย) กรุณาส่งรูปสลิปที่ถ่ายหรือแคปมาจากแอปธนาคารโดยตรงอีกครั้งนะครับ');
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
    await reply(`ได้รับสลิปแล้วครับ ${amountLabel} — แต่ระบบยังไม่ทราบว่าเป็นห้องไหน (LINE นี้ยังไม่เชื่อมต่อกับห้อง) กรุณาพิมพ์เบอร์โทรศัพท์ของคุณครับ (ตามที่ระบุในสัญญาเช่า) เจ้าของจะตรวจสอบและจับคู่ให้เร็วๆ นี้ครับ ขอบคุณครับ 🙏`);
    notifyAdmin('unmatchedSlip', `มีสลิปใหม่ที่ยังไม่ทราบว่าเป็นห้องไหนครับ (${amountLabel}) เข้าไปจับคู่ห้องได้ที่หน้า Bills → สลิปรอตรวจสอบ`).catch(() => {});
    return;
  }

  const result = await attachSlipToRoom(room.id, newSlip);
  await reply(`ได้รับสลิปแล้วครับ ${amountLabel} ${result.note} ขอบคุณครับ 🙏`);
  notifyAdmin('slipPending', `ห้อง ${room.id} ส่งสลิปเข้ามาแล้วครับ (${amountLabel}) รอตรวจสอบที่หน้า Bills → สลิปรอตรวจสอบ`).catch(() => {});
}

// Per explicit user request ("จัดการให้เลยครับ" — fixing the previously
// KNOWN LIMITATION documented here and in CLAUDE.md): route now accepts
// an OPTIONAL :customerSheetId segment — DECIDED (2026-07-12, discussed
// re: บ้านพักครูโจ) as per-customer webhook URLs over the alternative of
// trying every customer's Channel Secret until one matches (clearer, no
// O(n) signature checks as the customer count grows). Each building
// registers its OWN distinct URL (e.g. .../api/line/webhook/<their
// customerSheetId>) in ITS OWN LINE Developers Console, using ITS OWN
// Channel Secret/Access Token (saved via the Settings gear-icon form,
// same readIntegrationCredentials() already used by the outgoing /send
// route and /status check). Omitting the segment (plain /webhook, the
// URL already registered for the main property) falls back to
// process.env.GOOGLE_SHEET_ID + the shared server/.env credentials —
// zero migration needed for the existing registration.
router.post('/webhook/:customerSheetId?', async (req, res) => {
  // Always ack quickly so LINE doesn't retry/disable the webhook, even if something
  // downstream fails — we log failures instead of surfacing them to LINE.
  res.status(200).json({ ok: true });

  const targetSheetId = req.params.customerSheetId || process.env.GOOGLE_SHEET_ID;
  await runWithSheetId(targetSheetId, async () => {
    try {
      // Resolved INSIDE runWithSheetId so readIntegrationCredentials()
      // (which itself calls readTab('Settings')) reads THIS building's
      // own Sheet, not whichever one a previous concurrent request left
      // as the ambient default — same per-request-isolation guarantee
      // AsyncLocalStorage already gives every other route in this app.
      const creds = await readIntegrationCredentials();
      const lineCreds = creds.line;
      const reply = (replyToken, text) => replyMessage(replyToken, text, lineCreds);

      const signature = req.headers['x-line-signature'];
      if (!verifySignature(req.rawBody || Buffer.from(''), signature, lineCreds)) {
        console.error('[line] invalid webhook signature for sheet', targetSheetId, '— ignoring payload');
        return;
      }
      const events = (req.body && req.body.events) || [];
      for (const event of events) {
        try {
          if (event.type === 'follow') {
            // Per explicit user request: changed from "type your room number"
            // to "type your phone number" — a room number can be understood
            // differently between the tenant and owner (e.g. "22/3" typed as
            // "223", or a tenant simply not sure what their own room's ID is
            // labeled as in the system), while the phone number is
            // unambiguous and is also what the room record is keyed to
            // everywhere else (contract, tenant-login). Matched against
            // room.phone below via normPhone (digits-only) so dashes/spaces
            // in what the tenant types don't matter.
            await reply(event.replyToken, 'ยินดีต้อนรับสู่เช่าสุข! กรุณาพิมพ์เบอร์โทรศัพท์ของคุณ (ตามที่ระบุในสัญญาเช่า) เพื่อเชื่อมต่อระบบแจ้งเตือนครับ');
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
              // Same reasoning as the tenant's rich-menu-linking above —
              // right after the owner's own self-link succeeds, give them
              // the owner Rich Menu matching the CURRENT lineAiModeEnabled
              // state (see prototype-auth/setup-owner-richmenu.js, which
              // creates an ON and an OFF variant — see
              // handleOwnerRichMenuPostback's 'owner:ai' case for the
              // toggle itself). Non-fatal if missing/failed.
              try {
                const aiOn = settingsRows.some((r) => r.key === 'lineAiModeEnabled' && r.value === 'TRUE');
                const rmKey = aiOn ? 'ownerRichMenuIdOn' : 'ownerRichMenuIdOff';
                const rmRow = settingsRows.find((r) => r.key === rmKey);
                if (rmRow && rmRow.value) await linkRichMenuToUser(event.source.userId, rmRow.value, lineCreds);
              } catch (err) {
                console.error('[line] linkRichMenuToUser (owner) failed for', event.source.userId, err.message);
              }
              await reply(event.replyToken, `เชื่อมต่อบัญชีผู้ดูแลระบบเรียบร้อยแล้วครับ${nameRow && nameRow.value ? ' (' + nameRow.value + ')' : ''} ระบบจะส่งการแจ้งเตือนมาทางไลน์นี้ครับ`);
              continue;
            }

            // normPhone strips everything but digits, so "081-234-5671" and
            // "0812345671" both match the same way. Declared here (used by
            // both the admin self-link below and the tenant self-link
            // further down) rather than twice.
            const normPhone = (s) => String(s || '').replace(/\D/g, '');
            const pendingKey = `${getCurrentSheetId() || process.env.GOOGLE_SHEET_ID}:${event.source.userId}`;

            // Per explicit owner follow-up (real security concern raised:
            // "ถ้าผมเป็นผู้เช่าแล้วได้รหัสผู้ดูแลไป ผมเข้าได้ไหม" — yes,
            // originally, since a bare PIN alone had no second factor at
            // all): "ผู้ดูแล" (Admins tab — the separate accounting-clerk
            // login role, session role: 'staff', NOT the unrelated "Staff"/
            // สัญญาพนักงาน employment-contract tab) now self-links via a
            // real TWO-STEP chat flow — STEP 1 (this block): type the PIN
            // alone → if it matches an Admins row, don't link yet, just
            // remember "this LINE user claims to be admin X" for 2 minutes
            // and ask them to confirm by typing their phone number next.
            // STEP 2 (further below, checked FIRST on every message so a
            // pending confirmation is always caught before any other
            // branch): if this LINE user has a live pending confirmation,
            // check whatever they typed against THAT specific admin's own
            // phone — matches → actually link; doesn't match → clear the
            // pending state and tell them to start over. Per owner's own
            // stated reasoning: this keeps each step unambiguous (a bare
            // PIN can never be confused with the tenant phone-number flow
            // below, unlike a combined "phone pin" single message which
            // reads too much like "just a phone number" if a tenant is
            // standing nearby watching). Checked AFTER the owner's own
            // single adminEditPin above (different, deliberately
            // PIN-only concept, see CLAUDE.md's PIN-gate notes).
            const pending = pendingAdminLinks.get(pendingKey);
            if (pending && pending.expiresAt > Date.now()) {
              pendingAdminLinks.delete(pendingKey); // one attempt only, success or fail
              if (normPhone(text) === normPhone(pending.phone)) {
                await updateRow('Admins', pending.adminId, { lineUserId: event.source.userId });
                try {
                  const rmRow = settingsRows.find((r) => r.key === 'staffRichMenuId');
                  if (rmRow && rmRow.value) await linkRichMenuToUser(event.source.userId, rmRow.value, lineCreds);
                } catch (err) {
                  console.error('[line] linkRichMenuToUser (staff) failed for', event.source.userId, err.message);
                }
                await reply(event.replyToken, `เชื่อมต่อบัญชีผู้ดูแลเรียบร้อยแล้วครับ (${pending.name || 'ผู้ดูแล'}) ระบบจะส่งการแจ้งเตือนมาทางไลน์นี้ครับ`);
              } else {
                await reply(event.replyToken, 'เบอร์โทรไม่ตรงกับที่ยืนยันครับ กรุณาพิมพ์รหัสผู้ดูแลใหม่อีกครั้งเพื่อเริ่มใหม่');
              }
              continue;
            }
            if (pending) pendingAdminLinks.delete(pendingKey); // expired — clear before falling through

            const adminRows = await readTab('Admins');
            const matchedAdmin = adminRows.find((a) => a.pin && a.pin === text);
            if (matchedAdmin) {
              pendingAdminLinks.set(pendingKey, { adminId: matchedAdmin.id, phone: matchedAdmin.phone, name: matchedAdmin.name, expiresAt: Date.now() + ADMIN_LINK_CONFIRM_WINDOW_MS });
              await reply(event.replyToken, `พบรหัสผู้ดูแลถูกต้องครับ (${matchedAdmin.name || 'ผู้ดูแล'}) กรุณาพิมพ์เบอร์โทรของคุณเพื่อยืนยัน ภายใน 2 นาทีครับ`);
              continue;
            }

            // Per explicit user request: match by PHONE NUMBER instead of
            // room number — a tenant might not type/know their room's exact
            // ID as labeled in the system (room numbering can be understood
            // differently between tenant and owner), but their own phone
            // number is unambiguous.
            const rooms = await readTab('Rooms');
            const room = rooms.find((r) => r.phone && normPhone(r.phone) === normPhone(text));
            if (room) {
              await updateRow('Rooms', room.id, { lineUserId: event.source.userId });
              // Per explicit user request: right after a tenant successfully
              // self-links, give them the tenant-specific Rich Menu (see
              // prototype-auth/setup-tenant-richmenu.js for how it's
              // created) instead of leaving them on the OA's default menu —
              // this is the actual mechanism behind "different menu per
              // role" even though everyone messages the same shared LINE
              // OA. tenantRichMenuId is a Settings KV set once by that setup
              // script; non-fatal if missing/not set up yet or if the link
              // call itself fails — the tenant is still fully linked either
              // way, just without the nicer menu.
              try {
                const rmRow = settingsRows.find((r) => r.key === 'tenantRichMenuId');
                if (rmRow && rmRow.value) await linkRichMenuToUser(event.source.userId, rmRow.value, lineCreds);
              } catch (err) {
                console.error('[line] linkRichMenuToUser failed for', event.source.userId, err.message);
              }
              await reply(event.replyToken, `เชื่อมต่อห้อง ${room.id} เรียบร้อยแล้วครับ จะแจ้งเตือนบิล/ข่าวสารมาทางไลน์นี้`);
            } else {
              await reply(event.replyToken, 'ไม่พบเบอร์โทรนี้ในระบบครับ กรุณาพิมพ์เบอร์โทรศัพท์ตามที่ระบุในสัญญาเช่าให้ถูกต้อง');
            }
            continue;
          }
          if (event.type === 'message' && event.message && event.message.type === 'image') {
            await handleSlipImage(event, req, lineCreds);
            continue;
          }
          // Per explicit user request: Rich Menu tap zones use postback
          // actions (not "uri" actions) specifically so the webhook always
          // learns WHO tapped (event.source.userId) — a plain link opened
          // from a rich menu carries no identifying info back to us at all.
          // See prototype-auth/setup-tenant-richmenu.js for the actual menu
          // layout/postback-data values created; this switch is the other
          // half of that contract.
          if (event.type === 'postback' && event.postback) {
            // Per explicit user request: owner Rich Menu buttons use a
            // distinct "owner:" data prefix (see prototype-auth/setup-owner-
            // richmenu.js) specifically so this dispatcher can tell owner
            // taps apart from tenant taps — the two are looked up completely
            // differently (owner via Settings.adminLineUserId, tenant via a
            // Rooms row's lineUserId), so they can't share one lookup path.
            const data = event.postback.data || '';
            if (data.startsWith('owner:')) {
              await handleOwnerRichMenuPostback(event, lineCreds);
            } else if (data.startsWith('staff:')) {
              await handleStaffRichMenuPostback(event, lineCreds);
            } else {
              await handleTenantRichMenuPostback(event, lineCreds);
            }
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
});

// Per explicit user request ("ทดสอบเมนูฝั่งผู้เช่าก่อน"): handles every
// tap-zone on the tenant Rich Menu. Three actions reply with info
// directly in the chat (no web page needed); three open the tenant
// portal via a short-lived signed auto-login link, since a postback event
// has no browser session to carry — see GET /auto-login below for the
// other half.
async function handleTenantRichMenuPostback(event, lineCreds) {
  const data = event.postback.data || '';
  const reply = (text) => replyMessage(event.replyToken, text, lineCreds);
  const rooms = coerceRooms(await readTab('Rooms'));
  const room = rooms.find((r) => r.lineUserId === event.source.userId);
  if (!room) {
    await reply('บัญชี LINE นี้ยังไม่ได้เชื่อมต่อกับห้องไหนเลยครับ กรุณาพิมพ์เบอร์โทรศัพท์ของคุณ (ตามที่ระบุในสัญญาเช่า) ก่อนครับ');
    return;
  }

  const BASE_URL = process.env.PUBLIC_BASE_URL || 'https://chaosuk-rental.onrender.com';
  // Short-lived (5 min) signed token — payload deliberately minimal
  // (customerSheetId + roomId only, matching a real tenant session's
  // shape). Verified + consumed by GET /auto-login below. customerSheetId
  // comes from getCurrentSheetId() (the ambient context runWithSheetId set
  // up in the webhook route above) rather than a hardcoded env var, so this
  // correctly reflects whichever building's own webhook this event
  // actually came through — was the last hardcoded main-property
  // assumption remaining after the per-customer-webhook-URL fix.
  function autoLoginLink(view) {
    const token = sign({ role: 'tenant', customerSheetId: getCurrentSheetId() || process.env.GOOGLE_SHEET_ID, roomId: room.id, exp: Date.now() + 5 * 60 * 1000 });
    return `${BASE_URL}/api/line/auto-login?token=${encodeURIComponent(token)}&view=${view}`;
  }

  switch (data) {
    case 'action=bill':
      await reply(`ดูยอดค้างชำระห้อง ${room.id} ได้ที่นี่ครับ (ลิงก์นี้ใช้ได้ 5 นาที)\n${autoLoginLink('bill')}`);
      return;
    case 'action=contract':
      await reply(`ดูสัญญาเช่าห้อง ${room.id} ได้ที่นี่ครับ (ลิงก์นี้ใช้ได้ 5 นาที)\n${autoLoginLink('contract')}`);
      return;
    case 'action=maintenance':
      await reply(`แจ้งซ่อมห้อง ${room.id} ได้ที่นี่ครับ (ลิงก์นี้ใช้ได้ 5 นาที)\n${autoLoginLink('maintenance')}`);
      return;
    case 'action=contact': {
      const settings = await readSettings();
      const name = settings.propertyProfile.adminName || 'เจ้าของหอพัก';
      const phone = settings.propertyProfile.adminPhone;
      await reply(phone ? `ติดต่อผู้ดูแล (${name}) ได้ที่เบอร์ ${phone} ครับ` : 'ยังไม่ได้ตั้งค่าเบอร์ติดต่อผู้ดูแลไว้ในระบบครับ');
      return;
    }
    case 'action=wifi':
      await reply(room.wifiCode ? `รหัส Wifi ห้อง ${room.id}: ${room.wifiCode}` : 'ยังไม่ได้บันทึกรหัส Wifi ของห้องนี้ไว้ในระบบครับ ลองสอบถามผู้ดูแลโดยตรงครับ');
      return;
    case 'action=usage': {
      const usage = await computeTenantUsage(room);
      if (!usage.hasElecDevice && !usage.hasWaterDevice) {
        await reply(`ห้อง ${room.id} ยังไม่ได้เชื่อมต่ออุปกรณ์วัดน้ำ/ไฟกับระบบครับ`);
        return;
      }
      const lines = [`การใช้น้ำ/ไฟห้อง ${room.id} (นับจากบิลล่าสุด):`];
      if (usage.hasElecDevice) {
        lines.push(usage.elecLive && usage.elecLive.online
          ? `⚡ ไฟตอนนี้: ${usage.elecLive.voltage?.toFixed(1)}V · ${usage.elecLive.current?.toFixed(2)}A · ${usage.elecLive.power?.toFixed(1)}W`
          : '⚡ อุปกรณ์ไฟฟ้า: ออฟไลน์');
        if (usage.elecUsage != null) lines.push(`ไฟที่ใช้รอบนี้: ${usage.elecUsage} หน่วย (฿${usage.elecCost})`);
      }
      if (usage.hasWaterDevice) {
        if (!(usage.waterLive && usage.waterLive.online)) lines.push('💧 อุปกรณ์น้ำ: ออฟไลน์');
        if (usage.waterUsage != null) lines.push(`น้ำที่ใช้รอบนี้: ${usage.waterUsage} หน่วย (฿${usage.waterCost})`);
      }
      await reply(lines.join('\n'));
      return;
    }
    default:
      return;
  }
}

// Per explicit user request: owner Rich Menu — 5 buttons reply with a
// quick data summary directly in the chat (no web page needed, same
// "answer in chat" pattern as 3 of the tenant menu's buttons), the 6th
// (การเปิดโหมด Claude AI) is a placeholder for now — the owner explicitly
// asked to build the image/menu first and design the actual "chat with
// Claude through LINE" mode as a separate follow-up (it needs a stateful
// per-user "AI mode on/off" flag plus routing subsequent free-text
// messages through Claude's tool-calling flow, materially different from
// the other 5 buttons' one-shot replies).
// Per explicit user request (screenshot of the web app's "ใบแจ้งหนี้ที่รอ
// ชำระ" table): the บิลค้างชำระ/เกินกำหนด Rich Menu button should list each
// bill individually (room, tenant, amount owed, due date, status) instead
// of just a room-number list — same underlying data as that table, just
// rendered as chat text. Shared between the owner and ผู้ดูแล postback
// handlers below (identical info, just gated behind a different auth
// check per role) so the two don't drift out of sync. Same status-label
// wording as Rental Management.dc.html's own invStatusMeta (partial →
// "ชำระบางส่วน", overdue → "เกินกำหนด", default → "รอชำระ") so a ผู้ดูแล/
// owner reading this in LINE sees the exact same words as on the web
// page. Capped at 15 lines (same cap already used for staff:maintenance)
// — LINE text messages have a length limit, and a wall of 50+ bills
// wouldn't be readable in a chat bubble anyway; the total/count line
// above the list still reflects the TRUE full total, not just the
// capped subset shown.
function formatOverdueList(overdue) {
  const statusLabel = (status) => {
    if (status === 'partial') return 'ชำระบางส่วน';
    if (status === 'overdue') return 'เกินกำหนด';
    return 'รอชำระ';
  };
  const lines = overdue.slice(0, 15).map((i) => {
    const full = i.rent + i.water + i.elec + (i.trash || 0) + (i.internet || 0);
    const remaining = i.remainingDue != null ? i.remainingDue : Math.max(0, full - (i.amountPaid || 0));
    return `- ห้อง ${i.room}${i.tenant ? ' (' + i.tenant + ')' : ''}: ${remaining.toLocaleString()} บาท ครบกำหนด ${i.due || '-'} [${statusLabel(i.status)}]`;
  }).join('\n');
  return lines + (overdue.length > 15 ? `\n...และอีก ${overdue.length - 15} รายการ` : '');
}

async function handleOwnerRichMenuPostback(event, lineCreds) {
  const data = event.postback.data || '';
  const reply = (text) => replyMessage(event.replyToken, text, lineCreds);
  const settingsRows = await readTab('Settings');
  const adminLineIdRow = settingsRows.find((r) => r.key === 'adminLineUserId');
  if (!adminLineIdRow || adminLineIdRow.value !== event.source.userId) {
    // Never reveal building financials to a LINE account that isn't the
    // verified owner — same trust boundary as every other admin-only
    // action in this app (see CLAUDE.md's PIN-gate notes).
    await reply('บัญชี LINE นี้ยังไม่ได้เชื่อมต่อเป็นผู้ดูแลระบบครับ');
    return;
  }

  const monthPrefix = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' }).slice(0, 7); // YYYY-MM

  switch (data) {
    case 'owner:summary': {
      const [invoices, expenses] = await Promise.all([
        readTab('Invoices').then(coerceInvoices),
        readTab('Expenses').then((rows) => rows.map((r) => ({ ...r, amount: Number(r.amount) || 0 }))),
      ]);
      // "เดือนนี้" — paidDate/date are both YYYY-MM-DD (see
      // Rental Management.dc.html's markInvoicePaid/submitExpense), so a
      // plain string-prefix match against the current YYYY-MM is exact
      // and doesn't need a Date object at all.
      const monthPaid = invoices.filter((i) => i.status === 'paid' && i.paidDate && i.paidDate.startsWith(monthPrefix));
      const monthExpenses = expenses.filter((e) => e.date && e.date.startsWith(monthPrefix) && !e.hidden);
      const revenue = monthPaid.reduce((a, i) => a + i.rent + i.water + i.elec + (i.trash || 0) + (i.internet || 0), 0);
      const expenseTotal = monthExpenses.reduce((a, e) => a + e.amount, 0);
      await reply(`สรุปเดือนนี้ครับ:\nรายรับ (บิลที่ชำระแล้ว): ${revenue.toLocaleString()} บาท (${monthPaid.length} บิล)\nรายจ่าย: ${expenseTotal.toLocaleString()} บาท (${monthExpenses.length} รายการ)\nกำไร-ขาดทุนสุทธิ: ${(revenue - expenseTotal).toLocaleString()} บาท`);
      return;
    }
    case 'owner:overdue': {
      const invoices = coerceInvoices(await readTab('Invoices'));
      const overdue = invoices.filter((i) => i.status === 'overdue' || i.status === 'pending' || i.status === 'partial');
      const total = overdue.reduce((a, i) => {
        const full = i.rent + i.water + i.elec + (i.trash || 0) + (i.internet || 0);
        const remaining = i.remainingDue != null ? i.remainingDue : Math.max(0, full - (i.amountPaid || 0));
        return a + remaining;
      }, 0);
      if (!overdue.length) { await reply('ไม่มีบิลค้างชำระเลยครับ ✅'); return; }
      await reply(`บิลค้างชำระ/เกินกำหนด: ${overdue.length} ห้อง รวม ${total.toLocaleString()} บาท\n${formatOverdueList(overdue)}`);
      return;
    }
    case 'owner:slips': {
      const invoices = coerceInvoices(await readTab('Invoices'));
      const pendingSlips = invoices.filter((i) => i.slipPending);
      const unmatched = await readTab('UnmatchedSlips');
      if (!pendingSlips.length && !unmatched.length) { await reply('ไม่มีสลิปรอตรวจสอบครับ ✅'); return; }
      await reply(`สลิปรอตรวจสอบ: ${pendingSlips.length} รายการ (ผูกห้องแล้ว)${unmatched.length ? `\nสลิปที่ยังไม่ทราบห้อง: ${unmatched.length} รายการ (ต้องจับคู่เอง)` : ''}\nเข้าไปตรวจได้ที่หน้า Bills → สลิปรอตรวจสอบครับ`);
      return;
    }
    case 'owner:dashboard': {
      // Per explicit user follow-up (redesigned image — งานซ่อม cell
      // replaced with this one): "เข้าใช้งานหน้าเว็ปไซต์" opens the main
      // app with no re-login needed, same short-lived signed-token
      // mechanism as the tenant menu's bill/contract/maintenance links
      // (see GET /auto-login above, now branches on payload.role).
      // customerSheetId comes from getCurrentSheetId() — same reasoning as
      // the tenant menu's autoLoginLink above, correctly reflects whichever
      // building's own webhook this event came through.
      const BASE_URL = process.env.PUBLIC_BASE_URL || 'https://chaosuk-rental.onrender.com';
      const token = sign({ role: 'owner', customerSheetId: getCurrentSheetId() || process.env.GOOGLE_SHEET_ID, exp: Date.now() + 5 * 60 * 1000 });
      await reply(`เข้าหน้าเว็บได้ที่นี่ครับ (ลิงก์นี้ใช้ได้ 5 นาที)\n${BASE_URL}/api/line/auto-login?token=${encodeURIComponent(token)}`);
      return;
    }
    case 'owner:rooms': {
      const rooms = coerceRooms(await readTab('Rooms'));
      const vacant = rooms.filter((r) => r.status === 'vacant');
      const occupied = rooms.filter((r) => r.status !== 'vacant');
      await reply(`สรุปห้องพักทั้งหมด ${rooms.length} ห้อง:\nมีผู้เช่าอยู่: ${occupied.length} ห้อง\nห้องว่าง: ${vacant.length} ห้อง${vacant.length ? ` (${vacant.map((r) => r.id).join(', ')})` : ''}`);
      return;
    }
    case 'owner:ai': {
      // Per explicit user request: tapping this button TOGGLES a status
      // flag (lineAiModeEnabled) and re-links the owner to whichever Rich
      // Menu variant (ON/OFF badge on this same cell — see prototype-auth/
      // setup-owner-richmenu.js) matches the NEW state, so the next time
      // they open the menu tray they see it reflected visually. The
      // actual "chat with Claude through LINE" behavior this flag will
      // eventually gate is a separate follow-up (needs stateful per-user
      // routing of free-text messages through Claude's tool-calling flow)
      // — for now this just tracks on/off and confirms in chat, matching
      // what the owner explicitly asked to ship first.
      const wasOn = settingsRows.some((r) => r.key === 'lineAiModeEnabled' && r.value === 'TRUE');
      const nowOn = !wasOn;
      await updateSettingKV('lineAiModeEnabled', nowOn ? 'TRUE' : 'FALSE');
      try {
        const rmKey = nowOn ? 'ownerRichMenuIdOn' : 'ownerRichMenuIdOff';
        const rmRow = settingsRows.find((r) => r.key === rmKey);
        if (rmRow && rmRow.value) await linkRichMenuToUser(event.source.userId, rmRow.value, lineCreds);
      } catch (err) {
        console.error('[line] linkRichMenuToUser (owner AI toggle) failed for', event.source.userId, err.message);
      }
      await reply(nowOn
        ? '🟢 เปิดโหมด Claude AI แล้วครับ — เปิดเมนูอีกครั้งจะเห็นสถานะอัปเดตแล้ว (ฟีเจอร์คุยกับ AI ผ่าน LINE โดยตรงกำลังพัฒนาอยู่ครับ ตอนนี้ยังใช้ผ่านช่องแชทในหน้าตั้งค่าบนเว็บไปก่อนนะครับ)'
        : '⚪ ปิดโหมด Claude AI แล้วครับ');
      return;
    }
    default:
      return;
  }
}

// "ผู้ดูแล" (Admins tab, session role 'staff' — see server/routes/
// auth.js's POST /staff-login) Rich Menu handler. Per explicit user
// request an admin sees the exact same full dashboard as the owner once
// logged in — same principle applies here: same info buttons as the
// owner menu (summary/overdue/slips/rooms/dashboard-link), MINUS the
// owner-only "เปิดโหมด Claude AI" toggle (swapped for "งานซ่อมที่ยังไม่เสร็จ"
// per the image the owner designed — see images/staff-richmenu.png).
// Auth check is against the Admins tab's OWN lineUserId per row (set by
// the PIN self-link above) rather than a single Settings key, since
// there can be multiple ผู้ดูแล accounts.
async function handleStaffRichMenuPostback(event, lineCreds) {
  const data = event.postback.data || '';
  const reply = (text) => replyMessage(event.replyToken, text, lineCreds);
  const adminRows = await readTab('Admins');
  const admin = adminRows.find((a) => a.lineUserId === event.source.userId);
  if (!admin) {
    await reply('บัญชี LINE นี้ยังไม่ได้เชื่อมต่อเป็นผู้ดูแลครับ');
    return;
  }

  const monthPrefix = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' }).slice(0, 7); // YYYY-MM

  switch (data) {
    case 'staff:summary': {
      const [invoices, expenses] = await Promise.all([
        readTab('Invoices').then(coerceInvoices),
        readTab('Expenses').then((rows) => rows.map((r) => ({ ...r, amount: Number(r.amount) || 0 }))),
      ]);
      const monthPaid = invoices.filter((i) => i.status === 'paid' && i.paidDate && i.paidDate.startsWith(monthPrefix));
      const monthExpenses = expenses.filter((e) => e.date && e.date.startsWith(monthPrefix) && !e.hidden);
      const revenue = monthPaid.reduce((a, i) => a + i.rent + i.water + i.elec + (i.trash || 0) + (i.internet || 0), 0);
      const expenseTotal = monthExpenses.reduce((a, e) => a + e.amount, 0);
      await reply(`สรุปเดือนนี้ครับ:\nรายรับ (บิลที่ชำระแล้ว): ${revenue.toLocaleString()} บาท (${monthPaid.length} บิล)\nรายจ่าย: ${expenseTotal.toLocaleString()} บาท (${monthExpenses.length} รายการ)\nกำไร-ขาดทุนสุทธิ: ${(revenue - expenseTotal).toLocaleString()} บาท`);
      return;
    }
    case 'staff:overdue': {
      const invoices = coerceInvoices(await readTab('Invoices'));
      const overdue = invoices.filter((i) => i.status === 'overdue' || i.status === 'pending' || i.status === 'partial');
      const total = overdue.reduce((a, i) => {
        const full = i.rent + i.water + i.elec + (i.trash || 0) + (i.internet || 0);
        const remaining = i.remainingDue != null ? i.remainingDue : Math.max(0, full - (i.amountPaid || 0));
        return a + remaining;
      }, 0);
      if (!overdue.length) { await reply('ไม่มีบิลค้างชำระเลยครับ ✅'); return; }
      await reply(`บิลค้างชำระ/เกินกำหนด: ${overdue.length} ห้อง รวม ${total.toLocaleString()} บาท\n${formatOverdueList(overdue)}`);
      return;
    }
    case 'staff:slips': {
      const invoices = coerceInvoices(await readTab('Invoices'));
      const pendingSlips = invoices.filter((i) => i.slipPending);
      const unmatched = await readTab('UnmatchedSlips');
      if (!pendingSlips.length && !unmatched.length) { await reply('ไม่มีสลิปรอตรวจสอบครับ ✅'); return; }
      await reply(`สลิปรอตรวจสอบ: ${pendingSlips.length} รายการ (ผูกห้องแล้ว)${unmatched.length ? `\nสลิปที่ยังไม่ทราบห้อง: ${unmatched.length} รายการ (ต้องจับคู่เอง)` : ''}\nเข้าไปตรวจได้ที่หน้า Bills → สลิปรอตรวจสอบครับ`);
      return;
    }
    case 'staff:rooms': {
      const rooms = coerceRooms(await readTab('Rooms'));
      const vacant = rooms.filter((r) => r.status === 'vacant');
      const occupied = rooms.filter((r) => r.status !== 'vacant');
      await reply(`สรุปห้องพักทั้งหมด ${rooms.length} ห้อง:\nมีผู้เช่าอยู่: ${occupied.length} ห้อง\nห้องว่าง: ${vacant.length} ห้อง${vacant.length ? ` (${vacant.map((r) => r.id).join(', ')})` : ''}`);
      return;
    }
    case 'staff:maintenance': {
      const maintenance = await readTab('Maintenance');
      const open = maintenance.filter((m) => m.status !== 'done');
      if (!open.length) { await reply('ไม่มีงานซ่อมค้างเลยครับ ✅'); return; }
      const lines = open.slice(0, 15).map((m) => `- ห้อง ${m.room}: ${m.issue || '-'} (${m.status || 'pending'})`).join('\n');
      await reply(`งานซ่อมที่ยังไม่เสร็จ: ${open.length} รายการ\n${lines}${open.length > 15 ? '\n...' : ''}`);
      return;
    }
    case 'staff:dashboard': {
      // Same no-relogin auto-login mechanism as the owner's
      // "เข้าใช้งานหน้าเว็ปไซต์" button — session role 'staff' carries the
      // SAME customerSheetId + staffId this admin logged in with normally
      // (see POST /staff-login), so it lands on the exact same full
      // dashboard, no separate scoping needed (ผู้ดูแล = full access by
      // design, see server/routes/auth.js's staff-login comment).
      const BASE_URL = process.env.PUBLIC_BASE_URL || 'https://chaosuk-rental.onrender.com';
      const token = sign({ role: 'staff', customerSheetId: getCurrentSheetId() || process.env.GOOGLE_SHEET_ID, staffId: admin.id, exp: Date.now() + 5 * 60 * 1000 });
      await reply(`เข้าหน้าเว็บได้ที่นี่ครับ (ลิงก์นี้ใช้ได้ 5 นาที)\n${BASE_URL}/api/line/auto-login?token=${encodeURIComponent(token)}`);
      return;
    }
    default:
      return;
  }
}

// The other half of the Rich Menu's bill/contract/maintenance actions
// above — verifies the short-lived signed token, sets a REAL tenant
// session cookie (same setSessionCookie used by the normal tenant-login
// flow), then redirects into the tenant portal. `view` isn't consumed
// server-side (tenant-portal.html shows everything on one page already,
// per explicit design — there's no separate bill/contract/maintenance
// sub-page to route between), just carried through in case a future
// version wants to auto-scroll/highlight a section.
// Shared by both Rich Menus (tenant AND owner) — per explicit user
// request, the owner's "เข้าใช้งานหน้าเว็ปไซต์" Rich Menu button
// (server/routes/line.js's 'owner:dashboard' postback below) also needs
// a no-re-login link into the main app, same mechanism as the tenant
// bill/contract/maintenance links. Branches on payload.role rather than
// assuming tenant — an owner token has no roomId at all (a room only
// exists on a tenant's own session), which is why the old hardcoded
// `!payload.roomId` validity check had to move into the tenant-only
// branch instead of gating the whole route.
router.get('/auto-login', (req, res) => {
  const { token } = req.query;
  const payload = token && verify(token);
  if (!payload || !payload.exp || Date.now() > payload.exp) {
    return res.status(401).send('ลิงก์หมดอายุหรือไม่ถูกต้องครับ กรุณากดปุ่มจากเมนูอีกครั้ง');
  }
  if (payload.role === 'owner') {
    if (!payload.customerSheetId) return res.status(401).send('ลิงก์ไม่ถูกต้องครับ กรุณากดปุ่มจากเมนูอีกครั้ง');
    const session = { ownerId: payload.ownerId || null, role: 'owner', customerSheetId: payload.customerSheetId, roomId: null, staffId: null };
    setSessionCookie(res, session);
    return res.redirect('/');
  }
  if (payload.role === 'staff') {
    if (!payload.customerSheetId || !payload.staffId) return res.status(401).send('ลิงก์ไม่ถูกต้องครับ กรุณากดปุ่มจากเมนูอีกครั้ง');
    const session = { ownerId: null, role: 'staff', customerSheetId: payload.customerSheetId, roomId: null, staffId: payload.staffId };
    setSessionCookie(res, session);
    return res.redirect('/');
  }
  if (!payload.roomId) return res.status(401).send('ลิงก์ไม่ถูกต้องครับ กรุณากดปุ่มจากเมนูอีกครั้ง');
  const session = { ownerId: null, role: 'tenant', customerSheetId: payload.customerSheetId, roomId: payload.roomId, staffId: null };
  setSessionCookie(res, session);
  res.redirect('/tenant-portal');
});

router.post('/send', async (req, res, next) => {
  try {
    // Resolves THIS customer's own LINE credentials (from whichever Sheet
    // the current request/session is scoped to) if they've set any via
    // the Settings gear-icon form, otherwise falls back to server/.env —
    // but ONLY when there's no multi-tenant session at all (คุณต้น's own
    // usage). A logged-in customer with no credentials of their own must
    // NOT silently fall back and send through คุณต้น's real LINE OA —
    // that would actually deliver a message from the wrong account, not
    // just show a wrong status badge. See the matching fix + comment on
    // GET /status above for the read-only version of this same bug.
    const creds = await readIntegrationCredentials();
    const sessionScoped = !!(req.session && req.session.customerSheetId) && !isMainAccountSheetId(req.session.customerSheetId);
    const lineConfigured = sessionScoped ? !!creds.line && isConfigured(creds.line) : isConfigured(creds.line);
    if (!lineConfigured) return res.status(400).json({ error: 'ยังไม่ได้ตั้งค่า LINE (ใส่ Token/Secret ที่หน้าตั้งค่า หรือฝั่งเซิร์ฟเวอร์)' });
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
