// ONE-TIME MIGRATION SCRIPT — adds "waterRate"/"elecRate" columns to the
// Invoices tab (บาท/หน่วย ที่ใช้คิดจริงตอนออกบิลนั้น), per explicit owner
// request while looking directly at the Invoices sheet and not seeing the
// rate anywhere ("ช่วยเอาอัตราค่าบริการ น้ำ ไฟ มาแสดงส่วนนี้ให้ด้วยครับ
// ผมไม่เห็นครับ", 2026-08-01). server/routes/invoices.js's POST / now
// writes these going forward (see its comment) — this script only
// backfills EXISTING rows, since the header must exist before appendRow/
// updateRow can ever write to it (see server/sheets.js's "Permanent
// gotcha" — new columns silently no-op on write if the header isn't there).
//
// Backfill strategy per existing row:
//   1. If both `water` (บาท) and `waterUnits` (หน่วย) are present and
//      waterUnits > 0 → rate = water / waterUnits (the true rate that
//      row was actually billed at, reconstructed exactly).
//   2. Otherwise (older rows before waterUnits existed, or a 0-usage
//      cycle) → falls back to this Sheet's CURRENT waterRate/elecRate
//      Settings value — an approximation, logged as such, since there's
//      no way to know the historical rate at the time for those rows.
// Same logic for elec.
//
// Safety: only touches THIS SHEET's Invoices/Settings tabs (run once per
// building — pass a different customerSheetId as the CLI arg for another
// building, per the "Permanent gotcha" note in CLAUDE.md — every other
// customer's own separate spreadsheet needs this run again individually).
// Refuses to run if the columns already exist (idempotency guard).
const path = require('path');
require(path.join(__dirname, '..', 'server', 'node_modules', 'dotenv')).config({
  path: path.join(__dirname, '..', 'server', '.env'),
});
const { google } = require(path.join(__dirname, '..', 'server', 'node_modules', 'googleapis'));

function colLetter(idx) {
  let s = '';
  let n = idx;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

async function client() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  return google.sheets({ version: 'v4', auth });
}

async function ensureColumn(sheets, spreadsheetId, tab, header, colName) {
  if (header.includes(colName)) return header;
  const newColIdx = header.length;
  const newColLetter = colLetter(newColIdx);
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetMeta = meta.data.sheets.find((s) => s.properties.title === tab);
  const currentColCount = sheetMeta.properties.gridProperties.columnCount;
  if (newColIdx >= currentColCount) {
    console.log(`Sheet grid only has ${currentColCount} columns — widening by 10 first...`);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ appendDimension: { sheetId: sheetMeta.properties.sheetId, dimension: 'COLUMNS', length: 10 } }] },
    });
  }
  console.log(`Adding column "${newColLetter}1" = ${colName}...`);
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `${tab}!${newColLetter}1`, valueInputOption: 'RAW',
    requestBody: { values: [[colName]] },
  });
  return [...header, colName];
}

async function main() {
  const spreadsheetId = process.argv[2] || process.env.GOOGLE_SHEET_ID;
  console.log('Target spreadsheet (Invoices tab):', spreadsheetId);
  const sheets = await client();

  let headerRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Invoices!A1:ZZ1' });
  let header = (headerRes.data.values || [[]])[0] || [];
  const hadWater = header.includes('waterRate');
  const hadElec = header.includes('elecRate');
  if (hadWater && hadElec) {
    console.log('waterRate/elecRate columns already exist — nothing to do (safe to ignore, already migrated).');
    return;
  }

  // Current fallback rates (Settings tab) — used only for rows we can't
  // reconstruct exactly (no waterUnits/elecUnits recorded).
  const settingsRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Settings!A1:B1000' });
  const settingsRows = (settingsRes.data.values || []).slice(1); // skip header
  const settingsMap = {};
  settingsRows.forEach(([key, value]) => { settingsMap[key] = value; });
  const fallbackWaterRate = Number(settingsMap.waterRate) || 18;
  const fallbackElecRate = Number(settingsMap.elecRate) || 8;
  console.log(`Fallback rates for rows with no recorded units — water: ${fallbackWaterRate}, elec: ${fallbackElecRate}`);

  header = await ensureColumn(sheets, spreadsheetId, 'Invoices', header, 'waterRate');
  header = await ensureColumn(sheets, spreadsheetId, 'Invoices', header, 'elecRate');

  const dataRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Invoices!A2:ZZ1000' });
  const rows = dataRes.data.values || [];
  console.log(`Found ${rows.length} existing invoice rows — backfilling waterRate/elecRate for each.`);

  const waterCol = header.indexOf('water');
  const elecCol = header.indexOf('elec');
  const waterUnitsCol = header.indexOf('waterUnits');
  const elecUnitsCol = header.indexOf('elecUnits');
  const waterRateCol = header.indexOf('waterRate');
  const elecRateCol = header.indexOf('elecRate');
  const waterRateLetter = colLetter(waterRateCol);
  const elecRateLetter = colLetter(elecRateCol);

  let reconstructed = 0, approximated = 0;
  const waterValues = [], elecValues = [];
  rows.forEach((row) => {
    const water = Number(row[waterCol]) || 0;
    const elec = Number(row[elecCol]) || 0;
    const waterUnits = Number(row[waterUnitsCol]) || 0;
    const elecUnits = Number(row[elecUnitsCol]) || 0;
    let waterRate, elecRate;
    if (waterUnits > 0) { waterRate = Math.round((water / waterUnits) * 100) / 100; reconstructed++; }
    else { waterRate = fallbackWaterRate; approximated++; }
    if (elecUnits > 0) { elecRate = Math.round((elec / elecUnits) * 100) / 100; reconstructed++; }
    else { elecRate = fallbackElecRate; approximated++; }
    waterValues.push([waterRate]);
    elecValues.push([elecRate]);
  });

  if (rows.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: `Invoices!${waterRateLetter}2:${waterRateLetter}${rows.length + 1}`, valueInputOption: 'RAW',
      requestBody: { values: waterValues },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: `Invoices!${elecRateLetter}2:${elecRateLetter}${rows.length + 1}`, valueInputOption: 'RAW',
      requestBody: { values: elecValues },
    });
  }

  console.log(`\n✅ Done — backfilled ${rows.length} invoice rows (${reconstructed} values reconstructed exactly from recorded units, ${approximated} approximated from the current Settings rate since no units were recorded on that row).`);
}

main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
