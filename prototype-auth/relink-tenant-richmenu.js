// One-off: re-links every ALREADY-linked tenant (any Rooms row with a
// lineUserId already on file) to the current tenant Rich Menu
// (tenantRichMenuId), WITHOUT requiring them to unfollow/re-follow the
// LINE OA or re-type their phone number. Used right after setup-tenant-
// richmenu.js regenerates the menu image (e.g. a button label/design
// change) — otherwise an already-linked tenant keeps seeing the OLD
// menu until they happen to re-link some other way. Same one-shot
// utility pattern as relink-owner-richmenu.js.
//
// Usage: node prototype-auth/relink-tenant-richmenu.js [customerSheetId]
const path = require('path');
const SERVER_MODULES = path.join(__dirname, '..', 'server', 'node_modules');
require(path.join(SERVER_MODULES, 'dotenv')).config({ path: path.join(__dirname, '..', 'server', '.env') });
const { google } = require(path.join(SERVER_MODULES, 'googleapis'));
const { isConfigured, linkRichMenuToUser } = require(path.join(__dirname, '..', 'server', 'line'));

async function main() {
  const spreadsheetId = process.argv[2] || process.env.GOOGLE_SHEET_ID;
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  const sheets = google.sheets({ version: 'v4', auth });

  const settingsRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Settings!A2:B1000' });
  const map = {};
  (settingsRes.data.values || []).forEach(([k, v]) => { map[k] = v; });

  const creds = (map.lineChannelAccessToken || map.lineChannelSecret)
    ? { accessToken: map.lineChannelAccessToken || '', channelSecret: map.lineChannelSecret || '' }
    : null;
  if (!isConfigured(creds)) { console.error('No LINE credentials found.'); process.exit(1); }

  const richMenuId = map.tenantRichMenuId;
  if (!richMenuId) { console.error('Missing tenantRichMenuId in Settings — run setup-tenant-richmenu.js first.'); process.exit(1); }

  const roomsRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Rooms!A1:BZ1000' });
  const [header, ...rows] = roomsRes.data.values || [];
  const idCol = header.indexOf('id');
  const lineUserIdCol = header.indexOf('lineUserId');
  if (lineUserIdCol === -1) { console.log('Rooms tab has no lineUserId column — nothing to do.'); return; }

  const linkedRooms = rows.filter((r) => r[lineUserIdCol]);
  console.log(`Found ${linkedRooms.length} already-linked room(s). Re-linking each to ${richMenuId}...`);

  let ok = 0, fail = 0;
  for (const r of linkedRooms) {
    const roomId = r[idCol];
    const lineUserId = r[lineUserIdCol];
    try {
      await linkRichMenuToUser(lineUserId, richMenuId, creds);
      ok++;
    } catch (err) {
      fail++;
      console.warn(`  room ${roomId}: failed —`, err.message);
    }
  }
  console.log(`Done. ${ok} re-linked, ${fail} failed.`);
}

main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
