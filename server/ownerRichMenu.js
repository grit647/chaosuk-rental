// Per explicit user request: the owner's LINE Rich Menu ("บิลค้างชำระ" and
// "สลิปรอตรวจสอบ" buttons) should show a small notification-style badge
// number in the top-right corner reflecting how many are outstanding right
// now — same idea as an app icon's unread-count badge. Rich Menu images
// are static (same limitation already documented for the AI on/off
// toggle), so this works the same way: regenerate BOTH the ON and OFF
// image variants with the current numbers baked in, create fresh rich
// menus, delete the old ones, and re-link the owner to whichever variant
// matches their current lineAiModeEnabled state. Called periodically from
// server/routes/scheduler.js's GET /run (same hourly-ish external-ping
// cron already used for overdue-bill detection) — per explicit user
// choice, NOT live/instant on every new slip, to keep this simple. Only
// actually regenerates when the numbers changed since the last check
// (tracked via lastOverdueBadgeCount/lastSlipBadgeCount in Settings), so
// a no-change run costs nothing beyond two cheap COUNT reads.
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { readTab, updateRow, appendRow } = require('./sheets');
const { coerceInvoices } = require('./coerce');
const { createRichMenu, uploadRichMenuImage, deleteRichMenu, linkRichMenuToUser } = require('./line');

const WIDTH = 2500;
const HEIGHT = 1686;
const COLS = 3;
const ROWS = 2;
const CELL_W = WIDTH / COLS;
const CELL_H = HEIGHT / ROWS;

// Same postback action data as prototype-auth/setup-owner-richmenu.js —
// MUST stay in sync with server/routes/line.js's handleOwnerRichMenuPostback
// switch. Index 1 (บิลค้างชำระ) and index 2 (สลิปรอตรวจสอบ) get count
// badges; index 5 (เปิดโหมด Claude AI) keeps its existing on/off badge.
const BUTTONS = [
  ['สรุปรายรับ-รายจ่ายเดือนนี้', 'owner:summary'],
  ['บิลค้างชำระ/เกินกำหนด', 'owner:overdue'],
  ['สลิปรอตรวจสอบ', 'owner:slips'],
  ['สรุปห้องว่าง/มีคนอยู่', 'owner:rooms'],
  ['เข้าใช้งานหน้าเว็ปไซต์', 'owner:dashboard'],
  ['เปิดโหมด Claude AI', 'owner:ai'],
];
const OVERDUE_CELL_INDEX = 1;
const SLIPS_CELL_INDEX = 2;
const AI_CELL_INDEX = 5;

function cellBounds(i) {
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  return { x: col * CELL_W, y: row * CELL_H, width: CELL_W, height: CELL_H };
}

