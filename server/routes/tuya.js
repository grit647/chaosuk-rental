const express = require('express');
const router = express.Router();
const { readTab, appendRow, updateRow } = require('../sheets');
const { isConfigured, listDevices, getElecReading, getWaterReading, getWaterUsageDeltaLiters, sendCommand } = require('../tuya');
const { readIntegrationCredentials } = require('../coerce');
const { isMainAccountSheetId, getCurrentSheetId } = require('../requestContext');

// Shared chart-aggregation helpers (originally written inline inside
// /elec-history, hoisted to module scope so /water-history — "ส่วนน้ำ
// จัดการให้ด้วยครับ" (2026-07-26) — can reuse them instead of duplicating).
// Bangkok-local date/month key — a UTC-based day boundary is 7 hours off
// from the Thailand calendar day the owner actually cares about (same bug
// class fixed for the hourly chart below).
const bangkokDateStr = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' }); // "YYYY-MM-DD"
const dayKey = (d) => bangkokDateStr(d);
const monthKey = (d) => bangkokDateStr(d).slice(0, 7); // YYYY-MM
const monthNames = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const monthLabel = (key) => {
  const [y, m] = key.split('-');
  return monthNames[Number(m) - 1];
};
const toBE = (yyyy) => Number(yyyy) + 543;
// groups raw log rows (any tab — ElectricityLog or WaterLog) by room,
// skipping rows with no room/timestamp or an unparseable timestamp (real
// bug hit in production: a malformed timestamp made new Date(...).getTime()
// throw further down, surfacing as a 500 on every single /status poll for
// that whole building).
function groupByRoom(rows) {
  const byRoom = {};
  rows.forEach((r) => {
    if (!r.room || !r.timestamp) return;
    if (Number.isNaN(new Date(r.timestamp).getTime())) return;
    if (!byRoom[r.room]) byRoom[r.room] = [];
    byRoom[r.room].push(r);
  });
  return byRoom;
}
// "มาดูการแสดงข้อมูล ส่วนรายวัน แสดงย้อนหลัง 7 วัน รายเดือนให้แสดงย้อนหลัง
// 6 เดือน" (2026-07-26) — zero-fills every key in fixedKeys (a trailing
// window ending "now"), not just whatever buckets happen to have real data
// — a room linked only a few days ago used to show just 2-3 bars instead
// of a full week. valueField is the running-cumulative-total column name
// on each log row (ElectricityLog: 'energy', WaterLog: 'cumulativeLiters')
// — usage per bucket = last reading in that bucket minus last reading in
// the previous bucket (both logs store a cumulative total per tick, not a
// per-tick delta), summed across every room in byRoom.
function aggregate(byRoom, bucketFn, labelFn, fixedKeys, valueField) {
  const bucketTotals = new Map();
  Object.values(byRoom).forEach((roomRows) => {
    roomRows.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const perBucketLast = new Map();
    roomRows.forEach((r) => {
      const key = bucketFn(new Date(r.timestamp));
      perBucketLast.set(key, Number(r[valueField]) || 0);
    });
    let prevVal = null;
    for (const [key, val] of perBucketLast) {
      if (prevVal != null) {
        const usage = Math.max(0, val - prevVal);
        bucketTotals.set(key, (bucketTotals.get(key) || 0) + usage);
      }
      prevVal = val;
    }
  });
  return fixedKeys.map((key) => ({ label: labelFn(key), value: Math.round((bucketTotals.get(key) || 0) * 100) / 100 }));
}

