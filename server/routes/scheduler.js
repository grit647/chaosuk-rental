const express = require('express');
const router = express.Router();
const { readTab, updateRow } = require('../sheets');
const { readSettings, coerceRecurringTasks, coerceInvoices, readIntegrationCredentials } = require('../coerce');
const { pushMessage, isConfigured: lineConfigured } = require('../line');
const { runAutomatedInstruction } = require('../automation');
const { isConfigured: claudeConfigured } = require('../claude');
const { notifyAdmin } = require('../adminNotify');
const { syncOwnerRichMenuBadges } = require('../ownerRichMenu');

// "แจ้งเตือน ตัดน้ำตัดไฟ...แจ้งเตือนยังไม่ชำระ ทุกวันที่เท่าไร ถ้ายังไม่
// ชำระ วันไหน ตัดน้ำ ตัดไฟ" (2026-07-26) — in-memory throttle (same
// pattern as notifyBusyPeriod/notifyOwnerInsufficientCredit in
// server/notifications.js) instead of a persisted Sheet column, to avoid
// yet another multi-tenant Sheet migration (see CLAUDE.md's "Permanent
// gotcha") for what's a low-stakes once-a-day nudge — worst case after a
// rare server restart is one duplicate notification that day.
const _cutoffNotifiedDates = new Map(); // "reminder:room:invId" | "final:room:invId" -> "YYYY-MM-DD"

