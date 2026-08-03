// เส้นทางสำหรับ "ช.นายท้าย" (แพลตฟอร์มที่ 4 ของคุณต้น, D:\chor-naithai)
// เรียกเข้ามาสั่งส่งข้อความ LINE ผ่านบัญชีนี้ได้ — ไม่ใช่ user session ปกติ
// (ไม่มี cookie/login) เป็นการเรียกระหว่างเซิร์ฟเวอร์ (server-to-server)
// ยืนยันตัวตนด้วย shared secret key แทน (CHOR_NAITHAI_SHARED_KEY ใน .env
// ต้องตรงกันทั้ง 2 ฝั่ง) — ทุก route ในไฟล์นี้เช็ค header นี้ก่อนเสมอ ถ้าไม่
// ตรง/ไม่มี ปฏิเสธทันที ป้องกันใครก็ได้ที่รู้ URL มาสั่งส่งข้อความปลอมหา
// ผู้เช่า/เจ้าของจริงได้
//
// ข้อจำกัด (เหมือน /api/system-health): endpoint นี้ไม่มี session/
// customerSheetId context ให้รู้ว่ากำลังหมายถึงตึกไหน — เข้าถึงได้แค่บัญชี
// หลัก (server/.env's GOOGLE_SHEET_ID) เท่านั้น ไม่รวมอีก 2 ตึกที่มี Sheet
// แยกของตัวเอง (บ้านเลขที่1873/บ้านพักครูโจ)
const express = require('express');
const router = express.Router();
const { readTab } = require('./../sheets');
const { readSettings } = require('../coerce');
const { pushMessage, isConfigured: lineConfigured } = require('../line');

function requireSharedKey(req, res, next) {
  const key = req.headers['x-chor-naithai-key'];
  if (!process.env.CHOR_NAITHAI_SHARED_KEY || key !== process.env.CHOR_NAITHAI_SHARED_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}
router.use(requireSharedKey);

// ส่งข้อความหาเจ้าของ (adminLineUserId ที่ตั้งไว้ในหน้า "ผู้ดูแลหอพัก")
router.post('/notify-owner', async (req, res, next) => {
  try {
    const { message } = req.body || {};
    if (!message || !String(message).trim()) return res.status(400).json({ error: 'กรุณาระบุข้อความ' });
    if (!lineConfigured()) return res.status(400).json({ error: 'บัญชีนี้ยังไม่ได้เชื่อมต่อ LINE' });
    const settings = await readSettings();
    const adminId = settings.propertyProfile && settings.propertyProfile.adminLineUserId;
    if (!adminId) return res.status(400).json({ error: 'ยังไม่ได้เชื่อมบัญชี LINE เจ้าของ (adminLineUserId ว่าง)' });
    await pushMessage(adminId, message);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ค้นหาผู้เช่า (ห้อง) — พิมพ์ชื่อ/เบอร์/เลขห้อง จับคู่แบบ "มีคำนี้อยู่บ้าง"
// (ไม่สนตัวพิมพ์เล็ก/ใหญ่) คืนเฉพาะ id+ป้ายชื่อ+มี LINE เชื่อมหรือยัง —
// ไม่คืน lineUserId จริงออกไปเลย (ให้ ช.นายท้าย เรียก send-to-recipient
// ด้วย id แทน กันข้อมูลรั่วข้ามระบบโดยไม่จำเป็น)
router.get('/search-recipient', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (!q) return res.json({ results: [] });
    const rooms = await readTab('Rooms');
    const results = rooms
      .filter((r) => {
        const hay = [r.id, r.tenant, r.phone].filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
      })
      .slice(0, 20)
      .map((r) => ({
        id: r.id,
        label: `ห้อง ${r.id}${r.tenant ? ` — ${r.tenant}` : ''}${r.phone ? ` (${r.phone})` : ''}`,
        hasLine: !!r.lineUserId,
      }));
    res.json({ results });
  } catch (err) { next(err); }
});

router.post('/send-to-recipient', async (req, res, next) => {
  try {
    const { id, message } = req.body || {};
    if (!id) return res.status(400).json({ error: 'กรุณาระบุ id' });
    if (!message || !String(message).trim()) return res.status(400).json({ error: 'กรุณาระบุข้อความ' });
    if (!lineConfigured()) return res.status(400).json({ error: 'บัญชีนี้ยังไม่ได้เชื่อมต่อ LINE' });
    const rooms = await readTab('Rooms');
    const room = rooms.find((r) => String(r.id) === String(id));
    if (!room) return res.status(404).json({ error: 'ไม่พบห้องนี้' });
    if (!room.lineUserId) return res.status(400).json({ error: 'ห้องนี้ยังไม่ได้เชื่อมต่อ LINE' });
    await pushMessage(room.lineUserId, message);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