// "แสดงข้อมูลในกราฟใหม่ครับ รายวันจะมีทั้งหมด 24 กราฟ รายชั่วโมง...
// รายเดือน จะมีทั้งหมด 30-31 กราฟ ตามวันของแต่ละเดือน...รายปีก็หลักการ
// เดียวกันครับ" (2026-08-10) — เปลี่ยนจากกราฟ "แนวโน้มย้อนหลังแบบเลื่อน"
// (trailing window เช่น "7 วันล่าสุด") มาเป็นกราฟ "เจาะจงลงไปในช่วงเวลา
// เดียว" แทน: mode=day → 24 แท่งชั่วโมงของวันที่เลือก, mode=month → 28-31
// แท่งวันของเดือนที่เลือก, mode=year → 12 แท่งเดือนของปีที่เลือก — พร้อม
// ปุ่ม ‹ › เลื่อนดูช่วงเวลาก่อนหน้า/ถัดไป (ย้อนหลังได้ไม่จำกัด, ไปข้างหน้า
// ได้ไม่เกิน "วันนี้/เดือนนี้/ปีนี้") ใช้ aggregate() ตัวเดิมทุกโหมด — ตัว
// aggregate() เองคำนวณผลต่างจากค่าที่อ่านได้ "ก่อนหน้า" เสมอ (แม้จะอยู่
// นอกช่วง fixedKeys ที่ขอ) จึงได้ยอดใช้งานที่ถูกต้องตั้งแต่แท่งแรกของ
// ช่วงนั้นๆ โดยไม่ต้องเขียนตรรกะ baseline แยกต่างหาก
function hourOfDayKey(d) {
  // en-CA locale ให้ "YYYY-MM-DD, HH:MM:SS" ตาม timeZone ที่ระบุ — วิธี
  // เดียวกับ bangkokDateStr ด้านบน แค่ต้องการชั่วโมงด้วย
  const s = d.toLocaleString('en-CA', { timeZone: 'Asia/Bangkok', hour12: false });
  const [datePart, timePart] = s.split(', ');
  return datePart + 'T' + timePart.slice(0, 2);
}
const hourOfDayLabel = (key) => key.split('T')[1] + ':00';
function dayHourKeys(dateStr) {
  return Array.from({ length: 24 }, (_, h) => dateStr + 'T' + String(h).padStart(2, '0'));
}
const dayOfMonthLabel = (key) => String(Number(key.split('-')[2]));
function monthDayKeys(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const keys = [];
  for (let d = 1; d <= daysInMonth; d++) keys.push(monthStr + '-' + String(d).padStart(2, '0'));
  return keys;
}
function yearMonthKeys(yearStr) {
  return Array.from({ length: 12 }, (_, i) => yearStr + '-' + String(i + 1).padStart(2, '0'));
}
function dayPeriodLabel(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return Number(d) + ' ' + monthNames[Number(m) - 1] + ' ' + toBE(y);
}
const monthPeriodLabel = (monthStr) => monthLabel(monthStr) + ' ' + toBE(monthStr.slice(0, 4));
const yearPeriodLabel = (yearStr) => String(toBE(yearStr));
// "หนึ่งดึงข้อมูลมาแสดงให้ด้วยครับ" (2026-08-10 follow-up) — real bug:
// defaulting period to literally "today/this month/this year" meant a
// building whose LAST log entry (ElectricityLog/WaterLog rows only get
// appended when /status is polled, throttled to once/hour/room — see
// LOG_INTERVAL_MS below) happened to fall on an earlier day showed a
// totally empty chart the moment someone opened the page, even though
// real historical data existed just one ‹ click away. The OLD hourly-only
// chart (removed earlier today, see git history) had already solved this
// exact problem by defaulting to "the most recent day that actually has
// log data" instead of blindly "today" — this restores that same
// principle for all 3 modes now, not just hourly. Only affects the
// DEFAULT (period not explicitly passed by the ‹ › buttons) — once a
// user has navigated anywhere, that explicit choice is always honored.
function latestBangkokDate(byRoom) {
  let latest = null;
  Object.values(byRoom).forEach((rows) => rows.forEach((r) => {
    const d = bangkokDateStr(new Date(r.timestamp));
    if (!latest || d > latest) latest = d;
  }));
  return latest; // "YYYY-MM-DD" ของแถวล่าสุดที่มีจริง, หรือ null ถ้าไม่มีข้อมูลเลย
}
function buildDrillDownChart(byRoom, mode, period, valueField) {
  const now = bangkokDateStr(new Date());
  // เฉพาะตอนไม่ได้ระบุ period มาเอง (ผู้ใช้ยังไม่เคยกด ‹ ›) ถึงจะ fallback
  // ไปหาวันที่ล่าสุดที่มีข้อมูลจริงแทน "วันนี้" ตรงๆ — ถ้าไม่มีข้อมูลเลย
  // (ตึกใหม่ยังไม่เคยเชื่อมอุปกรณ์) ก็กลับไปใช้ "วันนี้" เหมือนเดิม (ว่าง
  // เท่ากันไม่ว่าจะเลือกวันไหน ไม่มีผลต่างอะไร)
  const defaultDate = period ? null : (latestBangkokDate(byRoom) || now);
  if (mode === 'day') {
    const dateStr = period || defaultDate;
    return {
      period: dateStr,
      periodLabel: dayPeriodLabel(dateStr),
      bars: aggregate(byRoom, hourOfDayKey, hourOfDayLabel, dayHourKeys(dateStr), valueField),
      canGoNext: dateStr < now,
    };
  }
  if (mode === 'year') {
    const yearStr = period || defaultDate.slice(0, 4);
    return {
      period: yearStr,
      periodLabel: yearPeriodLabel(yearStr),
      bars: aggregate(byRoom, monthKey, monthLabel, yearMonthKeys(yearStr), valueField),
      canGoNext: yearStr < now.slice(0, 4),
    };
  }
  // month (default)
  const monthStr = period || defaultDate.slice(0, 7);
  return {
    period: monthStr,
    periodLabel: monthPeriodLabel(monthStr),
    bars: aggregate(byRoom, dayKey, dayOfMonthLabel, monthDayKeys(monthStr), valueField),
    canGoNext: monthStr < now.slice(0, 7),
  };
}

