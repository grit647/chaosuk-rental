const express = require('express');
const router = express.Router();
const { seedDemoData } = require('../demoSeed');

// Called periodically by an external trigger (GitHub Actions cron — see
// .github/workflows/demo-reset.yml), same pattern already used for the
// scheduled-messages checker (server/routes/scheduler.js) — Render's free
// tier sleeps the app when idle, so an in-process timer alone can't
// reliably fire on schedule. Per explicit user request: resets the
// dedicated Demo Sheet back to its baseline every hour, discarding
// anything a visitor typed/saved — never touches any real customer's
// Sheet (DEMO_SHEET_ID is a completely separate spreadsheet).
router.get('/run', async (req, res, next) => {
  try {
    if (!process.env.DEMO_SHEET_ID) return res.status(500).json({ error: 'ยังไม่ได้ตั้งค่า DEMO_SHEET_ID บนเซิร์ฟเวอร์' });
    const result = await seedDemoData(process.env.DEMO_SHEET_ID);
    res.json({ ok: true, ...result });
  } catch (err) { next(err); }
});

module.exports = router;
