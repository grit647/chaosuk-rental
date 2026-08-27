const express = require('express');
const router = express.Router();
const { readTab, appendRow } = require('../sheets');
const { coerceRooms, coerceInvoices, readSettings, readIntegrationCredentials } = require('../coerce');
const { getElecReading, getWaterReading, isConfigured } = require('../tuya');

// Per explicit user request: a tenant session (see server/routes/auth.js's
// POST /tenant-login) must only ever see THEIR OWN room's data — never
// another tenant's, never the building's overall financials, never
// anything an owner/staff session can do. Every route below re-checks
// req.session.role === 'tenant' server-side (never trusts a client-side
// flag) and scopes every query to req.session.roomId.
function requireTenant(req, res, next) {
  if (!req.session || req.session.role !== 'tenant' || !req.session.roomId) {
    return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบก่อน' });
  }
  next();
}

router.get('/me', requireTenant, async (req, res, next) => {
  try {
    const rooms = coerceRooms(await readTab('Rooms'));
    const room = rooms.find((r) => r.id === req.session.roomId);
    if (!room) return res.status(404).json({ error: 'ไม่พบข้อมูลห้อง' });
    // Only the fields a tenant actually needs to see about their own
    // room — deliberately excludes tenantIdImg/leaseDocName (owner-side
    // document references) and any other-room-adjacent internals.
    res.json({
      id: room.id, tenant: room.tenant, phone: room.phone, rent: room.rent,
      deposit: room.deposit, moveIn: room.moveIn, contractEnd: room.contractEnd,
      dueDay: room.dueDay, wifiUsername: room.wifiUsername, wifiPassword: room.wifiPassword,
      creditBalance: room.creditBalance,
    });
  } catch (err) { next(err); }
});

router.get('/invoices', requireTenant, async (req, res, next) => {
  try {
    const invoices = coerceInvoices(await readTab('Invoices')).filter((i) => i.room === req.session.roomId);
    // Newest first — most useful order for both "current amount owed"
    // (frontend picks the first non-paid one) and "ประวัติบิลย้อนหลัง".
    invoices.sort((a, b) => (b.id > a.id ? 1 : -1));
    res.json(invoices);
  } catch (err) { next(err); }
});

