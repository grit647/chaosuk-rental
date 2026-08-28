// ONE-OFF READ-ONLY: check each building's platformVersion in the Directory
// sheet's Users tab, to know which staged-rollout features are actually
// live for each building right now.
const path = require('path');
require(path.join(__dirname, '..', 'server', 'node_modules', 'dotenv')).config({
  path: path.join(__dirname, '..', 'server', '.env'),
});
const { google } = require(path.join(__dirname, '..', 'server', 'node_modules', 'googleapis'));

async function main() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets.readonly']
  );
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_DIRECTORY_SHEET_ID, range: 'Users!A1:ZZ1000' });
  const [header, ...rows] = res.data.values || [[]];
  const idx = (name) => header.indexOf(name);
  rows.forEach((r) => {
    console.log(r[idx('name')] || r[idx('customerSheetId')], '— platformVersion:', r[idx('platformVersion')], '— customerSheetId:', r[idx('customerSheetId')]);
  });
}
main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
