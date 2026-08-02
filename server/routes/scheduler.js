const express = require('express');
const router = express.Router();
const { readTab, updateRow, pruneOldRows } = require('../sheets');
const { readSettings, coerceRecurringTasks, coerceInvoices, readIntegrationCredentials } = require('../coerce');
const { pushMessage, pushMessageWithConfirmButton, pushButtonMessage, isConfigured: lineConfigured } = require('../line');
const { runAutomatedInstruction } = require('../automation');
const { isConfigured: claudeConfigured } = require('../claude');
const { notifyAdmin } = require('../adminNotify');
const { syncOwnerRichMenuBadges } = require('../ownerRichMenu');
const { runWithSheetId, getCurrentSheetId } = require('../requestContext');

const DIRECTORY_SHEET_ID = process.env.GOOGLE_DIRECTORY_SHEET_ID;
// ค่านี้ต้องคงที่ = เวอร์ชันที่ฟีเจอร์นี้เปิดตัวจริง (4) ห้ามอ้างอิง
// CURRENT_PLATFORM_VERSION แบบ live เพราะค่านั้นจะขยับขึ้นเรื่อยๆ ทุกครั้งที่
// มีฟีเจอร์หน้าบ้านใหม่ๆ ในอนาคต — ถ้าอ้างอิงตรงๆ ตึกที่กด "🆕 อัปเดต" ไป
// รับ v4 แล้ว จะถูกเขี่ยออกจากลูปนี้อีกครั้งทันทีที่ CURRENT_PLATFORM_VERSION
// ขยับเป็น 5 ทั้งที่เจ้าของตึกนั้นไม่เคยเปลี่ยนใจอะไรเลย (ดู server/
// platformVersion.js's v4 note — pattern เดียวกับที่ frontend ใช้เทียบ
// เวอร์ชันตายตัวของแต่ละฟีเจอร์ เช่น `authSession.platformVersion >= 2`)
const SCHEDULER_MULTI_BUILDING_VERSION = 4;

// "แจ้งเตือน ตัดน้ำตัดไฟ...แจ้งเตือนยังไม่ชำระ ทุกวันที่เท่าไร ถ้ายังไม่
// ชำระ วันไหน ตัดน้ำ ตัดไฟ" (2026-07-26) — in-memory throttle (same
// pattern as notifyBusyPeriod/notifyOwnerInsufficientCredit in
// server/notifications.js) instead of a persisted Sheet column, to avoid
// yet another multi-tenant Sheet migration (see CLAUDE.md's "Permanent
// gotcha") for what's a low-stakes once-a-day nudge — worst case after a
// rare server restart is one duplicate notification that day.
//
// 2026-07-29 — keys are now prefixed with the sheetId (see
// runSchedulerOnce below, which now runs once PER BUILDING). Before this
// fix a room ID like "101" existing in two different buildings' own
// separate spreadsheets would collide in this single shared Map, wrongly
// suppressing a real notification in building B just because building A
// already fired one for "the same" key today.
const _cutoffNotifiedDates = new Map(); // "sheetId:reminder:room:invId" | "sheetId:final:room:invId" -> "YYYY-MM-DD"

// "เก็บข้อมูลไว้สูงสุด 5 ปีเลยครับ" (2026-07-26) — ElectricityLog/WaterLog
// เก็บได้ถึง 1 แถว/ห้อง/ชั่วโมง ไม่เคยมีวันลบมาก่อน (ดู comment เต็มใน
// sheets.js's pruneOldRows) — เพิ่มการล้างข้อมูลเก่าเกิน 5 ปีให้อัตโนมัติ
// ตรงนี้ ทำแค่วันละครั้งพอ (in-memory throttle เหมือน cutoff-warning ด้าน
// ล่าง) เพราะ pruneOldRows ทำ read+clear+rewrite ทั้งแท็บ ไม่จำเป็นต้องรัน
// ทุกครั้งที่ scheduler ติ๊ก (รายชั่วโมง) — เก็บเป็น Map ต่อ sheetId
// (2026-07-29, เดิมเป็นตัวแปรเดี่ยวใช้ร่วมกันทุกตึก ทำให้ตึก B โดนข้ามไป
// ทั้งที่ยังไม่เคย prune วันนี้เลย แค่เพราะตึก A prune ไปแล้วก่อนหน้านั้น)
const LOG_RETENTION_YEARS = 5;
const _lastLogPruneDateBySheet = new Map(); // sheetId -> "YYYY-MM-DD"

// สิ่งที่ทำจริงในแต่ละรอบ scheduler — เดิมเป็นเนื้อในของ router.get('/run')
// ตรงๆ (สมมติว่ามีแค่บัญชีหลักบัญชีเดียวเสมอ) แยกออกมาเป็นฟังก์ชันเดี่ยวๆ
// (2026-07-29) เพื่อให้เรียกซ้ำได้ "ทีละตึก" — ดู router.get('/run')
// ด้านล่างซึ่งวน runWithSheetId ทับทุกตึกในทำเนียบ (Directory) ก่อนเรียก
// ฟังก์ชันนี้ — ก่อนหน้านี้ endpoint นี้ (ถูกเรียกจากภายนอกผ่าน GitHub
// Actions cron, ไม่มี session/คุกกี้เลย) จะ fallback ไปที่
// process.env.GOOGLE_SHEET_ID (บัญชีหลัก) เสมอเพียงบัญชีเดียว — ทุก
// ฟีเจอร์อัตโนมัติในไฟล์นี้ (แจ้งบิลเกินกำหนด/เตือนตัดน้ำ-ไฟ/เตือนก่อน
// ครบกำหนด/เตือนสัญญาใกล้หมดอายุ/ตั้งเวลาส่งบิล ฯลฯ) ไม่เคยทำงานให้ตึกอื่น
// นอกจากบัญชีหลักเลยสักครั้ง — บั๊กจริงที่คุณต้นเจอ ("ตอนนี้ตัวตั้งเวลา
// ข้อความยังไม่ส่งครับ เลยเวลาไปแล้ว" กับห้อง 647 ที่ไม่มีอยู่ในบัญชีหลัก)
// "ให้เจ้าของยืนยันได้เลย...ระบบส่งข้อความไปใหม่...แจ้งเจ้าของ" (2026-08-02)
// — RECEIPT_CONFIRM_VERSION เหมือน SCHEDULER_MULTI_BUILDING_VERSION ข้างบน
// เป๊ะ (ค่าคงที่ ไม่อ้างอิง CURRENT_PLATFORM_VERSION แบบ live ด้วยเหตุผล
// เดียวกัน) — คุมเฉพาะ block ยืนยันใบเสร็จข้างล่าง ไม่ใช่ทั้งฟังก์ชัน
const RECEIPT_CONFIRM_VERSION = 6;

