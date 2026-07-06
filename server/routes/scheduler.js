const express = require('express');
const router = express.Router();
const { readTab, updateRow } = require('../sheets');
const { readSettings } = require('../coerce');
const { pushMessage, isConfigured: lineConfigured } = require('../line');

// Called periodically by an external trigger (GitHub Actions cron — see
// .github/workflows/scheduler.yml) rather than an in-process setInterval,
// because Render's free tier sleeps the app when idle; an external ping both
// wakes the instance and drives this check, the same fix already used for
// unreliable auto-deploy. Safe to call as often as needed — every call is a
// no-op unless a message's time has actually arrived.
router.get('/run', async (req, res, next) => {
  try {
    const settings = await readSettings();
    if (!settings.claudeAutomationEnabled) {
      return res.json({ ran: false, reason: 'ปิดใช้งานอยู่ (เปิดสวิตช์ "เปิดใช้งานฟีเจอร์นี้" ในหน้าตั้งค่าก่อน)' });
    }
    if (!lineConfigured()) {
      return res.json({ ran: false, reason: 'ยังไม่ได้ตั้งค่า LINE บนเซิร์ฟเวอร์' });
    }

    const nowStr = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).slice(0, 16).replace(' ', 'T');
    const [rows, rooms] = await Promise.all([readTab('ScheduledMessages'), readTab('Rooms')]);
    const due = rows.filter((r) => r.sent !== 'TRUE' && r.sendAt && r.sendAt <= nowStr);

    let sentCount = 0;
    for (const row of due) {
      try {
        if (row.room === 'all') {
          const targets = rooms.filter((r) => r.lineUserId);
          for (const r of targets) await pushMessage(r.lineUserId, row.message);
        } else {
          const room = rooms.find((r) => r.id === row.room);
          if (room && room.lineUserId) await pushMessage(room.lineUserId, row.message);
        }
        await updateRow('ScheduledMessages', row.id, { sent: 'TRUE' });
        sentCount++;
      } catch (err) {
        console.error('[scheduler] failed to send', row.id, err.message);
      }
    }
    res.json({ ran: true, checked: rows.length, due: due.length, sent: sentCount });
  } catch (err) { next(err); }
});

module.exports = router;
