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

// Per explicit user request: the "เปิดโหมด Claude AI" button (cell index
// 5 — bottom-right) needs to visibly show its current on/off STATE, not
// just be a static button. Rich Menu images are static, so LINE's
// standard pattern for this is: keep two separate rich menus (one per
// state) and RELINK the user to whichever one matches reality every time
// they tap the toggle (see handleOwnerRichMenuPostback's 'owner:ai' case
// in server/routes/line.js) — LINE reloads the visible menu the next time
// the user opens the menu tray.
// Owner explicitly chose the cheaper option over generating 2 full
// AI images: keep their real base photo as-is for the other 5 cells, and
// overlay just a small status badge onto cell 6's own region
// programmatically. This function draws ONLY that badge (transparent
// everywhere else) at cell 6's exact pixel bounds, to be composited on
// top of the resized base image via sharp.
function buildStatusBadgeOverlay(isOn) {
  const AI_CELL_INDEX = 5; // bottom-right — must match BUTTONS' 'owner:ai' entry position
  const col = AI_CELL_INDEX % COLS;
  const row = Math.floor(AI_CELL_INDEX / COLS);
  const cellX = col * CELL_W;
  const cellY = row * CELL_H;
  const badgeW = CELL_W * 0.72;
  const badgeH = 110;
  const badgeX = cellX + (CELL_W - badgeW) / 2;
  const badgeY = cellY + 40; // small margin from the cell's own top edge
  const bg = isOn ? '#3B7A52' : '#9C8B78'; // green when on, muted grey when off — same green already used elsewhere in the app for "connected/active" states
  const label = isOn ? '🟢 เปิดอยู่' : '⚪ ปิดอยู่';
  const svg = `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <rect x="${badgeX}" y="${badgeY}" width="${badgeW}" height="${badgeH}" rx="${badgeH / 2}" fill="${bg}" stroke="#FFFFFF" stroke-width="5"/>
    <text x="${badgeX + badgeW / 2}" y="${badgeY + badgeH / 2}" font-size="44" font-family="sans-serif" font-weight="700" fill="#FFFFFF" text-anchor="middle" dominant-baseline="central">${label}</text>
  </svg>`;
  return Buffer.from(svg);
}

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

  // Per explicit user request: the "เปิดโหมด Claude AI" button needs to
  // show its current on/off state — creates TWO rich menus now (ON/OFF
  // variants, badge overlaid on cell 6 only, see buildStatusBadgeOverlay
  // above), replacing the single ownerRichMenuId this script used to
  // create. Deletes BOTH old keys if present (the old single-menu
  // ownerRichMenuId from before this feature, AND any previous on/off
  // pair from a prior run) so re-running never piles up orphaned menus.
  for (const key of ['ownerRichMenuId', 'ownerRichMenuIdOn', 'ownerRichMenuIdOff']) {
    const existingId = await readSettingKV(sheets, spreadsheetId, key);
    if (existingId) {
      console.log(`Found existing ${key}`, existingId, '— deleting before creating fresh ones...');
      try { await deleteRichMenu(existingId, creds); } catch (err) { console.warn('  (delete failed, continuing anyway:', err.message, ')'); }
    }
  }

  const fs = require('fs');
  const IMAGES_DIR = path.join(__dirname, '..', 'images');
  const sourceCandidates = ['owner-richmenu.png', 'owner-richmenu.jpg', 'owner-richmenu.jpeg'].map((f) => path.join(IMAGES_DIR, f));
  const sourcePath = sourceCandidates.find((p) => fs.existsSync(p));

  // Base image (before the on/off badge is composited on) — either the
  // owner's real photo, resized, or the generated SVG placeholder. Kept
  // as a raw PNG buffer at this stage (not yet JPEG-compressed) so sharp
  // can composite the badge onto it cleanly before the final JPEG
  // encode+size-check happens per variant below.
  let baseBuffer;
  if (sourcePath) {
    console.log('Found real source image:', sourcePath, '— resizing to', WIDTH + 'x' + HEIGHT, '(exact fit, no crop)...');
    baseBuffer = await sharp(sourcePath).resize(WIDTH, HEIGHT, { fit: 'fill' }).png().toBuffer();
  } else {
    console.log('No images/owner-richmenu.png/.jpg found — generating a placeholder image instead...');
    baseBuffer = await sharp(Buffer.from(buildSvg())).png().toBuffer();
  }

  // Both variants share the exact same 6 tap zones/postback actions (the
  // "owner:ai" tap always means "toggle", regardless of which state is
  // currently showing) — only the composited badge on cell 6 differs.
  const areas = BUTTONS.map(([, label, data], i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    return {
      bounds: { x: col * CELL_W, y: row * CELL_H, width: CELL_W, height: CELL_H },
      action: { type: 'postback', data, displayText: label },
    };
  });

  async function createVariant(isOn, settingsKey) {
    const composited = await sharp(baseBuffer).composite([{ input: buildStatusBadgeOverlay(isOn) }]).png().toBuffer();
    let jpegBuffer;
    let quality = 85;
    do {
      jpegBuffer = await sharp(composited).jpeg({ quality }).toBuffer();
      quality -= 15;
    } while (jpegBuffer.length > 1024 * 1024 && quality > 20);
    if (jpegBuffer.length > 1024 * 1024) throw new Error(`${settingsKey}: could not get under LINE's 1MB limit even at low JPEG quality.`);
    console.log(`Creating ${isOn ? 'ON' : 'OFF'} variant rich menu on LINE (${(jpegBuffer.length / 1024 / 1024).toFixed(2)}MB)...`);
    const richMenuId = await createRichMenu({
      size: { width: WIDTH, height: HEIGHT },
      selected: false,
      name: `เช่าสุข - เมนูเจ้าของ (AI ${isOn ? 'เปิด' : 'ปิด'})`,
      chatBarText: 'เมนู',
      areas,
    }, creds);
    console.log(`  Created richMenuId: ${richMenuId}`);
    await uploadRichMenuImage(richMenuId, jpegBuffer, 'image/jpeg', creds);
    await upsertSettingKV(sheets, spreadsheetId, settingsKey, richMenuId);
    return richMenuId;
  }

  await createVariant(true, 'ownerRichMenuIdOn');
  await createVariant(false, 'ownerRichMenuIdOff');

  console.log('\nDone! The owner will get the OFF-state menu automatically the next time they self-link (type their adminEditPin to the LINE OA) — lineAiModeEnabled defaults to off. Tapping the AI button then toggles between the two menus from there (see handleOwnerRichMenuPostback in server/routes/line.js).');
  console.log('Note: if the owner already linked their LINE before this script ran, they will NOT retroactively get the new menu pair — they can re-trigger it by typing their adminEditPin again (self-link is idempotent, re-typing it just re-runs the same linking step).');
}

main().catch((err) => { console.error('Setup failed:', err.message); process.exit(1); });
