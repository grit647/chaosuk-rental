// ONE-TIME SCRIPT — copies only the TAB NAMES + HEADER ROWS (row 1) from
// the real production chaosuk-rental Sheet into a brand-new, empty Sheet
// for a second real customer, per explicit user request ("ยังไม่มี ต้อง
// สร้างใหม่" when asked if customer #2's sheet already had matching
// columns). Deliberately lives in prototype-auth/, not server/ — this is
// a throwaway setup script, not something the live app ever runs.
//
// Safety: READS from the production Sheet (GOOGLE_SHEET_ID in
// server/.env) — never writes to it, never touches any data row (only
// row 1, the header). WRITES only to the brand-new target Sheet the
// owner just created and shared, which has no real data in it yet
// (confirmed: only the default empty "ชีต1" tab existed before this ran).
const path = require('path');
require(path.join(__dirname, '..', 'server', 'node_modules', 'dotenv')).config({
  path: path.join(__dirname, '..', 'server', '.env'),
});
const { google } = require(path.join(__dirname, '..', 'server', 'node_modules', 'googleapis'));

const SOURCE_SHEET_ID = process.env.GOOGLE_SHEET_ID; // real production data — READ ONLY below
const TARGET_SHEET_ID = '1_018tkPfe3OLIyeA_lyek8o0H8esbi15-hBiuAqWzvA'; // customer #2's new, empty sheet

async function client() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  return google.sheets({ version: 'v4', auth });
}

async function main() {
  const sheets = await client();

  console.log('อ่านโครงสร้างจากชีตจริง (อ่านอย่างเดียว)...');
  const srcMeta = await sheets.spreadsheets.get({ spreadsheetId: SOURCE_SHEET_ID });
  const tabNames = srcMeta.data.sheets.map((s) => s.properties.title);
  console.log('พบ', tabNames.length, 'แท็บ:', tabNames.join(', '));

  const headers = {};
  for (const name of tabNames) {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SOURCE_SHEET_ID,
      range: `${name}!A1:ZZ1`,
    });
    headers[name] = (res.data.values && res.data.values[0]) || [];
    console.log(`  ${name}: ${headers[name].length} คอลัมน์`);
  }

  console.log('\nสร้างแท็บใหม่ในชีตของลูกค้ารายที่ 2...');
  const addSheetsRequests = tabNames.map((name) => ({ addSheet: { properties: { title: name } } }));
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: TARGET_SHEET_ID,
    requestBody: { requests: addSheetsRequests },
  });
  console.log('สร้างแท็บเปล่าสำเร็จ — กำลังใส่หัวคอลัมน์...');

  for (const name of tabNames) {
    if (!headers[name].length) continue;
    await sheets.spreadsheets.values.update({
      spreadsheetId: TARGET_SHEET_ID,
      range: `${name}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers[name]] },
    });
    console.log(`  ใส่หัวคอลัมน์ ${name} แล้ว`);
  }

  console.log('\nลบแท็บเริ่มต้น "ชีต1" ที่ไม่ได้ใช้แล้ว...');
  const targetMeta = await sheets.spreadsheets.get({ spreadsheetId: TARGET_SHEET_ID });
  const defaultTab = targetMeta.data.sheets.find((s) => s.properties.title === 'ชีต1' || s.properties.title === 'Sheet1');
  if (defaultTab) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: TARGET_SHEET_ID,
      requestBody: { requests: [{ deleteSheet: { sheetId: defaultTab.properties.sheetId } }] },
    });
    console.log('ลบแท็บเริ่มต้นแล้ว');
  }

  console.log('\n✅ เสร็จสิ้น! ชีตของลูกค้ารายที่ 2 มีโครงสร้างตรงกับชีตจริงแล้วครับ (ยังไม่มีข้อมูลจริงใดๆ อยู่ในนั้น)');
}

main().catch((err) => {
  console.error('เกิดข้อผิดพลาด:', err.message);
  process.exit(1);
});
