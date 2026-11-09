const path = require('path');

// Same fontconfig trick as receiptImage.js — must be set before sharp/
// libvips's SVG renderer does any real work, or Thai text renders as tofu
// boxes on Render's Linux instance (no Thai font installed system-wide).
process.env.FONTCONFIG_PATH = path.join(__dirname, 'fonts');

const sharp = require('sharp');

// "เพิ่มอีก 1 ฟังก์ชัน สเตทเม้นท์ รายรับจ่าย...สร้างเป็น png สรุป"
// (2026-09-18) — สเตทเม้นท์รายรับ/รายจ่าย แบบเลือกเดือน (หรือทั้งหมด)
// เป็นรูปภาพเดียว เหมือนใบเสร็จ (receiptImage.js) แต่เป็นตารางรายการแทน
// รายการบิล — ใช้ sharp (SVG -> PNG) ตัวเดียวกัน ไม่ใช้ headless browser
// (เหตุผลเดียวกับ receiptImage.js/pdf.js — RAM จำกัดบน Render free tier)
//
// แยกไฟล์ออกจาก receiptImage.js เพราะคนละรูปแบบเนื้อหา (ตารางรายการ
// เรื่อยๆ ไม่จำกัดจำนวน ต่างจากใบเสร็จที่มีโครงสร้างคงที่) แต่ใช้ฟอนต์/
// สี/แนวทางเดียวกันทั้งหมดให้ดูเป็นแบรนด์เดียวกัน
const THAI_FONT_FAMILY = 'Noto Sans Thai';

const WIDTH = 700;
const PAD = 36;
const BRAND = '#C1622D';
const TEXT = '#3B2E22';
const MUTED = '#8A7A66';
const LINE = '#E3D8C8';
const GREEN = '#3B7A52';
const RED = '#B24336';

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmt(n) {
  return (Number(n) || 0).toLocaleString('th-TH', { maximumFractionDigits: 2 });
}

function todayStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
}

function formatDateTh(iso) {
  if (!iso || typeof iso !== 'string') return iso || '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

// rows: [{ date, title, sublabel, amount }] — title is the main line (เช่น
// "ห้อง 5 · ชำระเต็มจำนวน" หรือ "ค่าซ่อมบำรุง · เปลี่ยนก๊อกน้ำ"), sublabel
// เป็นบรรทัดเล็กด้านล่าง (optional — เช่นหมายเหตุเพิ่มเติม)
async function generateStatementImage({ kindLabel, periodLabel, rows, total, propertyName, isIncome }) {
  let y = PAD;
  const parts = [];
  const accentColor = isIncome ? GREEN : RED;

  parts.push(`<rect x="0" y="0" width="${WIDTH}" height="92" fill="${BRAND}"/>`);
  parts.push(`<text x="${PAD}" y="38" font-size="24" font-weight="700" fill="#fff">${esc(propertyName || 'สเตทเม้นท์')}</text>`);
  parts.push(`<text x="${PAD}" y="66" font-size="15" fill="#FBE9DD">สเตทเม้นท์${esc(kindLabel)} · ${esc(periodLabel)}</text>`);
  parts.push(`<text x="${WIDTH - PAD}" y="66" font-size="12" fill="#FBE9DD" text-anchor="end">สร้างเมื่อ ${formatDateTh(todayStr())}</text>`);
  y = 92 + 36;

  if (!rows.length) {
    parts.push(`<text x="${WIDTH / 2}" y="${y}" font-size="15" fill="${MUTED}" text-anchor="middle">ไม่มีรายการในช่วงที่เลือก</text>`);
    y += 40;
  }

  for (const r of rows) {
    parts.push(`<text x="${PAD}" y="${y}" font-size="15" font-weight="600" fill="${TEXT}">${esc(r.title)}</text>`);
    parts.push(`<text x="${WIDTH - PAD}" y="${y}" font-size="15" font-weight="700" fill="${accentColor}" text-anchor="end">${fmt(r.amount)}</text>`);
    y += 20;
    const subBits = [r.date ? formatDateTh(r.date) : '', r.sublabel || ''].filter(Boolean).join(' · ');
    if (subBits) {
      parts.push(`<text x="${PAD}" y="${y}" font-size="12" fill="${MUTED}">${esc(subBits)}</text>`);
      y += 20;
    }
    y += 10;
    parts.push(`<line x1="${PAD}" y1="${y - 4}" x2="${WIDTH - PAD}" y2="${y - 4}" stroke="${LINE}" stroke-width="1"/>`);
  }

  y += 24;
  parts.push(`<rect x="${PAD}" y="${y - 26}" width="${WIDTH - PAD * 2}" height="56" rx="8" fill="#F1EBE0"/>`);
  parts.push(`<text x="${PAD + 16}" y="${y}" font-size="14" fill="${MUTED}">รวม ${rows.length} รายการ</text>`);
  parts.push(`<text x="${WIDTH - PAD - 16}" y="${y + 2}" font-size="20" font-weight="700" fill="${accentColor}" text-anchor="end">${fmt(total)} บาท</text>`);
  y += 48;

  const totalHeight = y + 20;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${totalHeight}">
    <style>
      text { font-family: '${THAI_FONT_FAMILY}', sans-serif; }
    </style>
    <rect width="${WIDTH}" height="${totalHeight}" fill="#fff"/>
    ${parts.join('\n')}
  </svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

module.exports = { generateStatementImage };
