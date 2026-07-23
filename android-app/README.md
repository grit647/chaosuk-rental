# เช่าสุข — Android app (WebView wrapper)

"เปลือกแอป" ห่อเว็บเช่าสุข (`https://chaosuk-rental.onrender.com`) ที่มีอยู่แล้ว
— ไม่มีระบบธุรกิจ/ฐานข้อมูลอะไรใหม่เลย จอเดียวคือ WebView ที่โหลดหน้า
`/login` ของเว็บจริงตรงๆ (สำเนาโครงสร้างเดียวกับโปรเจกต์ check-service-24
ที่เคยทำ android-app มาก่อน แต่ตัดฟีเจอร์เสียงพูด/Foreground Service ออก
ทั้งหมด — เช่าสุขไม่มีระบบเลขาเสียง แค่ต้องการทางลัดเปิดแอปเข้าเว็บตรงๆ)

## โครงสร้าง

- `app/src/main/java/com/chaosuk/rentalapp/MainActivity.java` — Activity
  เดียวทั้งแอป สร้าง WebView แล้วโหลด `SITE_URL` ตรงๆ
- `app/src/main/res/` — โลโก้/ธีมสีของแบรนด์ (ส้ม `#C1622D` + ตัวอักษร "ช"
  สีขาว) ตามที่ใช้อยู่ในเว็บจริง

## Build

Build ผ่าน GitHub Actions อัตโนมัติ (ดู `.github/workflows/build-android.yml`
ที่ root ของ repo) — push อะไรก็ตามที่แก้ในโฟลเดอร์ `android-app/` จะ
trigger build debug APK ให้เอง แล้ว commit ไฟล์กลับเข้า
`server/downloads/chaosuk-rental-app.apk` โดยอัตโนมัติ ไม่ต้องมี Android
Studio ในเครื่องเลย

Build มือ (ถ้ามี Android Studio + JDK 17):
```
cd android-app
./gradlew assembleDebug
```
ไฟล์ APK จะอยู่ที่ `app/build/outputs/apk/debug/app-debug.apk`

## ติดตั้งบนมือถือ

APK นี้เป็น build แบบ debug (ไม่ได้เซ็นด้วย key จริงสำหรับขึ้น Play Store)
— ติดตั้งตรงจากไฟล์ต้องกด "อนุญาตติดตั้งจากแหล่งอื่น" ก่อน (ปกติสำหรับ
APK นอก Play Store)

## แก้ URL ปลายทาง

แก้ค่า `SITE_URL` ใน `MainActivity.java` บรรทัดเดียว ถ้าต้องการชี้ไปหน้า
อื่น/เซิร์ฟเวอร์อื่น (เช่น ทดสอบกับ ngrok/localhost ก่อน deploy จริง)

## ไอคอนแอป

`ic_launcher_foreground.xml` เป็นเส้น vector ที่พยายามวาดตัวอักษร "ช" เอง
แบบประมาณรูปทรง (ไม่ใช่ฟอนต์จริง) — ถ้าดูแล้วไม่สวยพอ แนะนำใช้ Android
Studio's Image Asset wizard แทน (คลิกขวา `res` > New > Image Asset >
อัปโหลดภาพหน้าจอตราสัญลักษณ์ "ช" จริงจากเว็บ — มีอยู่แล้วใน
`login.html`/`my-buildings.html`) จะได้ไอคอนที่แม่นยำกว่านี้มาก
