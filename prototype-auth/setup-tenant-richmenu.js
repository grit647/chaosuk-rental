// One-time setup: creates the tenant-facing LINE Rich Menu (6 buttons:
// ดูบิล/ดูสัญญาเช่า/แจ้งซ่อม/ติดต่อผู้ดูแล/ขอรหัส wifi/การใช้น้ำ-ไฟปัจจุบัน),
// generates its image, uploads it to LINE, and saves the resulting
// richMenuId into this building's own Settings sheet as `tenantRichMenuId`
// — server/routes/line.js's webhook reads that key and links this menu to
// each tenant automatically right after their phone-number self-link
// succeeds (see the "linkRichMenuToUser" call there).
//
// Deliberately does NOT call setDefaultRichMenu — a tenant who hasn't
// self-linked yet shouldn't see this menu at all (they haven't proven
// which room is theirs), so linking stays purely per-user, triggered only
// by a successful link. Safe to re-run: creates a NEW rich menu each time
// (LINE doesn't support updating an existing one's image/areas in place),
// deletes the previously-saved one first if a tenantRichMenuId is already
// on file, so re-running doesn't pile up orphaned rich menus on the
// account.
//
// Usage: node prototype-auth/setup-tenant-richmenu.js [customerSheetId]
// (customerSheetId optional — defaults to GOOGLE_SHEET_ID, i.e. the main
// property; pass a different building's Sheet ID to set this up for them
// instead, using THEIR OWN saved LINE credentials from their Settings tab.)
const path = require('path');
const SERVER_MODULES = path.join(__dirname, '..', 'server', 'node_modules');
// Explicit node_modules paths (not a plain `require('dotenv')`/`require
// ('googleapis')`) — prototype-auth/ has no node_modules of its own,
// only server/ does, and Node's module resolution walks up from the
// REQUIRING FILE's own directory, not the process's cwd, so a plain
// bare require here would fail regardless of which directory this
// script is invoked from.
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

// Per explicit user follow-up (shown a nicer mockup with rounded icon
// cards): redesigned from flat emoji-on-solid-color blocks to white
// rounded cards + a real drawn icon (Material Design icon paths, 24x24
// viewBox each, scaled/translated into an orange circle badge) + a Thai
// label — matches the "เช่าสุข" brand look (cream background, #C1622D
// orange accent) used everywhere else in the app (login pages, sidebar).
// Emoji intentionally dropped entirely — LINE's image renderer doesn't
// reliably render emoji glyphs consistently across platforms, drawn SVG
// paths always render the same everywhere.
const ICONS = {
  // ฿ — money/receipt, drawn as text (baht sign) rather than a generic
  // receipt icon path, since it reads instantly as "this is about money".
  baht: null,
  // "description" (Material Icons) — a page with a folded corner + lines.
  document: 'M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z',
  // "build" (Material Icons) — wrench.
  wrench: 'M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z',
  // "call" (Material Icons) — phone handset.
  phone: 'M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z',
  // "wifi" (Material Icons) — concentric signal arcs.
  wifi: 'M1 9l2 2c4.97-4.97 13.03-4.97 18 0l2-2C16.93 2.93 7.08 2.93 1 9zm8 8l3 3 3-3a4.237 4.237 0 0 0-6 0zm-4-4l2 2c2.76-2.76 7.24-2.76 10 0l2-2C15.14 9.14 8.87 9.14 5 13z',
  // "bolt" (Material Icons) — lightning bolt, for the water/elec usage button.
  bolt: 'M7 2v11h3v9l7-12h-4l4-8z',
};

