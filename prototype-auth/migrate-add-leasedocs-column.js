// One-time migration: adds `leaseDocsJson` column to the Rooms tab.
//
// เหตุผล (2026-09-18 ตามคำขอคุณต้น "ให้เพิ่มรูปได้มากกว่า 1 รูป ตอนนี้
// อัปโหลดได้แค่ภาพเดียว") — ระหว่างแก้ พบว่าฟีเจอร์ "แนบเอกสารสัญญา"
// (PDF/รูป) เดิมไม่เคยอัปโหลดไฟล์จริงขึ้นที่ไหนเลย เก็บแค่ "ชื่อไฟล์"
// (leaseDocName) เป็น string เดียวเท่านั้น — สร้างฟีเจอร์ใหม่จริงจัง
// รองรับหลายไฟล์ต่อห้อง เก็บเป็น JSON array [{id,name,url}] ในคอลัมน์ใหม่
// leaseDocsJson (เหมือน creditSlipsJson ที่มีอยู่แล้ว) — leaseDocName เดิม
// ปล่อยทิ้งไว้เฉยๆ ไม่ลบ (เผื่อโค้ดที่อื่นยังอ้างอิงอยู่)
//
// เหมือน migrate-add-owner-lineqr-columns.js ทุกประการ (อ่านแถวเป็น
// header-keyed object ก่อน กันข้อมูลเสียหายจากเซลล์ว่างท้ายแถวที่ Google
// Sheets ไม่คืนมาให้) — รับ Sheet ID เป็น CLI arg ได้ เผื่อต้องรันซ้ำกับ
// ชีตของลูกค้ารายอื่น (ดู CLAUDE.md's "Permanent gotcha" — สถาปัตยกรรม
// multi-tenant ของโปรเจกต์นี้คือแยกชีตจริงต่อลูกค้า ไม่ใช่กรองแถวในชีต
// เดียวกัน)
require('dotenv').config({ path: require('path').join(__dirname, '..', 'server', '.env') });
const { google } = require('googleapis');

const NEW_COLUMNS = ['leaseDocsJson'];

function colLetter(n) {
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

async function main() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.argv[2] || process.env.GOOGLE_SHEET_ID;
  console.log('Target spreadsheet:', spreadsheetId);

  const headerRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Rooms!A1:BZ1' });
  const header = headerRes.data.values[0];
  const missing = NEW_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length === 0) {
    console.log('All columns already exist — nothing to do.');
    return;
  }

  const allRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Rooms!A2:BZ1000' });
  const rows = allRes.data.values || [];
  console.log(`Found ${rows.length} data row(s). Adding column(s): ${missing.join(', ')} at position ${header.length + 1}.`);

  const newHeader = [...header, ...missing];
  const newRows = rows.map((row) => {
    const obj = {};
    header.forEach((key, i) => { obj[key] = row[i] !== undefined ? row[i] : ''; });
    missing.forEach((key) => { obj[key] = ''; });
    return newHeader.map((key) => obj[key]);
  });

  const lastCol = colLetter(newHeader.length);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `Rooms!A1:${lastCol}1`,
    valueInputOption: 'RAW',
    requestBody: { values: [newHeader] },
  });
  if (newRows.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `Rooms!A2:${lastCol}${1 + newRows.length}`,
      valueInputOption: 'RAW',
      requestBody: { values: newRows },
    });
  }
  console.log('Done. New header:', newHeader.join(', '));
}

main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
