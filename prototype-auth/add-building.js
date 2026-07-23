// Reusable CLI version of the "+ เพิ่มตึกใหม่" flow in Settings (Rental
// Management.dc.html) / server/routes/settings.js's setup-building-start +
// add-building endpoints — built per explicit owner request when he asked
// to connect a new customer's building directly instead of going through
// the browser UI. Mirrors the exact same two steps those endpoints do,
// against the SAME production sheets (server/.env's GOOGLE_SHEET_ID +
// GOOGLE_DIRECTORY_SHEET_ID):
//   1. Clone tab names + header row (row 1 only) from the real production
//      Sheet into the customer's brand-new (must already be empty, already
//      shared with the service account) target Sheet.
//   2. Append one row to the central Directory sheet's "Users" tab linking
//      phone -> customerSheetId (reusing an existing ownerId+pin if this
//      phone already owns another building, exactly like the web flow's
//      multi-building-per-owner logic).
//
// Safety: READS from GOOGLE_SHEET_ID (production) — never writes to it.
// WRITES only to (a) the target sheet ID explicitly passed in, and (b) the
// Directory sheet's Users tab (append only, never touches existing rows).
// Refuses to run if this target sheetId is already registered, so it's
// safe to re-run by mistake.
//
// Usage: node add-building.js <phone> <sheetIdOrUrl> [pin]
//   pin is optional — leave blank so the customer claims/sets their own
//   pin at their first login (recommended, same default as the web form).
const path = require('path');
require(path.join(__dirname, '..', 'server', 'node_modules', 'dotenv')).config({
  path: path.join(__dirname, '..', 'server', '.env'),
});
const { google } = require(path.join(__dirname, '..', 'server', 'node_modules', 'googleapis'));
const crypto = require('crypto');

const SOURCE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const DIRECTORY_SHEET_ID = process.env.GOOGLE_DIRECTORY_SHEET_ID;

function extractSheetId(input) {
  const m = String(input).match(/\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : String(input).trim();
}

function genOwnerId() {
  return 'OWNER-' + crypto.randomBytes(6).toString('hex');
}

async function client() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  return google.sheets({ version: 'v4', auth });
}

