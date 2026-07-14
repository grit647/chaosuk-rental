// One-time setup: creates the owner-facing LINE Rich Menu (6 buttons:
// สรุปรายรับ-รายจ่ายเดือนนี้/บิลค้างชำระ-เกินกำหนด/สลิปรอตรวจสอบ/งานซ่อมที่ยังไม่
// เสร็จ/สรุปห้องว่าง-มีคนอยู่/เปิดโหมด Claude AI), generates its image,
// uploads it to LINE, and saves the resulting richMenuId into this
// building's own Settings sheet as `ownerRichMenuId` — server/routes/
// line.js's webhook reads that key and links this menu to the owner
// automatically right after their admin-PIN self-link succeeds (see the
// "linkRichMenuToUser" call there, right next to the tenant one).
//
// Sibling script to setup-tenant-richmenu.js — same structure/reasoning
// throughout, just a different button set and a different Settings key
// (ownerRichMenuId vs tenantRichMenuId) so the two menus never collide.
//
// Deliberately does NOT call setDefaultRichMenu — same reasoning as the
// tenant script: an unidentified LINE follower shouldn't see either
// role-specific menu until they've proven who they are. Safe to re-run:
// deletes the previously-saved ownerRichMenuId first if one's on file.
//
// Usage: node prototype-auth/setup-owner-richmenu.js [customerSheetId]
const path = require('path');
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

// Same Material Design icon path set as the tenant menu, plus 2 new ones
// (warning triangle for overdue bills, robot for the AI mode button).
const ICONS = {
  baht: null,
  // "warning" (Material Icons) — overdue/urgent.
  warning: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z',
  // "attach_file" (Material Icons) — pending slips.
  clip: 'M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z',
  // "build" (Material Icons) — wrench, reused from the tenant set.
  wrench: 'M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z',
  // "home" (Material Icons) — room status.
  home: 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',
  // "smart_toy" (Material Icons) — robot/AI.
  robot: 'M20 9V7c0-1.1-.9-2-2-2h-3c0-1.66-1.34-3-3-3S9 3.34 9 5H6c-1.1 0-2 .9-2 2v2c-1.66 0-3 1.34-3 3s1.34 3 3 3v4c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2v-4c1.66 0 3-1.34 3-3s-1.34-3-3-3zM7.5 11.5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5S9.83 13 9 13s-1.5-.67-1.5-1.5zm9 5c-1 1-2.87 1.5-4.5 1.5s-3.5-.5-4.5-1.5c-.28-.28-.28-.72 0-1 .28-.28.72-.28 1 0 .68.68 2.16 1 3.5 1s2.82-.32 3.5-1c.28-.28.72-.28 1 0 .28.28.28.72 0 1zm-.5-3.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z',
};

// [iconKey, label, postback action data] — order fills left-to-right,
// top-to-bottom. "owner:" prefix on every data value is what server/
// routes/line.js's postback dispatcher uses to tell owner taps apart
// from tenant taps (see handleOwnerRichMenuPostback there).
const BUTTONS = [
  ['baht', 'สรุปรายรับ-รายจ่ายเดือนนี้', 'owner:summary'],
  ['warning', 'บิลค้างชำระ/เกินกำหนด', 'owner:overdue'],
  ['clip', 'สลิปรอตรวจสอบ', 'owner:slips'],
  ['wrench', 'งานซ่อมที่ยังไม่เสร็จ', 'owner:maintenance'],
  ['home', 'สรุปห้องว่าง/มีคนอยู่', 'owner:rooms'],
  ['robot', 'เปิดโหมด Claude AI', 'owner:ai'],
];

