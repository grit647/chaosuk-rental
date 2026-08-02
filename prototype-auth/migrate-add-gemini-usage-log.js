// One-time migration: creates a "GeminiUsageLog" tab, backing the new
// server/gemini.js's logUsage() (see its own comment for full context —
// built while wiring the "เลือกใช้ AI: Claude/Gemini" picker on the AI
// assistant card to a real working Gemini backend, 2026-08-01).
//
// Columns: id, timestamp, feature, building, model, inputTokens,
// outputTokens, costUsd — deliberately includes `building` (unlike
// wholesale-order's own GeminiUsageLog) since this app is genuinely
// multi-tenant via SEPARATE spreadsheets per building (see CLAUDE.md's
// "Permanent gotcha" section) — this script must be re-run individually
// against every other building's own spreadsheet the same way every other
// new-tab migration in this project has needed to be.
const path = require('path');
require(path.join(__dirname, '..', 'server', 'node_modules', 'dotenv')).config({
  path: path.join(__dirname, '..', 'server', '.env'),
});
const { google } = require(path.join(__dirname, '..', 'server', 'node_modules', 'googleapis'));

const TAB_NAME = 'GeminiUsageLog';
const HEADER = ['id', 'timestamp', 'feature', 'building', 'model', 'inputTokens', 'outputTokens', 'costUsd'];

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

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets.find((s) => s.properties.title === TAB_NAME);
  if (existing) {
    console.log(`Tab "${TAB_NAME}" already exists — nothing to do.`);
    return;
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: TAB_NAME } } }] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${TAB_NAME}!A1:H1`,
    valueInputOption: 'RAW',
    requestBody: { values: [HEADER] },
  });
  console.log(`Created "${TAB_NAME}" tab with header:`, HEADER.join(', '));
}

main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
