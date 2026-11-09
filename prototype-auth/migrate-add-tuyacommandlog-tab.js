// One-time migration: creates the TuyaCommandLog tab (if it doesn't exist
// yet) with headers id, timestamp, room, deviceId, command, value, source,
// success, errorMessage.
//
// เหตุผล (2026-09-18 ตามคำขอคุณต้น "แผนฟรี กับการสั่งตัดไฟ...อยากให้เพิ่ม
// ประวัติการสั่งตัดไฟไว้ด้วยครับ") — หลังย้าย Render ไปแผนฟรี คุณต้นถาม
// ว่าคำสั่งตัดไฟ (ผ่านเว็บหรือปุ่ม LINE) มีดีเลย์/error บ้างไหม แต่ไม่มี
// ที่เก็บประวัติไว้ดูย้อนหลังเลย — สร้างแท็บใหม่นี้บันทึกทุกครั้งที่สั่ง
// คำสั่ง switch (ตัดไฟ/จ่ายไฟ) ทั้งสำเร็จและล้มเหลว (ดู server/tuya.js's
// logTuyaCommand) — เหมือน migrate-add-linesendlog-tab.js ทุกประการ
// (สร้างแท็บใหม่ ไม่ใช่เพิ่มคอลัมน์ในแท็บเดิม) — รับ Sheet ID เป็น CLI arg
// ได้ เผื่อต้องรันซ้ำกับชีตของลูกค้ารายอื่น (ดู CLAUDE.md's "Permanent
// gotcha" — สถาปัตยกรรม multi-tenant ของโปรเจกต์นี้คือแยกชีตจริงต่อลูกค้า)
require('dotenv').config({ path: require('path').join(__dirname, '..', 'server', '.env') });
const { google } = require('googleapis');

const HEADERS = ['id', 'timestamp', 'room', 'deviceId', 'command', 'value', 'source', 'success', 'errorMessage'];
const TAB_NAME = 'TuyaCommandLog';

async function main() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.argv[2] || process.env.GOOGLE_SHEET_ID;
  console.log('Target spreadsheet:', spreadsheetId);

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets.find((s) => s.properties.title === TAB_NAME);
  if (existing) {
    console.log(`Tab "${TAB_NAME}" already exists — nothing to do.`);
    return;
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: TAB_NAME } } }] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${TAB_NAME}!A1:${String.fromCharCode(64 + HEADERS.length)}1`,
    valueInputOption: 'RAW',
    requestBody: { values: [HEADERS] },
  });
  console.log(`Created tab "${TAB_NAME}" with headers:`, HEADERS.join(', '));
}

main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