async function runSchedulerOnce(platformVersion = 0) {
  const sheetId = getCurrentSheetId() || process.env.GOOGLE_SHEET_ID;
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
    // ดึงครั้งเดียวก่อนลูป (ดู comment เต็มใน adminNotify.js's preloadedCreds
    // param) — ห้องเกินกำหนดหลายห้องพร้อมกันไม่ต้องอ่าน Settings ซ้ำทุกห้อง
    const overdueCreds = candidates.length ? await readIntegrationCredentials() : null;
    for (const inv of candidates) {
      try {
        await updateRow('Invoices', inv.id, { status: 'overdue' });
        overdueNew++;
        const total = inv.rent + inv.water + inv.elec + (inv.trash || 0) + (inv.internet || 0);
        const remaining = inv.remainingDue != null ? inv.remainingDue : Math.max(0, total - (inv.amountPaid || 0));
        notifyAdmin('overdueBill', `บิลห้อง ${inv.room} เกินกำหนดชำระแล้วครับ (ครบกำหนด ${inv.due}) ยอดค้าง ${remaining.toLocaleString()} บาท`, overdueCreds).catch(() => {});
      } catch (err) {
        console.error('[scheduler] overdue transition failed', inv.id, err.message);
      }
    }
  } catch (err) {
    console.error('[scheduler] overdue check failed', err.message);
  }

  // "ถ้าผ่านไป 24 ชม. ยังไม่กดยืนยัน ระบบส่งข้อความไปใหม่...ส่งไป 2 ครั้ง
  // แล้วไม่มีการยืนยัน ให้ส่งข้อความไปหาเจ้าของ" (2026-08-02) — เหมือน
  // overdue check ข้างบน ทำงานไม่มีเงื่อนไข (basic reliability housekeeping
  // ไม่ใช่ AI feature ที่ปิดได้) — resend ใช้ receiptImageUrl ที่บันทึกไว้
  // แล้วจากตอนส่งครั้งแรก (ไม่สร้างใบเสร็จใหม่ กันปัญหาเดิม "ใบเสร็จไม่
  // ตรงกับของเก่า") ถ้าไม่มีรูป fallback เป็นข้อความสรุปสั้นๆ จากข้อมูลบิล
  // เอง (server ไม่มีสิทธิ์เข้าถึง _buildReceiptMessage ซึ่งเป็นโค้ดฝั่ง
  // frontend)
  let receiptRetried = 0, receiptEscalated = 0;
  try {
    // ตึกที่ยังไม่กด "🆕 อัปเดต" ให้ถึง v6 (ดู platformVersion.js's v6
    // note) ไม่มีทางมีบิลไหนตั้ง receiptSendCount/receiptLastSentAt จริง
    // อยู่แล้ว (ฝั่ง frontend ก็ gate ไว้เหมือนกัน) แต่เช็คซ้ำตรงนี้ไว้
    // เป็นชั้นป้องกันที่สอง เผื่อมีทางอื่นเซ็ตค่าเหล่านี้เข้ามาในอนาคต
    const invoices = platformVersion >= RECEIPT_CONFIRM_VERSION ? coerceInvoices(await readTab('Invoices')) : [];
    const now = Date.now();
    const HOURS_24 = 24 * 60 * 60 * 1000;
    const pendingConfirm = invoices.filter((i) => i.receiptSent && !i.receiptDeliveryConfirmed && i.receiptLastSentAt);
    if (pendingConfirm.length) {
      const rooms = await readTab('Rooms');
      const receiptCreds = await readIntegrationCredentials();
      for (const inv of pendingConfirm) {
        const lastSent = new Date(inv.receiptLastSentAt).getTime();
        if (!lastSent || (now - lastSent) < HOURS_24) continue;
        const room = rooms.find((r) => r.id === inv.room);
        if (!room || !room.lineUserId) continue;
        if (inv.receiptSendCount >= 2) {
          if (!inv.receiptOwnerNotified) {
            try {
              await notifyAdmin('overdueBill', `ผู้เช่าห้อง ${inv.room} ยังไม่ยืนยันรับใบแจ้งหนี้ ${inv.id} เลยครับ (ส่งไปแล้ว ${inv.receiptSendCount} ครั้ง) กรุณาติดต่อผู้เช่าโดยตรงเพื่อยืนยันว่าได้รับบิลแล้วครับ`, receiptCreds);
              await updateRow('Invoices', inv.id, { receiptOwnerNotified: true });
              receiptEscalated++;
            } catch (err) { console.error('[scheduler] receipt escalation failed', inv.id, err.message); }
          }
          continue;
        }
        try {
          const total = inv.rent + inv.water + inv.elec + (inv.trash || 0) + (inv.internet || 0);
          const fallbackText = `ใบแจ้งหนี้ห้อง ${inv.room} (${inv.id}) — ยอดรวม ${total.toLocaleString()} บาท กำหนดชำระ ${inv.due || '-'} (ส่งซ้ำอีกครั้งเผื่อครั้งก่อนไม่ถึงครับ)`;
          await pushMessageWithConfirmButton(room.lineUserId, inv.receiptImageUrl ? '' : fallbackText, inv.receiptImageUrl || undefined, inv.id, receiptCreds.line);
          await updateRow('Invoices', inv.id, { receiptSendCount: inv.receiptSendCount + 1, receiptLastSentAt: new Date().toISOString() });
          receiptRetried++;
        } catch (err) { console.error('[scheduler] receipt retry failed', inv.id, err.message); }
      }
    }
  } catch (err) {
    console.error('[scheduler] receipt confirmation check failed', err.message);
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
      // "เพิ่มส่วนของวัน และเวลาตัดไฟจริงไว้ให้หน่อยครับ...เมื่อถึงวันและ
      // เวลาที่กำหนด ถ้ายังไม่ชำระบิล จะส่งข้อมูลให้เจ้าของเพื่อตัดสินใจ"
      // (2026-07-26) — เดิมเช็คแค่ "วันที่" (todayDom) อย่างเดียว ยิงทุก
      // 10 นาทีตลอดวันนั้นจนกว่า dedup จะกันซ้ำ (จริงๆ ก็แค่ส่งครั้งแรกตอน
      // เที่ยงคืนผ่านไปนิดเดียว ไม่ใช่เวลาที่เจ้าของอยากได้) — ตอนนี้ต้อง
      // ถึง "เวลา" ที่ตั้งไว้ด้วย (เทียบ HH:MM ปัดขึ้นตาม cron รัน */10 นาที
      // — แม่นยำในหลักนาที ไม่ใช่วินาที) ก่อนถึงจะเช็ค/ส่งจริง — dedup
      // ต่อวันเดิมยังทำงานเหมือนเดิม กันส่งซ้ำหลายรอบในวันเดียวกัน
      const nowTimeStr = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Bangkok', hour12: false }).slice(0, 5); // "HH:MM"
      const checkTime = settings.cutoffCheckTime || '09:00';
      const timeReached = nowTimeStr >= checkTime;
      if ((todayDom === reminderDay || todayDom === finalDay || todayDom === cancelWarningDay) && timeReached) {
        const invoices = coerceInvoices(await readTab('Invoices'));
        // "แก้บักครับ ไม่ยุ่งกับข้อมูลที่บันทึกไว้ครับ" (2026-07-30) — บั๊ก
        // จริงที่เจอ: เดิมกรองแค่ "สถานะยังไม่จ่าย" (pending/partial/overdue)
        // แล้วเทียบ "วันที่ของเดือนวันนี้" กับวันที่ตั้งไว้ (reminderDay/
        // finalDay/cancelWarningDay) เท่านั้น — ไม่เคยเช็คเลยว่าบิลใบนั้น
        // ครบกำหนดจริงหรือยัง (inv.due) ผลคือถ้าออกบิลใหม่ในเดือนที่วันที่
        // ปัจจุบันดันเลยวันที่ตั้งไว้ไปแล้ว (เช่น ตึกใหม่เพิ่งเริ่มใช้งาน
        // ออกบิลชุดแรกหลังวันที่ 20 ของเดือน) บิลที่เพิ่งออกจะโดนนับว่า
        // "ค้างชำระเกินกำหนด" ทันที ทั้งที่ผู้เช่ายังไม่ทันมีเวลาจ่ายเลย —
        // แก้โดยเพิ่มเงื่อนไข "ครบกำหนดจริงแล้ว" (i.due ผ่านมาแล้ว) ก่อน
        // ถึงจะเข้าเงื่อนไข reminder/final/cancelWarning ได้ (ไม่แตะ/แก้ไข
        // ข้อมูลบิลที่บันทึกไว้เดิมเลย แก้แค่ตรรกะตัดสินใจส่งแจ้งเตือน)
        const unpaid = invoices.filter((i) =>
          (i.status === 'pending' || i.status === 'partial' || i.status === 'overdue') &&
          i.due && i.due < todayStr);
        cutoffChecked = unpaid.length;
        // "ข้อความที่ส่งไปให้ลูกค้า เป็นแบบไหน...ครบเลย 3 รายการครับ"
        // (2026-07-26 follow-up) — เดิมแจ้งแค่เจ้าของ/ผู้ดูแล ตอนนี้ส่งหา
        // ผู้เช่าด้วยทั้ง 3 ระดับ (ถ้าห้องนั้นผูก LINE ไว้แล้ว) ใช้ toggle
        // เดียวกับ cutoffWarning (ไม่แยกสวิตช์เพิ่ม) ข้อความฝั่งผู้เช่า
        // สุภาพกว่า พูดกับผู้เช่าโดยตรง ไม่ใช้คำว่า "ห้อง X" แบบข้อความ
        // ฝั่งเจ้าของ — dedup แยก key จากฝั่งเจ้าของ (คนละ recipient กัน)
        const rooms = await readTab('Rooms');
        // "กดปุ่ม ยืนยันที่หน้าไลน์เจ้าของเพื่อให้กดยืนยันเองได้เลย"
        // (2026-07-26) — ต้องใช้ creds.line เพื่อ push ปุ่ม postback ให้
        // เจ้าของ (คนละ path จาก notifyAdmin ซึ่งส่งได้แค่ข้อความล้วน)
        const cutoffCreds = await readIntegrationCredentials();
        for (const inv of unpaid) {
          const total = inv.rent + inv.water + inv.elec + (inv.trash || 0) + (inv.internet || 0);
          const remaining = inv.remainingDue != null ? inv.remainingDue : Math.max(0, total - (inv.amountPaid || 0));
          const kind = todayDom === cancelWarningDay ? 'cancelWarning' : todayDom === finalDay ? 'final' : 'reminder';
          const key = `${sheetId}:${kind}:${inv.room}:${inv.id}`;
          const room = rooms.find((r) => r.id === inv.room);
          if (_cutoffNotifiedDates.get(key) !== todayStr) {
            const msg = kind === 'cancelWarning'
              ? `🚨 ห้อง ${inv.room} ยังไม่ชำระถึงวันที่ ${cancelWarningDay} แล้วครับ ยอดค้าง ${remaining.toLocaleString()} บาท — พิจารณายกเลิกสัญญาเช่าได้เลยครับ (ต้องไปกดยกเลิกเองที่หน้าสัญญาเช่า ระบบไม่ยกเลิกให้อัตโนมัติ)`
              : kind === 'final'
              ? `⚠️ ห้อง ${inv.room} ยังไม่ชำระถึงวันที่ ${finalDay} แล้วครับ ยอดค้าง ${remaining.toLocaleString()} บาท — พิจารณาตัดน้ำ/ไฟ ได้เลยครับ (ตัดจริงต้องทำเองที่หน้า "Set อุปกรณ์" ระบบไม่ตัดให้อัตโนมัติ)`
              : `🔔 ห้อง ${inv.room} ยังไม่ชำระค่าเช่าครับ (ยอดค้าง ${remaining.toLocaleString()} บาท)`;
            notifyAdmin('cutoffWarning', msg, cutoffCreds).catch(() => {});
            // "ให้ขึ้นปุ่ม ยืนยันที่หน้าไลน์เจ้าของเพื่อให้กดยืนยันเองได้
            // เลย" (2026-07-26) — เฉพาะ tier "final" (วันพิจารณาตัดน้ำ/ไฟ)
            // และเฉพาะห้องที่เชื่อม Tuya ไฟจริงแล้ว (ตัดได้จริงผ่าน
            // sendCommand — ไม่มีวาล์วน้ำที่ควบคุมได้ในระบบนี้ จึงมีปุ่มนี้
            // ให้แค่ไฟ) ส่งหาเจ้าของ (adminLineUserId) เท่านั้น ไม่ส่งหา
            // ผู้ดูแลทุกคน เพราะเป็นการกระทำที่กระทบผู้เช่าโดยตรง — กดปุ่ม
            // เดียวตัดทันที (ไม่ถามซ้ำ) ตามที่คุณต้นยืนยันเอง แต่ยังต้อง
            // เป็นการกดของเจ้าของเองเสมอ ไม่มีการตัดอัตโนมัติล้วนๆ
            //
            // "เปลี่ยนแปลงเงื่อนไขส่วนนี้...ทุกวันที่ 7 จะเป็นการตัดไฟ
            // วันที่ 15 ตัดทั้งไฟและน้ำ" (2026-07-26 follow-up) — ชี้แจง
            // กับคุณต้นแล้วว่าไม่มีวาล์วน้ำที่ควบคุมได้จริงในระบบนี้ (มีแค่
            // สวิตช์ไฟฟ้า Tuya) คุณต้นเลือกให้ส่งปุ่ม "ยืนยันตัดไฟ" (ไฟฟ้า
            // อย่างเดียว) ให้ทั้ง 2 ระดับ (reminder วันที่ 7 เดิมมีแค่ข้อความ
            // เตือนเฉยๆ, final วันที่ 15 มีปุ่มอยู่แล้ว) — ขยายเงื่อนไขจาก
            // "เฉพาะ final" เป็น "reminder หรือ final" ทั้งคู่
            const adminLineId = settings.propertyProfile && settings.propertyProfile.adminLineUserId;
            if ((kind === 'reminder' || kind === 'final') && room && room.tuyaElecDeviceId && adminLineId && lineConfigured(cutoffCreds.line)) {
              pushButtonMessage(
                adminLineId,
                `⚡ ห้อง ${inv.room} ค้างชำระ ${remaining.toLocaleString()} บาท (${kind === 'final' ? 'เกินกำหนดตัดไฟแล้ว' : 'ถึงกำหนดพิจารณาตัดไฟแล้ว'}) กดปุ่มด้านล่างเพื่อตัดไฟห้องนี้ทันที`,
                '🔌 ยืนยันตัดไฟ',
                `owner:cutoff_confirm_elec:${inv.room}`,
                `ยืนยันตัดไฟห้อง ${inv.room}`,
                cutoffCreds.line,
              ).catch((err) => console.error('[scheduler] cutoff confirm button push failed', err.message));
            }
            _cutoffNotifiedDates.set(key, todayStr);
            cutoffNotified++;
          }
          const tenantKey = `tenant:${key}`;
          if (_cutoffNotifiedDates.get(tenantKey) !== todayStr) {
            if (room && room.lineUserId) {
              // "ส่วนนี้เพิ่ม ข้อ 1 2 3 ให้ด้วยครับ" (2026-07-26) — ข้อความ
              // ทั้ง 3 ระดับตอนนี้แก้ไขเองได้จาก Settings แล้ว (เดิมตายตัว
              // ในโค้ด) {ยอดค้าง} เป็น placeholder แทนที่ด้วยยอดจริงตรงนี้
              const template = kind === 'cancelWarning' ? settings.cutoffCancelWarningMsg
                : kind === 'final' ? settings.cutoffFinalMsg
                : settings.cutoffReminderMsg;
              const tenantMsg = (template || '').replace(/\{ยอดค้าง\}/g, remaining.toLocaleString());
              // บั๊กจริงที่พบ (2026-07-29): pushMessage เรียกแบบไม่ส่ง creds
              // เลย ทำให้ fallback ไปใช้ credentials ของบัญชีหลักเสมอ ไม่ว่า
              // จะรันให้ตึกไหน — ตึกอื่นที่มี LINE OA แยกต่างหากจะส่งไม่ออก
              // เลย (LINE ปฏิเสธเพราะ token ผิดช่องทาง) ต้องส่ง cutoffCreds.line
              // (ดึงไว้แล้วด้านบนในสโคปนี้) เหมือนที่ pushButtonMessage ด้านบน
              // ทำถูกอยู่แล้ว
              pushMessage(room.lineUserId, tenantMsg, undefined, cutoffCreds.line).catch(() => {});
              _cutoffNotifiedDates.set(tenantKey, todayStr);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('[scheduler] cutoff warning check failed', err.message);
  }

  // "เจอ 'เตือนก่อนครบกำหนด 3 วัน' ในหน้าตั้งค่าอยู่แล้ว แต่...ไม่เคยส่ง
  // ข้อความจริงเลย...ทำให้ทำงานจริง" (2026-07-26) — daily reminders for
  // the last dueReminderDays days before EACH invoice's own due date
  // (not a shared calendar day like cutoffReminderDay — every room's due
  // date differs). Confirmed example with the owner: dueReminderDays=3,
  // due the 15th → remind on 12/13/14 (every day, NOT just once).
  // Gated behind settings.settings.dueReminder (unconditional otherwise,
  // same basic-housekeeping tier as overdue-bill detection above).
  let dueReminderChecked = 0, dueReminderNotified = 0;
  try {
    if (settings.settings && settings.settings.dueReminder) {
      const todayStr2 = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
      const reminderDays = Number(settings.dueReminderDays) || 3;
      const msg = settings.dueReminderMsg || 'แจ้งเตือน: ค่าเช่าห้องของท่านใกล้ถึงกำหนดชำระแล้ว กรุณาชำระภายในวันที่กำหนด ขอบคุณครับ';
      const invoices = coerceInvoices(await readTab('Invoices'));
      const unpaid = invoices.filter((i) => (i.status === 'pending' || i.status === 'partial') && i.due);
      dueReminderChecked = unpaid.length;
      const rooms = await readTab('Rooms');
      // บั๊กจริงที่พบ (2026-07-29) — pushMessage เดิมเรียกไม่ส่ง creds เลย
      // (ดู comment เต็มในส่วน cutoff warning ด้านบน) ตึกอื่นที่มี LINE OA
      // แยกต่างหากจะส่งไม่ออกเลย ต้องดึง credentials ของตึกนี้เองมาก่อน
      const dueReminderCreds = await readIntegrationCredentials();
      for (const inv of unpaid) {
        const daysUntilDue = Math.round((new Date(inv.due + 'T00:00:00Z') - new Date(todayStr2 + 'T00:00:00Z')) / 86400000);
        if (daysUntilDue < 1 || daysUntilDue > reminderDays) continue; // นอกช่วง N วันก่อนครบกำหนด (ไม่รวมวันครบกำหนดเอง)
        const key = `${sheetId}:dueReminder:${inv.room}:${inv.id}`;
        if (_cutoffNotifiedDates.get(key) === todayStr2) continue; // วันนี้แจ้งไปแล้ว
        const room = rooms.find((r) => r.id === inv.room);
        if (room && room.lineUserId) {
          pushMessage(room.lineUserId, msg, undefined, dueReminderCreds.line).catch((err) => console.error('[scheduler] due reminder push failed', err.message));
          dueReminderNotified++;
        }
        _cutoffNotifiedDates.set(key, todayStr2);
      }
    }
  } catch (err) {
    console.error('[scheduler] due reminder check failed', err.message);
  }

  // "จัดการเลยครับ" (2026-07-26) — สวิตช์ "สัญญาเช่า/บัตรประชาชนใกล้หมด
  // อายุ" มีอยู่แล้วแต่ไม่เคยส่งอะไรจริงเลย — เพิ่มการเช็คจริงตรงนี้ ส่ง
  // ทั้งเจ้าของและผู้เช่า (ถ้าผูก LINE ไว้) เมื่อเหลืออีกพอดี
  // leaseExpiringReminderDays วันก่อนหมดอายุ (ทั้งวันหมดอายุบัตรและวัน
  // สิ้นสุดสัญญา แยกกันคนละข้อความ) — ครั้งเดียวต่อห้องต่อประเภทต่อรอบ
  // อายุ (dedup ด้วยตัววันหมดอายุเองเป็นส่วนหนึ่งของ key กันแจ้งซ้ำถ้า
  // เปลี่ยนวันหมดอายุใหม่ในสัญญาแล้วรอบใหม่ควรแจ้งได้อีกครั้ง)
  let leaseExpiringChecked = 0, leaseExpiringNotified = 0;
  try {
    if (settings.adminNotify && settings.adminNotify.leaseExpiring) {
      const todayStr2 = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
      const daysUntil = (dateStr) => {
        if (!dateStr) return null;
        const target = new Date(dateStr + 'T00:00:00Z');
        if (Number.isNaN(target.getTime())) return null;
        const now = new Date(todayStr2 + 'T00:00:00Z');
        return Math.round((target - now) / 86400000);
      };
      const reminderDays = Number(settings.leaseExpiringReminderDays) || 7;
      const rooms = await readTab('Rooms');
      const occupied = rooms.filter((r) => r.tenant);
      leaseExpiringChecked = occupied.length;
      // บั๊กจริงที่พบ (2026-07-29) — pushMessage เดิมเรียกไม่ส่ง creds เลย
      // (ดู comment เต็มในส่วน cutoff warning ด้านบน)
      const leaseExpiringCreds = await readIntegrationCredentials();
      for (const room of occupied) {
        const checks = [
          { field: 'tenantIdExpiry', value: room.tenantIdExpiry, kind: 'idCard', label: 'บัตรประชาชนผู้เช่า', tenantLabel: 'บัตรประชาชนของคุณ' },
          { field: 'contractEnd', value: room.contractEnd, kind: 'contract', label: 'สัญญาเช่า', tenantLabel: 'สัญญาเช่าของคุณ' },
        ];
        for (const c of checks) {
          const days = daysUntil(c.value);
          if (days !== reminderDays) continue; // เตือนแค่วันที่ตรงเป๊ะเท่านั้น กันแจ้งซ้ำทุกวัน
          const key = `${sheetId}:leaseExpiring:${c.kind}:${room.id}:${c.value}`;
          if (_cutoffNotifiedDates.get(key) === todayStr2) continue;
          notifyAdmin('leaseExpiring', `📄 ${c.label}ห้อง ${room.id} (${room.tenant}) จะหมดอายุในอีก ${reminderDays} วัน (${c.value})`, leaseExpiringCreds).catch(() => {});
          if (room.lineUserId) {
            pushMessage(room.lineUserId, `📄 แจ้งเตือนครับ ${c.tenantLabel}จะหมดอายุในอีก ${reminderDays} วัน (${c.value}) รบกวนเตรียมต่ออายุ/อัปเดตให้เรียบร้อยนะครับ`, undefined, leaseExpiringCreds.line).catch(() => {});
          }
          _cutoffNotifiedDates.set(key, todayStr2);
          leaseExpiringNotified++;
        }
      }
    }
  } catch (err) {
    console.error('[scheduler] lease/ID expiring check failed', err.message);
  }

  // "เก็บข้อมูลไว้สูงสุด 5 ปีเลยครับ" (2026-07-26) — unconditional basic
  // housekeeping (same tier as overdue-bill detection above), throttled
  // to once a day PER BUILDING via _lastLogPruneDateBySheet. Prunes
  // ElectricityLog/WaterLog rows older than 5 years — both tabs use
  // `timestamp` as their date column (see server/routes/tuya.js's
  // appendRow calls).
  let logPruneResult = null;
  try {
    const todayStr3 = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
    if (_lastLogPruneDateBySheet.get(sheetId) !== todayStr3) {
      const cutoff = new Date();
      cutoff.setFullYear(cutoff.getFullYear() - LOG_RETENTION_YEARS);
      const [elecResult, waterResult] = await Promise.all([
        pruneOldRows('ElectricityLog', 'timestamp', cutoff).catch((err) => { console.error('[scheduler] prune ElectricityLog failed', err.message); return null; }),
        pruneOldRows('WaterLog', 'timestamp', cutoff).catch((err) => { console.error('[scheduler] prune WaterLog failed', err.message); return null; }),
      ]);
      logPruneResult = { elec: elecResult, water: waterResult };
      _lastLogPruneDateBySheet.set(sheetId, todayStr3);
    }
  } catch (err) {
    console.error('[scheduler] log retention prune failed', err.message);
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

  // ตั้งเวลาส่งข้อความ (ScheduledMessages) — ย้ายมาไว้ก่อนสวิตช์ "เปิดใช้
  // งานฟีเจอร์นี้" (claudeAutomationEnabled) ด้านล่าง (2026-07-29, ตามคำขอ
  // "แยกสวิทย์") เพราะเดิมสวิตช์ตัวเดียวคุมทั้ง AI อัตโนมัติ (Claude คิด/
  // ทำเอง) และ "ตั้งเวลาส่งบิล" (เจ้าของกดตั้งเองทุกครั้ง ไม่มี AI ตัดสิน
  // ใจอะไรเลย) — ปิดสวิตช์ Claude แล้วลืมว่าบิลที่ตั้งเวลาไว้จะไม่ถูกส่ง
  // ด้วยเป็นความเสี่ยงจริง (กระทบเงิน/การแจ้งหนี้ผู้เช่าโดยตรง) ตอนนี้แค่
  // ข้อความที่มาจาก source: 'invoice_receipt' (server/routes/
  // scheduledMessages.js's POST /) เท่านั้นที่ส่งได้เสมอไม่ว่าสวิตช์จะเปิด
  // หรือปิด — ข้อความจาก Claude tool/ปฏิทิน (source: 'manual'/'calendar')
  // ยังคงต้องเปิดสวิตช์ไว้เหมือนเดิม (ยังถือเป็น AI-related automation จริง)
  let sentCount = 0, scheduledChecked = 0, scheduledDue = 0;
  // เก็บ error message ล่าสุด (สูงสุด 3 อัน, ไม่มีข้อความ/ข้อมูลอ่อนไหวหลุด
  // ออกมา) ไว้ถาวร — เกิดจากการไล่บั๊ก "ตั้งเวลาส่งบิลแล้วไม่ยอมส่ง"
  // (2026-07-29, root cause ที่พบจริง: LINE API ปฏิเสธการ push เพราะห้อง
  // ทดสอบผูก LINE ปลอมไว้ ไม่ใช่บั๊กโค้ด) — เก็บไว้ต่อเพราะมีประโยชน์เวลา
  // เจอเคสแบบนี้อีกในอนาคต ไม่ต้องเพิ่ม log ใหม่ทุกครั้ง
  let scheduledMessagesErrors = [];
  // บั๊กจริงที่พบ (2026-07-29) — lineConfigured() เรียกแบบไม่ส่ง creds เลย
  // เช็คแค่ credentials ของบัญชีหลัก (process.env) ไม่ใช่ของตึกนี้เอง —
  // ตึกที่มี LINE OA แยกต่างหาก (บันทึกไว้ผ่านหน้าตั้งค่าของตัวเอง ไม่ใช่
  // .env) จะโดนข้ามทั้ง block นี้ไปเฉยๆ ทั้งที่จริงมี credentials ของตัวเอง
  // อยู่แล้ว — ต้องดึง credentials ของตึกนี้มาเช็ค/ใช้จริง
  const scheduledMsgCreds = await readIntegrationCredentials();
  if (lineConfigured(scheduledMsgCreds.line)) {
    const nowStr = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).slice(0, 16).replace(' ', 'T');
    const [rows, rooms] = await Promise.all([readTab('ScheduledMessages'), readTab('Rooms')]);
    const due = rows.filter((r) => r.sent !== 'TRUE' && r.sendAt && r.sendAt <= nowStr);
    scheduledChecked = rows.length;
    scheduledDue = due.length;

    // "ถ้าอนาคตส่งทีเดียวเป็น 10 ห้องจะเจอปัญหาโควตาไหม" (2026-07-29) —
    // เจอจริง: เดิมโค้ดด้านล่าง (ตอนมาร์ค receiptSent) อ่านทั้งแท็บ
    // Invoices ใหม่ "ในลูป" ทุกครั้งที่ส่งสำเร็จ 1 ห้อง — 10 ห้องพร้อมกัน =
    // อ่านซ้ำ 10 รอบ ทั้งที่จริงอ่านครั้งเดียวพอ (ห้องอื่นไม่ได้แก้ระหว่างนี้)
    // ย้ายมาอ่านครั้งเดียวก่อนเข้าลูป แทน — ลดจำนวนการอ่าน Sheets ลงตาม
    // จำนวนห้องที่ส่งพร้อมกันในรอบเดียวกัน (เหลือแค่ 1 ครั้งเสมอ ไม่ว่าจะมี
    // กี่ห้องก็ตาม)
    let invoicesForReceiptSent = null;
    const sendErrors = [];
    for (const row of due) {
      if (row.source !== 'invoice_receipt' && !settings.claudeAutomationEnabled) continue; // ยังปิดสวิตช์อยู่ — ข้ามไปก่อน รอบหน้าค่อยเช็คใหม่
      try {
        if (row.room === 'all') {
          const targets = rooms.filter((r) => r.lineUserId);
          for (const r of targets) await pushMessage(r.lineUserId, row.message, undefined, scheduledMsgCreds.line);
        } else {
          const room = rooms.find((r) => r.id === row.room);
          if (room && room.lineUserId) await pushMessage(room.lineUserId, row.message, undefined, scheduledMsgCreds.line);
        }
        await updateRow('ScheduledMessages', row.id, { sent: 'TRUE' });
        sentCount++;
        // "ถ้าส่งแล้วให้ขึ้นสถานะส่งสำเร็จ" (2026-07-29) — เดิม PATCH
        // receiptSent:true เกิดแค่ตอนกดส่งเองผ่านปุ่ม (sendReceiptLine,
        // ฝั่ง frontend) ไม่เคยเกิดเมื่อส่งผ่านคิวตั้งเวลานี้เลย ทำให้ปุ่ม
        // "ส่งข้อมูล (LINE)" บนตารางบิลยังโชว์ค้างเหมือนไม่เคยส่ง แม้จริงๆ
        // ส่งไปแล้ว — เติมให้ที่นี่ด้วย เฉพาะ invoice_receipt (มีบิลจริง
        // ผูกอยู่) หาบิลที่ยังไม่จ่ายของห้องนี้ (มีได้สูงสุด 1 ใบเสมอ —
        // ระบบกันไม่ให้ออกบิลซ้อนอยู่แล้ว, orders.js/invoices.js's guard)
        if (row.source === 'invoice_receipt' && row.room !== 'all') {
          try {
            if (!invoicesForReceiptSent) invoicesForReceiptSent = coerceInvoices(await readTab('Invoices'));
            const inv = invoicesForReceiptSent.find((i) => i.room === row.room && i.status !== 'paid');
            if (inv) await updateRow('Invoices', inv.id, { receiptSent: true });
          } catch (err2) {
            console.error('[scheduler] failed to mark invoice receiptSent after scheduled send', row.id, err2.message);
          }
        }
      } catch (err) {
        console.error('[scheduler] failed to send', row.id, err.message, err.stack);
        if (sendErrors.length < 3) sendErrors.push(String(err.message || err));
      }
    }
    scheduledMessagesErrors = sendErrors;
  }

  if (!settings.claudeAutomationEnabled) {
    return {
      ran: false, reason: 'ปิดใช้งานอยู่ (เปิดสวิตช์ "เปิดใช้งานฟีเจอร์นี้" ในหน้าตั้งค่าก่อน — ยกเว้นบิลที่ตั้งเวลาส่งไว้ ซึ่งยังส่งได้ปกติ)',
      overdueBills: { checked: overdueChecked, newlyOverdue: overdueNew },
      receiptConfirmation: { retried: receiptRetried, escalatedToOwner: receiptEscalated },
      cutoffWarnings: { checked: cutoffChecked, notified: cutoffNotified },
      dueReminder: { checked: dueReminderChecked, notified: dueReminderNotified },
      leaseExpiring: { checked: leaseExpiringChecked, notified: leaseExpiringNotified },
      logPrune: logPruneResult, ownerRichMenu: ownerRichMenuResult,
      scheduledMessages: { checked: scheduledChecked, due: scheduledDue, sent: sentCount, errors: scheduledMessagesErrors },
    };
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

  return {
    ran: true,
    overdueBills: { checked: overdueChecked, newlyOverdue: overdueNew },
    receiptConfirmation: { retried: receiptRetried, escalatedToOwner: receiptEscalated },
    cutoffWarnings: { checked: cutoffChecked, notified: cutoffNotified },
    dueReminder: { checked: dueReminderChecked, notified: dueReminderNotified },
    leaseExpiring: { checked: leaseExpiringChecked, notified: leaseExpiringNotified },
    logPrune: logPruneResult,
    scheduledMessages: { checked: scheduledChecked, due: scheduledDue, sent: sentCount, errors: scheduledMessagesErrors },
    recurringTasks: { checked: recurringChecked, ran: recurringRan },
    ownerRichMenu: ownerRichMenuResult,
  };
}

// Called periodically by an external trigger (GitHub Actions cron — see
// .github/workflows/scheduler.yml) rather than an in-process setInterval,
// because Render's free tier sleeps the app when idle; an external ping both
// wakes the instance and drives this check, the same fix already used for
// unreliable auto-deploy. Safe to call as often as needed — every call is a
// no-op unless a message's time has actually arrived.
//
// 2026-07-29 — now loops over EVERY building in the Directory (Users tab,
// unique customerSheetId values), not just the main account. Real bug this
// fixes: a customer's own building never got ANY of this file's automation
// (overdue detection, cutoff warnings, due reminders, lease-expiring
// notices, scheduled bill sends, log pruning, rich menu badge sync) because
// this endpoint is hit by an external cron ping with no session — it
// always fell back to process.env.GOOGLE_SHEET_ID (the main account) only.
// One building's failure is caught and logged, not allowed to abort the
// rest — same reasoning as every other try/catch in this file.
router.get('/run', async (req, res, next) => {
  try {
    // ตึกหลัก (main account) รันเสมอ ไม่ต้องเช็ค platformVersion — โค้ดชุด
    // นี้ทำงานให้บัญชีหลักอยู่แล้วตั้งแต่ก่อนแก้บั๊กวันนี้ ไม่ใช่พฤติกรรม
    // ใหม่สำหรับบัญชีนี้ (ดู CLAUDE.md's staged-rollout rule — gate ป้องกัน
    // "ของใหม่โผล่แบบไม่ทันตั้งตัว" ไม่ใช่ป้องกันของที่ทำงานอยู่แล้ว)
    const sheetIds = new Set();
    // "ให้เจ้าของยืนยันได้เลย...ระบบส่งข้อความไปใหม่...แจ้งเจ้าของ"
    // (2026-08-02, ดู platformVersion.js's v6 note) — runSchedulerOnce
    // ต้องรู้ platformVersion ของแต่ละตึกเอง เพื่อเปิด/ปิดเฉพาะ block
    // ยืนยันใบเสร็จ (ต่างจาก SCHEDULER_MULTI_BUILDING_VERSION ที่คุมว่า
    // ตึกนั้นเข้าลูปทั้งฟังก์ชันหรือเปล่า) — เก็บเป็น map แยกต่างหาก
    const platformVersions = new Map(); // sheetId -> platformVersion
    if (process.env.GOOGLE_SHEET_ID) sheetIds.add(process.env.GOOGLE_SHEET_ID);

    // ตึกอื่นๆ ในทำเนียบ — ต้อง platformVersion >= 4 (ดู server/
    // platformVersion.js's v4 note) ก่อนถึงจะรวมเข้ามาในลูปนี้ — ป้องกันไม่
    // ให้ตึกที่เจ้าของเคยเปิดสวิตช์แจ้งเตือน (เช่น cutoffWarning) ไว้นานแล้ว
    // จู่ๆ เริ่มส่งข้อความจริงหาผู้เช่าจริงแบบไม่มีการแจ้งเตือนล่วงหน้าเลย —
    // ต้องรอคุณต้นกดปุ่ม "🆕 อัปเดต" ให้ตึกนั้นก่อน ตามกฎ staged-rollout
    // เดิม (แม้ครั้งนี้จะเป็นการแก้บั๊ก ไม่ใช่ฟีเจอร์ใหม่ก็ตาม เพราะผลที่
    // เกิดขึ้นจริงกับผู้เช่าเหมือนกันทุกประการ) — อ่าน platformVersion ของ
    // ทุกแถวรวมถึงบัญชีหลักเองด้วย (v6's receipt-confirm gate ไม่ได้ยกเว้น
    // บัญชีหลัก ต่างจาก v4 ข้างบน — ดู platformVersion.js's v6 note)
    if (DIRECTORY_SHEET_ID) {
      try {
        const directoryRows = await runWithSheetId(DIRECTORY_SHEET_ID, () => readTab('Users'));
        for (const row of directoryRows) {
          if (!row.customerSheetId || row.status === 'suspended') continue;
          const pv = Number(row.platformVersion) || 0;
          if (row.customerSheetId === process.env.GOOGLE_SHEET_ID) { platformVersions.set(row.customerSheetId, pv); continue; } // นับใน sheetIds ไปแล้วด้านบน
          if (pv >= SCHEDULER_MULTI_BUILDING_VERSION) { sheetIds.add(row.customerSheetId); platformVersions.set(row.customerSheetId, pv); }
        }
      } catch (err) {
        console.error('[scheduler] failed to read Directory — falling back to main account only', err.message);
      }
    }

    const buildings = {};
    for (const sheetId of sheetIds) {
      try {
        buildings[sheetId] = await runWithSheetId(sheetId, () => runSchedulerOnce(platformVersions.get(sheetId) || 0));
      } catch (err) {
        console.error('[scheduler] run failed for building', sheetId, err.message);
        buildings[sheetId] = { ran: false, error: err.message };
      }
    }

    res.json({ buildingsChecked: sheetIds.size, buildings });
  } catch (err) { next(err); }
});

module.exports = router;
