require('dotenv').config();
const express = require('express');
const path = require('path');

// Safety net: an uncaught promise rejection anywhere (e.g. a transient Google
// Sheets API hiccup) should never take the whole server down. Log it and keep going.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

const ROOT = path.join(__dirname, '..');
const app = express();
app.set('trust proxy', 1); // behind Render's proxy — needed so req.protocol reports https, not http
app.use(express.json({ limit: '5mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Per explicit user request (multi-tenant login prototype): if this
// request carries a valid signed session cookie, resolve every
// sheets.js call for the REST of this request to that session's own
// customerSheetId instead of the single GOOGLE_SHEET_ID env var — see
// requestContext.js for how sheets.js reads this back. No session (which
// is every request today, since nothing requires login yet) falls
// straight through to next() unchanged — zero behavior change for the
// current owner's existing no-login usage.
const { getSession } = require('./auth');
const { runWithSheetId } = require('./requestContext');
app.use((req, res, next) => {
  const session = getSession(req);
  if (session && session.customerSheetId) {
    req.session = session;
    runWithSheetId(session.customerSheetId, next);
  } else {
    if (session) req.session = session; // role set but no customerSheetId (e.g. ผู้ดูแลระบบ) — still expose it
    next();
  }
});

// Never let browsers cache these — every deploy changes the app logic, and a
// stale cached copy would silently keep showing old behavior/data forever.
const noCache = (req, res, next) => { res.set('Cache-Control', 'no-store, no-cache, must-revalidate'); next(); };
app.get('/', noCache, (req, res) => res.sendFile(path.join(ROOT, 'Rental Management.dc.html')));
app.get('/support.js', noCache, (req, res) => res.sendFile(path.join(ROOT, 'support.js')));
app.get('/doc-page.js', noCache, (req, res) => res.sendFile(path.join(ROOT, 'doc-page.js')));
app.get('/Lease Agreement - Room 302.dc.html', noCache, (req, res) => res.sendFile(path.join(ROOT, 'Lease Agreement - Room 302.dc.html')));
// Static design mockup only — per explicit user request to preview what a
// future multi-tenant login/signup page could look like. Pure HTML/CSS/JS,
// no backend wiring, not linked from anywhere in the real app's nav.
app.get('/login-preview.html', noCache, (req, res) => res.sendFile(path.join(ROOT, 'login-preview.html')));
// The REAL login page — per explicit user request, wired to POST
// /api/auth/login for real (unlike login-preview.html's role-picker
// mockup). Separate static file, not yet linked from '/' — visiting '/'
// directly still works exactly as before with no login required, until a
// later step makes that mandatory.
app.get('/login', noCache, (req, res) => res.sendFile(path.join(ROOT, 'login.html')));
// Per explicit user request: a "your buildings" picker shown right after
// login — lets an owner with multiple buildings choose which one to
// manage, and gives every owner an obvious "+ เพิ่มตึกใหม่" entry point.
// Client-side JS fetches /api/auth/me + /api/settings itself (both
// already session-scoped) rather than this route doing anything special.
app.get('/my-buildings', noCache, (req, res) => res.sendFile(path.join(ROOT, 'my-buildings.html')));
// Plain "coming soon" placeholder — real self-service signup (new
// customer creating their own building/account) isn't built yet. Linked
// from both /login's "สร้างตึกใหม่" link and /my-buildings' "+ เพิ่มตึกใหม่"
// button.
app.get('/contact-us', noCache, (req, res) => res.sendFile(path.join(ROOT, 'contact-us.html')));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/bootstrap', require('./routes/bootstrap'));
app.use('/api/rooms', require('./routes/rooms'));
app.use('/api/staff', require('./routes/staff'));
app.use('/api/invoices', require('./routes/invoices'));
app.use('/api/maintenance', require('./routes/maintenance'));
app.use('/api/expenses', require('./routes/expenses'));
app.use('/api/calendar', require('./routes/calendar'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/line', require('./routes/line'));
app.use('/api/uploads', require('./routes/uploads'));
app.use('/api/tuya', require('./routes/tuya'));
app.use('/api/claude', require('./routes/claude'));
app.use('/api/recurring-tasks', require('./routes/recurringTasks'));
app.use('/api/unmatched-slips', require('./routes/unmatchedSlips'));
app.use('/api/system-data', require('./routes/systemData'));
app.use('/api/scheduler', require('./routes/scheduler'));
app.use('/api/payment-card-image', require('./routes/paymentCard'));
app.use('/api/payment-log', require('./routes/paymentLog'));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`เช่าสุข server running on http://localhost:${PORT}`));
