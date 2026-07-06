const express = require('express');
const router = express.Router();
const { readTab, updateRow } = require('../sheets');
const { isConfigured, verifySignature, replyMessage, pushMessage } = require('../line');

router.get('/status', (req, res) => {
  res.json({ connected: isConfigured() });
});

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
    const { roomId, message } = req.body;
    if (!roomId || !message || !String(message).trim()) {
      return res.status(400).json({ error: 'กรุณาระบุห้องและข้อความ' });
    }
    const rooms = await readTab('Rooms');
    const room = rooms.find((r) => r.id === roomId);
    if (!room || !room.lineUserId) {
      return res.status(400).json({ error: `ห้อง ${roomId} ยังไม่ได้เชื่อมต่อ LINE` });
    }
    await pushMessage(room.lineUserId, message);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
