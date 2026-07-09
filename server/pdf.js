const PDFDocument = require('pdfkit');
const path = require('path');

const THAI_FONT = path.join(__dirname, 'fonts', 'NotoSansThai-Variable.ttf');

function fmtBaht(n) {
  return Number(n || 0).toLocaleString('en-US');
}

// Renders a simple one-page invoice as a PDF Buffer. Uses a single Thai
// variable-weight font for everything (pdfkit doesn't need a separate bold
// file — emphasis is done with size/color instead of font weight, keeping
// this simple and avoiding a second font download).
function generateInvoicePdf(invoice, room, propertyProfile) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      doc.registerFont('Thai', THAI_FONT);
      doc.font('Thai');

      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const propName = (propertyProfile && propertyProfile.name) || 'หอพัก';
      const adminName = (propertyProfile && propertyProfile.adminName) || '';
      const adminPhone = (propertyProfile && propertyProfile.adminPhone) || '';

      // Header
      doc.fontSize(20).fillColor('#241812').text(propName, { align: 'left' });
      doc.moveDown(0.2);
      doc.fontSize(11).fillColor('#7C6E5F').text('ใบแจ้งหนี้ค่าเช่า');
      if (adminName || adminPhone) {
        doc.fontSize(9).fillColor('#9C8B78').text([adminName, adminPhone].filter(Boolean).join(' · '));
      }
      doc.moveDown(1);
      doc.strokeColor('#E3D8C8').moveTo(50, doc.y).lineTo(545, doc.y).stroke();
      doc.moveDown(0.8);

      // Invoice meta
      doc.fontSize(11).fillColor('#241812');
      doc.text('เลขที่ใบแจ้งหนี้: ' + invoice.id);
      doc.text('ห้อง: ' + invoice.room + '   ผู้เช่า: ' + (invoice.tenant || '-'));
      doc.text('วันครบกำหนดชำระ: ' + (invoice.due || '-'));
      doc.moveDown(1);

      // Itemized table
      const rows = [
        ['ค่าเช่า', invoice.rent],
        ['ค่าน้ำ', invoice.water],
        ['ค่าไฟ', invoice.elec],
        ['ค่าขยะ', invoice.trash],
        ['ค่าอินเทอร์เน็ต', invoice.internet],
      ].filter(([, v]) => v != null);

      const colLabelX = 50, colAmountX = 420, tableWidth = 495;
      doc.fontSize(10).fillColor('#7C6E5F');
      doc.text('รายการ', colLabelX, doc.y, { continued: false });
      doc.text('จำนวนเงิน', colAmountX, doc.y - doc.currentLineHeight(), { width: tableWidth - (colAmountX - colLabelX), align: 'right' });
      doc.moveDown(0.3);
      doc.strokeColor('#E3D8C8').moveTo(50, doc.y).lineTo(545, doc.y).stroke();
      doc.moveDown(0.4);

      let total = 0;
      doc.fontSize(11).fillColor('#241812');
      rows.forEach(([label, value]) => {
        total += Number(value) || 0;
        const y = doc.y;
        doc.text(label, colLabelX, y);
        doc.text(fmtBaht(value), colAmountX, y, { width: tableWidth - (colAmountX - colLabelX), align: 'right' });
        doc.moveDown(0.6);
      });

      doc.moveDown(0.2);
      doc.strokeColor('#241812').moveTo(50, doc.y).lineTo(545, doc.y).stroke();
      doc.moveDown(0.4);

      const totalY = doc.y;
      doc.fontSize(13).fillColor('#C1622D').text('ยอดรวมทั้งหมด', colLabelX, totalY);
      doc.fontSize(13).fillColor('#C1622D').text(fmtBaht(total), colAmountX, totalY, { width: tableWidth - (colAmountX - colLabelX), align: 'right' });

      doc.moveDown(2.5);
      doc.fontSize(9).fillColor('#9C8B78').text('สถานะ: ' + (invoice.status === 'paid' ? 'ชำระแล้ว' : invoice.status === 'overdue' ? 'เกินกำหนด' : 'รอชำระ'));
      if (invoice.paidDate) doc.text('วันที่ชำระ: ' + invoice.paidDate);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateInvoicePdf };
