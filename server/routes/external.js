// เส้นทางสำหรับ "ช.นายท้าย" (แพลตฟอร์มที่ 4 ของคุณต้น, D:\chor-naithai)
// เรียกเข้ามาสั่งส่งข้อความ LINE ผ่านบัญชีนี้ได้ — ไม่ใช่ user session ปกติ
// (ไม่มี cookie/login) เป็นการเรียกระหว่างเซิร์ฟเวอร์ (server-to-server)
// ยืนยันตัวตนด้วย shared secret key แทน (CHOR_NAITHAI_SHARED_KEY ใน .env
// ต้องตรงกันทั้ง 2 ฝั่ง) — ทุก route ในไฟล์นี้เช็ค header นี้ก่อนเสมอ ถ้าไม่
// ตรง/ไม่มี ปฏิเสธทันที ป้องกันใครก็ได้ที่รู้ URL มาสั่งส่งข้อความปลอมหา
// ผู้เช่า/เจ้าของจริงได้
//
// ต่างจาก 2 แพลตฟอร์มพี่น้อง (check-service-24/wholesale-order — Sheet
// เดียวใช้ร่วมกันหลายร้านจริงที่เป็นเจ้าของคนอื่น): เช่าสุขทุกตึกเป็นของ
// คุณต้นคนเดียว (แค่แยก Google Sheet ต่อตึก) เลยอนุญาตให้ "เลือกทั้งหมด"
// (ส่งหาทุกตึกพร้อมกัน) ได้ — customerSheetId เป็น optional: ไม่ระบุ =
// บัญชีหลัก (เหมือนเดิม, backward compatible) ระบุ = ใช้ runWithSheetId
// สลับไปตึกนั้นก่อนอ่าน/ส่ง
const express = require('express');
const router = express.Router();
const { readTab } = require('./../sheets');
const { readSettings, readIntegrationCredentials } = require('../coerce');
const { pushMessage, isConfigured: lineConfigured } = require('../line');
const { runWithSheetId } = require('../requestContext');

const DIRECTORY_SHEET_ID = process.env.GOOGLE_DIRECTORY_SHEET_ID;

function requireSharedKey(req, res, next) {
  const key = req.headers['x-chor-naithai-key'];
  if (!process.env.CHOR_NAITHAI_SHARED_KEY || key !== process.env.CHOR_NAITHAI_SHARED_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}
router.use(requireSharedKey);

async function withScope(customerSheetId, fn) {
  if (!customerSheetId) return fn(); // ไม่ระบุ = บัญชีหลัก (เหมือนเดิมก่อนมี multi-building)
  return runWithSheetId(customerSheetId, fn);
}

// รายชื่อตึกทั้งหมดของคุณต้น — ให้ ช.นายท้าย โชว์เป็น dropdown (รวม
// "ทุกตึก" ได้ เพราะทุกตึกเป็นของคุณต้นคนเดียว ต่างจาก 2 แพลตฟอร์มพี่น้อง
// ที่ร้าน/ธุรกิจเป็นของคนอื่นจริง)
router.get('/list-scopes', async (req, res, next) => {
  try {
    if (!DIRECTORY_SHEET_ID) return res.json({ scopes: [] });
    const users = await runWithSheetId(DIRECTORY_SHEET_ID, () => readTab('Users'));
    const seen = new Set();
    const rows = users.filter((u) => u.customerSheetId && !seen.has(u.customerSheetId) && seen.add(u.customerSheetId) && u.status !== 'suspended');
    const scopes = await Promise.all(rows.map(async (u) => {
      let name = u.customerSheetId === process.env.GOOGLE_SHEET_ID ? 'ตึกหลัก' : 'ตึกของคุณต้น';
      try {
        const settings = await runWithSheetId(u.customerSheetId, () => readSettings());
        if (settings.propertyProfile && settings.propertyProfile.name) name = settings.propertyProfile.name;
      } catch { /* ใช้ค่า fallback ด้านบน */ }
      return { id: u.customerSheetId, name };
    }));
    res.json({ scopes });
  } catch (err) { next(err); }
});

// ส่งข้อความหาเจ้าของ (adminLineUserId ที่ตั้งไว้ในหน้า "ผู้ดูแลหอพัก")
router.post('/notify-owner', async (req, res, next) => {
  try {
    const { message, customerSheetId } = req.body || {};
    if (!message || !String(message).trim()) return res.status(400).json({ error: 'กรุณาระบุข้อความ' });
    await withScope(customerSheetId, async () => {
      const creds = await readIntegrationCredentials();
      if (!lineConfigured(creds.line)) throw Object.assign(new Error('บัญชีนี้ยังไม่ได้เชื่อมต่อ LINE'), { status: 400 });
      const settings = await readSettings();
      const adminId = settings.propertyProfile && settings.propertyProfile.adminLineUserId;
      if (!adminId) throw Object.assign(new Error('ยังไม่ได้เชื่อมบัญชี LINE เจ้าของ (adminLineUserId ว่าง)'), { status: 400 });
      await pushMessage(adminId, message, undefined, creds.line);
    });
    res.json({ ok: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// ค้นหาผู้เช่า (ห้อง) — พิมพ์ชื่อ/เบอร์/เลขห้อง จับคู่แบบ "มีคำนี้อยู่บ้าง"
// (ไม่สนตัวพิมพ์เล็ก/ใหญ่) คืนเฉพาะ id+ป้ายชื่อ+มี LINE เชื่อมหรือยัง —
// ไม่คืน lineUserId จริงออกไปเลย (ให้ ช.นายท้าย เรียก send-to-recipient
// ด้วย id แทน กันข้อมูลรั่วข้ามระบบโดยไม่จำเป็น)
router.get('/search-recipient', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (!q) return res.json({ results: [] });
    const results = await withScope(req.query.customerSheetId, async () => {
      const rooms = await readTab('Rooms');
      return rooms
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
    });
    res.json({ results });
  } catch (err) { next(err); }
});

router.post('/send-to-recipient', async (req, res, next) => {
  try {
    const { id, message, customerSheetId } = req.body || {};
    if (!id) return res.status(400).json({ error: 'กรุณาระบุ id' });
    if (!message || !String(message).trim()) return res.status(400).json({ error: 'กรุณาระบุข้อความ' });
    await withScope(customerSheetId, async () => {
      const creds = await readIntegrationCredentials();
      if (!lineConfigured(creds.line)) throw Object.assign(new Error('บัญชีนี้ยังไม่ได้เชื่อมต่อ LINE'), { status: 400 });
      const rooms = await readTab('Rooms');
      const room = rooms.find((r) => String(r.id) === String(id));
      if (!room) throw Object.assign(new Error('ไม่พบห้องนี้'), { status: 404 });
      if (!room.lineUserId) throw Object.assign(new Error('ห้องนี้ยังไม่ได้เชื่อมต่อ LINE'), { status: 400 });
      await pushMessage(room.lineUserId, message, undefined, creds.line);
    });
    res.json({ ok: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
