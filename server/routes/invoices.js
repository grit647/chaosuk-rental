const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { appendRow, updateRow, deleteRow, readTab } = require('../sheets');
const { coerceInvoices, coerceRooms, readSettings } = require('../coerce');
const { generateInvoicePdf } = require('../pdf');
const { generateReceiptImage } = require('../receiptImage');
const { isConfigured: cloudinaryConfigured, uploadBuffer: uploadToCloudinary } = require('../cloudinary');

const INVOICE_PDF_DIR = path.join(__dirname, '..', 'uploads', 'invoices');
fs.mkdirSync(INVOICE_PDF_DIR, { recursive: true });
const RECEIPT_IMG_DIR = path.join(__dirname, '..', 'uploads', 'receipts');
fs.mkdirSync(RECEIPT_IMG_DIR, { recursive: true });

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
    // "ช่วยเอาอัตราค่าบริการ น้ำ ไฟ มาแสดงส่วนนี้ให้ด้วยครับ" (2026-08-01)
    // — เก็บอัตราที่ใช้คิดจริงตอนออกบิลนี้ลงในตัว invoice เอง (เหมือน
    // waterUnits/elecUnits ที่ frozen ไว้อยู่แล้วด้านล่าง) แทนที่จะปล่อยให้
    // ต้องหารย้อนกลับ (water÷waterUnits) เอาเอง หรือไปดูอัตราปัจจุบันของ
    // ห้องซึ่งอาจถูกแก้ไปแล้วหลังจากนั้น — ใช้อัตราของห้องเองก่อน (ตั้งจาก
    // สัญญาเช่า) ถ้าไม่มีค่อย fallback อัตรากลาง เหมือน frontend's
    // roomRate() เป๊ะๆ แต่คำนวณฝั่ง server เพื่อไม่ต้องพึ่ง client ส่งมาให้
    const settings = await readSettings();
    const waterRate = room && room.waterRate != null ? room.waterRate : settings.waterRate;
    const elecRate = room && room.elecRate != null ? room.elecRate : settings.elecRate;
    const credit = room ? room.creditBalance || 0 : 0;
    const applied = Math.min(credit, total);
    // Deliberately NOT 'partial' when credit only covers part of the bill —
    // 'partial' is reserved for when an actual slip payment came in and was
    // less than what was owed (see resolveSlip in Rental Management.dc.html),
    // a distinct real-world event from "some of this bill was pre-paid via
    // advance credit at the moment it was issued". A brand-new invoice with
    // leftover credit applied should still read as a normal outstanding bill
    // (ยอดที่ต้องชำระ = the remainder) so the next slip that arrives goes
    // through the regular full/partial/credit resolution flow against that
    // remainder, instead of being treated as a second partial payment on an
    // already-partial bill. amountPaid/remainingDue (see coerceInvoices)
    // still correctly reflect the applied credit either way.
    const status = applied >= total && total > 0 ? 'paid' : 'pending';

    const invoice = {
      id: 'INV-' + b.room + '-' + Date.now(),
      room: b.room,
      tenant: b.tenant || '',
      rent, water, elec, trash, internet,
      due: b.due || '',
      status,
      paidDate: status === 'paid' ? new Date().toISOString().slice(0, 10) : '',
      amountPaid: applied,
      // Frozen at creation time so the LINE receipt can show "X หน่วย ×
      // rate" and the previous bill's reading no matter when it's actually
      // sent — see coerceInvoices' comment on why these can't just be
      // recomputed from the room's current waterPrev/elecPrev later.
      waterUnits: b.waterUnits != null ? Number(b.waterUnits) : '',
      elecUnits: b.elecUnits != null ? Number(b.elecUnits) : '',
      waterPrevReading: b.waterPrevReading != null ? Number(b.waterPrevReading) : '',
      elecPrevReading: b.elecPrevReading != null ? Number(b.elecPrevReading) : '',
      waterRate, elecRate,
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
    // "ถ้ามีการชำระบิลเรียบร้อยแล้ว ให้ลบออกไปเลยครับ มันจะได้ไม่เต็ม
    // เหมือนถูกเคลียร์ข้อมูลตลอด หลังจบบิล" (2026-07-29) — พอบิลนี้ปิดจบแล้ว
    // (status กลายเป็น 'paid' — ไม่ว่าจะมาจากกด "ยืนยันชำระ", ยืนยันสลิป,
    // หรือทางไหนก็ตามที่เรียก PATCH นี้) ล้างแถว ScheduledMessages ของห้อง
    // นี้ที่มาจากบิลนี้ทิ้งไปเลย (ทั้งที่ส่งไปแล้วและยังไม่ส่ง) กันชีตค้าง
    // ข้อมูลเก่าสะสมไปเรื่อยๆ ไม่มีวันจบ — ปลอดภัยเพราะห้องนี้จะมีบิลค้าง
    // (ไม่ paid) ได้แค่ 1 ใบเสมอ (ระบบกันไม่ให้ออกบิลซ้อน) การมาร์ค paid
    // ที่นี่จึงหมายความว่า ScheduledMessages ที่เหลือของห้องนี้ต้องเป็นของ
    // บิลใบนี้เท่านั้น ไม่มีทางเป็นของบิลใบอื่น
    if (req.body.status === 'paid' && merged.room) {
      try {
        const scheduled = await readTab('ScheduledMessages');
        const closed = scheduled.filter((m) => m.room === merged.room && m.source === 'invoice_receipt');
        for (const m of closed) await deleteRow('ScheduledMessages', m.id);
      } catch (err) {
        console.error('[invoices] failed to clear closed-bill scheduled sends', req.params.id, err.message);
      }
    }
    res.json(coerceInvoices([merged])[0]);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    // Real bug a user hit: deleting an invoice used to just delete the
    // row, with no regard for amountPaid on it — any money already
    // tracked against that bill (whether from auto-applied advance credit
    // or a confirmed slip) simply vanished, since neither the invoice nor
    // the room's creditBalance still remembered it existed. Since deleting
    // the BILL doesn't mean the tenant's already-given money stops
    // existing, refund the full amountPaid back to the room's
    // creditBalance before removing the row — it becomes available credit
    // for the next bill, same bucket advance payments already use.
    const invoices = coerceInvoices(await readTab('Invoices'));
    const invoice = invoices.find((i) => i.id === req.params.id);
    // Accounting-integrity guard, per explicit user request: once a real
    // tenant slip has come in against this bill — either currently awaiting
    // review (slipPending) or already resolved as a partial payment (status
    // 'partial' only ever comes from an actual slip resolution now, see
    // Rental Management.dc.html's resolveSlip / server-side create logic) —
    // block deletion entirely, even if this endpoint is hit directly instead
    // of through the frontend's own guard (defense in depth, same pattern as
    // the duplicate-invoice check in POST / above). Editing is unaffected.
    if (invoice && (invoice.slipPending || invoice.status === 'partial')) {
      return res.status(400).json({ error: 'บิลนี้มีสลิปที่ส่งเข้ามาแล้ว ไม่สามารถลบได้ (แก้ไขได้ปกติ)' });
    }
    let refunded = 0;
    // Real bug a user hit: creating an invoice advances the room's
    // waterPrev/elecPrev baseline to the reading THAT invoice was billed
    // against (see POST / above and Rental Management.dc.html's
    // submitInvoice), so the create-invoice form's "หน่วยบิลหลังสุด" always
    // shows the right starting point for the NEXT bill. But deleting that
    // invoice never undid the advance — the room stayed pointed at a
    // reading that belonged to a bill that no longer exists, silently
    // corrupting every future usage calculation for that room. Revert the
    // baseline back to what this invoice recorded as ITS OWN "before"
    // reading (waterPrevReading/elecPrevReading), but ONLY if the room's
    // current baseline still matches what this exact invoice set it to
    // (prevReading + units) — if it's since moved further (a newer invoice,
    // a manual meter edit), leave it alone rather than clobbering more
    // recent legitimate data.
    const roomPatch = {};
    if (invoice) {
      const rooms = coerceRooms(await readTab('Rooms'));
      const room = rooms.find((r) => r.id === invoice.room);
      if (room) {
        if (invoice.amountPaid > 0) {
          refunded = invoice.amountPaid;
          roomPatch.creditBalance = (room.creditBalance || 0) + refunded;
        }
        if (invoice.waterPrevReading != null && invoice.waterUnits != null) {
          const expectedCurrent = invoice.waterPrevReading + invoice.waterUnits;
          if (room.waterPrev === expectedCurrent) roomPatch.waterPrev = invoice.waterPrevReading;
        }
        if (invoice.elecPrevReading != null && invoice.elecUnits != null) {
          const expectedCurrent = invoice.elecPrevReading + invoice.elecUnits;
          if (room.elecPrev === expectedCurrent) roomPatch.elecPrev = invoice.elecPrevReading;
        }
        if (Object.keys(roomPatch).length) await updateRow('Rooms', invoice.room, roomPatch);
      }
    }
    // "กรณีที่กดลบใบเสร็จ ให้ลบส่วนของการส่งข้อมูลแบบกำหนดเวลาออกด้วย
    // ไม่อย่างนั้นมันจะค้าง" (2026-07-29) — ถ้าบิลนี้เคยตั้ง "ตั้งวันเวลาส่ง"
    // ไว้ (server/routes/scheduledMessages.js's source: 'invoice_receipt')
    // แล้วโดนลบก่อนถึงเวลาที่ตั้งไว้ คิวเก่าจะยังค้างอยู่ใน ScheduledMessages
    // เฉยๆ แล้วไปส่งข้อความ "ใบแจ้งหนี้" อ้างถึงบิลที่ไม่มีอยู่แล้วจริงในภาย
    // หลัง (bug จริงที่เจอวันนี้ตอนไล่ debug ฟีเจอร์ตั้งเวลาส่ง) — ลบทุกแถว
    // ของห้องนี้ที่มาจากฟอร์มออกบิลออกไปด้วย **ไม่ว่าจะส่งไปแล้วหรือยังไม่ส่ง
    // ก็ตาม** (2026-07-29 follow-up ตามคำขอ "บักตัวเล็กๆ ถ้าข้อความถูกส่งไป
    // แล้ว แต่มีการลบ ให้เคลียร์ส่วนนี้ด้วย" — เดิมกรองแค่ sent !== 'TRUE'
    // ทำให้แถวที่ส่งไปแล้ว (sent: TRUE) ค้างอยู่ในชีตตลอดไปถ้าบิลถูกลบ ไม่
    // เคยถูกเคลียร์เหมือน mark-paid ทำอยู่แล้ว — ตอนนี้พฤติกรรมตรงกัน:
    // ลบบิล = เคลียร์ ScheduledMessages ของบิลนั้นทิ้งเสมอ ไม่ว่าจะอยู่ใน
    // สถานะไหน) — (ไม่แตะ source อื่นอย่าง 'manual'/'calendar' — นั่นไม่ผูก
    // กับบิลใบนี้)
    let cancelledSchedules = 0;
    if (invoice) {
      try {
        const scheduled = await readTab('ScheduledMessages');
        const stale = scheduled.filter((m) => m.room === invoice.room && m.source === 'invoice_receipt');
        for (const m of stale) {
          await deleteRow('ScheduledMessages', m.id);
          cancelledSchedules++;
        }
      } catch (err) {
        console.error('[invoices] failed to cancel stale scheduled sends for deleted invoice', req.params.id, err.message);
      }
    }
    await deleteRow('Invoices', req.params.id);
    res.json({ ok: true, refundedToCredit: refunded, meterReverted: !!(roomPatch.waterPrev != null || roomPatch.elecPrev != null), cancelledSchedules });
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

// Combined receipt-as-one-image, per explicit user request — used INSTEAD
// of the plain-text LINE message when the owner has a payment QR uploaded
// (see sendReceiptLine in Rental Management.dc.html), so the tenant gets a
// single readable image with the itemized bill AND the scan-to-pay QR baked
// into it, rather than two separate bubbles. Falls back to plain text on
// the frontend if this endpoint errors or no QR is configured.
router.post('/:id/receipt-image', async (req, res, next) => {
  try {
    const [invoices, rooms, settingsData] = await Promise.all([
      readTab('Invoices'), readTab('Rooms'), readSettings(),
    ]);
    const invoice = coerceInvoices(invoices).find((i) => i.id === req.params.id);
    if (!invoice) return res.status(404).json({ error: 'ไม่พบใบแจ้งหนี้นี้' });
    const room = coerceRooms(rooms).find((r) => r.id === invoice.room);

    let qrBuffer = null;
    const qrUrl = settingsData.propertyProfile.paymentQrUrl;
    if (qrUrl) {
      try {
        const qrRes = await fetch(qrUrl);
        if (qrRes.ok) qrBuffer = Buffer.from(await qrRes.arrayBuffer());
      } catch { /* QR fetch failing shouldn't block the rest of the receipt */ }
    }

    const buffer = await generateReceiptImage(invoice, room, settingsData.propertyProfile, qrBuffer);

    // Per explicit user follow-up request: the owner wants to look these
    // back up later (bill history modal), not just fire-and-forget them to
    // LINE — so this needs to survive a deploy. Cloudinary (same persistent
    // store already used for slip photos and the payment QR itself), NOT
    // the ephemeral local disk the PDF above still uses — a downloadable
    // PDF regenerates identically from the invoice data at any time, but a
    // deleted receipt IMAGE can't be perfectly reconstructed later (e.g. if
    // the QR gets replaced afterward, regenerating would show the NEW QR,
    // not the one actually sent).
    let url;
    if (cloudinaryConfigured()) {
      url = await uploadToCloudinary(buffer, 'chaosuk-rental/receipts');
    } else {
      // Fallback so this endpoint still works in a dev environment with no
      // Cloudinary credentials set — same ephemeral-disk trade-off as
      // everywhere else that falls back this way.
      const filename = invoice.id.replace(/[^a-zA-Z0-9-]/g, '_') + '-' + Date.now() + '.png';
      fs.writeFileSync(path.join(RECEIPT_IMG_DIR, filename), buffer);
      url = `${req.protocol}://${req.get('host')}/uploads/receipts/${filename}`;
    }

    await updateRow('Invoices', invoice.id, { receiptImageUrl: url });
    res.json({ url, hasQr: !!qrBuffer });
  } catch (err) { next(err); }
});

module.exports = router;