// Called periodically by an external trigger (GitHub Actions cron — see
// .github/workflows/scheduler.yml) rather than an in-process setInterval,
// because Render's free tier sleeps the app when idle; an external ping both
// wakes the instance and drives this check, the same fix already used for
// unreliable auto-deploy. Safe to call as often as needed — every call is a
// no-op unless a message's time has actually arrived.
router.get('/run', async (req, res, next) => {
  try {
    const settings = await readSettings();

    // Overdue-bill detection runs unconditionally — deliberately NOT gated
    // behind claudeAutomationEnabled below, since transitioning a bill to
    // "เกินกำหนด" is basic bill-management housekeeping, not an "AI
    // automation" feature the owner might have off. Only invoices moving
    // INTO overdue status this run get an admin notification (not
    // re-notifying every 10 minutes for bills already overdue).
    let overdueChecked = 0, overdueNew = 0;
    try {
      const invoices = coerceInvoices(await readTab('Invoices'));
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
      const candidates = invoices.filter((i) => (i.status === 'pending' || i.status === 'partial') && i.due && i.due < todayStr);
      overdueChecked = candidates.length;
      for (const inv of candidates) {
        try {
          await updateRow('Invoices', inv.id, { status: 'overdue' });
          overdueNew++;
          const total = inv.rent + inv.water + inv.elec + (inv.trash || 0) + (inv.internet || 0);
          const remaining = inv.remainingDue != null ? inv.remainingDue : Math.max(0, total - (inv.amountPaid || 0));
          notifyAdmin('overdueBill', `บิลห้อง ${inv.room} เกินกำหนดชำระแล้วครับ (ครบกำหนด ${inv.due}) ยอดค้าง ${remaining.toLocaleString()} บาท`).catch(() => {});
        } catch (err) {
          console.error('[scheduler] overdue transition failed', inv.id, err.message);
        }
      }
    } catch (err) {
      console.error('[scheduler] overdue check failed', err.message);
    }

    // "แจ้งเตือน ตัดน้ำตัดไฟ" (2026-07-26) — ยังไม่ชำระถึงวันที่ reminderDay
    // = เตือนเฉยๆ, ยังไม่ชำระถึงวันที่ finalDay = เตือนให้พิจารณาตัดน้ำ/ไฟ
    // (แค่เตือน — ไม่มีการตัดจริงอัตโนมัติเลย ตาม permanent rule ใน
    // CLAUDE.md) unconditional เหมือน overdue-bill check ด้านบน (basic
    // bill housekeeping ไม่ใช่ AI feature) แต่ต้องเปิดสวิตช์
    // adminNotify.cutoffWarning ไว้ก่อน (ผ่าน notifyAdmin เอง อยู่แล้ว)
    let cutoffChecked = 0, cutoffNotified = 0;
    try {
      if (settings.adminNotify && settings.adminNotify.cutoffWarning) {
        const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
        const todayDom = Number(todayStr.slice(8, 10));
        const reminderDay = Number(settings.cutoffReminderDay) || 5;
        const finalDay = Number(settings.cutoffFinalDay) || 15;
        // "อนุญาติยกเลิกสัญญาเช่า" (2026-07-26 follow-up) — วันที่ 3 ถัดจาก
        // reminder/final — แค่ "เตือน" ให้พิจารณายกเลิกสัญญา ไม่มีการยกเลิก
        // อัตโนมัติเด็ดขาด (ดู comment เต็มใน coerce.js's cutoffCancelWarningDay
        // — คุณต้นปฏิเสธการยกเลิกอัตโนมัติไปแล้วเพราะขัด permanent rule)
        const cancelWarningDay = Number(settings.cutoffCancelWarningDay) || 25;
        if (todayDom === reminderDay || todayDom === finalDay || todayDom === cancelWarningDay) {
          const invoices = coerceInvoices(await readTab('Invoices'));
          const unpaid = invoices.filter((i) => i.status === 'pending' || i.status === 'partial' || i.status === 'overdue');
          cutoffChecked = unpaid.length;
          for (const inv of unpaid) {
            const total = inv.rent + inv.water + inv.elec + (inv.trash || 0) + (inv.internet || 0);
            const remaining = inv.remainingDue != null ? inv.remainingDue : Math.max(0, total - (inv.amountPaid || 0));
            const kind = todayDom === cancelWarningDay ? 'cancelWarning' : todayDom === finalDay ? 'final' : 'reminder';
            const key = `${kind}:${inv.room}:${inv.id}`;
            if (_cutoffNotifiedDates.get(key) === todayStr) continue; // already notified today
            const msg = kind === 'cancelWarning'
              ? `🚨 ห้อง ${inv.room} ยังไม่ชำระถึงวันที่ ${cancelWarningDay} แล้วครับ ยอดค้าง ${remaining.toLocaleString()} บาท — พิจารณายกเลิกสัญญาเช่าได้เลยครับ (ต้องไปกดยกเลิกเองที่หน้าสัญญาเช่า ระบบไม่ยกเลิกให้อัตโนมัติ)`
              : kind === 'final'
              ? `⚠️ ห้อง ${inv.room} ยังไม่ชำระถึงวันที่ ${finalDay} แล้วครับ ยอดค้าง ${remaining.toLocaleString()} บาท — พิจารณาตัดน้ำ/ไฟ ได้เลยครับ (ตัดจริงต้องทำเองที่หน้า "Set อุปกรณ์" ระบบไม่ตัดให้อัตโนมัติ)`
              : `🔔 ห้อง ${inv.room} ยังไม่ชำระค่าเช่าครับ (ยอดค้าง ${remaining.toLocaleString()} บาท)`;
            notifyAdmin('cutoffWarning', msg).catch(() => {});
            _cutoffNotifiedDates.set(key, todayStr);
            cutoffNotified++;
          }
        }
      }
    } catch (err) {
      console.error('[scheduler] cutoff warning check failed', err.message);
    }

    // Per explicit user request: keep the owner Rich Menu's "บิลค้างชำระ"/
    // "สลิปรอตรวจสอบ" badge numbers roughly current — same unconditional
    // treatment as the overdue-bill check right above (basic upkeep, not
    // an "AI automation" feature the claudeAutomationEnabled switch should
    // gate). Deliberately only refreshes on this hourly-ish external cron
    // tick, not live on every new slip — owner's own explicit choice to
    // keep this simple; syncOwnerRichMenuBadges() itself is a no-op unless
    // the counts actually changed since the last tick.
    let ownerRichMenuResult = null;
    try {
      const creds = await readIntegrationCredentials();
      ownerRichMenuResult = await syncOwnerRichMenuBadges(creds.line);
    } catch (err) {
      console.error('[scheduler] owner rich menu badge sync failed', err.message);
    }

    if (!settings.claudeAutomationEnabled) {
      return res.json({ ran: false, reason: 'ปิดใช้งานอยู่ (เปิดสวิตช์ "เปิดใช้งานฟีเจอร์นี้" ในหน้าตั้งค่าก่อน)', overdueBills: { checked: overdueChecked, newlyOverdue: overdueNew }, cutoffWarnings: { checked: cutoffChecked, notified: cutoffNotified }, ownerRichMenu: ownerRichMenuResult });
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
          // This exact gap (a recurring task silently failing for days with
          // no owner-visible signal beyond opening the modal) is what
          // prompted the whole admin-notification feature in the first
          // place — see the Anthropic-credit-exhaustion incident this app
          // hit during development.
          notifyAdmin('taskFailure', `คำสั่งงานประจำล้มเหลวครับ: "${task.humanSummary || task.actionSummary}"\nข้อผิดพลาด: ${err.message}`).catch(() => {});
        }
      }
    }

    res.json({
      ran: true,
      overdueBills: { checked: overdueChecked, newlyOverdue: overdueNew },
      cutoffWarnings: { checked: cutoffChecked, notified: cutoffNotified },
      scheduledMessages: { checked: scheduledChecked, due: scheduledDue, sent: sentCount },
      recurringTasks: { checked: recurringChecked, ran: recurringRan },
      ownerRichMenu: ownerRichMenuResult,
    });
  } catch (err) { next(err); }
});

module.exports = router;
