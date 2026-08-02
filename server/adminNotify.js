// Shared helper for pushing a LINE message to the owner/admin's own linked
// LINE account (propertyProfile.adminLineUserId — see the "ผู้ดูแลหอพัก"
// card in Settings) — separate from the tenant-facing messaging in
// server/line.js. Every call is gated behind BOTH the owner having
// connected their LINE account AND having explicitly turned on that
// specific notification category (server/coerce.js's readSettings()
// adminNotify object) — per explicit user request, nothing gets sent
// unless deliberately opted into.
const { pushMessage, pushLinkButton, isConfigured: lineConfigured } = require('./line');
const { readSettings, readIntegrationCredentials } = require('./coerce');

// category must match one of the keys in readSettings()'s adminNotify:
// taskFailure | slipPending | overdueBill | unmatchedSlip | maintenance | leaseExpiring | wifiRequest | cutoffWarning
// (wifiRequest is a special case — it fans out to the owner AND every
// linked ผู้ดูแล, not just the owner, so server/routes/line.js's
// action=wifi handler checks settings.adminNotify.wifiRequest directly
// and pushes to multiple recipients itself, rather than calling this
// single-recipient notifyAdmin() helper.)
// preloadedCreds (optional) — เลี่ยงอ่าน Settings ซ้ำเวลาโดนเรียกในลูป
// (เช่น scheduler.js's cutoff-warning/lease-expiring loops ที่วนต่อบิล/
// ต่อห้อง เรียก notifyAdmin หลายรอบในการรันครั้งเดียว) — ผู้เรียกที่ดึง
// readIntegrationCredentials() ไว้ก่อนหน้าลูปแล้วส่ง .line เข้ามาตรงนี้ได้
// เลย ไม่ต้องอ่านซ้ำทุกรอบ ไม่ระบุก็ยังทำงานได้ปกติ (อ่านเองข้างใน เหมือน
// เดิม) — เพิ่มหลังเจอ N+1 read pattern จริงจากการแก้บั๊ก LINE credentials
// ผิดตึกวันนี้เอง (2026-07-29)
// linkButton (optional) — { label, url } — "ฝั่งเจ้าของเปลี่ยนรูปแบบ
// ลิงก์เป็นแบบนี้ให้หน่อยครับ" (2026-08-02, ชี้ไปที่ปุ่ม "✅ ยืนยันได้รับ
// แล้ว" ของฝั่งผู้เช่าที่ดูเรียบร้อยกว่า) — เดิมลิงก์ที่แนบไปกับ
// notifyAdmin ทุกจุดเป็นแค่ URL ดิบต่อท้ายข้อความ ยาวและดูรก เมื่อระบุ
// พารามิเตอร์นี้จะส่งเป็นปุ่มจริง (LINE buttons template, ปุ่ม "uri")
// แทนที่จะฝัง URL ในเนื้อข้อความ
async function notifyAdmin(category, message, preloadedCreds, linkButton) {
  try {
    // บั๊กจริงที่พบ (2026-07-29, ระหว่างไล่บั๊ก "ตั้งเวลาส่งบิลแล้วไม่ยอม
    // ส่ง") — เดิม lineConfigured()/pushMessage() เรียกแบบไม่ส่ง creds เลย
    // เช็ค/ใช้แค่ credentials ของบัญชีหลัก (process.env) เสมอ ไม่ว่าจะรัน
    // อยู่ในบริบทของตึกไหนก็ตาม (readTab/readSettings ข้างล่างนี้แก้ไขไป
    // แล้วก่อนหน้านี้ ให้ผูกกับตึกปัจจุบันถูกต้อง แต่ credentials LINE เอง
    // ยังลืมผูกอยู่) — ตึกอื่นที่มี LINE OA แยกต่างหาก (บันทึกไว้ในหน้า
    // ตั้งค่าของตัวเอง ไม่ใช่ .env) จะส่งแจ้งเตือนไม่ออกเลย เพราะใช้ token
    // ผิดตึก — ดึง credentials ของตึกปัจจุบัน (ตาม runWithSheetId context
    // ที่ readIntegrationCredentials อ่านตามอยู่แล้ว) มาใช้แทน — บัญชีหลัก
    // (ไม่เคยบันทึก credentials ของตัวเองไว้ใน Settings เพราะใช้ .env มา
    // ตลอด) ยัง fallback ไปที่ .env ได้ปกติ เพราะ readIntegrationCredentials
    // คืนค่า null ให้ แล้ว pushMessage/lineConfigured เองก็ fallback ไปที่
    // process.env ต่อเมื่อ creds เป็น null/undefined อยู่แล้ว (resolveCreds
    // ใน line.js) — ไม่กระทบพฤติกรรมเดิมของบัญชีหลักเลย
    const creds = preloadedCreds || await readIntegrationCredentials();
    if (!lineConfigured(creds.line)) return;
    const settings = await readSettings();
    const adminId = settings.propertyProfile && settings.propertyProfile.adminLineUserId;
    if (!adminId) return;
    if (!settings.adminNotify || !settings.adminNotify[category]) return;
    if (linkButton && linkButton.url) {
      await pushLinkButton(adminId, message, linkButton.label || 'เปิดดู', linkButton.url, creds.line);
    } else {
      await pushMessage(adminId, message, undefined, creds.line);
    }
  } catch (err) {
    // Never let a notification failure break the caller's real work
    // (slip handling, scheduler run, etc.) — just log it.
    console.error('[adminNotify] failed to send', category, err.message);
  }
}

module.exports = { notifyAdmin };
