const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// Combined receipt-as-one-image, per explicit user request — an alternative
// to the plain-text LINE bill (server/routes/invoices.js's PDF stays as the
// separate downloadable/record-keeping file; this is specifically for what
// shows up IN the LINE chat). Built with sharp (SVG -> PNG) instead of a
// headless browser (puppeteer etc.) — same reasoning as server/pdf.js's
// choice of pdfkit over a browser: Render's free instance only has 512MB
// RAM, and sharp/libvips is a tiny native image library, not a whole
// Chromium process.
const THAI_FONT_PATH = path.join(__dirname, 'fonts', 'NotoSansThai-Variable.ttf');
const THAI_FONT_B64 = fs.readFileSync(THAI_FONT_PATH).toString('base64');

const WIDTH = 700;
const PAD = 40;
const BRAND = '#C1622D';
const TEXT = '#3B2E22';
const MUTED = '#8A7A66';
const LINE = '#E3D8C8';

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmt(n) {
  return (Number(n) || 0).toLocaleString('th-TH', { maximumFractionDigits: 2 });
}

// Builds the full receipt as a single PNG buffer. `qrBuffer` (already-
// fetched, decoded image bytes) is optional — if given, it's composited at
// the bottom of the canvas; if not, the receipt just ends after the due
// date (sendReceiptLine only calls this at all when a QR is configured, but
// the function itself doesn't hard-require one).
async function generateReceiptImage(invoice, room, propertyProfile, qrBuffer) {
  const rate = (kind) => {
    if (!room) return kind === 'water' ? 18 : 8;
    const own = kind === 'water' ? room.waterRate : room.elecRate;
    return own > 0 ? own : (kind === 'water' ? 18 : 8);
  };
  const rows = [
    { label: 'ค่าเช่า', amount: invoice.rent, detail: null },
    { label: 'ค่าน้ำ', amount: invoice.water, detail: invoice.waterUnits != null ? `${invoice.waterUnits} หน่วย × ${rate('water')}` : null },
    { label: 'ค่าไฟ', amount: invoice.elec, detail: invoice.elecUnits != null ? `${invoice.elecUnits} หน่วย × ${rate('elec')}` : null },
    { label: 'ค่าขยะ', amount: invoice.trash, detail: null },
    { label: 'ค่าอินเทอร์เน็ต', amount: invoice.internet, detail: null },
  ].filter((r) => r.amount != null && r.amount !== '');
  const total = (invoice.rent || 0) + (invoice.water || 0) + (invoice.elec || 0) + (invoice.trash || 0) + (invoice.internet || 0);
  const amountPaid = invoice.amountPaid || 0;
  const remaining = invoice.remainingDue != null ? invoice.remainingDue : Math.max(0, total - amountPaid);
  const hasCredit = amountPaid > 0;

  const prevLines = [];
  if (invoice.waterPrevReading != null) prevLines.push(`หน่วยมิเตอร์น้ำบิลก่อนหน้า: ${invoice.waterPrevReading}`);
  if (invoice.waterPrevReading != null && invoice.waterUnits != null) prevLines.push(`หน่วยมิเตอร์น้ำที่ออกบิล: ${invoice.waterPrevReading + invoice.waterUnits}`);
  if (invoice.elecPrevReading != null) prevLines.push(`หน่วยมิเตอร์ไฟบิลก่อนหน้า: ${invoice.elecPrevReading}`);
  if (invoice.elecPrevReading != null && invoice.elecUnits != null) prevLines.push(`หน่วยมิเตอร์ไฟที่ออกบิล: ${invoice.elecPrevReading + invoice.elecUnits}`);

  // Lay out top-to-bottom, tracking a running y cursor so the canvas height
  // is only as tall as the actual content (varies per invoice — not every
  // bill has credit lines or meter-reading lines).
  let y = PAD;
  const parts = [];

  parts.push(`<rect x="0" y="0" width="${WIDTH}" height="86" fill="${BRAND}"/>`);
  parts.push(`<text x="${PAD}" y="40" font-size="26" font-weight="700" fill="#fff">${esc(propertyProfile.name || 'ใบแจ้งหนี้')}</text>`);
  parts.push(`<text x="${PAD}" y="68" font-size="15" fill="#FBE9DD">ใบแจ้งหนี้ห้อง ${esc(invoice.room)} • ${esc(invoice.id)}</text>`);
  y = 86 + 36;

  parts.push(`<text x="${PAD}" y="${y}" font-size="16" fill="${TEXT}">ผู้เช่า: ${esc(invoice.tenant || '-')}</text>`);
  y += 30;
  parts.push(`<line x1="${PAD}" y1="${y}" x2="${WIDTH - PAD}" y2="${y}" stroke="${LINE}" stroke-width="1.5"/>`);
  y += 34;

  for (const r of rows) {
    parts.push(`<text x="${PAD}" y="${y}" font-size="17" fill="${TEXT}">${esc(r.label)}</text>`);
    parts.push(`<text x="${WIDTH - PAD}" y="${y}" font-size="17" fill="${TEXT}" text-anchor="end">${fmt(r.amount)}</text>`);
    if (r.detail) {
      y += 22;
      parts.push(`<text x="${PAD}" y="${y}" font-size="13" fill="${MUTED}">(${esc(r.detail)})</text>`);
    }
    y += 32;
  }

  y += 4;
  parts.push(`<line x1="${PAD}" y1="${y}" x2="${WIDTH - PAD}" y2="${y}" stroke="${LINE}" stroke-width="1.5"/>`);
  y += 38;
  parts.push(`<text x="${PAD}" y="${y}" font-size="20" font-weight="700" fill="${TEXT}">รวม</text>`);
  parts.push(`<text x="${WIDTH - PAD}" y="${y}" font-size="20" font-weight="700" fill="${TEXT}" text-anchor="end">${fmt(total)} บาท</text>`);
  y += 34;

  if (hasCredit) {
    parts.push(`<rect x="${PAD}" y="${y - 20}" width="${WIDTH - PAD * 2}" height="70" rx="8" fill="#F1EBE0"/>`);
    y += 6;
    parts.push(`<text x="${PAD + 16}" y="${y}" font-size="14" fill="${MUTED}">หักจากเงินล่วงหน้าที่ชำระไว้แล้ว: ${fmt(amountPaid)}</text>`);
    y += 26;
    parts.push(`<text x="${PAD + 16}" y="${y}" font-size="17" font-weight="700" fill="${BRAND}">ยอดที่ต้องชำระจริง: ${fmt(remaining)} บาท</text>`);
    y += 34;
  }

  if (prevLines.length) {
    y += 6;
    for (const line of prevLines) {
      parts.push(`<text x="${PAD}" y="${y}" font-size="13" fill="${MUTED}">${esc(line)}</text>`);
      y += 20;
    }
    y += 10;
  }

  y += 10;
  parts.push(`<text x="${PAD}" y="${y}" font-size="16" font-weight="700" fill="#B24336">ครบกำหนดชำระ: ${esc(invoice.due || '-')}</text>`);
  y += 36;

  let qrBlockHeight = 0;
  const QR_SIZE = 200;
  if (qrBuffer) {
    qrBlockHeight = QR_SIZE + 70;
    parts.push(`<line x1="${PAD}" y1="${y}" x2="${WIDTH - PAD}" y2="${y}" stroke="${LINE}" stroke-width="1.5"/>`);
    y += 32;
    parts.push(`<text x="${WIDTH / 2}" y="${y}" font-size="15" font-weight="700" fill="${TEXT}" text-anchor="middle">สแกนเพื่อชำระเงิน</text>`);
    y += 20;
  }

  const footerY = y + qrBlockHeight + (qrBuffer ? 20 : 20);
  const adminLine = [propertyProfile.adminName, propertyProfile.adminPhone].filter(Boolean).join(' • ');
  const totalHeight = footerY + 40;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${totalHeight}">
    <style>
      @font-face { font-family: 'NotoThai'; src: url(data:font/ttf;base64,${THAI_FONT_B64}) format('truetype'); font-weight: 400 700; }
      text { font-family: 'NotoThai'; }
    </style>
    <rect width="${WIDTH}" height="${totalHeight}" fill="#fff"/>
    ${parts.join('\n')}
    ${adminLine ? `<text x="${WIDTH / 2}" y="${footerY}" font-size="12" fill="${MUTED}" text-anchor="middle">${esc(adminLine)}</text>` : ''}
  </svg>`;

  let img = sharp(Buffer.from(svg));
  if (qrBuffer) {
    const qrResized = await sharp(qrBuffer).resize(QR_SIZE, QR_SIZE, { fit: 'contain', background: '#fff' }).png().toBuffer();
    img = img.composite([{ input: qrResized, top: Math.round(y - 4), left: Math.round((WIDTH - QR_SIZE) / 2) }]);
  }
  return img.png().toBuffer();
}

module.exports = { generateReceiptImage };
