// PROTOTYPE ONLY — validates the "master directory" login-routing concept
// discussed with the owner, per their explicit request to try this OUT OF
// BAND before touching the real app at all. Deliberately lives in its own
// folder, completely separate from server/ — nothing in the live
// chaosuk-rental app requires or imports this file, and it never touches
// the real Rooms/Invoices/etc. data. It only reads a brand-new, empty
// Google Sheet the owner created and shared just for this experiment
// (Sheet ID below), using the SAME service account credentials already in
// server/.env (reused for convenience — the credential itself isn't the
// risk here, which SHEET it points at is, and this only ever reads the
// new "Users" directory sheet).
//
// Concept: when someone logs in with phone+PIN, we don't yet know which
// customer's Google Sheet their data lives in — so a lookup has to happen
// against a SEPARATE, small "directory" sheet FIRST, which just maps
// phone+PIN -> { role, which customer's Sheet ID, which room/staff row }.
// Only after that lookup succeeds would the real app go open the actual
// customer Sheet and load real data scoped to that one room/staff member.
//
// This script proves steps 1-2 (the directory lookup itself) work as
// designed. It does NOT yet implement step 3 (opening the target
// customer's real Sheet) — that's the next thing to prototype once this
// part is confirmed to make sense.

const path = require('path');
require(path.join(__dirname, '..', 'server', 'node_modules', 'dotenv')).config({
  path: path.join(__dirname, '..', 'server', '.env'),
});
const { google } = require(path.join(__dirname, '..', 'server', 'node_modules', 'googleapis'));

// The "เช่าสุข - สมุดรายชื่อกลาง (ทดลอง)" sheet the owner created and shared
// with the service account, per the instructions given in chat — completely
// separate from the real chaosuk-rental data Sheet ID (which this file
// never references at all).
const DIRECTORY_SHEET_ID = '1gI6TRnfs-MThskXuAUwgYEdL209MQLiWsGOEsWCm_Dw';

async function client() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  return google.sheets({ version: 'v4', auth });
}

async function readUsers() {
  const sheets = await client();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: DIRECTORY_SHEET_ID,
    range: 'Users!A1:Z1000',
  });
  const rows = res.data.values || [];
  const header = rows[0] || [];
  return rows.slice(1).map((r) => {
    const obj = {};
    header.forEach((key, i) => { obj[key] = r[i] || ''; });
    return obj;
  });
}

// The actual "step 1-2" lookup: phone+PIN in -> role + routing info out
// (or null if no match / wrong PIN). In a real build this PIN would be
// hashed, never stored/compared in plain text — skipped here since this
// is a throwaway prototype, not something real credentials will ever go
// through.
async function lookupLogin(phone, pin) {
  const users = await readUsers();
  const match = users.find((u) => u.phone === phone && u.pin === pin);
  if (!match) return null;
  return {
    role: match.role,
    customerSheetId: match.customerSheetId || null,
    roomId: match.roomId || null,
    staffId: match.staffId || null,
  };
}

module.exports = { lookupLogin, readUsers, DIRECTORY_SHEET_ID };
