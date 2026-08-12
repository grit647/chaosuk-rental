// Tool definitions + execution logic for the "Claude command box" — a scoped
// natural-language assistant that can only do what's listed here. There is no
// tool for touching server code, environment variables, or deployment, so no
// matter what a user types, Claude has no mechanical way to act on it — the
// system prompt in routes/claude.js also has Claude explicitly decline and
// explain when asked for something outside this tool list.
//
// READ_TOOL_NAMES execute immediately (safe, no side effects).
// Anything not in READ_TOOL_NAMES is a write/mutating action — the route
// layer never executes those directly from a first pass; it returns a
// { type: 'confirm' } payload for the frontend to show a popup, and only
// server/routes/claude.js's /command/confirm endpoint (after explicit user
// click) calls executeWriteTool.

const fs = require('fs');
const path = require('path');
const { readTab, appendRow, updateRow, deleteRow } = require('./sheets');
const { coerceRooms, coerceInvoices, coerceMaintenance, coerceExpenses, coerceCalendar, coercePaymentLog, coerceUnmatchedSlips, readSettings, readIntegrationCredentials } = require('./coerce');
const { pushMessage, isConfigured: lineConfigured } = require('./line');
const { generateInvoicePdf } = require('./pdf');
// "มาดูส่วนนี้การคาลิเบรตค่าน้ำจะเพิ่มการทำงานของ AI ให้สามารถกรอกค่าน้ำ
// และค่าคาลิเบรตค่าน้ำแทนได้" (2026-08-12) — ใช้ฟังก์ชันเดียวกับปุ่ม
// "คาลิเบรต" บนหน้า "Set อุปกรณ์" (server/routes/tuya.js) ไม่เขียน logic
// คาลิเบรต/safety-check ซ้ำที่นี่
const { calibrateWaterMeter } = require('./routes/tuya');

const INVOICE_PDF_DIR = path.join(__dirname, 'uploads', 'invoices');
fs.mkdirSync(INVOICE_PDF_DIR, { recursive: true });

