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
// "แอปเช่าสุข" APK (android-app/, 2026-07-23) — build อัตโนมัติจาก
// .github/workflows/build-android.yml เขียนไฟล์ตรงเข้า server/downloads/
// ตรงๆ (เก็บใน repo จริง ไม่ใช่ ephemeral uploads/ กันลิงก์ดาวน์โหลดหาย
// ตอน deploy ใหม่ — เหตุผลเดียวกับที่ check-service-24 ใช้) เสิร์ฟแบบ
// static ตรงๆ ที่ /downloads/chaosuk-rental-app.apk + /downloads/apk-build-info.json
app.use('/downloads', express.static(path.join(__dirname, 'downloads')));

// Per explicit user request (multi-tenant login prototype): if this
// request carries a valid signed session cookie, resolve every
// sheets.js call for the REST of this request to that session's own
// customerSheetId instead of the single GOOGLE_SHEET_ID env var — see
// requestContext.js for how sheets.js reads this back. No session (which
// is every request today, since nothing requires login yet) falls
// straight through to next() unchanged — zero behavior change for the
// current owner's existing no-login usage.
const { getSession, setSessionCookie } = require('./auth');
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

// SECURITY: real gap found while adding the tenant-login feature. Every
// /api/* route below (rooms, invoices, expenses, staff, settings, etc.)
// has NEVER had role-based access control — only the PAGE load
// (`requireLogin` on GET '/') was ever gated. That was fine as long as
// every logged-in role had full access anyway (owner AND staff, by
// explicit design, both see everything) — but a tenant session is the
// FIRST genuinely restricted role this app has ever had. Verified: a
// tenant session's valid cookie, hit directly against GET /api/rooms,
// returned ALL 6 rooms' full data — completely bypassing tenant-portal.
// html's own scoping (which only ever calls /api/tenant/*). Blanket-deny
// here rather than patching each of the ~15 admin route files
// individually — simpler to reason about, and any NEW admin route added
// later is protected automatically without remembering to gate it.
// Real bug found by the owner (LINE Rich Menu link "เข้าดูไม่ได้", screenshot
// showed exactly {"error":"ไม่มีสิทธิ์เข้าถึงส่วนนี้"}): GET /api/line/
// auto-login (server/routes/line.js) is a SESSION-CREATION endpoint, same
// category as /api/auth/* — a tenant taps a Rich Menu button, gets a
// signed one-time link, opens it to get logged in. But once that tenant
// ALREADY has a valid tenant session cookie (from a previous tap, or from
// having visited /tenant-portal before), this blanket block caught their
// NEXT request to /api/line/auto-login too, since /api/line/* wasn't in
// the exclusion list — the tenant was blocked from re-authenticating via
// a fresh link even though the route's whole purpose is establishing/
// refreshing that exact session. Excluded the same way /api/auth already
// is.
app.use((req, res, next) => {
  const isRestrictedApi = req.path.startsWith('/api/') && !req.path.startsWith('/api/tenant') && !req.path.startsWith('/api/auth') && req.path !== '/api/line/auto-login';
  if (req.session && req.session.role === 'tenant' && isRestrictedApi) {
    return res.status(403).json({ error: 'ไม่มีสิทธิ์เข้าถึงส่วนนี้' });
  }
  next();
});

// Per explicit user request: the main app page used to be reachable by
// ANYONE who knew the URL, with zero login wall — คุณต้น's own real data
// (rooms/tenants/bills) was fully visible to anyone, session or not. Now
// requires a valid session (customerSheetId set) or bounces to /login.
// คุณต้น's own login row was added to the directory Sheet using his
// existing "ข้อมูลหอพัก" card PIN + phone (0820798793), so his own login
// works exactly the same as before this change — no new PIN to remember.
// Scope note: this only gates the PAGE — /api/* endpoints are NOT gated
// here, since some (LINE's incoming webhook, the GitHub Actions scheduler
// ping) are called by external services that can never carry a browser
// session cookie. Locking those down needs a different mechanism (e.g. a
// shared secret per endpoint) — a separate follow-up if wanted, not
// covered by this change.
const requireLogin = (req, res, next) => {
  const hasSession = !!(req.session && req.session.customerSheetId);
  if (!hasSession) return res.redirect('/login');
  // Per explicit user request: a tenant session must NEVER load the full
  // owner/staff dashboard (`Rental Management.dc.html`) — that page has
  // zero data scoping, it shows every room/tenant/bill/expense in the
  // building. Tenants get their own dedicated, data-scoped page instead
  // (server/routes/tenant.js's requireTenant re-checks this server-side
  // on every API call too, this redirect is just so a tenant landing on
  // '/' doesn't even see the wrong page load for a moment).
  if (req.session.role === 'tenant') return res.redirect('/tenant-portal');
  next();
};
app.get('/', noCache, requireLogin, (req, res) => res.sendFile(path.join(ROOT, 'Rental Management.dc.html')));
// Per explicit user request: a frictionless demo entry point — no login
// form, no account needed. Sets a session scoped to a dedicated, separate
// Demo Sheet (never real customer data — see prototype-auth/seed-demo-
// data.js, which the hourly reset cron re-runs to restore a fresh
// baseline every hour, discarding anything a visitor typed/saved).
// role: 'demo' deliberately distinct from 'owner'/'staff'/'tenant' — the
// blanket security middleware below and isPlatformAdminSession's
// whitelist both already deny anything non-'owner' by default, so a demo
// session automatically gets ZERO platform-admin/cross-tenant access
// without needing a new special-case anywhere.
app.get('/demo', noCache, (req, res) => {
  if (!process.env.DEMO_SHEET_ID) return res.status(500).send('ยังไม่ได้ตั้งค่า DEMO_SHEET_ID บนเซิร์ฟเวอร์');
  const session = { ownerId: null, role: 'demo', customerSheetId: process.env.DEMO_SHEET_ID, roomId: null, staffId: null };
  setSessionCookie(res, session);
  res.redirect('/');
});
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
// Per explicit user design: staff (an accounting clerk operating the site
// on the owner's behalf) logs in with a different 3-field flow (building
// code + own phone + own PIN) than the owner's 2-field one — see POST
// /api/auth/staff-login. Separate page so the owner's own login flow
// stays untouched.
app.get('/staff-login', noCache, (req, res) => res.sendFile(path.join(ROOT, 'staff-login.html')));
// Per explicit user design: a tenant logs in with building code + their
// own phone ONLY (no PIN — see POST /api/auth/tenant-login's security-
// trade-off note) and lands on a dedicated, data-scoped portal — never
// the full owner/staff dashboard.
app.get('/tenant-login', noCache, (req, res) => res.sendFile(path.join(ROOT, 'tenant-login.html')));
app.get('/tenant-portal', noCache, (req, res) => {
  if (!req.session || req.session.role !== 'tenant') return res.redirect('/tenant-login');
  res.sendFile(path.join(ROOT, 'tenant-portal.html'));
});
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
app.use('/api/admins', require('./routes/admins'));
app.use('/api/tenant', require('./routes/tenant'));
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
app.use('/api/scheduled-messages', require('./routes/scheduledMessages'));
app.use('/api/demo-reset', require('./routes/demoReset'));
app.use('/api/payment-card-image', require('./routes/paymentCard'));
app.use('/api/payment-log', require('./routes/paymentLog'));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`เช่าสุข server running on http://localhost:${PORT}`));
