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

const { readTab, appendRow, updateRow, deleteRow } = require('./sheets');
const { coerceRooms, coerceInvoices, coerceMaintenance, coerceExpenses, coerceCalendar, readSettings } = require('./coerce');
const { pushMessage, isConfigured: lineConfigured } = require('./line');

const TOOLS = [
  {
    name: 'get_rooms',
    description: 'ดูรายชื่อห้องทั้งหมด พร้อมสถานะ (ว่าง/มีผู้เช่า/ค้างชำระ), ผู้เช่า, เบอร์โทร, ค่าเช่า, มัดจำ, เลขมิเตอร์น้ำ-ไฟปัจจุบัน, และรายละเอียดสัญญาเช่า (วันที่เข้าอยู่, วันสิ้นสุดสัญญา, วันครบกำหนดชำระรายเดือน, รหัส WiFi) — ใช้เครื่องมือนี้สำหรับคำถามเกี่ยวกับสัญญาเช่าด้วย',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_pending_invoices',
    description: 'ดูรายการบิล/ใบแจ้งหนี้ที่ยังไม่ได้ชำระ (ค้างจ่าย)',
    input_schema: { type: 'object', properties: {} },
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
        notifyChannel: { type: 'string', enum: ['line_broadcast', 'line_specific_room', 'none'], description: 'ช่องทางแจ้งเตือนที่ต้องการ (บันทึกไว้อ้างอิงเท่านั้น ยังไม่ส่งอัตโนมัติ)' },
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
    description: 'ส่งข้อความ LINE ถึงผู้เช่าห้องหนึ่ง (ห้องต้องเชื่อมต่อ LINE ไว้แล้ว) — ต้องยืนยันก่อนทำจริง',
    input_schema: {
      type: 'object',
      properties: { roomId: { type: 'string', description: 'เลขห้อง' }, message: { type: 'string', description: 'ข้อความที่จะส่ง' } },
      required: ['roomId', 'message'],
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
];

const READ_TOOL_NAMES = new Set(['get_rooms', 'get_pending_invoices', 'get_maintenance', 'get_expenses', 'get_financial_summary', 'get_electricity_log', 'get_calendar_events']);

async function executeReadTool(name, input) {
  switch (name) {
    case 'get_rooms':
      return coerceRooms(await readTab('Rooms')).map((r) => ({
        id: r.id, status: r.status, tenant: r.tenant, phone: r.phone, rent: r.rent, deposit: r.deposit,
        moveIn: r.moveIn, contractEnd: r.contractEnd, dueDay: r.dueDay, wifiCode: r.wifiCode,
        waterPrev: r.waterPrev, waterCurr: r.waterCurr, elecPrev: r.elecPrev, elecCurr: r.elecCurr,
        lineConnected: !!r.lineUserId,
      }));
    case 'get_pending_invoices': {
      const invoices = coerceInvoices(await readTab('Invoices'));
      return invoices.filter((i) => i.status !== 'paid');
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
      if (input.month) rows = rows.filter((r) => r.m === Number(input.month));
      return rows;
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
    case 'update_room_meter': {
      const parts = [];
      if (input.water != null) parts.push('น้ำ = ' + input.water);
      if (input.elec != null) parts.push('ไฟ = ' + input.elec);
      return `บันทึกเลขมิเตอร์ห้อง ${input.roomId}: ${parts.join(', ') || '(ไม่มีค่าที่จะบันทึก)'}`;
    }
    case 'add_calendar_event': {
      const dateStr = `${input.year}-${String(input.month).padStart(2, '0')}-${String(input.day).padStart(2, '0')}`;
      const channelLabel = { line_broadcast: 'แจ้งเตือนผู้เช่าทุกห้องทาง LINE (แค่บันทึกไว้ ยังไม่ส่งอัตโนมัติ)', line_specific_room: 'แจ้งเตือนห้องที่เกี่ยวข้องทาง LINE (แค่บันทึกไว้ ยังไม่ส่งอัตโนมัติ)', none: 'ไม่แจ้งเตือน' }[input.notifyChannel] || '';
      return `เพิ่มนัดหมาย "${input.title}" วันที่ ${dateStr} เวลา ${input.time}${input.type ? ' ประเภท ' + input.type : ''}${channelLabel ? ' — ' + channelLabel : ''}`;
    }
    case 'delete_calendar_event':
      return `ลบนัดหมายรหัส "${input.eventId}" (ลบแล้วกู้คืนไม่ได้)`;
    default:
      return `ทำรายการ "${name}"`;
  }
}

async function executeWriteTool(name, input) {
  switch (name) {
    case 'mark_invoice_paid': {
      const updated = await updateRow('Invoices', input.invoiceId, { status: 'paid', paidDate: new Date().toISOString().slice(0, 10) });
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
      const settings = await readSettings();
      const invoice = {
        id: 'INV-' + input.roomId + '-' + Date.now(),
        room: input.roomId, tenant: room.tenant || '', rent: Number(room.rent) || 0,
        water: Number(input.water) || 0, elec: Number(input.elec) || 0,
        trash: settings.trashRate, internet: settings.internetRate,
        due: input.due || '', status: 'pending', paidDate: '',
      };
      await appendRow('Invoices', invoice);
      return { ok: true, message: `สร้างใบแจ้งหนี้ ${invoice.id} แล้ว` };
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
    case 'add_calendar_event': {
      const item = {
        id: Date.now(), y: Number(input.year), m: Number(input.month), d: Number(input.day),
        time: input.time || '09:00', title: input.title, type: input.type || 'อื่นๆ',
        notifyChannel: input.notifyChannel || 'none', // extra column — silently ignored by appendRow if the sheet header doesn't have it yet
      };
      await appendRow('CalendarEvents', item);
      return { ok: true, message: `เพิ่มนัดหมาย "${input.title}" ในปฏิทินแล้ว` };
    }
    case 'delete_calendar_event':
      await deleteRow('CalendarEvents', input.eventId);
      return { ok: true, message: `ลบนัดหมายรหัส ${input.eventId} แล้ว` };
    default:
      throw new Error('ไม่รู้จักคำสั่งนี้: ' + name);
  }
}

module.exports = { TOOLS, READ_TOOL_NAMES, executeReadTool, describeWriteTool, executeWriteTool };
