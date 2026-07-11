const express = require('express');
const router = express.Router();
const { readTab } = require('../sheets');
const { runWithSheetId } = require('../requestContext');
const { getSession, setSessionCookie, clearSessionCookie } = require('../auth');

// The "เช่าสุข - สมุดรายชื่อกลาง (ทดลอง)" sheet — completely separate from
// any customer's own data Sheet. Maps phone+PIN -> role + which
// customer's Sheet/room/staff row to scope this session to. Per explicit
// user request, prototyped and verified against real data (see
// prototype-auth/) before wiring in here.
const DIRECTORY_SHEET_ID = process.env.GOOGLE_DIRECTORY_SHEET_ID;

// PINs are compared in plain text here — same accepted trade-off already
// documented in CLAUDE.md for this app's other PIN gates (dataResetPin,
// adminEditPin): no real auth system existed before this, so there's
// nowhere secure to hash against yet. Flagging again here since this one
// guards actual customer account access, a step up from the other PINs'
// "friction gate" purpose — worth hashing properly before this goes past
// prototype stage.
router.post('/login', async (req, res, next) => {
  try {
    const { phone, pin } = req.body;
    if (!phone || !pin) return res.status(400).json({ error: 'กรุณากรอกเบอร์โทรและรหัสผ่าน' });
    if (!DIRECTORY_SHEET_ID) return res.status(500).json({ error: 'ยังไม่ได้ตั้งค่า GOOGLE_DIRECTORY_SHEET_ID บนเซิร์ฟเวอร์' });

    const users = await runWithSheetId(DIRECTORY_SHEET_ID, () => readTab('Users'));
    const match = users.find((u) => u.phone === phone && u.pin === pin);
    if (!match) return res.status(401).json({ error: 'เบอร์โทรหรือรหัสผ่านไม่ถูกต้อง' });

    const session = {
      role: match.role,
      customerSheetId: match.customerSheetId || null,
      roomId: match.roomId || null,
      staffId: match.staffId || null,
    };
    setSessionCookie(res, session);
    res.json({ ok: true, ...session });
  } catch (err) { next(err); }
});

router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// Plain clickable-link version of the same thing, purely for convenience
// during local testing (so a non-technical tester can clear a stray test
// session by clicking a link instead of needing dev tools / clearing
// browser cookies manually). Same effect as POST /logout above, just
// reachable by typing/clicking a URL, then bounces back to the dashboard.
router.get('/logout-link', (req, res) => {
  clearSessionCookie(res);
  res.redirect('/');
});

router.get('/me', (req, res) => {
  const session = getSession(req);
  res.json(session || { role: null });
});

module.exports = router;
