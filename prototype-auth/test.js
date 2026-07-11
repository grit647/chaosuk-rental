// Run with: node test.js
// Reads whatever rows currently exist in the "Users" tab of the test
// directory sheet and tries a couple of lookups against them, to prove
// the phone+PIN -> role/routing concept actually works end-to-end.
const { lookupLogin, readUsers } = require('./lookup');

(async () => {
  console.log('--- Current rows in the test directory sheet ---');
  const users = await readUsers();
  console.log(users.length ? users : '(no rows yet — add some in the sheet first, see below)');

  if (!users.length) {
    console.log(`
ยังไม่มีข้อมูลในชีตเลยครับ ลองเพิ่มแถวตัวอย่างในแท็บ Users ดูก่อน เช่น:

phone         pin    role     customerSheetId                              roomId  staffId
0812345678    1111   tenant   1AbCdEfGhIjKlMnOpQrStUvWxYz (ตัวอย่าง)         103
0898765432    2222   staff    1AbCdEfGhIjKlMnOpQrStUvWxYz (ตัวอย่าง)                  S1
0891112223    3333   owner    1AbCdEfGhIjKlMnOpQrStUvWxYz (ตัวอย่าง)

แล้วรันสคริปต์นี้ใหม่อีกครั้งครับ (node test.js)
`);
    return;
  }

  console.log('\n--- ทดสอบ lookup ---');
  for (const u of users) {
    const result = await lookupLogin(u.phone, u.pin);
    console.log(`เบอร์ ${u.phone} + PIN ${u.pin} ->`, result);
  }

  console.log('\n--- ทดสอบ PIN ผิด (ควรได้ null) ---');
  const wrong = await lookupLogin(users[0].phone, 'ผิดแน่นอน');
  console.log('ผลลัพธ์:', wrong);
})().catch((err) => {
  console.error('เกิดข้อผิดพลาด:', err.message);
});
