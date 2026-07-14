// One-off: re-links the already-connected owner to whichever new owner
// Rich Menu variant (ON/OFF) matches their current lineAiModeEnabled
// state, WITHOUT requiring them to re-type their adminEditPin. Used right
// after setup-owner-richmenu.js regenerates the menu images (e.g. an
// updated button label) — otherwise an already-linked owner keeps seeing
// the OLD menu until they happen to re-link some other way. Not meant to
// be a permanent script — same one-shot utility pattern as the other
// migrate-*/setup-* scripts in this folder.
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
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Settings!A2:B1000' });
  const map = {};
  (res.data.values || []).forEach(([k, v]) => { map[k] = v; });

  const creds = (map.lineChannelAccessToken || map.lineChannelSecret)
    ? { accessToken: map.lineChannelAccessToken || '', channelSecret: map.lineChannelSecret || '' }
    : null;
  if (!isConfigured(creds)) { console.error('No LINE credentials found.'); process.exit(1); }

  if (!map.adminLineUserId) { console.log('No adminLineUserId on file — owner not linked yet, nothing to do.'); return; }
  const aiOn = map.lineAiModeEnabled === 'TRUE';
  const richMenuId = aiOn ? map.ownerRichMenuIdOn : map.ownerRichMenuIdOff;
  if (!richMenuId) { console.error(`Missing ${aiOn ? 'ownerRichMenuIdOn' : 'ownerRichMenuIdOff'} in Settings.`); process.exit(1); }

  await linkRichMenuToUser(map.adminLineUserId, richMenuId, creds);
  console.log(`Re-linked owner to ${aiOn ? 'ON' : 'OFF'} variant (${richMenuId}).`);
}

main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