// ElectricityLog was writing a row on EVERY /status call — every 5-minute
// auto-refresh tick from the frontend, plus every manual "รีเฟรช" click,
// plus once per open browser tab if more than one — which piled up far more
// often than once an hour (a real user report after seeing near-duplicate
// rows minutes apart in the Sheet). Per explicit request, throttle logging
// to at most once per hour per room. Kept in-memory (not persisted) since
// this only needs to survive within a single server process; a restart
// just means the next status poll logs immediately, which is harmless.
const lastLoggedAt = new Map();
const LOG_INTERVAL_MS = 60 * 60 * 1000;

// Real bug a customer hit: a brand-new multi-tenant customer with no Tuya
// credentials of their own was shown "เชื่อมต่อแล้ว" and could have pulled
// live device data — because tuya.js's resolveCreds() falls back to the
// SHARED server/.env values (คุณต้น's own Tuya Cloud project) whenever no
// override is given, which is correct for คุณต้น's own no-login usage but
// wrong once someone is logged in via the multi-tenant system: it would
// silently show/act on someone ELSE's real devices under this customer's
// login. Once a session has its own customerSheetId, only THIS customer's
// own saved credentials count — no falling back to the shared server ones.
// EXCEPT the main account's own session (see the matching fix + comment
// in server/routes/line.js for the identical bug hit there first) —
// คุณต้น's own account always carries a session too now that login is
// required, and server/.env genuinely ARE his own credentials.
function isConfiguredForRequest(req, tuyaCreds) {
  const sessionScoped = !!(req.session && req.session.customerSheetId) && !isMainAccountSheetId(req.session.customerSheetId);
  if (sessionScoped) return !!tuyaCreds && isConfigured(tuyaCreds);
  return isConfigured(tuyaCreds);
}

