// ONE-OFF NOTIFY SCRIPT (2026-08-13) — per explicit owner request in chat:
// "ช่วยส่งไลน์น้ำไฟ ห้อง 15 ไปให้เจ้าของหน่อยครับ แจ้งว่ามีการแก้ไข อัปเดท
// ข้อมูลใหม่ให้ทุกห้องแล้วครับ" — sends a status message to the OWNER's own
// LINE (adminLineUserId), not the tenant, confirming the water/elec usage
// formula fix (server/routes/tenant.js's computeTenantUsage — see today's
// git commit) is live, using room 15's real current numbers as a concrete
// example. Reuses computeTenantUsage() directly (not a re-implementation)
// so the numbers shown here are guaranteed to match what a tenant would
// actually see if they tapped "การใช้น้ำ/ไฟปัจจุบัน" themselves right now.
const path = require('path');
require(path.join(__dirname, '..', 'server', 'node_modules', 'dotenv')).config({
  path: path.join(__dirname, '..', 'server', '.env'),
});
const { runWithSheetId } = require(path.join(__dirname, '..', 'server', 'requestContext'));
const { readTab } = require(path.join(__dirname, '..', 'server', 'sheets'));
const { coerceRooms, readSettings, readIntegrationCredentials } = require(path.join(__dirname, '..', 'server', 'coerce'));
const { computeTenantUsage } = require(path.join(__dirname, '..', 'server', 'routes', 'tenant'));
const { pushMessage } = require(path.join(__dirname, '..', 'server', 'line'));

const SHEET_ID_1873 = '1moUMiEhF2Ie76_Ep8_rgtefWenlQXx7vEUyaO0exk4E';
const ROOM_ID = '15';

async function main() {
  await runWithSheetId(SHEET_ID_1873, async () => {
    const rooms = coerceRooms(await readTab('Rooms'));
    const room = rooms.find((r) => r.id === ROOM_ID);
    if (!room) throw new Error(`ไม่พบห้อง ${ROOM_ID}`);

    const settings = await readSettings();
    const creds = await readIntegrationCredentials();
    const adminId = settings.propertyProfile && settings.propertyProfile.adminLineUserId;
    if (!adminId) throw new Error('ไม่พบ adminLineUserId ในหน้าตั้งค่า');
    if (!creds.line) throw new Error('ยังไม่ได้ตั้งค่า LINE ของตึกนี้');

    const usage = await computeTenantUsage(room);

    const lines = [
      '🔧 แจ้งอัปเดตระบบครับ',
      'แก้ไขสูตรคำนวณค่าน้ำในข้อความไลน์ "การใช้น้ำ/ไฟปัจจุบัน" ที่ผู้เช่าเห็น ให้ตรงกับตัวเลขบนหน้าเว็บทุกห้องแล้วครับ (เดิมบางห้องคำนวณผิดพลาดเนื่องจากใช้สูตรเก่า)',
      '',
      `ตัวอย่างห้อง ${room.id} · ${room.tenant || '-'} (หลังแก้ไข):`,
    ];
    if (usage.hasElecDevice) {
      lines.push(usage.elecLive && usage.elecLive.online
        ? `⚡ ไฟตอนนี้: ${usage.elecLive.voltage != null ? usage.elecLive.voltage.toFixed(1) : '-'}V · ${usage.elecLive.current != null ? usage.elecLive.current.toFixed(2) : '-'}A · ${usage.elecLive.power != null ? usage.elecLive.power.toFixed(1) : '-'}W`
        : '⚡ อุปกรณ์ไฟฟ้า: ออฟไลน์');
      if (usage.elecUsage != null) lines.push(`ไฟที่ใช้รอบนี้: ${usage.elecUsage} หน่วย × หน่วยละ ${usage.elecRate} บาท = ${usage.elecCost.toLocaleString()} บาท`);
    }
    if (usage.hasWaterDevice) {
      if (!(usage.waterLive && usage.waterLive.online)) lines.push('💧 อุปกรณ์น้ำ: ออฟไลน์');
      if (usage.waterUsage != null) lines.push(`น้ำที่ใช้รอบนี้: ${usage.waterUsage} หน่วย × หน่วยละ ${usage.waterRate} บาท = ${usage.waterCost.toLocaleString()} บาท`);
    }
    const msg = lines.join('\n');
    await pushMessage(adminId, msg, undefined, creds.line);
    console.log('ส่งข้อความไปที่เจ้าของสำเร็จแล้วครับ:\n\n' + msg);
  });
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