// Small red circular badge, top-right corner of the given cell — standard
// "unread count" look. Renders "99+" instead of an ever-widening number
// for anything past 99, so the circle never has to grow. Returns '' (no
// badge at all) when count is 0 — a zero-count badge would just be visual
// noise contradicting the actual "nothing to do" state.
function countBadgeSvg(cellIndex, count) {
  if (!count) return '';
  const { x, y, width } = cellBounds(cellIndex);
  const label = count > 99 ? '99+' : String(count);
  const r = label.length > 2 ? 55 : 42;
  const cx = x + width - 50;
  const cy = y + 50;
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#B24336" stroke="#FFFFFF" stroke-width="6"/>
    <text x="${cx}" y="${cy}" font-size="46" font-family="sans-serif" font-weight="700" fill="#FFFFFF" text-anchor="middle" dominant-baseline="central">${label}</text>`;
}

function statusBadgeSvg(isOn) {
  const { x, y, width } = cellBounds(AI_CELL_INDEX);
  const badgeW = width * 0.72;
  const badgeH = 110;
  const badgeX = x + (width - badgeW) / 2;
  const badgeY = y + 40;
  const bg = isOn ? '#3B7A52' : '#9C8B78';
  const label = isOn ? '🟢 เปิดอยู่' : '⚪ ปิดอยู่';
  return `<rect x="${badgeX}" y="${badgeY}" width="${badgeW}" height="${badgeH}" rx="${badgeH / 2}" fill="${bg}" stroke="#FFFFFF" stroke-width="5"/>
    <text x="${badgeX + badgeW / 2}" y="${badgeY + badgeH / 2}" font-size="44" font-family="sans-serif" font-weight="700" fill="#FFFFFF" text-anchor="middle" dominant-baseline="central">${label}</text>`;
}

function buildOverlaySvg({ isOn, overdueCount, slipsCount }) {
  const svg = `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    ${statusBadgeSvg(isOn)}
    ${countBadgeSvg(OVERDUE_CELL_INDEX, overdueCount)}
    ${countBadgeSvg(SLIPS_CELL_INDEX, slipsCount)}
  </svg>`;
  return Buffer.from(svg);
}

async function computeBadgeCounts() {
  const invoices = coerceInvoices(await readTab('Invoices'));
  const overdueCount = invoices.filter((i) => i.status === 'overdue' || i.status === 'pending' || i.status === 'partial').length;
  const slipsCount = invoices.filter((i) => i.slipPending).length;
  return { overdueCount, slipsCount };
}

async function upsertKV(key, value) {
  const rows = await readTab('Settings');
  if (rows.some((r) => r.key === key)) {
    await updateRow('Settings', key, { value: String(value) }, 'key');
  } else {
    await appendRow('Settings', { key, value: String(value) });
  }
}

// Builds and uploads ONE variant (isOn true/false), returns its richMenuId.
async function createVariant(baseBuffer, { isOn, overdueCount, slipsCount }, lineCreds) {
  const overlay = buildOverlaySvg({ isOn, overdueCount, slipsCount });
  const composited = await sharp(baseBuffer).composite([{ input: overlay }]).png().toBuffer();
  let jpegBuffer;
  let quality = 85;
  do {
    jpegBuffer = await sharp(composited).jpeg({ quality }).toBuffer();
    quality -= 15;
  } while (jpegBuffer.length > 1024 * 1024 && quality > 20);
  const areas = BUTTONS.map(([label, data], i) => ({ bounds: cellBounds(i), action: { type: 'postback', data, displayText: label } }));
  const richMenuId = await createRichMenu({
    size: { width: WIDTH, height: HEIGHT },
    selected: false,
    name: `เช่าสุข - เมนูเจ้าของ (AI ${isOn ? 'เปิด' : 'ปิด'}, ค้าง ${overdueCount}/สลิป ${slipsCount})`,
    chatBarText: 'เมนู',
    areas,
  }, lineCreds);
  await uploadRichMenuImage(richMenuId, jpegBuffer, 'image/jpeg', lineCreds);
  return richMenuId;
}

// The actual periodic entry point — called from server/routes/scheduler.js.
// Non-fatal by design (caller wraps in try/catch too): a failed badge
// refresh should never break the rest of the scheduler run, and there's
// always a next hourly chance to retry.
async function syncOwnerRichMenuBadges(lineCreds) {
  const settingsRows = await readTab('Settings');
  const get = (key) => { const r = settingsRows.find((row) => row.key === key); return r ? r.value : ''; };

  const adminLineUserId = get('adminLineUserId');
  const onId = get('ownerRichMenuIdOn');
  const offId = get('ownerRichMenuIdOff');
  if (!adminLineUserId || !onId || !offId) return { skipped: 'owner rich menu not set up yet' };

  const { overdueCount, slipsCount } = await computeBadgeCounts();
  const lastOverdue = Number(get('lastOverdueBadgeCount') || 0);
  const lastSlips = Number(get('lastSlipBadgeCount') || 0);
  if (overdueCount === lastOverdue && slipsCount === lastSlips) {
    return { skipped: 'counts unchanged', overdueCount, slipsCount };
  }

  const imagePath = path.join(__dirname, '..', 'images', 'owner-richmenu.png');
  if (!fs.existsSync(imagePath)) return { skipped: 'images/owner-richmenu.png not found' };
  const baseBuffer = await sharp(imagePath).resize(WIDTH, HEIGHT, { fit: 'fill' }).png().toBuffer();

  const newOnId = await createVariant(baseBuffer, { isOn: true, overdueCount, slipsCount }, lineCreds);
  const newOffId = await createVariant(baseBuffer, { isOn: false, overdueCount, slipsCount }, lineCreds);

  // Delete the old pair AFTER the new ones are confirmed created — never
  // leaves the account with zero usable owner rich menus if the create/
  // upload step above throws partway through.
  try { await deleteRichMenu(onId, lineCreds); } catch (err) { console.error('[ownerRichMenu] delete old ON failed', err.message); }
  try { await deleteRichMenu(offId, lineCreds); } catch (err) { console.error('[ownerRichMenu] delete old OFF failed', err.message); }

  await upsertKV('ownerRichMenuIdOn', newOnId);
  await upsertKV('ownerRichMenuIdOff', newOffId);
  await upsertKV('lastOverdueBadgeCount', overdueCount);
  await upsertKV('lastSlipBadgeCount', slipsCount);

  const aiOn = get('lineAiModeEnabled') === 'TRUE';
  await linkRichMenuToUser(adminLineUserId, aiOn ? newOnId : newOffId, lineCreds);

  return { updated: true, overdueCount, slipsCount };
}

module.exports = { syncOwnerRichMenuBadges, computeBadgeCounts };
