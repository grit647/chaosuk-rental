// สร้างรายการ "ตั้งเวลาส่งข้อความ LINE" แบบทั่วไป — ใช้โดยฟีเจอร์ popup
// "ส่งใบแจ้งหนี้เมื่อไหร่ดี?" (2026-07-29) ตอนออกใบแจ้งหนี้ (ทั้งห้องเดียว
// และออกทั้งหมดพร้อมกัน) เมื่อเลือก "ตั้งวันและเวลาส่ง" — เขียนลงแท็บ
// ScheduledMessages ตัวเดียวกับที่ server/claudeTools.js's
// schedule_line_message tool และ add_calendar_event's notifyChannel ใช้อยู่
// แล้ว — server/routes/scheduler.js's GET /run เป็นตัวส่งข้อความจริงตอนถึง
// เวลา (ทำงานผ่าน GitHub Actions cron ภายนอก, ดู comment เต็มในไฟล์นั้น —
// ต้องเปิดสวิตช์ "เปิดใช้งานฟีเจอร์นี้" (claudeAutomationEnabled) ในหน้า
// ตั้งค่าไว้ด้วย ไม่งั้นข้อความที่ตั้งเวลาไว้จะไม่ถูกส่งเมื่อถึงเวลา —
// เงื่อนไขเดียวกับ schedule_line_message ทุกทางที่มีอยู่แล้ว)
const express = require('express');
const router = express.Router();
const { appendRow } = require('../sheets');

router.post('/', async (req, res, next) => {
  try {
    const { room, message, sendAt } = req.body;
    if (!room || !message || !sendAt) {
      return res.status(400).json({ error: 'ข้อมูลไม่ครบ (room, message, sendAt)' });
    }
    const row = { id: Date.now() + '-invoice', room, message, sendAt, sent: 'FALSE', source: 'invoice_receipt' };
    await appendRow('ScheduledMessages', row);
    res.json({ ok: true, ...row });
  } catch (err) { next(err); }
});

module.exports = router;
