// Server-side version of prototype-auth/clone-schema.js's logic — copies
// only the TAB NAMES + HEADER ROWS (row 1) from คุณต้น's real production
// Sheet into a brand-new customer's Sheet, reporting progress as it goes
// so the Settings page's "+ เพิ่มตึกใหม่" flow can show a live progress
// bar instead of the owner staring at a blank screen while a dozen
// sequential Google Sheets API calls run. Wired in via server/routes/
// settings.js's setup-building-stream (Server-Sent Events) endpoint.
//
// Safety: READS from GOOGLE_SHEET_ID (production) — never writes to it,
// never touches any data row (only row 1, the header). WRITES only to
// the target Sheet ID the platform admin explicitly typed in — same
// safety shape as the original one-time script this was lifted from.
const { google } = require('googleapis');

async function client() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  return google.sheets({ version: 'v4', auth });
}

// onProgress receives small plain objects: { phase, message, index?, total?, step? }
// so the frontend can render a percentage bar (index/total) plus a
// human-readable status line (message), and knows when to stop (phase
// 'complete' or 'error').
async function cloneSchemaToNewSheet(targetSheetId, onProgress) {
  const sheets = await client();
  const SOURCE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
  if (!SOURCE_SHEET_ID) throw new Error('ยังไม่ได้ตั้งค่า GOOGLE_SHEET_ID บนเซิร์ฟเวอร์');

  onProgress({ phase: 'reading', message: 'กำลังอ่านโครงสร้างจากชีตจริง (อ่านอย่างเดียว)...' });
  const srcMeta = await sheets.spreadsheets.get({ spreadsheetId: SOURCE_SHEET_ID });
  const tabNames = srcMeta.data.sheets.map((s) => s.properties.title);
  onProgress({ phase: 'read-done', message: `พบ ${tabNames.length} แท็บ: ${tabNames.join(', ')}`, total: tabNames.length, index: 0 });

  const headers = {};
  for (let i = 0; i < tabNames.length; i++) {
    const name = tabNames[i];
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SOURCE_SHEET_ID, range: `${name}!A1:ZZ1` });
    headers[name] = (res.data.values && res.data.values[0]) || [];
    onProgress({ phase: 'reading-headers', step: name, message: `อ่านหัวคอลัมน์: ${name} (${headers[name].length} คอลัมน์)`, index: i + 1, total: tabNames.length });
  }

  onProgress({ phase: 'creating-tabs', message: 'กำลังสร้างแท็บใหม่ในชีตปลายทาง...', index: tabNames.length, total: tabNames.length });
  const addSheetsRequests = tabNames.map((name) => ({ addSheet: { properties: { title: name } } }));
  await sheets.spreadsheets.batchUpdate({ spreadsheetId: targetSheetId, requestBody: { requests: addSheetsRequests } });
  onProgress({ phase: 'tabs-created', message: 'สร้างแท็บเปล่าสำเร็จ กำลังใส่หัวคอลัมน์...' });

  for (let i = 0; i < tabNames.length; i++) {
    const name = tabNames[i];
    if (headers[name].length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: targetSheetId, range: `${name}!A1`, valueInputOption: 'RAW',
        requestBody: { values: [headers[name]] },
      });
    }
    onProgress({ phase: 'writing-headers', step: name, message: `ใส่หัวคอลัมน์: ${name}`, index: i + 1, total: tabNames.length });
  }

  onProgress({ phase: 'cleanup', message: 'กำลังลบแท็บเริ่มต้นที่ไม่ได้ใช้...', index: tabNames.length, total: tabNames.length });
  const targetMeta = await sheets.spreadsheets.get({ spreadsheetId: targetSheetId });
  const defaultTab = targetMeta.data.sheets.find((s) => s.properties.title === 'ชีต1' || s.properties.title === 'Sheet1');
  if (defaultTab) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: targetSheetId,
      requestBody: { requests: [{ deleteSheet: { sheetId: defaultTab.properties.sheetId } }] },
    });
  }

  onProgress({ phase: 'complete', message: `เสร็จสิ้น! โครงสร้างตรงกับชีตจริงแล้ว (${tabNames.length} แท็บ)`, index: tabNames.length, total: tabNames.length });
}

module.exports = { cloneSchemaToNewSheet };
