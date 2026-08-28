// ONE-OFF FIX (2026-08-13) — schedule-missing-invoice-sends.js accidentally
// created a DUPLICATE ScheduledMessages row for room 11 (it already had one
// scheduled independently before the script ran, unnoticed since the room's
// invoice had been recreated between diagnostic checks). Removes the row
// this script itself created (id containing "-invoice-11"), leaving
// whichever pre-existing row was already there untouched.
const path = require('path');
require(path.join(__dirname, '..', 'server', 'node_modules', 'dotenv')).config({
  path: path.join(__dirname, '..', 'server', '.env'),
});
const { runWithSheetId } = require(path.join(__dirname, '..', 'server', 'requestContext'));
const { readTab, deleteRow } = require(path.join(__dirname, '..', 'server', 'sheets'));

const SHEET_ID_1873 = '1moUMiEhF2Ie76_Ep8_rgtefWenlQXx7vEUyaO0exk4E';

async function main() {
  await runWithSheetId(SHEET_ID_1873, async () => {
    const rows = await readTab('ScheduledMessages');
    const room11Rows = rows.filter((r) => r.room === '11' && r.source === 'invoice_receipt' && String(r.sent).toUpperCase() !== 'TRUE');
    console.log('Found', room11Rows.length, 'pending schedule rows for room 11:', room11Rows.map((r) => r.id));
    const mine = room11Rows.find((r) => String(r.id).includes('-invoice-11'));
    if (!mine) { console.log('Could not find the duplicate row this script created — nothing deleted, please check manually.'); return; }
    await deleteRow('ScheduledMessages', mine.id);
    console.log('Deleted duplicate row:', mine.id);
    const remaining = (await readTab('ScheduledMessages')).filter((r) => r.room === '11' && r.source === 'invoice_receipt' && String(r.sent).toUpperCase() !== 'TRUE');
    console.log('Remaining pending schedule rows for room 11:', remaining.map((r) => r.id));
  });
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