function buildSvg() {
  const MARGIN = 28;
  const cells = BUTTONS.map(([iconKey, label], i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const cardX = col * CELL_W + MARGIN;
    const cardY = row * CELL_H + MARGIN;
    const cardW = CELL_W - MARGIN * 2;
    const cardH = CELL_H - MARGIN * 2;
    const centerX = cardX + cardW / 2;
    const badgeCy = cardY + cardH * 0.36;
    const badgeR = 110;

    const words = label.split(/(?<=\/)|(?<= )/);
    let line1 = '', line2 = '';
    for (const w of words) { if ((line1 + w).length <= 12 && !line2) line1 += w; else line2 += w; }
    const labelLines = line2 ? [line1.trim(), line2.trim()] : [line1.trim()];
    const labelY = cardY + cardH * 0.74;
    const labelSvg = labelLines.map((ln, li) => `<text x="${centerX}" y="${labelY + li * 62}" font-size="50" font-family="sans-serif" font-weight="700" fill="#241812" text-anchor="middle" dominant-baseline="middle">${ln}</text>`).join('');

    const iconSvg = iconKey === 'baht'
      ? `<text x="${centerX}" y="${badgeCy}" font-size="120" font-family="sans-serif" font-weight="700" fill="#FFFFFF" text-anchor="middle" dominant-baseline="central">฿</text>`
      : `<g transform="translate(${centerX - 60},${badgeCy - 60}) scale(5)"><path d="${ICONS[iconKey]}" fill="#FFFFFF"/></g>`;

    return `
      <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="36" fill="#FFFFFF" stroke="#EDE1CE" stroke-width="4"/>
      <circle cx="${centerX}" cy="${badgeCy}" r="${badgeR}" fill="#C1622D"/>
      ${iconSvg}
      ${labelSvg}
    `;
  }).join('');
  return `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${WIDTH}" height="${HEIGHT}" fill="#F7F1E6"/>
    ${cells}
  </svg>`;
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

  const existingId = await readSettingKV(sheets, spreadsheetId, 'ownerRichMenuId');
  if (existingId) {
    console.log('Found existing ownerRichMenuId', existingId, '— deleting before creating a fresh one...');
    try { await deleteRichMenu(existingId, creds); } catch (err) { console.warn('  (delete failed, continuing anyway:', err.message, ')'); }
  }

  const fs = require('fs');
  const IMAGES_DIR = path.join(__dirname, '..', 'images');
  const sourceCandidates = ['owner-richmenu.png', 'owner-richmenu.jpg', 'owner-richmenu.jpeg'].map((f) => path.join(IMAGES_DIR, f));
  const sourcePath = sourceCandidates.find((p) => fs.existsSync(p));
  let pngBuffer;
  let contentType = 'image/png';
  if (sourcePath) {
    console.log('Found real source image:', sourcePath, '— resizing to', WIDTH + 'x' + HEIGHT, '(exact fit, no crop)...');
    contentType = 'image/jpeg';
    let quality = 85;
    do {
      pngBuffer = await sharp(sourcePath).resize(WIDTH, HEIGHT, { fit: 'fill' }).jpeg({ quality }).toBuffer();
      console.log(`  quality=${quality} → ${(pngBuffer.length / 1024 / 1024).toFixed(2)}MB`);
      quality -= 15;
    } while (pngBuffer.length > 1024 * 1024 && quality > 20);
    if (pngBuffer.length > 1024 * 1024) throw new Error('Could not get the source image under LINE\'s 1MB limit even at low JPEG quality — try a smaller/simpler source image.');
  } else {
    console.log('No images/owner-richmenu.png/.jpg found — generating a placeholder image instead...');
    const svg = buildSvg();
    pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
  }

  console.log('Creating rich menu on LINE...');
  const richMenuId = await createRichMenu({
    size: { width: WIDTH, height: HEIGHT },
    selected: false,
    name: 'เช่าสุข - เมนูเจ้าของ',
    chatBarText: 'เมนู',
    areas: BUTTONS.map(([, label, data], i) => {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      return {
        bounds: { x: col * CELL_W, y: row * CELL_H, width: CELL_W, height: CELL_H },
        action: { type: 'postback', data, displayText: label },
      };
    }),
  }, creds);
  console.log('Created richMenuId:', richMenuId);

  console.log('Uploading image...');
  await uploadRichMenuImage(richMenuId, pngBuffer, contentType, creds);

  console.log('Saving ownerRichMenuId to Settings sheet...');
  await upsertSettingKV(sheets, spreadsheetId, 'ownerRichMenuId', richMenuId);

  console.log('\nDone! The owner will get this menu automatically the next time they self-link (type their adminEditPin to the LINE OA).');
  console.log('Note: if the owner already linked their LINE before this script ran, they will NOT retroactively get the menu — they can re-trigger it by typing their adminEditPin again (self-link is idempotent, re-typing it just re-runs the same linking step).');
}

main().catch((err) => { console.error('Setup failed:', err.message); process.exit(1); });
