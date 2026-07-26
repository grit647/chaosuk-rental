const express = require('express');
const router = express.Router();
const { readTab, appendRow } = require('../sheets');
const { isConfigured, listDevices, getElecReading, getWaterReading, getWaterUsageDeltaLiters, sendCommand } = require('../tuya');
const { readIntegrationCredentials } = require('../coerce');
const { isMainAccountSheetId } = require('../requestContext');

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
    const rows = await readTab('ElectricityLog');
    const byRoom = {};
    rows.forEach((r) => {
      if (!r.room || !r.timestamp) return;
      // Real bug hit in production: a row with a malformed/unparseable
      // timestamp made new Date(r.timestamp).toISOString() throw a
      // RangeError ("Invalid time value") further down, which surfaced as
      // a 500 on every single /status poll (this endpoint piggybacks on
      // refreshTuyaLive — see Rental Management.dc.html) for that entire
      // building, not just once. Skip anything that doesn't parse to a
      // real date instead of crashing the whole aggregation.
      if (Number.isNaN(new Date(r.timestamp).getTime())) return;
      if (!byRoom[r.room]) byRoom[r.room] = [];
      byRoom[r.room].push(r);
    });

    function aggregate(bucketFn, labelFn, bucketCount) {
      // bucketTotals: ordered Map so we can slice the most recent N buckets
      // at the end regardless of how sparse the log is.
      const bucketTotals = new Map();
      Object.values(byRoom).forEach((roomRows) => {
        roomRows.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        // Last cumulative reading seen per bucket, in chronological order —
        // Map preserves insertion order, and re-setting an existing key
        // (same bucket, later row) keeps it in its original position while
        // updating to the latest value, which is exactly what we want.
        const perBucketLast = new Map();
        roomRows.forEach((r) => {
          const key = bucketFn(new Date(r.timestamp));
          perBucketLast.set(key, Number(r.energy) || 0);
        });
        let prevEnergy = null;
        for (const [key, energy] of perBucketLast) {
          if (prevEnergy != null) {
            const usage = Math.max(0, energy - prevEnergy);
            bucketTotals.set(key, (bucketTotals.get(key) || 0) + usage);
          }
          prevEnergy = energy;
        }
      });
      const keys = Array.from(bucketTotals.keys()).sort();
      const recentKeys = keys.slice(-bucketCount);
      return recentKeys.map((key) => ({ label: labelFn(key), value: Math.round(bucketTotals.get(key) * 100) / 100 }));
    }

    const dayKey = (d) => d.toISOString().slice(0, 10); // YYYY-MM-DD
    const dayLabel = (key) => {
      const d = new Date(key + 'T00:00:00Z');
      return d.getUTCDate() + '/' + (d.getUTCMonth() + 1);
    };
    const monthKey = (d) => d.toISOString().slice(0, 7); // YYYY-MM
    const monthNames = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
    const monthLabel = (key) => {
      const [y, m] = key.split('-');
      return monthNames[Number(m) - 1];
    };
    // "รายชั่วโมง 24 กราฟ เผื่อเอาไปดูการใช้ไฟระบบ TOU" (2026-07-26) —
    // TOU (Time-of-Use) electricity billing in Thailand charges different
    // rates for on-peak vs off-peak hours, so seeing usage broken down by
    // hour-of-day (not just day/month totals) helps the owner spot which
    // hours are driving cost. Same bucketing approach as day/month above —
    // most recent 24 hourly buckets that actually have log data, not
    // necessarily aligned to a single calendar day (consistent with how
    // "day" mode already shows the most recent 14 days rather than one
    // fixed calendar month).
    const hourKey = (d) => d.toISOString().slice(0, 13); // YYYY-MM-DDTHH
    const hourLabel = (key) => key.slice(11, 13) + ':00';

    res.json({
      day: aggregate(dayKey, dayLabel, 14),
      month: aggregate(monthKey, monthLabel, 6),
      hour: aggregate(hourKey, hourLabel, 24),
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
