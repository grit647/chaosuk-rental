const express = require('express');
const router = express.Router();
const { readSettings } = require('../coerce');
const { generateStatementImage } = require('../statementImage');

// "เพิ่มอีก 1 ฟังก์ชัน สเตทเม้นท์ รายรับจ่าย...สร้างเป็น png สรุป"
// (2026-09-18) — เจตนาใช้แค่ดู popup ในเว็บ + ดาวน์โหลด/แชร์เอง (ไม่ได้
// ส่งต่อทาง LINE เหมือน payment-card-image) จึงไม่ต้องอัป Cloudinary เลย
// — สตรีมไฟล์ PNG กลับตรงๆ เบากว่า/ไม่เปลืองโควต้า Cloudinary โดยไม่
// จำเป็น ฝั่งหน้าเว็บ fetch เป็น blob แล้วเปิด lightbox เดิมที่มีปุ่ม
// แชร์/ดาวน์โหลดอยู่แล้ว (ดู Rental Management.dc.html's
// generateStatementImage ฝั่ง frontend)
//
// Stateless เหมือน payment-card-image — รายการ (rows) คำนวณ/กรองไว้แล้ว
// ฝั่ง frontend (จาก s.paymentLog/s.expenses ที่โหลดมาอยู่แล้ว) ส่งมาแค่
// สิ่งที่ต้องวาดเป็นรูป ไม่ต้องอ่าน Sheet ซ้ำฝั่งนี้เลย
router.post('/', async (req, res, next) => {
  try {
    const { kindLabel, periodLabel, rows, total, isIncome } = req.body;
    if (!Array.isArray(rows)) return res.status(400).json({ error: 'ข้อมูลไม่ถูกต้อง' });
    const settingsData = await readSettings();
    const buffer = await generateStatementImage({
      kindLabel: kindLabel || '', periodLabel: periodLabel || '',
      rows, total: Number(total) || 0, isIncome: !!isIncome,
      propertyName: settingsData.propertyProfile.name,
    });
    res.set('Content-Type', 'image/png');
    res.send(buffer);
  } catch (err) { next(err); }
});

module.exports = router;
