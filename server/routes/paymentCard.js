const express = require('express');
const router = express.Router();
const { readSettings } = require('../coerce');
const { generatePaymentCardImage } = require('../receiptImage');
const { isConfigured: cloudinaryConfigured, uploadBuffer: uploadToCloudinary } = require('../cloudinary');

// Generic image card for payment-related LINE messages that AREN'T the
// itemized billing notice (that one's POST /api/invoices/:id/receipt-image,
// which needs real invoice line-items). Per explicit user request: advance-
// payment/credit confirmations and partial/full payment confirmations
// should ALSO go out as an image instead of plain text, but none of those
// events are always tied to one specific invoice (advance-payment credit
// especially — it's a room-level balance, not an invoice), so this endpoint
// is intentionally stateless — the frontend (which already computed all
// these numbers to build the old text message) just describes what to draw,
// and this renders + uploads it. Nothing gets persisted/looked-up server-
// side here (unlike receipt-image, which saves the URL back onto an
// invoice) — these events don't have one natural place to file that link.
router.post('/', async (req, res, next) => {
  try {
    const { title, subtitle, roomId, tenant, lines, highlight, footerNote, includeQr } = req.body;
    if (!title) return res.status(400).json({ error: 'ต้องระบุหัวข้อ (title)' });

    const settingsData = await readSettings();
    let qrBuffer = null;
    if (includeQr && settingsData.propertyProfile.paymentQrUrl) {
      try {
        const qrRes = await fetch(settingsData.propertyProfile.paymentQrUrl);
        if (qrRes.ok) qrBuffer = Buffer.from(await qrRes.arrayBuffer());
      } catch { /* QR fetch failing shouldn't block the rest of the card */ }
    }

    const buffer = await generatePaymentCardImage(
      { title, subtitle, roomId, tenant, lines, highlight, footerNote },
      settingsData.propertyProfile, qrBuffer
    );

    if (!cloudinaryConfigured()) {
      return res.status(400).json({ error: 'ยังไม่ได้ตั้งค่าระบบเก็บรูปถาวร (Cloudinary) กรุณาติดต่อผู้ดูแลระบบ' });
    }
    const url = await uploadToCloudinary(buffer, 'chaosuk-rental/payment-cards');
    res.json({ url });
  } catch (err) { next(err); }
});

module.exports = router;