const TOOLS = [
  {
    name: 'show_chart',
    description: `แสดงกราฟแท่งแบบ popup ให้ผู้ใช้ดู จากข้อมูลจริงที่ดึงมาด้วยเครื่องมือ get_* แล้วเท่านั้น (ห้ามสมมติตัวเลข) — ใช้ได้กับทุกเรื่อง เช่น การใช้น้ำ/ไฟย้อนหลัง, รายรับ-รายจ่าย, จุดคุ้มทุน ฯลฯ

กฎสำคัญ: ถ้าผู้ใช้แค่ถามข้อมูลย้อนหลังเฉยๆ (ไม่ได้พูดคำว่า "กราฟ"/"แผนภูมิ" มาตรงๆ) ให้ถามก่อนเสมอว่า "ต้องการให้แสดงเป็นกราฟด้วยไหมครับ" แล้วรอคำตอบ ค่อยเรียกเครื่องมือนี้ทีหลังถ้าผู้ใช้ตอบตกลง — ถ้าผู้ใช้ขอกราฟมาตรงๆ ตั้งแต่ต้น เรียกเครื่องมือนี้ได้เลยไม่ต้องถามซ้ำ

รองรับสูงสุด 3 ชุดข้อมูล (series) ต่อกราฟ`,
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'หัวข้อกราฟ' },
        xLabels: { type: 'array', items: { type: 'string' }, description: 'ป้ายกำกับแกน X เรียงตามลำดับ เช่น ชื่อเดือน หรือวันที่' },
        series: {
          type: 'array',
          maxItems: 3,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'ชื่อชุดข้อมูล เช่น "ค่าน้ำ", "รายรับ"' },
              values: { type: 'array', items: { type: 'number' }, description: 'ค่าตัวเลข เรียงตรงกับ xLabels' },
            },
            required: ['name', 'values'],
          },
          description: 'สูงสุด 3 ชุด',
        },
        insight: { type: 'string', description: 'บทวิเคราะห์สั้นๆ เกี่ยวกับข้อมูลนี้เป็นภาษาไทย (ถ้ามีข้อสังเกตที่น่าสนใจ)' },
      },
      required: ['title', 'xLabels', 'series'],
    },
  },
  {
    name: 'get_rooms',
    description: 'ดูรายชื่อห้องทั้งหมด พร้อมสถานะ (ว่าง/มีผู้เช่า/ค้างชำระ), ผู้เช่า, เบอร์โทร, ค่าเช่า, มัดจำ, เลขมิเตอร์น้ำ-ไฟปัจจุบัน, และรายละเอียดสัญญาเช่า (วันที่เข้าอยู่, วันสิ้นสุดสัญญา, วันครบกำหนดชำระรายเดือน, รหัส WiFi) — ใช้เครื่องมือนี้สำหรับคำถามเกี่ยวกับสัญญาเช่าด้วย',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'check_lease_completeness',
    description: 'ตรวจสอบว่าสัญญาเช่าของแต่ละห้อง (ที่มีผู้เช่าอยู่) มีข้อมูลครบถ้วนหรือไม่ — เช็คว่าขาดข้อมูลอะไรบ้าง เช่น เบอร์โทร, วันเข้าอยู่, วันสิ้นสุดสัญญา, วันครบกำหนดชำระ, รหัส WiFi, รูปบัตรประชาชนผู้เช่า, วันหมดอายุบัตร, ไฟล์สัญญาเช่า ใช้เมื่อถูกถามว่าห้องไหน/สัญญาไหนข้อมูลยังไม่ครบ',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_pending_invoices',
    description: 'ดูรายการบิล/ใบแจ้งหนี้ที่ยังไม่ได้ชำระ (ค้างจ่าย)',
    input_schema: { type: 'object', properties: {} },
  },
  {
    // "ขอดูรายการบิลที่ชำระแล้ว" (2026-08-02) — เดิม AI ไม่มีเครื่องมือนี้
    // เลย ตอบว่าทำไม่ได้ (ถูกต้องแล้วที่ไม่กุคำตอบมั่ว แต่เป็นช่องว่างจริง
    // ที่ควรเติมให้) — คู่กับ get_pending_invoices ข้างบน, ใช้ข้อมูลชุด
    // เดียวกับตาราง "✅ บิลที่ชำระแล้ว" ที่เพิ่งเพิ่มในหน้าเว็บ (billing
    // page, paidBills) ให้ผลตรงกันเป๊ะ
    name: 'get_paid_invoices',
    description: 'ดูรายการบิล/ใบแจ้งหนี้ที่ชำระเงินแล้ว (ประวัติการชำระเงิน) — ใช้เมื่อถูกถามว่าห้องไหนจ่ายไปแล้วเท่าไร/เมื่อไร หรือขอดูรายการบิลที่ปิดยอดแล้ว',
    input_schema: {
      type: 'object',
      properties: { roomId: { type: 'string', description: 'กรองเฉพาะห้องนี้ (ไม่ใส่ = ทุกห้อง)' } },
    },
  },
  {
    name: 'get_maintenance',
    description: 'ดูรายการแจ้งซ่อม ทั้งหมดหรือกรองตามสถานะ',
    input_schema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['pending', 'inprogress', 'done'], description: 'กรองตามสถานะ (ไม่ใส่ = ทั้งหมด)' } },
    },
  },
  {
    name: 'get_expenses',
    description: 'ดูรายการรายจ่ายทั้งหมด',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_calendar_events',
    description: 'ดูรายการนัดหมาย/กิจกรรมที่บันทึกไว้ในปฏิทินของระบบ (เช่น นัดประชุมผู้เช่า, นัดซ่อมบำรุง ฯลฯ)',
    input_schema: {
      type: 'object',
      properties: {
        year: { type: 'number', description: 'กรองเฉพาะปีนี้ (ไม่ใส่ = ทุกปี)' },
        month: { type: 'number', description: 'กรองเฉพาะเดือนนี้ 1-12 (ไม่ใส่ = ทุกเดือน)' },
      },
    },
  },
  {
    name: 'get_electricity_log',
    description: 'ดูประวัติการบันทึกค่ามิเตอร์ไฟฟ้าย้อนหลัง (โวลต์, แอมป์, วัตต์, หน่วยไฟสะสม) ที่เก็บไว้อัตโนมัติทุกครั้งที่ระบบอ่านค่าจาก Tuya — ใช้สำหรับดูแนวโน้ม/วิเคราะห์การใช้ไฟฟ้าของห้องใดห้องหนึ่งหรือทุกห้องย้อนหลัง',
    input_schema: {
      type: 'object',
      properties: {
        roomId: { type: 'string', description: 'กรองเฉพาะห้องนี้ (ไม่ใส่ = ทุกห้อง)' },
        limit: { type: 'number', description: 'จำนวนแถวล่าสุดที่ต้องการ (ค่าเริ่มต้น 50, สูงสุด 200)' },
      },
    },
  },
  {
    name: 'get_financial_summary',
    description: 'ดูสรุปตัวเลขการเงินโดยรวม (รายรับที่ชำระแล้ว, รายจ่ายรวม, จำนวนบิลค้าง, ห้องว่าง, งานซ่อมค้าง)',
    input_schema: { type: 'object', properties: {} },
  },
  {
    // "เปิด AI ให้เข้าถึงข้อมูลทั้งหมด...จะทดสอบการตรวจสอบบัญชี"
    // (2026-08-02) — เพิ่มเครื่องมือสำหรับตรวจสอบบัญชีให้ครบขึ้น ไม่เกี่ยว
    // กับโค้ด/เซิร์ฟเวอร์เลย (ยังคงกฎถาวรใน CLAUDE.md — ไม่มีทางเข้าถึง
    // โค้ด/config ได้จาก tool ไหนเลยเหมือนเดิม) — PaymentLog คือ ledger
    // เงินเข้าจริงที่ Dashboard's "รายรับเดือนนี้" ใช้คำนวณ (แยกจาก
    // get_financial_summary ที่รวมจากยอด invoice status='paid') ใช้เทียบ
    // กันได้ว่าทำไมตัวเลข 2 จุดอาจไม่ตรงกัน (เช่น เครดิตล่วงหน้าที่ยัง
    // ไม่ได้ตัดเข้าบิลไหนเลย จะอยู่ใน PaymentLog แต่ไม่อยู่ใน invoice ไหน)
    name: 'get_payment_log',
    description: 'ดูประวัติรายการเงินเข้าจริงทั้งหมด (PaymentLog — ต่างจากยอดใน invoice ตรงที่นี่คือ ledger เงินสดจริงที่บันทึกทุกครั้งที่มีเงินเข้า ใช้ตรวจสอบบัญชี/หาสาเหตุตัวเลขไม่ตรงกัน) กรองตามห้องหรือช่วงวันที่ได้',
    input_schema: {
      type: 'object',
      properties: {
        roomId: { type: 'string', description: 'กรองเฉพาะห้องนี้ (ไม่ใส่ = ทุกห้อง)' },
        fromDate: { type: 'string', description: 'กรองตั้งแต่วันที่นี้ (YYYY-MM-DD, ไม่ใส่ = ไม่กรอง)' },
        toDate: { type: 'string', description: 'กรองถึงวันที่นี้ (YYYY-MM-DD, ไม่ใส่ = ไม่กรอง)' },
      },
    },
  },
  {
    name: 'get_unmatched_slips',
    description: 'ดูรายการสลิปที่ผู้เช่าส่งเข้ามาแต่ระบบยังจับคู่กับห้อง/บิลไม่ได้ (LINE ยังไม่เชื่อมต่อกับห้อง) — ใช้ตรวจสอบว่ามีเงินเข้าที่ยังไม่ถูกบันทึกเข้าห้องไหนหรือไม่',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'mark_invoice_paid',
    description: 'ทำเครื่องหมายว่าบิล/ใบแจ้งหนี้รายการนี้ชำระเงินแล้ว (จะส่งข้อความขอบคุณทาง LINE ให้ผู้เช่าด้วยอัตโนมัติ) — ต้องยืนยันก่อนทำจริง',
    input_schema: { type: 'object', properties: { invoiceId: { type: 'string', description: 'รหัสใบแจ้งหนี้ เช่น INV-101-171...' } }, required: ['invoiceId'] },
  },
  {
    name: 'create_invoice',
    description: 'สร้างใบแจ้งหนี้ใหม่ให้ห้องหนึ่ง — ต้องยืนยันก่อนทำจริง',
    input_schema: {
      type: 'object',
      properties: {
        roomId: { type: 'string', description: 'เลขห้อง เช่น 101' },
        water: { type: 'number', description: 'ค่าน้ำ (บาท)' },
        elec: { type: 'number', description: 'ค่าไฟ (บาท)' },
        due: { type: 'string', description: 'วันครบกำหนดชำระ (YYYY-MM-DD)' },
      },
      required: ['roomId'],
    },
  },
  {
    name: 'add_expense',
    description: 'เพิ่มรายการรายจ่ายใหม่ — ต้องยืนยันก่อนทำจริง',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'วันที่ (YYYY-MM-DD)' },
        category: { type: 'string', description: 'หมวดหมู่รายจ่าย' },
        desc: { type: 'string', description: 'รายละเอียด' },
        amount: { type: 'number', description: 'จำนวนเงิน (บาท)' },
      },
      required: ['desc', 'amount'],
    },
  },
  {
    name: 'delete_expense',
    description: 'ลบรายการรายจ่าย — ต้องยืนยันก่อนทำจริง (ลบแล้วกู้คืนไม่ได้)',
    input_schema: { type: 'object', properties: { expenseId: { type: 'string', description: 'รหัสรายการรายจ่าย' } }, required: ['expenseId'] },
  },
  {
    name: 'add_maintenance',
    description: 'เพิ่มรายการแจ้งซ่อมใหม่ — ต้องยืนยันก่อนทำจริง',
    input_schema: {
      type: 'object',
      properties: { roomId: { type: 'string', description: 'เลขห้อง' }, issue: { type: 'string', description: 'รายละเอียดปัญหา' } },
      required: ['roomId', 'issue'],
    },
  },
  {
    name: 'set_maintenance_status',
    description: 'เปลี่ยนสถานะงานซ่อม (ถ้าเป็น done จะปิดงาน/นำออกจากรายการ) — ต้องยืนยันก่อนทำจริง',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'รหัสงานซ่อม' }, status: { type: 'string', enum: ['pending', 'inprogress', 'done'] } },
      required: ['id', 'status'],
    },
  },
  {
    name: 'create_room',
    description: 'เปิดห้องใหม่ในระบบ (ห้องว่าง ยังไม่มีผู้เช่า) — ต้องยืนยันก่อนทำจริง',
    input_schema: {
      type: 'object',
      properties: {
        roomId: { type: 'string', description: 'เลขห้อง เช่น 103 (ต้องไม่ซ้ำกับห้องที่มีอยู่)' },
        floor: { type: 'number', description: 'ชั้นที่ตั้งของห้อง' },
        rent: { type: 'number', description: 'ค่าเช่ารายเดือน (บาท)' },
        deposit: { type: 'number', description: 'เงินมัดจำ (บาท) — ถ้าไม่ระบุ ระบบจะตั้งเป็น 0' },
      },
      required: ['roomId'],
    },
  },
  {
    name: 'delete_room',
    description: 'ลบห้องออกจากระบบทั้งหมด — ต้องยืนยันก่อนทำจริง (ลบแล้วกู้คืนไม่ได้ ควรใช้กับห้องว่างที่เปิดผิดเท่านั้น ไม่ควรลบห้องที่มีผู้เช่าอยู่หรือมีประวัติบิล)',
    input_schema: { type: 'object', properties: { roomId: { type: 'string', description: 'เลขห้องที่จะลบ' } }, required: ['roomId'] },
  },
  {
    name: 'open_contract_form',
    description: 'เปิดฟอร์มกรอก/แก้ไขสัญญาเช่าของห้องหนึ่งให้ผู้ใช้กรอกเอง — ใช้เครื่องมือนี้ทุกครั้งที่ถูกขอให้เพิ่ม/แก้ไขข้อมูลผู้เช่าหรือสัญญาเช่า (ชื่อผู้เช่า, เบอร์โทร, วันเข้าอยู่, วันสิ้นสุดสัญญา, ค่าเช่า, รหัส WiFi, รูปบัตรประชาชน, ไฟล์สัญญา ฯลฯ) เพราะมีข้อมูลบางส่วน (รูปภาพ/ไฟล์) ที่กรอกผ่านแชทไม่ได้ ต้องให้ผู้ใช้กรอกในฟอร์มจริงเสมอ — ไม่ต้องพยายามถามข้อมูลผู้เช่าเองทีละช่องในแชท แค่เปิดฟอร์มให้ก็พอ',
    input_schema: { type: 'object', properties: { roomId: { type: 'string', description: 'เลขห้องที่จะเปิดฟอร์มสัญญาเช่าให้' } }, required: ['roomId'] },
  },
  {
    name: 'add_calendar_event',
    description: 'เพิ่มนัดหมาย/กิจกรรมลงปฏิทินระบบ — ต้องยืนยันก่อนทำจริง สำคัญ: ต้องระบุ "เวลา" เสมอ (ถ้าผู้ใช้ไม่ได้บอกเวลา ให้ถามก่อน อย่าเดาเวลาเอง) และควรระบุว่าจะแจ้งเตือนผ่านช่องทางไหน — หมายเหตุ: การบันทึกช่องทางแจ้งเตือนตอนนี้เป็นแค่การบันทึกข้อมูลไว้อ้างอิง ระบบยังไม่ส่งการแจ้งเตือนอัตโนมัติเมื่อถึงเวลานัดหมายจริง (เป็นฟีเจอร์ที่ยังไม่ได้สร้าง)',
    input_schema: {
      type: 'object',
      properties: {
        year: { type: 'number', description: 'ปี ค.ศ. เช่น 2026' },
        month: { type: 'number', description: 'เดือน 1-12' },
        day: { type: 'number', description: 'วันที่ 1-31' },
        time: { type: 'string', description: 'เวลานัดหมาย รูปแบบ HH:MM เช่น 14:00 — จำเป็นต้องมี' },
        title: { type: 'string', description: 'ชื่อ/รายละเอียดกิจกรรม' },
        type: { type: 'string', description: 'ประเภทกิจกรรม เช่น ประชุม, ซ่อมบำรุง, อื่นๆ' },
        notifyChannel: { type: 'string', enum: ['line_broadcast', 'line_specific_room', 'none'], description: 'ช่องทางแจ้งเตือน — ถ้าเลือก line_broadcast หรือ line_specific_room ระบบจะตั้งเวลาส่งข้อความ LINE จริงให้อัตโนมัติตรงวัน-เวลานัดหมายนี้ (ต้องเปิดสวิตช์ "เปิดใช้งานฟีเจอร์นี้" ไว้ ไม่งั้นจะไม่ส่ง)' },
        notifyRoomId: { type: 'string', description: 'เลขห้องที่จะแจ้งเตือน — จำเป็นถ้า notifyChannel เป็น line_specific_room' },
      },
      required: ['year', 'month', 'day', 'time', 'title'],
    },
  },
  {
    name: 'delete_calendar_event',
    description: 'ลบนัดหมาย/กิจกรรมออกจากปฏิทิน — ต้องยืนยันก่อนทำจริง (ลบแล้วกู้คืนไม่ได้)',
    input_schema: { type: 'object', properties: { eventId: { type: 'string', description: 'รหัสนัดหมาย' } }, required: ['eventId'] },
  },
  {
    name: 'send_line_message',
    description: 'ส่งข้อความ LINE ทั่วไปถึงผู้เช่าห้องหนึ่งทันที (ห้องต้องเชื่อมต่อ LINE ไว้แล้ว) — ใช้สำหรับข้อความทั่วไปเท่านั้น ถ้าเป็นการแจ้ง/เตือนใบแจ้งหนี้บิลที่ยังไม่จ่าย ให้ใช้ send_invoice_reminder แทน (จะได้ข้อความแบบแจกแจงรายการและอัปเดตสถานะ "ส่งแล้ว" ให้ถูกต้อง) — ต้องยืนยันก่อนทำจริง',
    input_schema: {
      type: 'object',
      properties: { roomId: { type: 'string', description: 'เลขห้อง' }, message: { type: 'string', description: 'ข้อความที่จะส่ง' } },
      required: ['roomId', 'message'],
    },
  },
  {
    name: 'send_invoice_reminder',
    description: 'ส่งใบแจ้งหนี้/แจ้งเตือนบิลค้างชำระของห้องหนึ่งทาง LINE — ส่งข้อความแบบแจกแจงรายการ (ค่าเช่า/น้ำ/ไฟ/ขยะ/เน็ต/ยอดรวม/กำหนดชำระ) พร้อมสร้าง PDF บันทึกไว้ และทำเครื่องหมายว่า "ส่งแล้ว" ในระบบให้ถูกต้อง (ใช้แทน send_line_message เสมอเมื่อเป็นเรื่องบิล/ใบแจ้งหนี้) — ต้องยืนยันก่อนทำจริง',
    input_schema: {
      type: 'object',
      properties: { invoiceId: { type: 'string', description: 'รหัสใบแจ้งหนี้ที่จะส่ง' } },
      required: ['invoiceId'],
    },
  },
  {
    name: 'schedule_line_message',
    description: 'ตั้งเวลาส่งข้อความ LINE ล่วงหน้า (ไม่ส่งทันที ส่งจริงเมื่อถึงวัน-เวลาที่กำหนด) — ต้องยืนยันก่อนทำจริง ต้องเปิดสวิตช์ "เปิดใช้งานฟีเจอร์นี้" ไว้ ไม่งั้นข้อความจะไม่ถูกส่งเมื่อถึงเวลา',
    input_schema: {
      type: 'object',
      properties: {
        roomId: { type: 'string', description: 'เลขห้อง หรือ "all" เพื่อส่งให้ทุกห้องที่เชื่อมต่อ LINE แล้ว' },
        message: { type: 'string', description: 'ข้อความที่จะส่ง' },
        year: { type: 'number', description: 'ปี ค.ศ.' },
        month: { type: 'number', description: 'เดือน 1-12' },
        day: { type: 'number', description: 'วันที่ 1-31' },
        time: { type: 'string', description: 'เวลาที่จะส่ง รูปแบบ HH:MM' },
      },
      required: ['roomId', 'message', 'year', 'month', 'day', 'time'],
    },
  },
  {
    name: 'update_room_meter',
    description: 'บันทึกเลขมิเตอร์น้ำ และ/หรือ ไฟฟ้าปัจจุบันของห้องหนึ่ง (ถ้าห้องยังไม่มีเลขฐานมาก่อน จะตั้งเป็นเลขฐานให้ด้วยอัตโนมัติ) — ต้องยืนยันก่อนทำจริง',
    input_schema: {
      type: 'object',
      properties: {
        roomId: { type: 'string', description: 'เลขห้อง' },
        water: { type: 'number', description: 'เลขมิเตอร์น้ำปัจจุบัน (ไม่ระบุ = ไม่เปลี่ยน)' },
        elec: { type: 'number', description: 'เลขมิเตอร์ไฟปัจจุบัน (ไม่ระบุ = ไม่เปลี่ยน)' },
      },
      required: ['roomId'],
    },
  },
  {
    // "มาดูส่วนนี้การคาลิเบรตค่าน้ำจะเพิ่มการทำงานของ AI ให้สามารถกรอกค่า
    // น้ำ และค่าคาลิเบรตค่าน้ำแทนได้...ข้อมูลที่เข้าไปให้คาลิเบรตอาจมี
    // มากกว่า 1 ห้องก็ได้" (2026-08-12) — เหมือนปุ่ม "🎯 คาลิเบรตมิเตอร์น้ำ"
    // บนหน้า "Set อุปกรณ์" ทุกประการ (ใช้ฟังก์ชันร่วมกันจริง ไม่ใช่แค่หน้าตา
    // คล้ายกัน) แค่ทำได้หลายห้องพร้อมกันในคำสั่งเดียว — array เดียว ยืนยัน
    // popup เดียวครอบทุกห้อง (ตามที่คุณต้นยืนยันไว้)
    name: 'calibrate_water_meters',
    description: 'คาลิเบรตยอดสะสมมิเตอร์น้ำ (Tuya) ของห้องหนึ่งห้องขึ้นไป ให้ตรงกับค่า "Total Use" ที่เจ้าของอ่านจากแอป Tuya บนมือถือเอง (หน่วยลิตร) — ใช้เมื่อผู้ใช้บอกตัวเลขจริงจากแอปมาให้ปรับ เช่น "คาลิเบรตน้ำห้อง 1 เป็น 1162.3, ห้อง 2 เป็น 980" รับได้ทีละหลายห้องในคำสั่งเดียว ต้องยืนยันก่อนทำจริงเสมอ (ระบบจะแสดงยอดก่อน→หลังของทุกห้องให้ดูก่อน) — ใช้ไม่ได้กับห้องที่ยังไม่ได้เชื่อมต่ออุปกรณ์น้ำ Tuya\n\nสำคัญมากถ้าผู้ใช้แนบรูปหน้าจอแอป Tuya มาด้วย: หน้าจอนั้นมักมีตัวเลขหลายค่าปนกัน (เช่น "Single Use", "Daily Use", "Flow Rate", "Total Use") — appLiters ที่ใช้คาลิเบรตต้องเป็นค่า "Total Use" เท่านั้น (ยอดสะสมทั้งหมดตั้งแต่ติดตั้งอุปกรณ์) ห้ามใช้ "Single Use" หรือ "Daily Use" เด็ดขาด เพราะเป็นคนละความหมายกัน (ยอดใช้แค่ครั้งเดียว/วันเดียว ไม่ใช่ยอดสะสมทั้งหมด) ถ้าอ่านจากรูปแล้วหาค่า "Total Use" ไม่เจอ ให้ถามผู้ใช้กลับก่อนว่าตัวเลขไหนคือ Total Use อย่าเดา',
    input_schema: {
      type: 'object',
      properties: {
        calibrations: {
          type: 'array',
          description: 'รายการห้องที่จะคาลิเบรต อย่างน้อย 1 ห้อง',
          items: {
            type: 'object',
            properties: {
              roomId: { type: 'string', description: 'เลขห้อง' },
              appLiters: { type: 'number', description: 'ค่า Total Use (ลิตร) จากแอป Tuya ที่ผู้ใช้บอกมา' },
            },
            required: ['roomId', 'appLiters'],
          },
        },
      },
      required: ['calibrations'],
    },
  },
  {
    // ข้อยกเว้นถาวรเฉพาะจุด (2026-08-04, คุณต้นยืนยันชัดเจนแยกต่างหากจาก
    // "No code/server/credential access" — ดู CLAUDE.md's permanent rule
    // note เต็ม) — ส่งข้อความได้ทางเดียวเท่านั้น (write-only, ไม่มีทาง
    // อ่าน/แก้ไข/ควบคุมอะไรใน ช.นายท้ายกลับมาเลย) ใช้ secret เดียวกับ
    // ฟีเจอร์ส่งข้อความ LINE ข้ามระบบที่มีอยู่แล้ว (CHOR_NAITHAI_SHARED_KEY)
    // เรียกใช้ได้แค่ตอนคุณต้นพิมพ์สั่งในกล่องคำสั่งนี้เท่านั้น (ไม่มีทางถูก
    // เรียกจาก server/scheduler.js หรืองานอัตโนมัติอื่นใดเลย)
    name: 'report_to_chor_naithai',
    description: 'ส่งข้อความไปยังห้องแชทของ ช.นายท้าย (แพลตฟอร์มที่ 4 ที่คอยดูแล/ตรวจสอบระบบทั้งหมด) — ใช้เมื่อคุณต้นสั่งให้ไปแนะนำตัว/รายงานสถานะ/คุยกับทีม AI ตัวอื่นในห้องนั้น ใช้ได้เฉพาะตอนคุณต้นสั่งเท่านั้น ห้ามเรียกเองโดยไม่มีคำสั่ง',
    input_schema: {
      type: 'object',
      properties: {
        page: { type: 'string', enum: ['health', 'marketing', 'planning'], description: 'ห้องแชทปลายทาง: health=ดูแลระบบ, marketing=การตลาด, planning=แผนงาน' },
        message: { type: 'string', description: 'ข้อความที่จะส่ง' },
      },
      required: ['page', 'message'],
    },
  },
  {
    // ข้อยกเว้นถาวรที่ 2 (2026-08-04, วันเดียวกับข้อยกเว้นแรกด้านบน คุณต้น
    // ยืนยันแยกต่างหากอีกครั้ง) — อ่านย้อนกลับได้แล้ว แต่ **จำกัดแค่ห้อง
    // "health" เท่านั้น ตายตัวในโค้ด ไม่ใช่พารามิเตอร์ที่ AI เปลี่ยนได้** —
    // ทดสอบกับเช่าสุขตัวเดียวก่อน ยังไม่ได้อนุมัติให้แพลตฟอร์มอื่นทำตาม
    name: 'read_chor_naithai_room',
    description: 'อ่านข้อความล่าสุด 20 รายการในห้องแชท "ดูแลระบบ" ของ ช.นายท้าย — ใช้เพื่อดูว่าพี่ใหญ่หรือ AI ตัวอื่นในห้องนั้นตอบอะไรกลับมาหลังจากส่งข้อความไปแล้ว (report_to_chor_naithai) เรียกใช้ได้เฉพาะตอนคุณต้นสั่งเท่านั้น',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

const READ_TOOL_NAMES = new Set(['get_rooms', 'check_lease_completeness', 'get_pending_invoices', 'get_paid_invoices', 'get_maintenance', 'get_expenses', 'get_financial_summary', 'get_electricity_log', 'get_calendar_events', 'get_payment_log', 'get_unmatched_slips', 'read_chor_naithai_room']);

async function executeReadTool(name, input) {
  switch (name) {
    case 'get_rooms':
      return coerceRooms(await readTab('Rooms')).map((r) => ({
        id: r.id, status: r.status, tenant: r.tenant, phone: r.phone, rent: r.rent, deposit: r.deposit,
        moveIn: r.moveIn, contractEnd: r.contractEnd, dueDay: r.dueDay,
        wifiUsername: r.wifiUsername, wifiPassword: r.wifiPassword,
        waterPrev: r.waterPrev, waterCurr: r.waterCurr, elecPrev: r.elecPrev, elecCurr: r.elecCurr,
        lineConnected: !!r.lineUserId,
      }));
    case 'check_lease_completeness': {
      const rooms = coerceRooms(await readTab('Rooms'));
      // Only rooms with a tenant are expected to have a full contract on
      // file — a vacant room having no phone/WiFi/ID card yet is normal,
      // not a gap.
      const occupied = rooms.filter((r) => r.tenant && String(r.tenant).trim());
      const REQUIRED = [
        ['phone', 'เบอร์โทรผู้เช่า'],
        ['moveIn', 'วันที่เข้าอยู่'],
        ['contractEnd', 'วันสิ้นสุดสัญญา'],
        ['dueDay', 'วันครบกำหนดชำระรายเดือน'],
        ['wifiUsername', 'ชื่อผู้ใช้ WiFi/Internet'],
        ['wifiPassword', 'รหัสผ่าน WiFi/Internet'],
        ['tenantIdImg', 'รูปบัตรประชาชนผู้เช่า'],
        ['tenantIdExpiry', 'วันหมดอายุบัตรประชาชน'],
        ['leaseDocName', 'ไฟล์สัญญาเช่า'],
      ];
      return occupied.map((r) => {
        const missing = REQUIRED.filter(([key]) => !r[key] || !String(r[key]).trim()).map(([, label]) => label);
        return { room: r.id, tenant: r.tenant, complete: missing.length === 0, missing };
      });
    }
    case 'get_pending_invoices': {
      const invoices = coerceInvoices(await readTab('Invoices'));
      return invoices.filter((i) => i.status !== 'paid');
    }
    case 'get_paid_invoices': {
      const invoices = coerceInvoices(await readTab('Invoices'));
      let paid = invoices.filter((i) => i.status === 'paid');
      if (input.roomId) paid = paid.filter((i) => String(i.room) === String(input.roomId));
      paid.sort((a, b) => (b.paidDate || '').localeCompare(a.paidDate || ''));
      return paid;
    }
    case 'get_maintenance': {
      const list = coerceMaintenance(await readTab('Maintenance'));
      return input.status ? list.filter((m) => m.status === input.status) : list;
    }
    case 'get_expenses':
      return coerceExpenses(await readTab('Expenses'));
    case 'get_electricity_log': {
      let rows = await readTab('ElectricityLog');
      if (input.roomId) rows = rows.filter((r) => String(r.room) === String(input.roomId));
      rows.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      const limit = Math.min(Number(input.limit) || 50, 200);
      return rows.slice(0, limit);
    }
    case 'get_calendar_events': {
      let rows = coerceCalendar(await readTab('CalendarEvents'));
      if (input.year) rows = rows.filter((r) => r.y === Number(input.year));
      // r.m is stored 0-indexed (0=Jan..11=Dec, matching the calendar page's
      // own JS Date-based convention) but this tool's "month" param — like
      // everywhere else Claude sees dates — is always natural 1-12. Convert
      // at this boundary so the 0-indexed storage quirk never leaks out.
      if (input.month) rows = rows.filter((r) => r.m === Number(input.month) - 1);
      return rows.map((r) => ({ id: r.id, year: r.y, month: r.m + 1, day: r.d, time: r.time, title: r.title, type: r.type }));
    }
    case 'get_financial_summary': {
      const [invoices, expenses, rooms, maintenance] = await Promise.all([
        readTab('Invoices').then(coerceInvoices),
        readTab('Expenses').then(coerceExpenses),
        readTab('Rooms').then(coerceRooms),
        readTab('Maintenance').then(coerceMaintenance),
      ]);
      const paid = invoices.filter((i) => i.status === 'paid');
      const pending = invoices.filter((i) => i.status !== 'paid');
      const totalRevenue = paid.reduce((a, i) => a + i.rent + i.water + i.elec + (i.trash || 0) + (i.internet || 0), 0);
      const totalExpense = expenses.reduce((a, e) => a + e.amount, 0);
      return {
        totalRevenue, totalExpense, paidCount: paid.length, pendingCount: pending.length,
        vacantRooms: rooms.filter((r) => r.status === 'vacant').length, totalRooms: rooms.length,
        openMaintenance: maintenance.filter((m) => m.status !== 'done').length,
      };
    }
    case 'get_payment_log': {
      let rows = coercePaymentLog(await readTab('PaymentLog'));
      if (input.roomId) rows = rows.filter((r) => String(r.room) === String(input.roomId));
      if (input.fromDate) rows = rows.filter((r) => (r.date || '') >= input.fromDate);
      if (input.toDate) rows = rows.filter((r) => (r.date || '') <= input.toDate);
      rows.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      return { count: rows.length, total: rows.reduce((a, r) => a + (r.amount || 0), 0), rows };
    }
    case 'get_unmatched_slips':
      return coerceUnmatchedSlips(await readTab('UnmatchedSlips'));
    case 'read_chor_naithai_room': {
      // page: 'health' ตายตัวในโค้ด ไม่รับจาก input เลย (ดู CLAUDE.md's
      // permanent rule exception ที่ 2 — จำกัดแค่ห้องนี้ห้องเดียว)
      if (!process.env.CHOR_NAITHAI_SHARED_KEY) throw new Error('ยังไม่ได้ตั้งค่า CHOR_NAITHAI_SHARED_KEY ใน .env');
      const chorNaithaiUrl = process.env.CHOR_NAITHAI_URL || 'https://chor-naithai.onrender.com';
      const res = await fetch(`${chorNaithaiUrl}/api/chat/external?page=health`, {
        headers: { 'x-chor-naithai-key': process.env.CHOR_NAITHAI_SHARED_KEY },
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'อ่านไม่สำเร็จ (สถานะ ' + res.status + ')');
      }
      const data = await res.json();
      return (data.logs || []).map((l) => ({ timestamp: l.timestamp, speaker: l.speaker, content: l.content }));
    }
    default:
      throw new Error('ไม่รู้จักคำสั่งนี้: ' + name);
  }
}

// Human-readable Thai description of what a write tool WILL do, shown in the
// confirm popup before anything actually happens.
async function describeWriteTool(name, input) {
  const rooms = coerceRooms(await readTab('Rooms'));
  switch (name) {
    case 'mark_invoice_paid':
      return `ทำเครื่องหมายใบแจ้งหนี้ "${input.invoiceId}" เป็นชำระแล้ว และส่งข้อความขอบคุณทาง LINE ให้ผู้เช่า`;
    case 'create_invoice':
      return `สร้างใบแจ้งหนี้ใหม่ให้ห้อง ${input.roomId} (ค่าน้ำ ${input.water ?? 0} บาท, ค่าไฟ ${input.elec ?? 0} บาท${input.due ? ', ครบกำหนด ' + input.due : ''})`;
    case 'add_expense':
      return `เพิ่มรายจ่าย "${input.desc}" จำนวน ${input.amount} บาท${input.category ? ' หมวด ' + input.category : ''}`;
    case 'delete_expense':
      return `ลบรายการรายจ่ายรหัส "${input.expenseId}" (ลบแล้วกู้คืนไม่ได้)`;
    case 'add_maintenance':
      return `เพิ่มรายการแจ้งซ่อมห้อง ${input.roomId}: "${input.issue}"`;
    case 'set_maintenance_status':
      return input.status === 'done'
        ? `ปิดงานซ่อมรหัส "${input.id}" (จะนำออกจากรายการ)`
        : `เปลี่ยนสถานะงานซ่อมรหัส "${input.id}" เป็น "${input.status}"`;
    case 'send_line_message': {
      const room = rooms.find((r) => r.id === input.roomId);
      if (room && !room.lineUserId) return `ห้อง ${input.roomId} ยังไม่ได้เชื่อมต่อ LINE — ส่งไม่ได้`;
      return `ส่งข้อความ LINE ถึงห้อง ${input.roomId}: "${input.message}"`;
    }
    case 'send_invoice_reminder': {
      const invoices = coerceInvoices(await readTab('Invoices'));
      const invoice = invoices.find((i) => i.id === input.invoiceId);
      if (!invoice) return `ไม่พบใบแจ้งหนี้รหัส "${input.invoiceId}"`;
      const room = rooms.find((r) => r.id === invoice.room);
      if (room && !room.lineUserId) return `ห้อง ${invoice.room} ยังไม่ได้เชื่อมต่อ LINE — ส่งไม่ได้`;
      const total = invoice.rent + invoice.water + invoice.elec + (invoice.trash || 0) + (invoice.internet || 0);
      const remainingNote = (invoice.amountPaid || 0) > 0 ? ` — ยอดที่ต้องชำระจริงหลังหักเงินล่วงหน้า ${(invoice.remainingDue != null ? invoice.remainingDue : Math.max(0, total - invoice.amountPaid)).toLocaleString()} บาท` : '';
      return `ส่งใบแจ้งหนี้ ${invoice.id} ให้ห้อง ${invoice.room} ทาง LINE (รวม ${total.toLocaleString()} บาท${remainingNote}) พร้อมบันทึก PDF และมาร์คว่า "ส่งแล้ว"`;
    }
    case 'update_room_meter': {
      const parts = [];
      if (input.water != null) parts.push('น้ำ = ' + input.water);
      if (input.elec != null) parts.push('ไฟ = ' + input.elec);
      return `บันทึกเลขมิเตอร์ห้อง ${input.roomId}: ${parts.join(', ') || '(ไม่มีค่าที่จะบันทึก)'}`;
    }
    case 'calibrate_water_meters': {
      // "ถ้าพิมพ์คำสั่งคาลิเบรตหลายห้องพร้อมกัน...เห็น popup ยืนยันเดียว
      // ครอบทุกห้อง...โชว์ก่อนค่อยยืนยัน" (2026-08-12) — สรุป "ก่อน →
      // หลัง" ของทุกห้องในคำสั่งเดียว ให้เจ้าของเห็นครบก่อนกดยืนยันจริง
      // (อ่านอย่างเดียว ไม่เขียนอะไรตรงนี้ — executeWriteTool ค่อยเขียนจริง
      // หลังยืนยัน) — ใช้ตรรกะ "before" เดียวกับ calibrateWaterMeter's own
      // lookup (server/routes/tuya.js) แต่ไม่เรียกฟังก์ชันนั้นตรงๆ เพราะจะ
      // เขียนจริงทันที (มี safety check เรื่องน้ำกำลังไหลด้วย เช็คตอน
      // ยืนยันจริงพอ ไม่ต้องเช็คซ้ำสองรอบตอนแค่แสดงตัวอย่าง)
      const waterLog = await readTab('WaterLog');
      const lines = (input.calibrations || []).map((c) => {
        const room = rooms.find((r) => r.id === c.roomId);
        if (!room || !room.tuyaWaterDeviceId) return `ห้อง ${c.roomId}: ยังไม่ได้เชื่อมต่ออุปกรณ์น้ำ — จะข้ามห้องนี้`;
        const roomRows = waterLog.filter((r) => r.room === c.roomId.toString()).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        const before = roomRows[0] ? Number(roomRows[0].cumulativeLiters) || 0 : 0;
        const appLiters = Number(c.appLiters) || 0;
        const accuracy = appLiters > 0 ? Math.round((before / appLiters) * 1000) / 10 : null;
        return `ห้อง ${c.roomId}: ${before.toLocaleString()} → ${appLiters.toLocaleString()} ลิตร${accuracy != null ? ` (ของเดิมแม่นยำ ${accuracy}%)` : ''}`;
      });
      return `คาลิเบรตมิเตอร์น้ำ ${(input.calibrations || []).length} ห้อง:\n` + lines.join('\n');
    }
    case 'add_calendar_event': {
      const dateStr = `${input.year}-${String(input.month).padStart(2, '0')}-${String(input.day).padStart(2, '0')}`;
      const channelLabel = {
        line_broadcast: `ตั้งเวลาส่ง LINE แจ้งเตือนให้ทุกห้องที่เชื่อมต่อไว้ อัตโนมัติตรง ${dateStr} ${input.time} (ต้องเปิดสวิตช์ "เปิดใช้งานฟีเจอร์นี้" ไว้)`,
        line_specific_room: `ตั้งเวลาส่ง LINE แจ้งเตือนห้อง ${input.notifyRoomId || '(ยังไม่ระบุห้อง)'} อัตโนมัติตรง ${dateStr} ${input.time} (ต้องเปิดสวิตช์ "เปิดใช้งานฟีเจอร์นี้" ไว้)`,
        none: 'ไม่แจ้งเตือน',
      }[input.notifyChannel] || '';
      return `เพิ่มนัดหมาย "${input.title}" วันที่ ${dateStr} เวลา ${input.time}${input.type ? ' ประเภท ' + input.type : ''}${channelLabel ? ' — ' + channelLabel : ''}`;
    }
    case 'delete_calendar_event':
      return `ลบนัดหมายรหัส "${input.eventId}" (ลบแล้วกู้คืนไม่ได้)`;
    case 'create_room': {
      const rent = Number(input.rent) || 0;
      // 2026-07-24 — was `: rent * 2` (auto-calc 2x rent when no deposit
      // given). Changed to 0, matching the same default-fallback change
      // made to POST /api/rooms — see the comment there.
      const deposit = input.deposit != null ? Number(input.deposit) : 0;
      return `เปิดห้องใหม่ ${input.roomId} (ชั้น ${input.floor || 1}, ค่าเช่า ${rent} บาท, มัดจำ ${deposit} บาท) เป็นห้องว่าง`;
    }
    case 'delete_room': {
      const room = rooms.find((r) => r.id === input.roomId);
      const warn = room && room.tenant ? ` ⚠️ ห้องนี้มีผู้เช่าอยู่ (${room.tenant}) — ควรตรวจสอบก่อนลบ` : '';
      return `ลบห้อง ${input.roomId} ออกจากระบบทั้งหมด (ลบแล้วกู้คืนไม่ได้)${warn}`;
    }
    case 'open_contract_form':
      return `เปิดฟอร์มสัญญาเช่าห้อง ${input.roomId} ให้กรอก`;
    case 'schedule_line_message': {
      const dateStr = `${input.year}-${String(input.month).padStart(2, '0')}-${String(input.day).padStart(2, '0')}`;
      const target = input.roomId === 'all' ? 'ทุกห้องที่เชื่อมต่อ LINE แล้ว' : 'ห้อง ' + input.roomId;
      return `ตั้งเวลาส่ง LINE ถึง${target}: "${input.message}" ในวันที่ ${dateStr} เวลา ${input.time} (ต้องเปิดสวิตช์ "เปิดใช้งานฟีเจอร์นี้" ไว้ ไม่งั้นจะไม่ถูกส่งเมื่อถึงเวลา)`;
    }
    case 'report_to_chor_naithai': {
      const pageLabel = { health: 'ดูแลระบบ', marketing: 'การตลาด', planning: 'แผนงาน' }[input.page] || input.page;
      return `ส่งข้อความไปห้องแชท "${pageLabel}" ของ ช.นายท้าย: "${input.message}"`;
    }
    default:
      return `ทำรายการ "${name}"`;
  }
}

async function executeWriteTool(name, input) {
  switch (name) {
    case 'mark_invoice_paid': {
      // Found during an accounting audit: this used to only set
      // status:'paid' and never touched amountPaid, leaving remainingDue
      // (total - amountPaid) showing a leftover balance on an invoice that
      // was supposedly fully paid — status and amount disagreeing on the
      // same record. Compute the total first and set amountPaid to match,
      // same as the native form's markInvoicePaid handler.
      const existingInvoices = coerceInvoices(await readTab('Invoices'));
      const before = existingInvoices.find((i) => i.id === input.invoiceId);
      if (!before) throw new Error('ไม่พบใบแจ้งหนี้ ' + input.invoiceId);
      const total0 = before.rent + before.water + before.elec + (before.trash || 0) + (before.internet || 0);
      const updated = await updateRow('Invoices', input.invoiceId, { status: 'paid', paidDate: new Date().toISOString().slice(0, 10), amountPaid: total0 });
      const inv = coerceInvoices([updated])[0];
      const total = inv.rent + inv.water + inv.elec + (inv.trash || 0) + (inv.internet || 0);
      if (lineConfigured()) {
        const rooms = await readTab('Rooms');
        const room = rooms.find((r) => r.id === inv.room);
        if (room && room.lineUserId) {
          await pushMessage(room.lineUserId, `ขอบคุณที่ชำระค่าเช่าห้อง ${inv.room} จำนวน ${total.toLocaleString()} บาท เรียบร้อยแล้วครับ 🙏`).catch(() => {});
        }
      }
      return { ok: true, message: `ทำเครื่องหมายบิล ${input.invoiceId} เป็นชำระแล้ว` };
    }
    case 'create_invoice': {
      const rooms = await readTab('Rooms');
      const room = rooms.find((r) => r.id === input.roomId);
      if (!room) throw new Error('ไม่พบห้อง ' + input.roomId);

      // Same duplicate-bill guard as the native form's server route
      // (server/routes/invoices.js) — this tool bypasses that HTTP route
      // and writes to the Sheet directly, so the check needs to be
      // repeated here too, otherwise automation could stack a second bill
      // on top of an unresolved one for the same room.
      const existingInvoices = coerceInvoices(await readTab('Invoices'));
      const alreadyPending = existingInvoices.find((i) => i.room === input.roomId && i.status !== 'paid');
      if (alreadyPending) {
        throw new Error(`ห้อง ${input.roomId} มีใบแจ้งหนี้ค้างอยู่แล้ว (${alreadyPending.id}) กรุณาจัดการบิลเดิมให้เสร็จก่อน (แก้ไข/ลบ/ยืนยันชำระ) จึงจะออกบิลใหม่ได้`);
      }

      const settings = await readSettings();
      const rent = Number(room.rent) || 0, water = Number(input.water) || 0, elec = Number(input.elec) || 0;
      const trash = settings.trashRate, internet = settings.internetRate;
      const total = rent + water + elec + trash + internet;

      // Same auto-apply as the native "+ สร้างใบแจ้งหนี้" form (server/routes/
      // invoices.js) — a tenant's already-confirmed advance payment
      // (creditBalance) gets applied the moment a real bill exists for it.
      const roomCoerced = coerceRooms([room])[0];
      const credit = roomCoerced.creditBalance || 0;
      const applied = Math.min(credit, total);
      // Same fix as server/routes/invoices.js's POST / handler — credit
      // applied at creation time that doesn't fully cover the bill should
      // NOT mark the invoice 'partial' (that status is reserved for an
      // actual slip payment coming in short); it stays a normal 'pending'
      // bill for the remainder, so the next slip resolves against it
      // through the regular full/partial/credit flow.
      const status = applied >= total && total > 0 ? 'paid' : 'pending';

      const invoice = {
        id: 'INV-' + input.roomId + '-' + Date.now(),
        room: input.roomId, tenant: room.tenant || '', rent,
        water, elec, trash, internet,
        due: input.due || '', status, paidDate: status === 'paid' ? new Date().toISOString().slice(0, 10) : '',
        amountPaid: applied,
      };
      await appendRow('Invoices', invoice);
      const creditAfter = credit - applied;
      if (applied > 0) await updateRow('Rooms', input.roomId, { creditBalance: creditAfter });
      const creditNote = applied > 0 ? ` (หักจากเงินล่วงหน้าที่มีอยู่ ${applied.toLocaleString()} บาทให้อัตโนมัติ${status === 'paid' ? ' ครบจำนวนพอดี' : ', คงเหลือต้องชำระเพิ่ม'})` : '';
      // Same as the native "+ สร้างใบแจ้งหนี้" form: if credit was applied
      // and some is still left over afterward, tell the tenant both facts
      // (deducted + remaining) instead of leaving them to find out later.
      if (applied > 0 && creditAfter > 0 && lineConfigured() && room.lineUserId) {
        await pushMessage(room.lineUserId, `ตัดยอดเงินล่วงหน้าของห้อง ${input.roomId} ไปชำระบิลใหม่ (${invoice.id}) จำนวน ${applied.toLocaleString()} บาทแล้วครับ ยอดเงินล่วงหน้าคงเหลือ ${creditAfter.toLocaleString()} บาท ขอบคุณครับ 🙏`).catch(() => {});
      }
      return { ok: true, message: `สร้างใบแจ้งหนี้ ${invoice.id} แล้ว${creditNote}` };
    }
    case 'add_expense': {
      const item = { id: Date.now(), date: input.date || '', category: input.category || '', desc: input.desc, amount: Number(input.amount) || 0 };
      await appendRow('Expenses', item);
      return { ok: true, message: `เพิ่มรายจ่าย "${input.desc}" แล้ว` };
    }
    case 'delete_expense':
      await deleteRow('Expenses', input.expenseId);
      return { ok: true, message: `ลบรายจ่ายรหัส ${input.expenseId} แล้ว` };
    case 'add_maintenance': {
      const item = { id: Date.now(), room: input.roomId, issue: input.issue, status: 'pending', date: 'วันนี้' };
      await appendRow('Maintenance', item);
      return { ok: true, message: `เพิ่มงานซ่อมห้อง ${input.roomId} แล้ว` };
    }
    case 'set_maintenance_status':
      if (input.status === 'done') {
        await deleteRow('Maintenance', input.id);
        return { ok: true, message: `ปิดงานซ่อมรหัส ${input.id} แล้ว` };
      }
      await updateRow('Maintenance', input.id, { status: input.status });
      return { ok: true, message: `เปลี่ยนสถานะงานซ่อมรหัส ${input.id} แล้ว` };
    case 'send_line_message': {
      if (!lineConfigured()) throw new Error('ยังไม่ได้ตั้งค่า LINE บนเซิร์ฟเวอร์');
      const rooms = await readTab('Rooms');
      const room = rooms.find((r) => r.id === input.roomId);
      if (!room || !room.lineUserId) throw new Error('ห้อง ' + input.roomId + ' ยังไม่ได้เชื่อมต่อ LINE');
      await pushMessage(room.lineUserId, input.message);
      return { ok: true, message: `ส่งข้อความ LINE ถึงห้อง ${input.roomId} แล้ว` };
    }
    case 'send_invoice_reminder': {
      if (!lineConfigured()) throw new Error('ยังไม่ได้ตั้งค่า LINE บนเซิร์ฟเวอร์');
      const [invoices, rooms, settingsData] = await Promise.all([
        readTab('Invoices').then(coerceInvoices), readTab('Rooms'), readSettings(),
      ]);
      const invoice = invoices.find((i) => i.id === input.invoiceId);
      if (!invoice) throw new Error('ไม่พบใบแจ้งหนี้รหัส ' + input.invoiceId);
      const room = rooms.find((r) => r.id === invoice.room);
      if (!room || !room.lineUserId) throw new Error('ห้อง ' + invoice.room + ' ยังไม่ได้เชื่อมต่อ LINE');

      const rowsToShow = [
        ['ค่าเช่า', invoice.rent], ['ค่าน้ำ', invoice.water], ['ค่าไฟ', invoice.elec],
        ['ค่าขยะ', invoice.trash], ['ค่าอินเทอร์เน็ต', invoice.internet],
      ].filter(([, v]) => v);
      const total = rowsToShow.reduce((a, [, v]) => a + Number(v || 0), 0);
      // Same bug/fix as the native "ส่งข้อมูล (LINE)" button
      // (Rental Management.dc.html's sendReceiptLine) — a real user report:
      // this used to always show the raw bill total even when advance-
      // payment credit had already been auto-applied at invoice creation,
      // misleading the tenant about what they actually still owe.
      const amountPaid = invoice.amountPaid || 0;
      const remaining = invoice.remainingDue != null ? invoice.remainingDue : Math.max(0, total - amountPaid);
      const creditLines = amountPaid > 0
        ? [`หักจากเงินล่วงหน้าที่ชำระไว้แล้ว: ${amountPaid.toLocaleString()}`, `ยอดที่ต้องชำระจริง: ${remaining.toLocaleString()}`]
        : [];
      // "เพิ่มอีก 1 ช่องทาง คือ หมายเลขบัญชี ชื่อบัญชี ธนาคาร...ส่งข้อมูลไป
      // พร้อมใบเสร็จ" (2026-07-26) — เหมือนปุ่ม "ส่งข้อมูล (LINE)" บนเว็บ
      const bp = settingsData.propertyProfile || {};
      const bankLines = (bp.bankName || bp.bankAccountNumber || bp.bankAccountName)
        ? ['', 'โอนเงินเข้าบัญชี:', bp.bankName, bp.bankAccountNumber, bp.bankAccountName].filter(Boolean)
        : [];
      let message = [
        'ใบแจ้งหนี้ห้อง ' + invoice.room + ' (' + invoice.id + ')',
        ...rowsToShow.map(([label, v]) => label + ': ' + Number(v).toLocaleString()),
        'รวม: ' + total.toLocaleString(),
        ...creditLines,
        'กรุณาชำระก่อน ' + (invoice.due || '-'),
        ...bankLines,
      ].join('\n');
      // Same first-invoice welcome-message append as the native "ส่งข้อมูล
      // (LINE)" button (2026-07-26) — keep the two paths in sync.
      const isFirstInvoiceForRoom = invoices.filter((i) => i.room === invoice.room).length <= 1;
      if (isFirstInvoiceForRoom && settingsData.firstInvoiceMsg && settingsData.firstInvoiceMsg.trim()) {
        message += '\n\n' + settingsData.firstInvoiceMsg.trim();
      }
      await pushMessage(room.lineUserId, message);

      // Fire-and-forget PDF save — same as the direct UI button, a PDF
      // hiccup shouldn't block the LINE message or the confirm response.
      generateInvoicePdf(invoice, room, settingsData.propertyProfile)
        .then((buffer) => fs.writeFileSync(path.join(INVOICE_PDF_DIR, invoice.id.replace(/[^a-zA-Z0-9-]/g, '_') + '.pdf'), buffer))
        .catch((err) => console.error('[send_invoice_reminder] PDF save failed:', err.message));

      await updateRow('Invoices', invoice.id, { receiptSent: true });
      return { ok: true, message: `ส่งใบแจ้งหนี้ ${invoice.id} ให้ห้อง ${invoice.room} ทาง LINE แล้ว` };
    }
    case 'update_room_meter': {
      const rooms = await readTab('Rooms');
      const room = coerceRooms(rooms).find((r) => r.id === input.roomId);
      if (!room) throw new Error('ไม่พบห้อง ' + input.roomId);
      const patch = {};
      if (input.water != null) {
        patch.waterCurr = String(input.water);
        if (!(Number(room.waterPrev) > 0)) patch.waterPrev = String(input.water);
      }
      if (input.elec != null) {
        patch.elecCurr = String(input.elec);
        if (!(Number(room.elecPrev) > 0)) patch.elecPrev = String(input.elec);
      }
      if (!Object.keys(patch).length) return { ok: true, message: 'ไม่มีค่าที่ต้องบันทึก' };
      await updateRow('Rooms', input.roomId, patch);
      return { ok: true, message: `บันทึกเลขมิเตอร์ห้อง ${input.roomId} แล้ว` };
    }
    case 'calibrate_water_meters': {
      // "มาดูส่วนนี้การคาลิเบรตค่าน้ำจะเพิ่มการทำงานของ AI ให้สามารถกรอก
      // ค่าน้ำ และค่าคาลิเบรตค่าน้ำแทนได้" (2026-08-12) — เขียนจริงทีละห้อง
      // ผ่าน calibrateWaterMeter ตัวเดียวกับปุ่มบนหน้าเว็บ (รวม safety
      // check "ห้ามคาลิเบรตขณะกำลังใช้น้ำอยู่" ด้วย) — ห้องไหนพังไม่ทำให้
      // ทั้งชุดล้มเหลว (เช่น อาจมีห้องหนึ่งกำลังใช้น้ำอยู่พอดี) แจ้งผลรวม
      // แยกทีละห้องกลับไปให้เจ้าของเห็นครบ
      const creds = await readIntegrationCredentials();
      const results = [];
      for (const c of input.calibrations || []) {
        try {
          const r = await calibrateWaterMeter(c.roomId, c.appLiters, creds.tuya);
          results.push(`✅ ห้อง ${c.roomId}: ${r.before.toLocaleString()} → ${r.after.toLocaleString()} ลิตร (ของเดิมแม่นยำ ${r.accuracyPercent}%)`);
        } catch (err) {
          results.push(`❌ ห้อง ${c.roomId}: ล้มเหลว — ${err.message}`);
        }
      }
      return { ok: true, message: 'คาลิเบรตมิเตอร์น้ำเสร็จแล้ว:\n' + results.join('\n') };
    }
    case 'add_calendar_event': {
      const y = Number(input.year), m = Number(input.month), d = Number(input.day);
      const time = input.time || '09:00';
      const item = {
        // CalendarEvents' "m" column is stored 0-indexed (0=Jan..11=Dec) to
        // match the calendar page's own JS Date-based rendering — Claude's
        // "month" input is always natural 1-12, so convert here, at the
        // point the value actually gets written to the sheet.
        id: Date.now(), y, m: m - 1, d, time, title: input.title, type: input.type || 'อื่นๆ',
        notifyChannel: input.notifyChannel || 'none', // extra column — silently ignored by appendRow if the sheet header doesn't have it yet
      };
      await appendRow('CalendarEvents', item);

      let scheduledNote = '';
      if (input.notifyChannel === 'line_broadcast' || input.notifyChannel === 'line_specific_room') {
        const target = input.notifyChannel === 'line_broadcast' ? 'all' : (input.notifyRoomId || '');
        if (target) {
          const sendAt = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T${time}`;
          await appendRow('ScheduledMessages', {
            id: Date.now() + '-cal', room: target, message: `แจ้งเตือน: ${input.title} (${time} น.)`,
            sendAt, sent: 'FALSE', source: 'calendar',
          });
          scheduledNote = ' และตั้งเวลาแจ้งเตือน LINE ไว้แล้ว';
        }
      }
      return { ok: true, message: `เพิ่มนัดหมาย "${input.title}" ในปฏิทินแล้ว${scheduledNote}` };
    }
    case 'delete_calendar_event':
      await deleteRow('CalendarEvents', input.eventId);
      return { ok: true, message: `ลบนัดหมายรหัส ${input.eventId} แล้ว` };
    case 'create_room': {
      const id = String(input.roomId || '').trim();
      if (!id) throw new Error('กรุณาระบุเลขห้อง');
      const existing = await readTab('Rooms');
      if (existing.some((r) => r.id === id)) throw new Error('มีห้อง ' + id + ' อยู่แล้ว');
      const rent = Number(input.rent) || 0;
      const room = {
        id, floor: Number(input.floor) || 1, status: 'vacant', tenant: '', phone: '', rent,
        moveIn: '', contractEnd: '', deposit: input.deposit != null ? Number(input.deposit) : 0,
        waterMeterNo: 'W-' + id, elecMeterNo: 'E-' + id, waterPrev: 0, waterCurr: '0', elecPrev: 0, elecCurr: '0',
        wifiUsername: '', wifiPassword: '', dueDay: '', tenantIdImg: '', tenantIdExpiry: '', leaseDocName: '',
      };
      await appendRow('Rooms', room);
      return { ok: true, message: `เปิดห้อง ${id} แล้ว (ห้องว่าง)` };
    }
    case 'delete_room':
      await deleteRow('Rooms', input.roomId);
      return { ok: true, message: `ลบห้อง ${input.roomId} ออกจากระบบแล้ว` };
    case 'open_contract_form':
      // No-op here — the frontend intercepts this action before ever calling
      // /command/confirm and opens the native contract form directly instead.
      // This only runs if something calls confirm anyway; harmless either way.
      return { ok: true, message: `เปิดฟอร์มสัญญาเช่าห้อง ${input.roomId} แล้ว` };
    case 'schedule_line_message': {
      const sendAt = `${input.year}-${String(input.month).padStart(2, '0')}-${String(input.day).padStart(2, '0')}T${input.time}`;
      await appendRow('ScheduledMessages', {
        id: Date.now() + '-cmd', room: input.roomId, message: input.message,
        sendAt, sent: 'FALSE', source: 'manual',
      });
      return { ok: true, message: `ตั้งเวลาส่ง LINE ไว้แล้ว (${sendAt.replace('T', ' ')})` };
    }
    case 'report_to_chor_naithai': {
      // ครั้งแรกที่เช่าสุขเป็นฝ่าย "เรียกออก" ไปหา ช.นายท้าย (เดิมมีแค่ทาง
      // กลับ — ช.นายท้ายเรียกเข้ามาที่ /api/external ของเช่าสุขเท่านั้น) —
      // ใช้ secret ตัวเดียวกัน (CHOR_NAITHAI_SHARED_KEY) เข้ารหัสยืนยันตัวตน
      // ฝั่งปลายทาง (server/routes/chat.js's POST /api/chat/external ของ
      // ช.นายท้าย) — speaker: 'nong1' ระบุตัวตนว่าเป็นเช่าสุขเสมอ (ไม่ใช่
      // ตัวแปร ป้องกันไม่ให้เผลอปลอมเป็นน้องตัวอื่น)
      if (!process.env.CHOR_NAITHAI_SHARED_KEY) throw new Error('ยังไม่ได้ตั้งค่า CHOR_NAITHAI_SHARED_KEY ใน .env');
      const chorNaithaiUrl = process.env.CHOR_NAITHAI_URL || 'https://chor-naithai.onrender.com';
      const res = await fetch(`${chorNaithaiUrl}/api/chat/external`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-chor-naithai-key': process.env.CHOR_NAITHAI_SHARED_KEY },
        body: JSON.stringify({ page: input.page, speaker: 'nong1', content: input.message }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'ส่งไม่สำเร็จ (สถานะ ' + res.status + ')');
      }
      return { ok: true, message: 'ส่งข้อความไปห้องแชท ช.นายท้ายแล้ว' };
    }
    default:
      throw new Error('ไม่รู้จักคำสั่งนี้: ' + name);
  }
}

module.exports = { TOOLS, READ_TOOL_NAMES, executeReadTool, describeWriteTool, executeWriteTool };