router.get('/health', async (req, res) => {
  const creds = await readIntegrationCredentials();
  if (!isConfiguredForRequest(req, creds.tuya)) return res.json({ connected: false });
  try {
    await listDevices(creds.tuya); // exercises the full auth + signing flow
    res.json({ connected: true });
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

router.get('/devices', async (req, res, next) => {
  try {
    const creds = await readIntegrationCredentials();
    if (!isConfiguredForRequest(req, creds.tuya)) return res.status(400).json({ error: 'ยังไม่ได้ตั้งค่า Tuya (ใส่ Access ID/Secret ที่หน้าตั้งค่า หรือฝั่งเซิร์ฟเวอร์)' });
    res.json(await listDevices(creds.tuya));
  } catch (err) { next(err); }
});

router.get('/status', async (req, res, next) => {
  try {
    const creds = await readIntegrationCredentials();
    if (!isConfiguredForRequest(req, creds.tuya)) return res.status(400).json({ error: 'ยังไม่ได้ตั้งค่า Tuya (ใส่ Access ID/Secret ที่หน้าตั้งค่า หรือฝั่งเซิร์ฟเวอร์)' });
    const rooms = await readTab('Rooms');
    const linked = rooms.filter((r) => r.tuyaElecDeviceId);
    const entries = await Promise.all(linked.map(async (r) => {
      try {
        const reading = await getElecReading(r.tuyaElecDeviceId, creds.tuya);
        return [r.id, { ...reading, online: true }];
      } catch (err) {
        return [r.id, { voltage: null, current: null, power: null, online: false, error: err.message }];
      }
    }));
    const resultMap = Object.fromEntries(entries);

    // Per explicit user request: same live-reading treatment for water
    // flowmeters (battery-powered, BLE-gateway devices) — cumulative
    // usage + flow rate + battery %. Merged into the SAME per-room
    // object as the electricity reading above (a room can have either,
    // both, or neither device linked) rather than a separate response
    // shape, so the frontend only has to read one place per room.
    const waterLinked = rooms.filter((r) => r.tuyaWaterDeviceId);
    await Promise.all(waterLinked.map(async (r) => {
      try {
        const waterReading = await getWaterReading(r.tuyaWaterDeviceId, creds.tuya);
        resultMap[r.id] = { ...(resultMap[r.id] || {}), ...waterReading, waterOnline: true };
      } catch (err) {
        resultMap[r.id] = { ...(resultMap[r.id] || {}), waterOnline: false, waterError: err.message };
      }
    }));

    // "เชื่อมยอดสะสมจริงเข้าหน้าจอ" (2026-07-23 ตามคำขอคุณต้น "ค่าตรงนี้
    // พร้อมอัปเดทยังครับ") — `usage` จาก getWaterReading() (ด้านบน) ค้าง
    // ที่ 0 ถาวรเสมอ (ดู server/tuya.js's getWaterReading comment เต็ม —
    // DP ของอุปกรณ์ไม่เคยอัปเดตจริง) เลยเอายอดสะสมที่คำนวณเองจาก WaterLog
    // (ดู getWaterUsageDeltaLiters ด้านล่าง) มาทับ `usage` ก่อนส่งกลับ
    // แทน — ไม่กระทบ error handling เดิม เพราะยังอ่านแค่แถวล่าสุดที่มีอยู่
    // แล้ว ไม่เรียก Tuya API เพิ่ม
    if (waterLinked.length) {
      try {
        const waterLog = await readTab('WaterLog');
        waterLinked.forEach((r) => {
          const roomRows = waterLog.filter((row) => row.room === r.id.toString());
          const latest = roomRows.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
          if (latest && resultMap[r.id]) {
            resultMap[r.id].usage = Number(latest.cumulativeLiters) || 0;
          }
        });
      } catch (err) {
        console.error('[tuya] WaterLog cumulative merge failed:', err.message);
      }
    }

    res.json(resultMap);

    // Fire-and-forget historical log for future usage analysis — never let a
    // logging hiccup affect the response above, which has already been sent.
    // Throttled to once per hour per room (see LOG_INTERVAL_MS above).
    //
    // Throttle keys prefixed with the current building's sheetId (2026-08-10
    // — found while wiring pollAndLogUsageForScheduler below, same bug class
    // as scheduler.js's _cutoffNotifiedDates fix documented in CLAUDE.md):
    // lastLoggedAt is ONE process-wide Map shared by every building, but
    // room IDs like "1"/"101" are only unique WITHIN a building's own
    // separate spreadsheet — two different buildings' room "1" would
    // collide and wrongly suppress a real log write in one just because the
    // other building already logged "the same" key recently.
    const now = Date.now();
    const _sheetIdForLog = getCurrentSheetId() || 'main';
    entries.forEach(([roomId, reading]) => {
      if (reading.voltage == null) return; // device was offline/errored — nothing useful to log
      const throttleKey = _sheetIdForLog + ':elec-' + roomId;
      const last = lastLoggedAt.get(throttleKey) || 0;
      if (now - last < LOG_INTERVAL_MS) return;
      lastLoggedAt.set(throttleKey, now);
      appendRow('ElectricityLog', {
        id: Date.now() + '-' + roomId,
        timestamp: new Date().toISOString(),
        room: roomId,
        voltage: reading.voltage,
        current: reading.current,
        power: reading.power,
        energy: reading.energy,
      }).catch((err) => console.error('[tuya] ElectricityLog append failed:', err.message));
    });

    // "ปริมาณน้ำสะสมจริง" (2026-07-23) — see the big comment on
    // getWaterUsageDeltaLiters (server/tuya.js): the device's own
    // cumulative-total DP (water_use_data) never updates on this device
    // family, so we build our own running total by replaying the
    // water_once event history via the Report Logs API and adding only
    // CONFIRMED-complete sessions since the last poll. Throttled hourly
    // per room like ElectricityLog (separate map key prefix so the two
    // don't collide for a room that has both device types linked).
    waterLinked.forEach((r) => {
      const throttleKey = _sheetIdForLog + ':water-' + r.id;
      const last = lastLoggedAt.get(throttleKey) || 0;
      if (now - last < LOG_INTERVAL_MS) return;
      lastLoggedAt.set(throttleKey, now);
      (async () => {
        try {
          const waterLog = await readTab('WaterLog');
          const roomRows = waterLog.filter((row) => row.room === r.id.toString());
          const latest = roomRows.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
          const prevCumulative = latest ? Number(latest.cumulativeLiters) || 0 : 0;
          const sinceEventTimeMs = latest ? Number(latest.lastProcessedEventTimeMs) || 0 : 0;
          const { deltaLiters, lastProcessedEventTimeMs } = await getWaterUsageDeltaLiters(r.tuyaWaterDeviceId, sinceEventTimeMs, creds.tuya);
          // No new confirmed-complete sessions since last poll — nothing
          // worth writing a row for (avoids a Sheet full of identical
          // zero-delta rows every hour when the room is simply unoccupied).
          if (deltaLiters <= 0 && lastProcessedEventTimeMs === sinceEventTimeMs) return;
          const currentReading = resultMap[r.id] || {};
          await appendRow('WaterLog', {
            id: Date.now() + '-' + r.id,
            timestamp: new Date().toISOString(),
            room: r.id,
            cumulativeLiters: prevCumulative + deltaLiters,
            lastProcessedEventTimeMs,
            flowRate: currentReading.flowRate,
            batteryPercent: currentReading.batteryPercent,
          });
        } catch (err) {
          console.error('[tuya] WaterLog append failed for room', r.id, ':', err.message);
        }
      })();
    });
  } catch (err) { next(err); }
});

// "ตอนนี้เรายิงกันแอปหลับอยู่แล้ว เพิ่มให้มีการบันทึกร่วมด้วยเลยได้ไหมครับ"
// (2026-08-10) — เดิม ElectricityLog/WaterLog จะถูกบันทึกก็ต่อเมื่อมีคนเปิด
// แอปนี้ค้างไว้จริง (GET /status ถูกเรียกตอน mount + ทุก 5 นาทีที่แท็บยัง
// เปิดอยู่ — ดู Rental Management.dc.html's refreshTuyaLive) ถ้าไม่มีใครเปิด
// แอปเลยช่วงไหน ช่วงนั้นไม่มีข้อมูลบันทึกเลย เจ้าของสังเกตว่า UptimeRobot
// ping GET /api/scheduler/run ทุก 20 นาทีอยู่แล้ว (กันเซิร์ฟเวอร์หลับ) เลย
// ขอให้ผูกการบันทึกข้อมูลเข้ากับรอบนั้นไปด้วยเลย — ฟังก์ชันนี้ทำหน้าที่
// เดียวกับ logging ส่วนท้ายของ /status ด้านบนทุกประการ (ใช้ lastLoggedAt/
// LOG_INTERVAL_MS Map ตัวเดียวกัน คีย์รูปแบบเดียวกัน กันเขียนซ้ำไม่ว่าจะถูก
// เรียกจากทางไหนก่อน) แค่ต้องดึงค่าอ่านสดเองแยกต่างหาก (ไม่ได้มี resultMap
// จาก /status ให้ใช้ร่วม เพราะถูกเรียกจาก scheduler.js ไม่ใช่จาก request
// ของ /status) — เรียกจาก server/routes/scheduler.js's runSchedulerOnce()
// ต่อตึก (อยู่ใน runWithSheetId context อยู่แล้ว จึง readTab/appendRow เข้า
// ชีตของตึกนั้นถูกต้องอัตโนมัติเหมือนทุกจุดอื่นในไฟล์นี้)
// "การยืนยันสถานะขอใช้ไฟชั่วคราวต้องถามเจ้าของว่า...คุณจัดการใช่ไหม...ถ้า
// ระบบไฟระบบแจ้งเป็น off จากแพลตฟอร์ม แล้วคุณไม่ยืนยัน สถานะก็ยังต้องขึ้น
// ตัดไฟไปแล้ว เพราะไม่อย่างนั้นระบบเราตรวจสอบความถูกต้องไม่ได้" (2026-08-10)
// — เจ้าของปฏิเสธแนวทาง auto-reconcile ล้วนๆ (เชื่อ reading.switchOn จาก
// อุปกรณ์ตรงๆ แล้วอัปเดตสถานะเองทันที) โดยให้เหตุผลว่า "ขอใช้ไฟชั่วคราว"
// เป็นสถานะที่สื่อถึง "การตัดสินใจของเจ้าของ" ไม่ใช่แค่สภาพอุปกรณ์เฉยๆ —
// อุปกรณ์อาจโชว์ "on" ได้จากหลายสาเหตุที่ไม่ใช่เจ้าของตั้งใจอนุญาต (ไฟกระตุก,
// ข้อมูล cache ของ Tuya ผิดพลาด ฯลฯ) เลยต้องให้เจ้าของ "ยืนยัน" ก่อนเปลี่ยน
// สถานะจริงเสมอ ไม่เปลี่ยนอัตโนมัติแม้จะตรวจพบไม่ตรงกันก็ตาม — ถ้าเจ้าของ
// ไม่ตอบ/ปฏิเสธ สถานะยังคงเป็น "ตัดไฟแล้ว" เหมือนเดิม (ค่า default ที่
// ปลอดภัยกว่า)
async function pollAndLogUsageForScheduler(sheetId, tuyaCreds, preloadedRooms, notifyOpts) {
  if (!tuyaCreds || !isConfigured(tuyaCreds)) return;
  // preloadedRooms (optional) — scheduler.js's runSchedulerOnce() already
  // reads Rooms once via its own batched readTabs() call; passing it in
  // avoids one extra Sheets API read per building per scheduler run (same
  // quota-conservation reasoning as everything else that function batches —
  // see its own big comment block).
  const rooms = preloadedRooms || await readTab('Rooms');
  const now = Date.now();

  const elecLinked = rooms.filter((r) => r.tuyaElecDeviceId);
  await Promise.all(elecLinked.map(async (r) => {
    const throttleKey = sheetId + ':elec-' + r.id;
    if (now - (lastLoggedAt.get(throttleKey) || 0) < LOG_INTERVAL_MS) return;
    try {
      const reading = await getElecReading(r.tuyaElecDeviceId, tuyaCreds);
      if (reading.voltage == null) return;
      lastLoggedAt.set(throttleKey, now);
      await appendRow('ElectricityLog', {
        id: Date.now() + '-' + r.id, timestamp: new Date().toISOString(), room: r.id,
        voltage: reading.voltage, current: reading.current, power: reading.power, energy: reading.energy,
      });
      // Reconciliation check — ระบบเราเชื่อว่าห้องนี้ "ตัดไฟอยู่" (elecCutoffAt
      // เป็นค่าล่าสุด ยังไม่มี elecRestoredAt ใหม่กว่ามาหักล้าง) แต่อุปกรณ์
      // จริงรายงานว่า "เปิดอยู่" — ไม่ตัดสินใจเปลี่ยนเอง แค่ถามเจ้าของ
      if (notifyOpts && reading.switchOn === true && r.elecCutoffAt) {
        const currentlyBelievedOff = !r.elecRestoredAt || r.elecRestoredAt < r.elecCutoffAt;
        if (currentlyBelievedOff) await notifyOpts.onElecMismatch(r.id).catch(() => {});
      }
    } catch (err) {
      console.error('[tuya] scheduled elec poll failed for room', r.id, ':', err.message);
    }
  }));

  const waterLinked = rooms.filter((r) => r.tuyaWaterDeviceId);
  // อ่าน WaterLog ครั้งเดียวก่อนเข้า Promise.all (ไม่ใช่แยกอ่านทีละห้องข้าง
  // ใน loop) — บั๊กเดียวกับที่เคยแก้ใน scheduler.js's receipt-sent-marking
  // step มาแล้ว (อ่านทั้ง tab ซ้ำต่อห้องแทนที่จะอ่านครั้งเดียวแล้วกรองเอา)
  const waterLogAll = waterLinked.length ? await readTab('WaterLog').catch(() => []) : [];
  await Promise.all(waterLinked.map(async (r) => {
    const throttleKey = sheetId + ':water-' + r.id;
    if (now - (lastLoggedAt.get(throttleKey) || 0) < LOG_INTERVAL_MS) return;
    try {
      lastLoggedAt.set(throttleKey, now);
      const roomRows = waterLogAll.filter((row) => row.room === r.id.toString());
      const latest = roomRows.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
      const prevCumulative = latest ? Number(latest.cumulativeLiters) || 0 : 0;
      const sinceEventTimeMs = latest ? Number(latest.lastProcessedEventTimeMs) || 0 : 0;
      const { deltaLiters, lastProcessedEventTimeMs } = await getWaterUsageDeltaLiters(r.tuyaWaterDeviceId, sinceEventTimeMs, tuyaCreds);
      if (deltaLiters <= 0 && lastProcessedEventTimeMs === sinceEventTimeMs) return;
      const waterReading = await getWaterReading(r.tuyaWaterDeviceId, tuyaCreds).catch(() => ({}));
      await appendRow('WaterLog', {
        id: Date.now() + '-' + r.id, timestamp: new Date().toISOString(), room: r.id,
        cumulativeLiters: prevCumulative + deltaLiters, lastProcessedEventTimeMs,
        flowRate: waterReading.flowRate, batteryPercent: waterReading.batteryPercent,
      });
    } catch (err) {
      console.error('[tuya] scheduled water poll failed for room', r.id, ':', err.message);
    }
  }));
}
router.pollAndLogUsageForScheduler = pollAndLogUsageForScheduler;

// Per real user report: the "ปริมาณการใช้ไฟรวม" chart on the Electricity
// Usage page always showed 0/empty even after weeks of real ElectricityLog
// data had accumulated. Root cause: the frontend's usageSeries.elecDay/
// elecMonth state was ONLY ever set once, to an empty array, at initial
// state — nothing anywhere in the whole codebase ever populated it. This
// is the endpoint that actually was missing: aggregates the raw cumulative
// kWh log rows into usage buckets (ElectricityLog stores a running
// cumulative total per room, not a per-tick delta, so usage per bucket =
// last reading in that bucket minus last reading in the previous bucket,
// summed across all rooms).
//
// "แสดงข้อมูลในกราฟใหม่ครับ" (2026-08-10) redesign — ?mode=day|month|year
// (default 'month'), ?period=<YYYY-MM-DD|YYYY-MM|YYYY> (omit = วันนี้/
// เดือนนี้/ปีนี้ ตามเวลาไทย) เลือกช่วงเวลาที่จะเจาะดู ดูรายละเอียดเต็มที่
// buildDrillDownChart ด้านบน
router.get('/elec-history', async (req, res, next) => {
  try {
    const byRoom = groupByRoom(await readTab('ElectricityLog'));
    const mode = ['day', 'month', 'year'].includes(req.query.mode) ? req.query.mode : 'month';
    res.json(buildDrillDownChart(byRoom, mode, req.query.period || null, 'energy'));
  } catch (err) { next(err); }
});

// "ส่วนน้ำ จัดการให้ด้วยครับ" (2026-07-26) — the "ปริมาณการใช้น้ำรวม" chart
// on the Water Usage page had the exact same pre-existing gap as elec-
// history above: usageSeries.waterDay/waterMonth were declared in state but
// NEVER populated anywhere in the whole codebase (no fetch call, no route)
// — confirmed live by the owner (chart always showed "รวม 0 · เฉลี่ย 0").
// Reuses the same shared buildDrillDownChart() as elec-history —
// WaterLog's running-cumulative column is 'cumulativeLiters' (not
// 'energy'), and its unit is liters while the frontend displays "ม³"
// (cubic meters), so divide by 1000 after aggregating.
router.get('/water-history', async (req, res, next) => {
  try {
    const byRoom = groupByRoom(await readTab('WaterLog'));
    const mode = ['day', 'month', 'year'].includes(req.query.mode) ? req.query.mode : 'month';
    const result = buildDrillDownChart(byRoom, mode, req.query.period || null, 'cumulativeLiters');
    result.bars = result.bars.map((b) => ({ label: b.label, value: Math.round((b.value / 1000) * 1000) / 1000 }));
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/switch', async (req, res, next) => {
  try {
    const creds = await readIntegrationCredentials();
    if (!isConfiguredForRequest(req, creds.tuya)) return res.status(400).json({ error: 'ยังไม่ได้ตั้งค่า Tuya (ใส่ Access ID/Secret ที่หน้าตั้งค่า หรือฝั่งเซิร์ฟเวอร์)' });
    const { roomId, on } = req.body;
    if (!roomId || typeof on !== 'boolean') return res.status(400).json({ error: 'ต้องระบุห้องและสถานะเปิด/ปิด' });
    const rooms = await readTab('Rooms');
    const room = rooms.find((r) => r.id === roomId);
    if (!room || !room.tuyaElecDeviceId) return res.status(400).json({ error: `ห้อง ${roomId} ยังไม่ได้เชื่อมต่ออุปกรณ์ไฟฟ้า` });
    await sendCommand(room.tuyaElecDeviceId, 'switch', on, creds.tuya);
    const reading = await getElecReading(room.tuyaElecDeviceId, creds.tuya);
    res.json({ ok: true, ...reading });
    // "การจ่ายไฟอาจมี 2 กรณี คือ 1 ชำระบิลทั้งหมด แล้วจ่ายไฟให้ กับ 2 การขอ
    // ใช้ไฟชั่วคราว คือ การที่บิลยังไม่ชำระแต่ขอให้เปิดการใช้ไฟให้ครับ...
    // ตัดไฟแล้ว แล้วจ่ายไฟให้ใหม่ ทั้งๆที่ยังไม่จ่ายบิล สถานะตรงนี้ต้องขึ้น
    // การขอใช้ไฟชั่วคราว" (2026-08-10 follow-up) — เดิม on:true เคลียร์
    // elecCutoffAt กลับเป็นว่างทันที ทำให้ "ตัดไฟแล้ว → จ่ายไฟกลับคืนทั้งที่
    // ยังไม่จ่ายบิล" กระโดดกลับไปโชว์ "รอตัดไฟ" เหมือนไม่เคยตัดไฟมาก่อนเลย
    // ทั้งที่จริงควรมีสถานะที่ 3 แยกต่างหาก ("ขอใช้ไฟชั่วคราว") บอกว่าเคย
    // ตัดมาแล้วแต่ปล่อยให้ใช้ชั่วคราว ไม่ใช่ไม่เคยตัด — เปลี่ยนมาเป็น: on:
    // false ตั้ง elecCutoffAt (เหมือนเดิม), on:true ตั้ง elecRestoredAt
    // แทน (ไม่แตะ elecCutoffAt เลย) — ฝั่งหน้าเว็บเทียบ 2 timestamp นี้เอง
    // ว่าอันไหนล่าสุดกว่ากัน (ดู pendingBills's isCurrentlyOff/tempPowerGrant
    // ใน Rental Management.dc.html) ตัดสินใจว่าจะโชว์ "ตัดไฟแล้ว" หรือ
    // "ขอใช้ไฟชั่วคราว" — ทั้ง 2 ฟิลด์รีเซ็ตกลับว่างเมื่อออกบิลใหม่ให้ห้อง
    // นั้น (submitInvoice/submitBulkInvoice's roomPatch) กันป้ายค้างข้ามรอบบิล
    updateRow('Rooms', roomId, on ? { elecRestoredAt: new Date().toISOString() } : { elecCutoffAt: new Date().toISOString() })
      .catch((err) => console.error('[tuya] elecCutoffAt/elecRestoredAt update failed:', err.message));
  } catch (err) { next(err); }
});

// "คาลิเบรตมิเตอร์น้ำ" — ตามคำขอคุณต้น (2026-07-24): ให้พิมพ์ค่า "Total Use"
// จากแอป Tuya บนมือถือ กด "คาลิเบรต" แล้วปรับยอดสะสมในเว็บให้ตรงกับแอปทันที
// แทนที่จะต้องให้ผมรันสคริปต์ one-off ทีละห้องแบบก่อนหน้านี้ — เขียนแถวใหม่ลง
// WaterLog เหมือน manual calibration ที่ทำไปก่อนหน้า (คงค่า watermark เดิม
// ไว้ ไม่ให้รอบโพลถัดไปนับ event ซ้ำ/ข้าม) และคืนค่าความแม่นยำก่อนคาลิเบรต
// (ค่าเว็บเดิม / ค่าแอปที่พิมพ์เข้ามา) ให้ frontend แสดงผลด้วย
router.post('/calibrate-water', async (req, res, next) => {
  try {
    const { roomId, appLiters } = req.body;
    const parsedLiters = Number(appLiters);
    if (!roomId || !Number.isFinite(parsedLiters) || parsedLiters < 0) {
      return res.status(400).json({ error: 'ต้องระบุห้องและค่าลิตรจากแอป (ตัวเลขที่ถูกต้อง)' });
    }
    const rooms = await readTab('Rooms');
    const room = rooms.find((r) => r.id === roomId);
    if (!room || !room.tuyaWaterDeviceId) {
      return res.status(400).json({ error: `ห้อง ${roomId} ยังไม่ได้เชื่อมต่ออุปกรณ์น้ำ` });
    }
    // "ปุ่มคาริเบท ถ้าห้องยังใช้น้ำอยู่ ขึ้นไม่สามารถคาริเบทได้...ต้องเป็น
    // ช่วงที่ไม่ใช้น้ำถึงจะตั้งค่าคาลิเบรตได้" (2026-07-26) — calibrating
    // while water is actively flowing would capture the app's Total Use
    // mid-session (before that session's own usage has even finished
    // accumulating), guaranteeing a fresh mismatch the moment the tap turns
    // off. Reuses the same live isFlowing signal (getWaterFlowActivity,
    // 15-second pulse window) the dashboard already shows — blocked
    // server-side (not just a disabled button) so a stale/cached frontend
    // state can't slip a mid-session calibration through.
    const creds = await readIntegrationCredentials();
    try {
      const liveReading = await getWaterReading(room.tuyaWaterDeviceId, creds.tuya);
      if (liveReading.isFlowing) {
        return res.status(400).json({ error: `ห้อง ${roomId} กำลังใช้น้ำอยู่ตอนนี้ครับ — รอให้หยุดใช้น้ำก่อนแล้วค่อยคาลิเบรต (เพื่อไม่ให้ค่าที่บันทึกคลาดเคลื่อนจากรอบที่ยังใช้อยู่)` });
      }
    } catch (err) {
      // เช็คสถานะไหลไม่ได้ (network hiccup ฯลฯ) — ไม่บล็อกการคาลิเบรต แค่
      // แจ้ง log ไว้ (isFlowing null ก็ไม่ error ใน getWaterReading อยู่แล้ว
      // แต่กันไว้เผื่อ getWaterReading เองล้มเหลวทั้งฟังก์ชัน)
      console.error('[tuya] calibrate-water: live flow check failed, allowing calibration anyway', err.message);
    }
    const waterLog = await readTab('WaterLog');
    const roomRows = waterLog.filter((r) => r.room === roomId.toString())
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const latest = roomRows[0];
    const beforeLiters = latest ? Number(latest.cumulativeLiters) || 0 : 0;
    const watermark = latest ? latest.lastProcessedEventTimeMs : 0;
    await appendRow('WaterLog', {
      id: Date.now() + '-' + roomId + '-calibration',
      timestamp: new Date().toISOString(),
      room: roomId,
      cumulativeLiters: parsedLiters,
      lastProcessedEventTimeMs: watermark,
      flowRate: 0,
      batteryPercent: 100,
    });
    const accuracyPercent = parsedLiters > 0 ? Math.round((beforeLiters / parsedLiters) * 1000) / 10 : null;
    res.json({ ok: true, before: beforeLiters, after: parsedLiters, accuracyPercent });
  } catch (err) { next(err); }
});

module.exports = router;
