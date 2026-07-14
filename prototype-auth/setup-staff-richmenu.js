// One-time setup: creates the "ผู้ดูแล" (Admins tab — accounting-clerk
// login role, session role 'staff', NOT the separate Staff/สัญญาพนักงาน
// employment-contract tab) LINE Rich Menu — 6 buttons matching
// images/staff-richmenu.png (สรุปรายรับ-รายจ่าย/บิลค้างชำระ/สลิปรอตรวจสอบ/
// สรุปห้องว่าง-มีคนอยู่/งานซ่อมที่ยังไม่เสร็จ/เข้าใช้งานหน้าเว็ปไซต์), uploads
// it to LINE, and saves the resulting richMenuId into this building's own
// Settings sheet as `staffRichMenuId` — server/routes/line.js's webhook
// reads that key and links this menu automatically right after a ผู้ดูแล's
// PIN self-link succeeds (see the matched-Admins-row branch there).
//
// Sibling script to setup-owner-richmenu.js / setup-tenant-richmenu.js —
// same structure. Unlike the owner menu, there is only ONE variant (no
// on/off toggle button on this menu), so no badge-compositing step.
//
// Usage: node prototype-auth/setup-staff-richmenu.js [customerSheetId]
const path = require('path');
const fs = require('fs');
const SERVER_MODULES = path.join(__dirname, '..', 'server', 'node_modules');
require(path.join(SERVER_MODULES, 'dotenv')).config({ path: path.join(__dirname, '..', 'server', '.env') });
const sharp = require(path.join(SERVER_MODULES, 'sharp'));
const { google } = require(path.join(SERVER_MODULES, 'googleapis'));
const {
  isConfigured, createRichMenu, uploadRichMenuImage, deleteRichMenu,
} = require(path.join(__dirname, '..', 'server', 'line'));

const WIDTH = 2500;
const HEIGHT = 1686;
const COLS = 3;
const ROWS = 2;
const CELL_W = WIDTH / COLS;
const CELL_H = HEIGHT / ROWS;

// [label, postback action data] — order matches images/staff-richmenu.png
// left-to-right, top-to-bottom. "staff:" prefix on every data value is
// what server/routes/line.js's postback dispatcher uses to route to
// handleStaffRichMenuPostback (auth checked against the Admins tab's own
// lineUserId, set by the PIN self-link, not Settings.adminLineUserId).
const BUTTONS = [
  ['สรุปรายรับ-รายจ่ายเดือนนี้', 'staff:summary'],
  ['บิลค้างชำระ/เกินกำหนด', 'staff:overdue'],
  ['สลิปรอตรวจสอบ', 'staff:slips'],
  ['สรุปห้องว่าง/มีคนอยู่', 'staff:rooms'],
  ['งานซ่อมที่ยังไม่เสร็จ', 'staff:maintenance'],
  ['เข้าใช้งานหน้าเว็ปไซต์', 'staff:dashboard'],
];

async function upsertSettingKV(sheets, spreadsheetId, key, value) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Settings!A2:B1000' });
  const rows = res.data.values || [];
  const idx = rows.findIndex((r) => r[0] === key);
  if (idx === -1) {
    await sheets.spreadsheets.values.append({
      spreadsheetId, range: 'Settings!A:B', valueInputOption: 'RAW',
      requestBody: { values: [[key, value]] },
    });
  } else {
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: `Settings!B${idx + 2}`, valueInputOption: 'RAW',
      requestBody: { values: [[value]] },
    });
  }
}

async function readSettingKV(sheets, spreadsheetId, key) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Settings!A2:B1000' });
  const row = (res.data.values || []).find((r) => r[0] === key);
  return row ? row[1] : null;
}

async function readLineCredsFromSheet(sheets, spreadsheetId) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Settings!A2:B1000' });
  const map = {};
  (res.data.values || []).forEach(([k, v]) => { map[k] = v; });
  if (map.lineChannelAccessToken || map.lineChannelSecret) {
    return { accessToken: map.lineChannelAccessToken || '', channelSecret: map.lineChannelSecret || '' };
  }
  return null;
}

async function main() {
  const spreadsheetId = process.argv[2] || process.env.GOOGLE_SHEET_ID;
  console.log('Target spreadsheet (Settings tab):', spreadsheetId);

  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  const sheets = google.sheets({ version: 'v4', auth });

  const creds = await readLineCredsFromSheet(sheets, spreadsheetId);
  if (!isConfigured(creds)) {
    console.error('No LINE credentials found — set LINE_CHANNEL_ACCESS_TOKEN/LINE_CHANNEL_SECRET in server/.env, or lineChannelAccessToken/lineChannelSecret in this building\'s own Settings sheet.');
    process.exit(1);
  }

  const existingId = await readSettingKV(sheets, spreadsheetId, 'staffRichMenuId');
  if (existingId) {
    console.log('Found existing staffRichMenuId', existingId, '— deleting before creating a fresh one...');
    try { await deleteRichMenu(existingId, creds); } catch (err) { console.warn('  (delete failed, continuing anyway:', err.message, ')'); }
  }

  const IMAGES_DIR = path.join(__dirname, '..', 'images');
  const sourceCandidates = ['staff-richmenu.png', 'staff-richmenu.jpg', 'staff-richmenu.jpeg'].map((f) => path.join(IMAGES_DIR, f));
  const sourcePath = sourceCandidates.find((p) => fs.existsSync(p));
  if (!sourcePath) {
    console.error('No images/staff-richmenu.png/.jpg/.jpeg found — save the design image there first.');
    process.exit(1);
  }
  console.log('Found source image:', sourcePath, '— resizing to', WIDTH + 'x' + HEIGHT, '(exact fit, no crop)...');
  const resizedBuffer = await sharp(sourcePath).resize(WIDTH, HEIGHT, { fit: 'fill' }).png().toBuffer();

  let jpegBuffer;
  let quality = 85;
  do {
    jpegBuffer = await sharp(resizedBuffer).jpeg({ quality }).toBuffer();
    quality -= 15;
  } while (jpegBuffer.length > 1024 * 1024 && quality > 20);
  if (jpegBuffer.length > 1024 * 1024) throw new Error('Could not get staff-richmenu image under LINE\'s 1MB limit even at low JPEG quality.');
  console.log(`Uploading rich menu image (${(jpegBuffer.length / 1024 / 1024).toFixed(2)}MB)...`);

  const areas = BUTTONS.map(([label, data], i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    return {
      bounds: { x: col * CELL_W, y: row * CELL_H, width: CELL_W, height: CELL_H },
      action: { type: 'postback', data, displayText: label },
    };
  });

  const richMenuId = await createRichMenu({
    size: { width: WIDTH, height: HEIGHT },
    selected: false,
    name: 'เช่าสุข - เมนูผู้ดูแล',
    chatBarText: 'เมนู',
    areas,
  }, creds);
  console.log('Created richMenuId:', richMenuId);
  await uploadRichMenuImage(richMenuId, jpegBuffer, 'image/jpeg', creds);
  await upsertSettingKV(sheets, spreadsheetId, 'staffRichMenuId', richMenuId);

  console.log('\nDone! A ผู้ดูแล (Admins tab entry) will get this menu automatically the next time they self-link by typing their own PIN into the LINE OA chat (see the Admins-PIN branch in server/routes/line.js\'s webhook text-message handler).');
  console.log('Note: if a ผู้ดูแล already linked their LINE before this script ran, they will NOT retroactively get the new menu — they can re-trigger it by typing their PIN again (self-link is idempotent).');
}

main().catch((err) => { console.error('Setup failed:', err.message); process.exit(1); });
