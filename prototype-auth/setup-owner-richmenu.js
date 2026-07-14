// One-time setup: creates the owner-facing LINE Rich Menu (6 buttons:
// สรุปรายรับ-รายจ่ายเดือนนี้/บิลค้างชำระ-เกินกำหนด/สลิปรอตรวจสอบ/สรุปห้องว่าง-
// มีคนอยู่/เข้าใช้งานหน้าเว็ปไซต์/เปิดโหมด Claude AI), generates its image,
// uploads it to LINE, and saves the resulting richMenuId into this
// building's own Settings sheet as `ownerRichMenuId` — server/routes/
// line.js's webhook reads that key and links this menu to the owner
// automatically right after their admin-PIN self-link succeeds.
//
// Sibling script to setup-tenant-richmenu.js/setup-staff-richmenu.js —
// same structure/reasoning throughout, just a different button set.
// SINGLE variant now (per explicit owner follow-up: the "เปิดโหมด Claude
// AI" button used to need TWO image variants — an ON/OFF status badge
// composited onto cell 6 — but that whole on/off-with-a-visual-badge
// design was replaced with a 5-minute auto-expiring chat session that has
// no persistent visual state at all, see AI_SESSION_TTL_MS in
// server/routes/line.js). Deleting that dual-variant complexity here
// brought this script back to the same simple shape as the tenant/staff
// ones.
//
// Deliberately does NOT call setDefaultRichMenu — same reasoning as the
// tenant script: an unidentified LINE follower shouldn't see either
// role-specific menu until they've proven who they are. Safe to re-run:
// deletes any previously-saved richMenuId(s) first — checks the CURRENT
// single-variant key (ownerRichMenuId) plus the two now-retired dual-
// variant keys (ownerRichMenuIdOn/Off) so a re-run after upgrading from
// the old dual-variant version cleans those up too, not just leaves them
// orphaned on the LINE account forever.
//
// Usage: node prototype-auth/setup-owner-richmenu.js [customerSheetId]
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

// [label, postback action data] — order matches images/owner-richmenu.png
// left-to-right, top-to-bottom. "owner:" prefix on every data value is
// what server/routes/line.js's postback dispatcher uses to tell owner
// taps apart from tenant/staff taps (see handleOwnerRichMenuPostback).
const BUTTONS = [
  ['สรุปรายรับ-รายจ่ายเดือนนี้', 'owner:summary'],
  ['บิลค้างชำระ/เกินกำหนด', 'owner:overdue'],
  ['สลิปรอตรวจสอบ', 'owner:slips'],
  ['สรุปห้องว่าง/มีคนอยู่', 'owner:rooms'],
  ['เข้าใช้งานหน้าเว็ปไซต์', 'owner:dashboard'],
  ['เปิดโหมด Claude AI', 'owner:ai'],
];

function cellBounds(i) {
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  return { x: col * CELL_W, y: row * CELL_H, width: CELL_W, height: CELL_H };
}

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

  for (const key of ['ownerRichMenuId', 'ownerRichMenuIdOn', 'ownerRichMenuIdOff']) {
    const existingId = await readSettingKV(sheets, spreadsheetId, key);
    if (existingId) {
      console.log(`Found existing ${key}`, existingId, '— deleting before creating a fresh one...');
      try { await deleteRichMenu(existingId, creds); } catch (err) { console.warn('  (delete failed, continuing anyway:', err.message, ')'); }
    }
  }

  const IMAGES_DIR = path.join(__dirname, '..', 'images');
  const sourceCandidates = ['owner-richmenu.png', 'owner-richmenu.jpg', 'owner-richmenu.jpeg'].map((f) => path.join(IMAGES_DIR, f));
  const sourcePath = sourceCandidates.find((p) => fs.existsSync(p));
  if (!sourcePath) {
    console.error('No images/owner-richmenu.png/.jpg/.jpeg found — save the design image there first.');
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
  if (jpegBuffer.length > 1024 * 1024) throw new Error('Could not get owner-richmenu image under LINE\'s 1MB limit even at low JPEG quality.');
  console.log(`Uploading rich menu image (${(jpegBuffer.length / 1024 / 1024).toFixed(2)}MB)...`);

  const areas = BUTTONS.map(([label, data], i) => ({ bounds: cellBounds(i), action: { type: 'postback', data, displayText: label } }));

  const richMenuId = await createRichMenu({
    size: { width: WIDTH, height: HEIGHT },
    selected: false,
    name: 'เช่าสุข - เมนูเจ้าของ',
    chatBarText: 'เมนู',
    areas,
  }, creds);
  console.log('Created richMenuId:', richMenuId);
  await uploadRichMenuImage(richMenuId, jpegBuffer, 'image/jpeg', creds);
  await upsertSettingKV(sheets, spreadsheetId, 'ownerRichMenuId', richMenuId);

  console.log('\nDone! The owner will get this menu automatically the next time they self-link (type their adminEditPin to the LINE OA).');
  console.log('Note: if the owner already linked their LINE before this script ran, they will NOT retroactively get the new menu — they can re-trigger it by typing their adminEditPin again (self-link is idempotent), or run prototype-auth/relink-owner-richmenu.js to re-link them directly without needing to re-type anything.');
}

main().catch((err) => { console.error('Setup failed:', err.message); process.exit(1); });
