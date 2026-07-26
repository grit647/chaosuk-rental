const express = require('express');
const router = express.Router();
const { readTab, appendRow } = require('../sheets');
const { isConfigured, listDevices, getElecReading, getWaterReading, getWaterUsageDeltaLiters, sendCommand } = require('../tuya');
const { readIntegrationCredentials } = require('../coerce');
const { isMainAccountSheetId } = require('../requestContext');

// Shared chart-aggregation helpers (originally written inline inside
// /elec-history, hoisted to module scope so /water-history — "ส่วนน้ำ
// จัดการให้ด้วยครับ" (2026-07-26) — can reuse them instead of duplicating).
// Bangkok-local date/month key — a UTC-based day boundary is 7 hours off
// from the Thailand calendar day the owner actually cares about (same bug
// class fixed for the hourly chart below).
const bangkokDateStr = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' }); // "YYYY-MM-DD"
const dayKey = (d) => bangkokDateStr(d);
const dayLabel = (key) => {
  const d = new Date(key + 'T00:00:00Z');
  return d.getUTCDate() + '/' + (d.getUTCMonth() + 1);
};
const monthKey = (d) => bangkokDateStr(d).slice(0, 7); // YYYY-MM
const monthNames = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const monthLabel = (key) => {
  const [y, m] = key.split('-');
  return monthNames[Number(m) - 1];
};
// Fixed trailing windows anchored on "today" in Bangkok time — pure
// day/month-count arithmetic (Thailand has no DST, so plain UTC ms
// stepping anchored at the Bangkok Y-M-D is safe here).
function trailingDayKeys(n) {
  const [y, m, dd] = bangkokDateStr(new Date()).split('-').map(Number);
  const base = Date.UTC(y, m - 1, dd);
  const keys = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(base - i * 86400000);
    keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`);
  }
  return keys;
}
function trailingMonthKeys(n) {
  const [y, m] = bangkokDateStr(new Date()).split('-').map(Number);
  const keys = [];
  for (let i = n - 1; i >= 0; i--) {
    let yy = y, mm = m - i;
    while (mm <= 0) { mm += 12; yy -= 1; }
    keys.push(`${yy}-${String(mm).padStart(2, '0')}`);
  }
  return keys;
}
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

// "รายชั่วโมง 24 กราฟ เผื่อเอาไปดูการใช้ไฟระบบ TOU" (2026-07-26, follow-up
// "ตรงนี้เรียง 00 นาฬิกาไปเลยครับ แบบนี้มองยาก ตาม app ของ Tuya") — first
// attempt reused the generic aggregate() helper (most recent 24 buckets by
// absolute UTC hour), which had 2 real bugs compared to what the owner
// actually wanted (matching Tuya's own app's hourly chart):
//   1. Labelled buckets in UTC, not Thailand local time (Asia/Bangkok,
//      UTC+7) — every hour label was 7 hours off from the wall-clock time
//      the owner actually cares about.
//   2. "Most recent 24 buckets" is a ROLLING window that can span the tail
//      of one day + start of another, so hour-of-day labels came out
//      repeated/out of order (e.g. "16:00" then "01:00" then "11:00"...)
//      instead of a clean 00:00→23:00 sequence for one day.
// Rewritten to build exactly one calendar day (Bangkok time) — the most
// recent day that actually has log data — as 24 fixed slots in order,
// zero-filled for any hour with no reading (same as Tuya's own chart shows
// dotted/empty bars for hours with nothing logged). Originally written
// inline inside /elec-history only; hoisted to module scope + parametrized
// by valueField so /water-history ("รายชั่วโมงให้ไปด้วยครับ จะได้เหมือนไฟ",
// 2026-07-26) can reuse it against WaterLog's cumulativeLiters column.
function bangkokDateHour(d) {
  // en-CA locale gives "YYYY-MM-DD, HH:MM:SS" in the given timeZone —
  // simplest reliable way to get Bangkok-local date+hour without a date
  // library, consistent with formatThaiDateTime's timeZone usage elsewhere
  // in this codebase.
  const s = d.toLocaleString('en-CA', { timeZone: 'Asia/Bangkok', hour12: false });
  const [datePart, timePart] = s.split(', ');
  return { date: datePart, hour: Number(timePart.slice(0, 2)) };
}
function buildHourlyChart(byRoom, valueField) {
  let latestDate = null;
  Object.values(byRoom).forEach((roomRows) => {
    roomRows.forEach((r) => {
      const { date } = bangkokDateHour(new Date(r.timestamp));
      if (!latestDate || date > latestDate) latestDate = date;
    });
  });
  if (!latestDate) return [];

  const hourTotals = new Array(24).fill(0);
  Object.values(byRoom).forEach((roomRows) => {
    const sorted = [...roomRows].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    // Last reading strictly before the target day (any date < latestDate)
    // becomes the baseline for computing hour 0's own delta — without
    // this, the first hour of the day with a reading would have no
    // "previous" value to diff against and would show 0 or be skipped.
    let baseline = null;
    const perHourLast = new Array(24).fill(null);
    sorted.forEach((r) => {
      const { date, hour } = bangkokDateHour(new Date(r.timestamp));
      const val = Number(r[valueField]) || 0;
      if (date < latestDate) baseline = val;
      else if (date === latestDate) perHourLast[hour] = val; // later same-hour rows overwrite — last wins
    });
    let prev = baseline;
    for (let h = 0; h < 24; h++) {
      const val = perHourLast[h];
      if (val != null) {
        if (prev != null) hourTotals[h] += Math.max(0, val - prev);
        prev = val;
      }
      // no reading this hour for this room: stays 0 for this room this
      // hour, `prev` carries forward unchanged to the next hour that does
      // have a reading (same carry-forward logic as aggregate()).
    }
  });
  return hourTotals.map((v, h) => ({ label: String(h).padStart(2, '0') + ':00', value: Math.round(v * 100) / 100 }));
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
    const now = Date.now();
    entries.forEach(([roomId, reading]) => {
      if (reading.voltage == null) return; // device was offline/errored — nothing useful to log
      const last = lastLoggedAt.get(roomId) || 0;
      if (now - last < LOG_INTERVAL_MS) return;
      lastLoggedAt.set(roomId, now);
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
      const throttleKey = 'water-' + r.id;
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

// Per real user report: the "ปริมาณการใช้ไฟรวม" chart on the Electricity
// Usage page always showed 0/empty even after weeks of real ElectricityLog
// data had accumulated. Root cause: the frontend's usageSeries.elecDay/
// elecMonth state was ONLY ever set once, to an empty array, at initial
// state — nothing anywhere in the whole codebase ever populated it. This
// is the endpoint that actually was missing: aggregates the raw cumulative
// kWh log rows into day/month usage buckets (ElectricityLog stores a
// running cumulative total per room, not a per-tick delta, so usage per
// bucket = last reading in that bucket minus last reading in the previous
// bucket, summed across all rooms).
router.get('/elec-history', async (req, res, next) => {
  try {
    const byRoom = groupByRoom(await readTab('ElectricityLog'));
    res.json({
      day: aggregate(byRoom, dayKey, dayLabel, trailingDayKeys(7), 'energy'),
      month: aggregate(byRoom, monthKey, monthLabel, trailingMonthKeys(6), 'energy'),
      hour: buildHourlyChart(byRoom, 'energy'),
    });
  } catch (err) { next(err); }
});

// "ส่วนน้ำ จัดการให้ด้วยครับ" (2026-07-26) — the "ปริมาณการใช้น้ำรวม" chart
// on the Water Usage page had the exact same pre-existing gap as elec-
// history above: usageSeries.waterDay/waterMonth were declared in state but
// NEVER populated anywhere in the whole codebase (no fetch call, no route)
// — confirmed live by the owner (chart always showed "รวม 0 · เฉลี่ย 0").
// Reuses the same shared aggregate()/trailingDayKeys()/trailingMonthKeys()
// helpers as elec-history (7-day / 6-month fixed trailing windows, zero-
// filled, Bangkok-local) — WaterLog's running-cumulative column is
// 'cumulativeLiters' (not 'energy'), and its unit is liters while the
// frontend displays "ม³" (cubic meters), so divide by 1000 after
// aggregating.
router.get('/water-history', async (req, res, next) => {
  try {
    const byRoom = groupByRoom(await readTab('WaterLog'));
    const toM3 = (buckets) => buckets.map((b) => ({ label: b.label, value: Math.round((b.value / 1000) * 1000) / 1000 }));
    res.json({
      day: toM3(aggregate(byRoom, dayKey, dayLabel, trailingDayKeys(7), 'cumulativeLiters')),
      month: toM3(aggregate(byRoom, monthKey, monthLabel, trailingMonthKeys(6), 'cumulativeLiters')),
      hour: toM3(buildHourlyChart(byRoom, 'cumulativeLiters')),
    });
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
