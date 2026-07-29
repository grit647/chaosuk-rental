// Thin client for UptimeRobot's read-only API — powers the "🖥️ สถานะ
// เซิร์ฟเวอร์" card in my-buildings.html's platform-admin-only "🔧 ทุกตึกใน
// ระบบ (Server only)" section (2026-07-29). UptimeRobot's monitor (pinging
// GET /api/scheduler/run every 20 min, see server/routes/scheduler.js's
// comment on why this exists — keeps Render's free tier awake + triggers
// the scheduled-message check) already tracks up/down status on its own
// dashboard; this just pulls that same status back into our own dashboard
// so คุณต้น doesn't need to open a separate site to check it.
const UPTIMEROBOT_API = 'https://api.uptimerobot.com/v2';

function isConfigured() {
  return !!process.env.UPTIMEROBOT_API_KEY;
}

// UptimeRobot's status codes: 0=Paused, 1=Not checked yet, 2=Up, 8=Seems
// down, 9=Down. Collapsed down to what the UI actually needs to show.
function statusLabel(code) {
  switch (code) {
    case 0: return { label: 'พักไว้ (Paused)', color: '#9C8B78', dot: '#9C8B78' };
    case 1: return { label: 'ยังไม่เคยเช็ค', color: '#9C8B78', dot: '#9C8B78' };
    case 2: return { label: 'ทำงานปกติ (Up)', color: '#3B7A52', dot: '#3B7A52' };
    case 8: return { label: 'อาจมีปัญหา', color: '#9C7A2E', dot: '#C1872E' };
    case 9: return { label: 'ล่ม (Down)', color: '#B24336', dot: '#B24336' };
    default: return { label: 'ไม่ทราบสถานะ', color: '#9C8B78', dot: '#9C8B78' };
  }
}

async function getMonitors() {
  if (!isConfigured()) throw new Error('ยังไม่ได้ตั้งค่า UPTIMEROBOT_API_KEY บนเซิร์ฟเวอร์');
  const res = await fetch(`${UPTIMEROBOT_API}/getMonitors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: new URLSearchParams({
      api_key: process.env.UPTIMEROBOT_API_KEY,
      format: 'json',
      logs: '0',
    }),
  });
  const data = await res.json();
  if (data.stat !== 'ok') throw new Error(data.error && data.error.message || 'UptimeRobot API error');
  return (data.monitors || []).map((m) => ({
    id: m.id,
    name: m.friendly_name,
    url: m.url,
    statusCode: m.status,
    ...statusLabel(m.status),
    uptimeRatio: m.all_time_uptime_ratio,
  }));
}

module.exports = { isConfigured, getMonitors };