async function readTabRows(sheets, spreadsheetId, tab) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tab}!A1:ZZ1000` });
  const [header, ...body] = res.data.values || [[]];
  const rows = body
    .filter((r) => r.some((c) => c !== undefined && c !== ''))
    .map((r) => {
      const obj = {};
      (header || []).forEach((key, i) => { obj[key] = r[i] !== undefined ? r[i] : ''; });
      return obj;
    });
  return { header: header || [], rows };
}

async function main() {
  const [, , phoneArg, sheetArg, pinArg] = process.argv;
  if (!phoneArg || !sheetArg) {
    console.error('ใช้งาน: node add-building.js <เบอร์โทร> <ลิงก์หรือ Sheet ID> [pin เว้นว่างได้]');
    process.exit(1);
  }
  const phone = phoneArg.trim();
  const targetSheetId = extractSheetId(sheetArg);
  const pin = (pinArg || '').trim();
  if (pin && pin.length < 4) {
    console.error('รหัสผ่านต้องมีอย่างน้อย 4 ตัวอักษร (หรือเว้นว่างให้ลูกค้าตั้งเอง)');
    process.exit(1);
  }

  const sheets = await client();

  console.log('ตรวจสอบว่าเข้าถึง Sheet เป้าหมายได้ (แชร์ service account แล้วหรือยัง)...');
  try {
    await sheets.spreadsheets.get({ spreadsheetId: targetSheetId });
  } catch (err) {
    console.error('เข้าถึง Sheet เป้าหมายไม่ได้ — ต้องแชร์ Sheet นี้ให้อีเมล service account (' + process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL + ') สิทธิ์ Editor ก่อนครับ');
    console.error('รายละเอียด:', err.message);
    process.exit(1);
  }

  console.log('อ่านสมุดรายชื่อกลาง (Directory) เพื่อตรวจสอบข้อมูลซ้ำ...');
  const { rows: directoryRows } = await readTabRows(sheets, DIRECTORY_SHEET_ID, 'Users');
  if (directoryRows.some((u) => u.customerSheetId === targetSheetId)) {
    console.error('Sheet ID นี้มีอยู่ในสมุดรายชื่อกลางแล้ว (ตึกนี้เพิ่มไปแล้วหรือเปล่า?)');
    process.exit(1);
  }

  const existingOwnerRow = directoryRows.find((u) => u.phone === phone);
  let ownerId, effectivePin, reusedExistingOwner;
  if (existingOwnerRow) {
    if (!existingOwnerRow.ownerId) {
      console.error('เบอร์นี้มีแถวเก่าที่ยังไม่มี ownerId (ต้องรัน migrate-add-owner-id.js ก่อน)');
      process.exit(1);
    }
    ownerId = existingOwnerRow.ownerId;
    effectivePin = existingOwnerRow.pin;
    reusedExistingOwner = true;
  } else {
    if (pin && directoryRows.some((u) => String(u.pin) === String(pin))) {
      console.error('รหัสผ่านนี้มีเจ้าของอื่นใช้อยู่แล้ว กรุณาตั้งรหัสอื่น');
      process.exit(1);
    }
    ownerId = genOwnerId();
    effectivePin = pin || '';
    reusedExistingOwner = false;
  }

  console.log('กำลังอ่านโครงสร้างจากชีตจริง (อ่านอย่างเดียว)...');
  const srcMeta = await sheets.spreadsheets.get({ spreadsheetId: SOURCE_SHEET_ID });
  const tabNames = srcMeta.data.sheets.map((s) => s.properties.title);
  console.log(`พบ ${tabNames.length} แท็บ: ${tabNames.join(', ')}`);

  const headers = {};
  for (const name of tabNames) {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SOURCE_SHEET_ID, range: `${name}!A1:ZZ1` });
    headers[name] = (res.data.values && res.data.values[0]) || [];
    console.log(`  อ่านหัวคอลัมน์: ${name} (${headers[name].length} คอลัมน์)`);
  }

  // Idempotency: this target sheet may already have been partially set up
  // in an earlier session (e.g. someone manually cloned it as a template
  // and set some Settings values, but never finished registering it in
  // the Directory) — only create tabs that are actually MISSING, and only
  // write a header row into a tab that doesn't already have data, so a
  // re-run (or a sheet that's already 90% ready) never clobbers anything.
  const targetMetaBefore = await sheets.spreadsheets.get({ spreadsheetId: targetSheetId });
  const existingTabNames = new Set(targetMetaBefore.data.sheets.map((s) => s.properties.title));
  const missingTabNames = tabNames.filter((name) => !existingTabNames.has(name));

  if (missingTabNames.length) {
    console.log('กำลังสร้างแท็บที่ขาดในชีตปลายทาง:', missingTabNames.join(', '));
    const addSheetsRequests = missingTabNames.map((name) => ({ addSheet: { properties: { title: name } } }));
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: targetSheetId, requestBody: { requests: addSheetsRequests } });
    for (const name of missingTabNames) {
      if (!headers[name].length) continue;
      await sheets.spreadsheets.values.update({
        spreadsheetId: targetSheetId, range: `${name}!A1`, valueInputOption: 'RAW',
        requestBody: { values: [headers[name]] },
      });
      console.log(`  ใส่หัวคอลัมน์: ${name}`);
    }
  } else {
    console.log('ชีตปลายทางมีแท็บครบทุกอันอยู่แล้ว — ข้ามขั้นตอนสร้างแท็บ');
  }

  console.log('กำลังลบแท็บเริ่มต้นที่ไม่ได้ใช้...');
  const targetMeta = await sheets.spreadsheets.get({ spreadsheetId: targetSheetId });
  const defaultTab = targetMeta.data.sheets.find((s) => s.properties.title === 'ชีต1' || s.properties.title === 'Sheet1');
  if (defaultTab) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: targetSheetId,
      requestBody: { requests: [{ deleteSheet: { sheetId: defaultTab.properties.sheetId } }] },
    });
  }
  console.log('โครงสร้างตึกใหม่เสร็จแล้ว (ตรงกับชีตจริง)');

  console.log('กำลังเพิ่มแถวลูกค้าลงสมุดรายชื่อกลาง...');
  const dirHeaderRes = await sheets.spreadsheets.values.get({ spreadsheetId: DIRECTORY_SHEET_ID, range: 'Users!A1:ZZ1' });
  const dirHeader = (dirHeaderRes.data.values || [[]])[0] || [];
  const newRowObj = {
    ownerId, phone, pin: effectivePin, role: 'owner', customerSheetId: targetSheetId,
    roomId: '', staffId: '', status: 'active', handoffStatus: 'pending',
  };
  const newRow = dirHeader.map((key) => {
    const v = newRowObj[key];
    return v === undefined || v === null ? '' : v;
  });
  await sheets.spreadsheets.values.append({
    spreadsheetId: DIRECTORY_SHEET_ID, range: 'Users!A1', valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [newRow] },
  });

  if (effectivePin) {
    console.log('ตั้งค่า adminEditPin เริ่มต้นของตึกนี้ให้ตรงกับรหัสผ่านล็อกอิน...');
    const settingsRes = await sheets.spreadsheets.values.get({ spreadsheetId: targetSheetId, range: 'Settings!A1:ZZ1000' });
    const [settingsHeader, ...settingsBody] = settingsRes.data.values || [[]];
    const keyIdx = (settingsHeader || []).indexOf('key');
    const existingIdx = settingsBody.findIndex((r) => r[keyIdx] === 'adminEditPin');
    if (existingIdx === -1) {
      const row = (settingsHeader || []).map((k) => (k === 'key' ? 'adminEditPin' : k === 'value' ? String(effectivePin) : ''));
      await sheets.spreadsheets.values.append({
        spreadsheetId: targetSheetId, range: 'Settings!A1', valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [row] },
      });
    } else {
      const rowNum = existingIdx + 2;
      const valueIdx = (settingsHeader || []).indexOf('value');
      const range = `Settings!${String.fromCharCode(65 + valueIdx)}${rowNum}`;
      await sheets.spreadsheets.values.update({
        spreadsheetId: targetSheetId, range, valueInputOption: 'RAW', requestBody: { values: [[String(effectivePin)]] },
      });
    }
  }

  console.log('\n✅ เสร็จสิ้น!');
  console.log('เบอร์โทร:', phone);
  console.log('customerSheetId:', targetSheetId);
  console.log('ownerId:', ownerId, reusedExistingOwner ? '(ใช้ owner เดิมที่มีอยู่แล้ว)' : '(owner ใหม่)');
  console.log('รหัสผ่าน:', effectivePin ? '(ตั้งไว้แล้ว)' : '(ว่าง — ลูกค้าตั้งเองตอน login ครั้งแรก)');
}

main().catch((err) => {
  console.error('เกิดข้อผิดพลาด:', err.message);
  process.exit(1);
});
