const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isConfigured: cloudinaryConfigured, uploadBuffer: uploadToCloudinary } = require('../cloudinary');

// Diagnostic endpoint — confirms the CLOUDINARY_* env vars are set AND that
// they're actually valid (does a real tiny test upload, not just a presence
// check), so a typo in the value (easy to make copying a mixed-case secret
// by hand) shows up immediately instead of silently falling back to the
// ephemeral local disk the next time a real slip comes in.
router.get('/cloudinary-health', async (req, res) => {
  if (!cloudinaryConfigured()) {
    return res.json({ configured: false, ok: false, message: 'ยังไม่ได้ตั้งค่า CLOUDINARY_* ใน environment variables' });
  }
  try {
    const tinyPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    );
    const url = await uploadToCloudinary(tinyPng, 'chaosuk-rental/health-check');
    res.json({ configured: true, ok: true, testUrl: url });
  } catch (err) {
    res.json({ configured: true, ok: false, message: err.message });
  }
});

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// LINE's image message type needs a public HTTPS URL to fetch from (it can't
// take inline base64 data). This endpoint takes the data URL the browser
// already produced (see _downscaleImage in Rental Management.dc.html),
// writes it to disk, and hands back a URL on this same server that LINE can
// fetch. Note: Render's free tier has an ephemeral disk — files don't survive
// a restart/redeploy, but that's fine since LINE fetches the image within
// seconds of the message being sent, not later.
router.post('/image', (req, res) => {
  try {
    const { dataUrl } = req.body;
    const match = /^data:(image\/\w+);base64,(.+)$/.exec(dataUrl || '');
    if (!match) return res.status(400).json({ error: 'รูปภาพไม่ถูกต้อง' });
    const ext = match[1] === 'image/png' ? 'png' : 'jpg';
    const buffer = Buffer.from(match[2], 'base64');
    const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), buffer);

    const publicUrl = `${req.protocol}://${req.get('host')}/uploads/${filename}`;
    res.json({ url: publicUrl });
  } catch (err) {
    res.status(500).json({ error: err.message || 'อัปโหลดรูปไม่สำเร็จ' });
  }
});

// QR code for tenants to scan-and-pay — per explicit user request. Unlike
// the ephemeral local-disk endpoint above (fine for one-off slip photos
// LINE fetches within seconds), this is a persistent asset reused for
// every bill going forward, so it needs to survive deploys — uploaded to
// Cloudinary instead, same persistent-storage mechanism already used for
// slip photos (see server/cloudinary.js).
router.post('/payment-qr', async (req, res) => {
  try {
    if (!cloudinaryConfigured()) {
      return res.status(400).json({ error: 'ยังไม่ได้ตั้งค่าระบบเก็บรูปถาวร (Cloudinary) กรุณาติดต่อผู้ดูแลระบบ' });
    }
    const { dataUrl } = req.body;
    const match = /^data:(image\/\w+);base64,(.+)$/.exec(dataUrl || '');
    if (!match) return res.status(400).json({ error: 'รูปภาพไม่ถูกต้อง' });
    const buffer = Buffer.from(match[2], 'base64');
    const url = await uploadToCloudinary(buffer, 'chaosuk-rental/payment-qr');
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message || 'อัปโหลดรูปไม่สำเร็จ' });
  }
});

module.exports = router;
