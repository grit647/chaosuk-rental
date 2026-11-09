// ONE-OFF READ-ONLY DIAGNOSTIC — check whether the waterSetNewValue column
// (added earlier today via migrate-add-water-setnew-column.js) actually
// exists on ALL 3 real buildings' own separate Rooms tabs, per the
// "Permanent gotcha" in CLAUDE.md (every building has its own physically
// separate spreadsheet — a migration only touches whichever ONE was open).
const path = require('path');
require(path.join(__dirname, '..', 'server', 'node_modules', 'dotenv')).config({
  path: path.join(__dirname, '..', 'server', '.env'),
});
const { google } = require(path.join(__dirname, '..', 'server', 'node_modules', 'googleapis'));

async function client() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets.readonly']
  );
  return google.sheets({ version: 'v4', auth });
}

async function main() {
  const buildings = {
    'ตึกหลัก (main account)': process.env.GOOGLE_SHEET_ID,
    'บ้านพักครูโจ': '1_018tkPfe3OLIyeA_lyek8o0H8esbi15-hBiuAqWzvA',
    'บ้านเลขที่1873': '1moUMiEhF2Ie76_Ep8_rgtefWenlQXx7vEUyaO0exk4E',
  };
  const sheets = await client();
  for (const [name, id] of Object.entries(buildings)) {
    try {
      const res = await sheets.spreadsheets.values.get({ spreadsheetId: id, range: 'Rooms!A1:ZZ1' });
      const header = (res.data.values || [[]])[0] || [];
      console.log(name, '(', id, '):', header.includes('waterSetNewValue') ? 'HAS waterSetNewValue column' : 'MISSING waterSetNewValue column');
    } catch (err) {
      console.log(name, '(', id, '): ERROR —', err.message);
    }
  }
}
main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