// [iconKey, label, postback action data] — order fills left-to-right, top-to-bottom.
const BUTTONS = [
  ['baht', 'ดูบิล/ยอดค้างชำระ', 'action=bill'],
  ['document', 'ดูสัญญาเช่า', 'action=contract'],
  ['wrench', 'แจ้งซ่อม', 'action=maintenance'],
  ['phone', 'ติดต่อผู้ดูแล', 'action=contact'],
  ['wifi', 'ขอรหัส Wifi', 'action=wifi'],
  ['bolt', 'การใช้น้ำ/ไฟปัจจุบัน', 'action=usage'],
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

    // Split long labels onto 2 lines at a natural word/slash break so
    // nothing gets clipped at this font size within a ~750px-wide card.
    const words = label.split(/(?<=\/)|(?<= )/); // keep the delimiter attached to the preceding chunk
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

// LINE credentials: this script deliberately reads the SAME per-customer-
// override-then-env-fallback shape server/line.js's resolveCreds expects,
// pulled straight from the Settings sheet the same way readIntegration
// Credentials() does server-side — kept as a tiny local reimplementation
// here rather than importing server/coerce.js, since that module also
// pulls in sheets.js's AsyncLocalStorage request-context machinery this
// standalone script doesn't have running.
async function readLineCredsFromSheet(sheets, spreadsheetId) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Settings!A2:B1000' });
  const map = {};
  (res.data.values || []).forEach(([k, v]) => { map[k] = v; });
  if (map.lineChannelAccessToken || map.lineChannelSecret) {
    return { accessToken: map.lineChannelAccessToken || '', channelSecret: map.lineChannelSecret || '' };
  }
  return null; // falls back to process.env inside server/line.js's resolveCreds
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

  const existingId = await readSettingKV(sheets, spreadsheetId, 'tenantRichMenuId');
  if (existingId) {
    console.log('Found existing tenantRichMenuId', existingId, '— deleting before creating a fresh one...');
    try { await deleteRichMenu(existingId, creds); } catch (err) { console.warn('  (delete failed, continuing anyway:', err.message, ')'); }
  }

  // Per explicit user follow-up: prefer a REAL source image (e.g.
  // AI-generated externally, matching this same 3x2 grid layout) over the
  // programmatically-drawn SVG one if it's present under images/ — resized
  // (not cropped) to LINE's exact required 2500x1686, since a slight
  // aspect-ratio stretch is imperceptible but a crop could cut off part of
  // a button. The tap-zone coordinates below stay a clean, even 3x2 grid
  // regardless of source — this only works because the requested image
  // layout was SPECIFICALLY asked for as "3 columns x 2 rows, equal
  // sections, no extra elements" (see the prompt given to the owner
  // earlier in this conversation) so the real image's buttons land in the
  // same places our grid math assumes. A visually different layout would
  // need custom-measured per-button coordinates instead of this even-grid
  // assumption.
  //
  // Per explicit user follow-up ("สร้างโฟลเดอร์ image แยกไว้ดีกว่าครับ"):
  // moved out of the repo root into a dedicated images/ folder — keeps
  // static design assets organized separately from server/uploads/
  // (dynamic, user-generated content: slip photos, invoice PDFs — a
  // completely different category that shouldn't live alongside these).
  const fs = require('fs');
  const IMAGES_DIR = path.join(__dirname, '..', 'images');
  const sourceCandidates = ['tenant-richmenu.png', 'tenant-richmenu.jpg', 'tenant-richmenu.jpeg'].map((f) => path.join(IMAGES_DIR, f));
  const sourcePath = sourceCandidates.find((p) => fs.existsSync(p));
  let pngBuffer;
  let contentType = 'image/png';
  if (sourcePath) {
    console.log('Found real source image:', sourcePath, '— resizing to', WIDTH + 'x' + HEIGHT, '(exact fit, no crop)...');
    // LINE caps rich menu images at 1MB — a full-res lossless PNG of a
    // real (non-flat-color) photo easily blows past that (hit a real 413
    // "Request Entity Too Large" here first). JPEG at quality 85 gets a
    // photo-content image comfortably under the cap while staying visually
    // indistinguishable at this display size; step quality down further
    // only if still too big.
    contentType = 'image/jpeg';
    let quality = 85;
    do {
      pngBuffer = await sharp(sourcePath).resize(WIDTH, HEIGHT, { fit: 'fill' }).jpeg({ quality }).toBuffer();
      console.log(`  quality=${quality} → ${(pngBuffer.length / 1024 / 1024).toFixed(2)}MB`);
      quality -= 15;
    } while (pngBuffer.length > 1024 * 1024 && quality > 20);
    if (pngBuffer.length > 1024 * 1024) throw new Error('Could not get the source image under LINE\'s 1MB limit even at low JPEG quality — try a smaller/simpler source image.');
  } else {
    console.log('No images/tenant-richmenu.png/.jpg found — generating a placeholder image instead...');
    const svg = buildSvg();
    pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
  }

  console.log('Creating rich menu on LINE...');
  const richMenuId = await createRichMenu({
    size: { width: WIDTH, height: HEIGHT },
    selected: false,
    name: 'เช่าสุข - เมนูผู้เช่า',
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

  console.log('Saving tenantRichMenuId to Settings sheet...');
  await upsertSettingKV(sheets, spreadsheetId, 'tenantRichMenuId', richMenuId);

  console.log('\nDone! Every tenant who self-links from now on (types their phone number to the LINE OA) will automatically get this menu.');
  console.log('Note: tenants who ALREADY linked before this script ran will NOT retroactively get the menu — they can re-trigger it by unfollowing/re-following the OA and re-linking, or a follow-up script could bulk-link everyone with an existing lineUserId if wanted.');
}

main().catch((err) => { console.error('Setup failed:', err.message); process.exit(1); });
