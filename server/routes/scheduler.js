const express = require('express');
const router = express.Router();
const { readTab, updateRow } = require('../sheets');
const { readSettings, coerceRecurringTasks } = require('../coerce');
const { pushMessage, isConfigured: lineConfigured } = require('../line');
const { runAutomatedInstruction } = require('../automation');
const { isConfigured: claudeConfigured } = require('../claude');

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

    let sentCount = 0, scheduledChecked = 0, scheduledDue = 0;
    if (lineConfigured()) {
      const nowStr = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).slice(0, 16).replace(' ', 'T');
      const [rows, rooms] = await Promise.all([readTab('ScheduledMessages'), readTab('Rooms')]);
      const due = rows.filter((r) => r.sent !== 'TRUE' && r.sendAt && r.sendAt <= nowStr);
      scheduledChecked = rows.length;
      scheduledDue = due.length;

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
    }

    // Recurring tasks (server/routes/recurringTasks.js's /parse+save flow) —
    // run any task whose day/time matches today and hasn't already run today.
    // Needs the Claude API (to interpret actionSummary via tool-use), not
    // necessarily LINE, so this runs independently of the block above.
    let recurringRan = 0, recurringChecked = 0;
    if (claudeConfigured()) {
      const recurringRows = coerceRecurringTasks(await readTab('RecurringTasks'));
      recurringChecked = recurringRows.length;
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
      const nowHHMM = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });
      const dow = new Date(todayStr + 'T00:00:00').getDay(); // 0=Sun..6=Sat
      const dom = Number(todayStr.slice(8, 10));

      for (const task of recurringRows) {
        if (!task.active) continue;
        if (task.lastRunDate === todayStr) continue; // already ran today
        if (!task.time || nowHHMM < task.time) continue; // not due yet today

        let dueToday = false;
        if (task.scheduleType === 'monthly') dueToday = task.dayOfMonth === dom;
        else if (task.scheduleType === 'weekly') dueToday = task.dayOfWeek === dow;
        else if (task.scheduleType === 'daily') dueToday = true;
        if (!dueToday) continue;

        try {
          const result = await runAutomatedInstruction(task.actionSummary);
          await updateRow('RecurringTasks', task.id, { lastRunDate: todayStr, lastRunResult: String(result.log || '').slice(0, 500) });
          recurringRan++;
        } catch (err) {
          console.error('[scheduler] recurring task failed', task.id, err.message);
          await updateRow('RecurringTasks', task.id, { lastRunDate: todayStr, lastRunResult: ('ผิดพลาด: ' + err.message).slice(0, 500) });
        }
      }
    }

    res.json({
      ran: true,
      scheduledMessages: { checked: scheduledChecked, due: scheduledDue, sent: sentCount },
      recurringTasks: { checked: recurringChecked, ran: recurringRan },
    });
  } catch (err) { next(err); }
});

module.exports = router;
