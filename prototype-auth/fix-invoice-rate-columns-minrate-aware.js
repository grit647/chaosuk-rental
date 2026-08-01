// CORRECTIVE SCRIPT — fixes the waterRate/elecRate columns on the
// Invoices tab (added by migrate-add-invoice-rate-columns.js) to account
// for the minimum-charge (ค่าบริการขั้นต่ำ) floor, per owner's explicit
// correction (2026-08-01):
//
//   คำนวณ = หน่วยที่ใช้ × อัตราค่าบริการ
//   ถ้า คำนวณ < ค่าขั้นต่ำ  →  เก็บเท่าค่าขั้นต่ำ (ไม่ใช่อัตราจริง!)
//   ถ้า คำนวณ ≥ ค่าขั้นต่ำ  →  เก็บตามคำนวณจริง (หน่วย × อัตรา)
//
// The original backfill blindly computed rate = charge ÷ units for every
// row, which is WRONG whenever the minimum-charge floor was the actual
// operative amount — dividing a flat minimum fee by a small usage number
// produces a meaningless inflated "rate" (concrete example caught by the
// owner: room 1's water charge was exactly its own waterMinRate=80, for
// only 3 units used — 80÷3=26.67 is NOT this room's real water rate, it's
// an artifact of the floor kicking in).
//
// Fix: for each invoice row, compare the charge against that ROOM'S own
// waterMinRate/elecMinRate (read from the Rooms tab, current value — this
// script can only use the CURRENT min-rate, not necessarily what it was
// at the exact moment that historical bill was created, same caveat as
// the original reconstruction already had for the rate itself). If the
// charge exactly matches the min-rate (and the min-rate is a real
// nonzero minimum), the true per-unit rate is UNRECOVERABLE from this
// bill alone — leave the cell BLANK rather than write a fake number, so
// it's honest about "we don't actually know" instead of quietly wrong.
// Otherwise, keep the same reconstruction as before (charge ÷ units).
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

async function main() {
  const spreadsheetId = process.argv[2] || process.env.GOOGLE_SHEET_ID;
  console.log('Target spreadsheet:', spreadsheetId);
  const sheets = await client();

  // Rooms — need waterMinRate/elecMinRate per room.
  const roomsRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Rooms!A1:ZZ200' });
  const roomsRows = roomsRes.data.values || [];
  const roomsHeader = roomsRows[0];
  const rIdx = (name) => roomsHeader.indexOf(name);
  const roomMinRates = {};
  roomsRows.slice(1).forEach((r) => {
    roomMinRates[r[rIdx('id')]] = {
      waterMinRate: Number(r[rIdx('waterMinRate')]) || 0,
      elecMinRate: Number(r[rIdx('elecMinRate')]) || 0,
    };
  });

  // Invoices — the columns to fix.
  const invRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Invoices!A1:ZZ1000' });
  const invRows = invRes.data.values || [];
  const header = invRows[0];
  const iIdx = (name) => header.indexOf(name);
  if (iIdx('waterRate') === -1 || iIdx('elecRate') === -1) {
    console.log('waterRate/elecRate columns missing on Invoices — run migrate-add-invoice-rate-columns.js first.');
    return;
  }

  const dataRows = invRows.slice(1);
  console.log(`Checking ${dataRows.length} invoice rows against each room's minimum-charge floor...`);

  let corrected = 0, keptSame = 0;
  const waterValues = [], elecValues = [];
  dataRows.forEach((row) => {
    const roomId = row[iIdx('room')];
    const water = Number(row[iIdx('water')]) || 0;
    const elec = Number(row[iIdx('elec')]) || 0;
    const waterUnits = Number(row[iIdx('waterUnits')]) || 0;
    const elecUnits = Number(row[iIdx('elecUnits')]) || 0;
    const mins = roomMinRates[roomId] || { waterMinRate: 0, elecMinRate: 0 };

    let waterRate = row[iIdx('waterRate')];
    const waterHitFloor = mins.waterMinRate > 0 && water === mins.waterMinRate;
    if (waterHitFloor) { waterRate = ''; corrected++; }
    else if (waterUnits > 0) { waterRate = Math.round((water / waterUnits) * 100) / 100; keptSame++; }

    let elecRate = row[iIdx('elecRate')];
    const elecHitFloor = mins.elecMinRate > 0 && elec === mins.elecMinRate;
    if (elecHitFloor) { elecRate = ''; corrected++; }
    else if (elecUnits > 0) { elecRate = Math.round((elec / elecUnits) * 100) / 100; keptSame++; }

    if (waterHitFloor || elecHitFloor) {
      console.log(`  room ${roomId}: water=${water} (min=${mins.waterMinRate}, hitFloor=${waterHitFloor}) elec=${elec} (min=${mins.elecMinRate}, hitFloor=${elecHitFloor})`);
    }

    waterValues.push([waterRate]);
    elecValues.push([elecRate]);
  });

  const waterRateLetter = colLetter(iIdx('waterRate'));
  const elecRateLetter = colLetter(iIdx('elecRate'));
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `Invoices!${waterRateLetter}2:${waterRateLetter}${dataRows.length + 1}`, valueInputOption: 'RAW',
    requestBody: { values: waterValues },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `Invoices!${elecRateLetter}2:${elecRateLetter}${dataRows.length + 1}`, valueInputOption: 'RAW',
    requestBody: { values: elecValues },
  });

  console.log(`\n✅ Done — ${corrected} value(s) cleared to blank (min-charge floor, real rate unrecoverable from this bill), ${keptSame} value(s) confirmed/recomputed as real unit÷rate.`);
}

main().catch((err) => { console.error('Fix failed:', err.message); process.exit(1); });