// Per explicit user request: a tenant who has a real Tuya device linked to
// their room should see the SAME live water/elec readout + this-cycle
// usage that the owner already sees on the ผู้เช่า page's tenant card
// (Rental Management.dc.html's deviceCharge/_waterRolloverUnits/
// _applyMinCharge) — replicates that exact same calc server-side (units/
// cost math kept in sync with those, see the comments there for the full
// reasoning behind the min-charge and water-rollover handling) so this
// never disagrees with what the owner sees for the same room. Exported
// as a standalone function (not just inline in the route below) so
// server/routes/line.js's Rich Menu "การใช้น้ำ/ไฟปัจจุบัน" postback
// action can reuse the exact same computation without duplicating it.
async function computeTenantUsage(room) {
  const settings = await readSettings();
  const creds = await readIntegrationCredentials();
  // Same reasoning as server/routes/tuya.js's isConfiguredForRequest: only
  // THIS building's own saved Tuya credentials count — never silently
  // fall back to the shared server/.env values (a different customer's
  // Tuya Cloud project) just because this building hasn't set its own.
  const tuyaReady = !!creds.tuya && isConfigured(creds.tuya);

  const roomRate = (kind) => {
    const own = kind === 'water' ? room.waterRate : room.elecRate;
    if (own > 0) return own;
    return kind === 'water' ? settings.waterRate : settings.elecRate;
  };
  const roomMinRate = (kind) => (kind === 'water' ? room.waterMinRate : room.elecMinRate) || 0;
  const applyMinCharge = (kind, rawCharge) => {
    const minRate = roomMinRate(kind);
    if (minRate > 0 && rawCharge < minRate) return { charge: minRate, minApplied: true };
    return { charge: rawCharge, minApplied: false };
  };

  const result = { hasElecDevice: false, hasWaterDevice: false };

  if (room.tuyaElecDeviceId && tuyaReady) {
    result.hasElecDevice = true;
    try {
      const live = await getElecReading(room.tuyaElecDeviceId, creds.tuya);
      result.elecLive = { voltage: live.voltage, current: live.current, power: live.power, energy: live.energy, online: true };
      if (live.energy != null) {
        // "หน่วยมิเตอร์ น้ำไฟ...จำนวนเต็มครับ ไม่มีจุดทศนิยม" — ปัดเป็น
        // จำนวนเต็มก่อนคำนวณค่าไฟ เหมือนกับ deviceCharge()'s elec branch
        // ฝั่งเจ้าของเป๊ะๆ (Rental Management.dc.html) กันตัวเลขไม่ตรงกัน
        // ระหว่างข้อความที่ส่งผู้เช่ากับที่เจ้าของเห็นในเว็บ
        const rawUnits = Math.max(0, live.energy - Number(room.elecPrev || 0));
        const units = Math.round(rawUnits);
        const { charge } = applyMinCharge('elec', Math.round(units * roomRate('elec')));
        result.elecUsage = units;
        result.elecCost = charge;
        // "หน่วยที่ใช้ × หน่วยละเท่ากับกี่บาท" (2026-07-31) — ข้อความ LINE
        // ต้องโชว์เรทต่อหน่วยด้วย ไม่ใช่แค่ยอดรวม — ส่งเรทกลับไปด้วย
        result.elecRate = roomRate('elec');
      }
    } catch (err) {
      result.elecLive = { online: false, error: err.message };
    }
  }

  if (room.tuyaWaterDeviceId && tuyaReady) {
    result.hasWaterDevice = true;
    try {
      const live = await getWaterReading(room.tuyaWaterDeviceId, creds.tuya);
      // "เราลืมแปลงหน่วยน้ำเป็นลิตร ของการขอดูข้อมูลน้ำไฟ ผู้เช่า ลูกค้า
      // ตกใจ" (2026-07-31) — บั๊กจริง: live.usage (จาก getWaterReading()
      // ตรงๆ) คือค่าดิบจาก DP `water_use_data` ซึ่งค้างที่ 0 ถาวรเสมอ (ดู
      // getWaterReading's comment เต็ม — DP ตัวนี้ไม่เคยอัปเดตจริงบน
      // อุปกรณ์รุ่นนี้) — routes/tuya.js's GET /status (หน้า Set อุปกรณ์/
      // แดชบอร์ดเจ้าของ) แก้ไปแล้วโดยเอายอดสะสมจริงจากแท็บ WaterLog มาทับ
      // usage ก่อนส่งกลับ แต่ endpoint นี้ (ใช้โดยปุ่ม LINE "การใช้น้ำ/ไฟ
      // ปัจจุบัน" ของผู้เช่า) ไม่เคยได้รับการแก้แบบเดียวกัน เลยยังคำนวณ
      // จาก live.usage ที่เป็น 0 ตลอด (ทำให้ตัวเลขน้ำที่ผู้เช่าเห็นผิดอยู่
      // เงียบๆ — ไม่ใช่แค่หน่วยผิด แต่ข้อมูลทั้งก้อนมาจากแหล่งที่ตายแล้ว)
      // แก้ให้อ่านจาก WaterLog แท็บเดียวกับที่แดชบอร์ดใช้แทน (เอาแถวล่าสุด
      // ของห้องนี้) แล้วค่อยแปลงลิตร→หน่วย (÷1000) เหมือนเดิม
      let cumulativeLiters = null;
      try {
        const waterLog = await readTab('WaterLog');
        const roomRows = waterLog.filter((row) => row.room === room.id.toString());
        const latest = roomRows.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
        if (latest) cumulativeLiters = Number(latest.cumulativeLiters) || 0;
      } catch (err) {
        console.error('[tenant] WaterLog cumulative read failed:', err.message);
      }
      result.waterLive = { usage: cumulativeLiters, flowRate: live.flowRate, batteryPercent: live.batteryPercent, online: true };
      if (cumulativeLiters != null) {
        // "ตัวเลขที่เป็นข้อความที่ส่งไลน์ให้ผู้เช่า...ตัวเลขไม่ตรงกับที่
        // แสดงหน้าเวป...หน้าเวปเราตรง แต่ข้อมูลที่ส่งไลน์ ส่วนของค่าน้ำ
        // ไม่ตรงครับ" (2026-08-13) — พบว่าฟังก์ชันนี้ (ใช้เฉพาะข้อความ LINE
        // "การใช้น้ำ/ไฟปัจจุบัน" ของผู้เช่า) ยังเป็นสูตรเก่า ค้างมาตั้งแต่
        // ก่อน 2026-08-12 ไม่เคยได้อัปเดตตามฝั่งเจ้าของ (Rental Management.
        // dc.html's deviceCharge/_waterRolloverUnits) เลย 2 จุด:
        // (1) ไม่ได้บวก waterSetNewValue (ค่าชดเชยสะสม) เข้าไปก่อนคำนวณ
        //     เหมือนที่ deviceCharge()'s water branch ทำ — ห้องที่ยังไม่
        //     คาลิเบรตจะได้ตัวเลขต่ำกว่าความจริงมาก (เพราะสะสมดิบยังไม่รวม
        //     ค่าชดเชย)
        // (2) ยังมีตรรกะ "rollover" (เดาว่ามิเตอร์รีเซ็ตแล้วใช้
        //     tuyaWaterMaxLiters แทน) ซึ่งฝั่งเจ้าของถอดทิ้งไปแล้วตั้งแต่
        //     2026-08-12 (พิสูจน์แล้วว่าเป็นสาเหตุบั๊กจริง ห้อง 4 เจอ 99
        //     หน่วยทั้งที่ควรเป็น ~0.91 — ดู _waterRolloverUnits's comment
        //     เต็มใน Rental Management.dc.html) — เอาออกให้ตรงกัน เหลือแค่
        //     current − baseline ธรรมดา (Math.max(0,...) กันติดลบ)
        const currentLiters = cumulativeLiters + (Number(room.waterSetNewValue) || 0);
        const baselineLiters = Number(room.waterPrev || 0) * 1000;
        const rawUnits = Math.max(0, (currentLiters - baselineLiters) / 1000);
        // "หน่วยมิเตอร์ น้ำไฟ...จำนวนเต็มครับ ไม่มีจุดทศนิยม" — ปัดเป็นจำนวน
        // เต็มก่อนคำนวณค่าน้ำ เหมือนกับ deviceCharge()'s water branch ฝั่ง
        // เจ้าของเป๊ะๆ กันตัวเลขไม่ตรงกันระหว่าง 2 ฝั่ง
        const units = Math.round(rawUnits);
        const { charge } = applyMinCharge('water', Math.round(units * roomRate('water')));
        result.waterUsage = units;
        result.waterCost = charge;
        result.waterRate = roomRate('water');
      }
    } catch (err) {
      result.waterLive = { online: false, error: err.message };
    }
  }

  return result;
}

router.get('/usage', requireTenant, async (req, res, next) => {
  try {
    const rooms = coerceRooms(await readTab('Rooms'));
    const room = rooms.find((r) => r.id === req.session.roomId);
    if (!room) return res.status(404).json({ error: 'ไม่พบข้อมูลห้อง' });
    res.json(await computeTenantUsage(room));
  } catch (err) { next(err); }
});

router.post('/maintenance', requireTenant, async (req, res, next) => {
  try {
    const issue = req.body && req.body.issue;
    if (!issue || !String(issue).trim()) return res.status(400).json({ error: 'กรุณากรอกรายละเอียดปัญหา' });
    const item = { id: Date.now(), room: req.session.roomId, issue: String(issue).trim(), status: 'pending', date: 'วันนี้' };
    await appendRow('Maintenance', item);
    res.json({ ok: true, message: 'ส่งคำขอแจ้งซ่อมแล้ว เจ้าของ/ผู้ดูแลจะรับเรื่องและดำเนินการให้ครับ' });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.computeTenantUsage = computeTenantUsage;
