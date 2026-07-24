// One-time migration: adds `ownerIdImg`, `ownerIdExpiry`, `lineQrImg`
// columns to the Rooms tab.
//
// เหตุผล (2026-07-24 ตามคำขอคุณต้น "จัดการเลย" หลังพบว่ากดบันทึกสัญญาไม่ได้
// เพราะรูปบัตรผู้เช่ายาวเกิน 50,000 ตัวอักษร) — ระหว่างแก้บั๊กนั้นพบเพิ่มว่า
// 3 ฟิลด์นี้ (รูปบัตรประชาชนเจ้าของ, วันหมดอายุบัตรเจ้าของ, รูป QR code
// LINE OA ให้ผู้เช่าสแกน) มีอยู่ในฟอร์ม "กรอกข้อมูลสัญญาเช่า" มานานแล้ว
// (อัปโหลด/พรีวิวได้ปกติ) แต่ไม่เคยถูกส่งไปบันทึกที่ server เลยสักครั้ง —
// เช็คคอลัมน์จริงในชีต Rooms แล้วพบว่าไม่มี 3 คอลัมน์นี้อยู่เลย เป็นฟีเจอร์
// ที่สร้าง UI ไว้ก่อนแต่ยังไม่เคยต่อ backend ให้ครบ
//
// เหมือน migrate-add-water-device-column.js ทุกประการ (อ่านแถวเป็น
// header-keyed object ก่อน กันข้อมูลเสียหายจากเซลล์ว่างท้ายแถวที่ Google
// Sheets ไม่คืนมาให้) — รับ Sheet ID เป็น CLI arg ได้ เผื่อต้องรันซ้ำกับ
// ชีตของลูกค้ารายอื่น (ดู CLAUDE.md's "Permanent gotcha" — สถาปัตยกรรม
// multi-tenant ของโปรเจกต์นี้คือแยกชีตจริงต่อลูกค้า ไม่ใช่กรองแถวในชีต
// เดียวกัน)
require('dotenv').config({ path: require('path').join(__dirname, '..', 'server', '.env') });
const { google } = require('googleapis');

const NEW_COLUMNS = ['ownerIdImg', 'ownerIdExpiry', 'lineQrImg'];

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
