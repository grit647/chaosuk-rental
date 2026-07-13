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
require('dotenv').config({ path: require('path').join(__dirname, '..', 'server', '.env') });
const path = require('path');
const sharp = require(path.join(__dirname, '..', 'server', 'node_modules', 'sharp'));
const { google } = require('googleapis');
const {
  isConfigured, createRichMenu, uploadRichMenuImage, deleteRichMenu,
} = require(path.join(__dirname, '..', 'server', 'line'));

const WIDTH = 2500;
const HEIGHT = 1686;
const COLS = 3;
const ROWS = 2;
const CELL_W = WIDTH / COLS;
const CELL_H = HEIGHT / ROWS;

// [emoji, label, postback action data] — order fills left-to-right, top-to-bottom.
const BUTTONS = [
  ['💰', 'ดูบิล/ยอดค้างชำระ', 'action=bill'],
  ['📄', 'ดูสัญญาเช่า', 'action=contract'],
  ['🔧', 'แจ้งซ่อม', 'action=maintenance'],
  ['📞', 'ติดต่อผู้ดูแล', 'action=contact'],
  ['🔑', 'ขอรหัส Wifi', 'action=wifi'],
  ['⚡', 'การใช้น้ำ/ไฟปัจจุบัน', 'action=usage'],
];

// Simple, legible 3x2 grid with alternating background shades so the tap
// zones are visually distinct even without icons rendering (LINE's image
// renderer doesn't reliably support emoji in SVG <text> on every
// platform, so the emoji is decorative/best-effort, the Thai label is
// what actually needs to always be readable).
function buildSvg() {
  const cells = BUTTONS.map(([emoji, label], i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const x = col * CELL_W;
    const y = row * CELL_H;
    const bg = (row + col) % 2 === 0 ? '#C1622D' : '#B85B27';
    const cx = x + CELL_W / 2;
    const cy = y + CELL_H / 2;
    return `
      <rect x="${x}" y="${y}" width="${CELL_W}" height="${CELL_H}" fill="${bg}" stroke="#F7F1E6" stroke-width="4"/>
      <text x="${cx}" y="${cy - 40}" font-size="120" text-anchor="middle" dominant-baseline="middle">${emoji}</text>
      <text x="${cx}" y="${cy + 90}" font-size="52" font-family="sans-serif" font-weight="700" fill="#FFFFFF" text-anchor="middle" dominant-baseline="middle">${label}</text>
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

  console.log('Generating rich menu image...');
  const svg = buildSvg();
  const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();

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
  await uploadRichMenuImage(richMenuId, pngBuffer, 'image/png', creds);

  console.log('Saving tenantRichMenuId to Settings sheet...');
  await upsertSettingKV(sheets, spreadsheetId, 'tenantRichMenuId', richMenuId);

  console.log('\nDone! Every tenant who self-links from now on (types their phone number to the LINE OA) will automatically get this menu.');
  console.log('Note: tenants who ALREADY linked before this script ran will NOT retroactively get the menu — they can re-trigger it by unfollowing/re-following the OA and re-linking, or a follow-up script could bulk-link everyone with an existing lineUserId if wanted.');
}

main().catch((err) => { console.error('Setup failed:', err.message); process.exit(1); });
