# เช่าสุข (chaosuk-rental) — Project Notes

Rental management web app for a real property. Frontend is a single declarative
template file (`Rental Management.dc.html`, rendered by `support.js`). Backend
is `server/` (Express + Google Sheets as the database). Deployed on Render at
https://chaosuk-rental.onrender.com, source at `grit647/chaosuk-rental` on GitHub.

Owner/maintainer: คุณต้น (not a programmer by training — explain changes in
plain Thai, avoid assuming CS background).

## Owner's working style (applies across ALL projects: เช่าสุข, ชัวร์ทรัพย์, ที่ปรึกษางาน)

**How Claude Code should interact with คุณต้น, regardless of project:**

- **Language:** Always Thai. Avoid unnecessary technical jargon; explain
  concepts in plain, practical terms. If using English terms (API, webhook,
  UUID), define them briefly in Thai context.
- **Communication style:** Short, direct, to-the-point. No fluff or over-
  explanation. Clarity > length.
- **Decision-making:** Offer choices, don't dictate. When there are
  multiple valid paths, present options and ask which one to take —
  don't just pick one and go. (e.g., "3 naming options: A, B, C — which
  one?") rather than "I recommend A").
- **Pacing:** Never rush. If คุณต้น says "สักครู่" (hold on), wait — don't ask
  again or continue unprompted. Respect that he may be handling other tasks.
- **When not at desk:** Assume higher risk. Require explicit confirmation
  for any destructive/side-effect operations; avoid yes/no popups that
  require immediate response. If a popup appears and he's away, assume
  "Deny" is the safe choice (don't auto-allow).
- **Relationship:** This is mutual learning — Claude learns his patterns,
  he learns what Claude can do. Over time, communication should feel like
  working with a teammate who "gets it" without having to explain every
  detail.

## Brand identity

**The real/official logo** (per explicit owner confirmation): an orange
(`#C1622D`) rounded-square badge with the character **"ช"** in it, next to
the wordmark **"เช่าสุข"**. Used consistently everywhere now —
`login.html`, `my-buildings.html`, `staff-login.html`, `tenant-login.html`
all match. (`staff-login.html`/`tenant-login.html` originally used
different colors/letters as a role-color-coding choice made when those
pages were first built — owner explicitly asked for both to be
reconciled to the real logo, done.) If any NEW page ever needs a
logo badge, use this exact same styling.

## Known issues / follow-ups

### Permanent gotcha: multi-tenant = separate physical Google Sheets — new columns/tabs must be retrofitted to EVERY existing customer's Sheet, not just the main one

**Discovered concretely 2026-07-23**, same investigation as the Tuya
water section right below. This app's multi-tenant model isn't
row-filtering within one shared spreadsheet (like the check-service-24
sister project) — each customer/building genuinely has its own
separate Google Spreadsheet (`customerSheetId` in the Directory,
`runWithSheetId()` swaps `sheets.js` to read/write that specific one
for the request). That means **any time a new column gets added to an
existing tab, or a new tab gets added, the migration only ever touches
whichever ONE spreadsheet was open at the time** (almost always the
main/test account's own `GOOGLE_SHEET_ID`) — every other customer's
physically separate spreadsheet silently stays on the old schema
forever, with no error anywhere, until someone actually tries to use
the new field and it silently no-ops.

**Concrete real-world case that surfaced this:** `tuyaWaterDeviceId`/
`tuyaWaterMaxLiters` columns exist on the main account's `Rooms` tab
and on "บ้านพักครูโจ"'s own separate `Rooms` tab, but were **missing
entirely** from "บ้านเลขที่1873"'s own separate `Rooms` tab (a building
added later than when those columns were migrated in). The owner
typed a real water Device ID into the Set อุปกรณ์ form, got a "บันทึก
สำเร็จ" success toast (the PATCH request itself succeeded, HTTP 200),
but the value never actually persisted — `updateRow()` rewrites a row
based on the header row's column positions, and there was no
`tuyaWaterDeviceId` header to place the value under, so it silently
dropped. Symptom the owner reported: "พอกดรีเฟรชหน้าเว็บ แล้วอุปกรณ์
หายไป" (after refreshing the page, the device disappeared) — looked
like data loss, was actually "never saved in the first place, no error
surfaced anywhere in the whole chain." Same root-cause class as the
missing `WaterLog` tab covered below (that one silently no-op'd the
cumulative-total merge instead of a room field, but identical
mechanism: assume every customer Sheet has the latest schema, when in
fact only whichever one was open during the original migration does).

**Fixed for now:** added the 2 missing `Rooms` columns to
"บ้านเลขที่1873"'s spreadsheet directly (appended at the end,
preserving existing column positions/data — the same safe pattern as
every other one-off Sheet migration in this project). Also created the
missing `WaterLog` tab there and in "บ้านพักครูโจ"'s spreadsheet (see
below).

**Not fixed architecturally — a real gap for a future session:** there
is currently **no systematic way to know which of N customer
spreadsheets are missing which columns/tabs**, and no migration-runner
that applies a schema change to all of them at once. Every future
schema change (new `Rooms` column, new log tab, etc.) needs to be
manually re-applied to every existing customer's spreadsheet
one-by-one, the same ad-hoc way this session just did for 2 buildings
— easy to forget one, especially as more customers get added. If this
becomes a recurring pain point, worth building either (a) a proper
migration runner that iterates every `customerSheetId` in the
Directory and applies pending schema changes, or (b) a lazy
column-repair step in `sheets.js`'s `readTab()`/`updateRow()` that
notices a target column is missing and appends it on the fly before
writing. Neither exists today — flagging so a future session
doesn't have to re-discover this the hard way (via another silent
"my save didn't work" report).

**Recurred again 2026-07-24, exact same mechanism:** owner reported
"ช่องนี้...กรอกข้อมูลอะไรไม่ได้ครับ" (this field won't accept input) for
the "ค่าเช่าล่วงหน้า" (advance rent) field on the lease contract form,
specifically on "บ้านเลขที่1873". Investigation initially chased the
wrong lead (checked the frontend `<input>`/`onchange` wiring
extensively — found nothing wrong, deposit's identical sibling field
worked fine) before checking the actual Sheet columns directly and
finding `migrate-add-advance-rent.js` (run when the feature first
shipped, per `server/platformVersion.js`'s v2 changelog note) had only
ever been run against the main account — บ้านเลขที่1873's own separate
spreadsheet was still missing the `advanceRent` column entirely,
identical to the `tuyaWaterDeviceId` incident above. Typing DID work
fine the whole time; the value just silently never persisted on save
(reopening the form always showed it blank again), which from the
owner's side was indistinguishable from "can't type here at all."
**Lesson for next time a "field won't take input" report comes in:**
check the target building's actual Sheet header row for the column
BEFORE spending time on frontend event-binding archaeology — this is
now the second time that's been the real cause. Fixed by re-running
`migrate-add-advance-rent.js` against บ้านเลขที่1873 AND บ้านพักครูโจ
(both were missing it) with each building's `customerSheetId` as the
CLI arg. Also proactively re-ran the newer
`migrate-add-owner-lineqr-columns.js` (added earlier the same session,
for `ownerIdImg`/`ownerIdExpiry`/`lineQrImg` — see the "Uploaded
files...don't survive a deploy" section's neighboring note about those
3 fields having working UI but never persisting) against both of those
buildings too, since it had only been run against the main account
when first written — pre-emptively closing the same gap before it
became a third support report.

### Tuya water flowmeter — 2 separate Cloud Projects (fixed), scale bug (fixed), cumulative total (new tracking built, not yet wired into billing) — 2026-07-23

**สรุปสั้นๆ สำหรับคนอ่านใหม่ (TL;DR) — บันทึกไว้ตามคำขอคุณต้น "บันทึก
ข้อมูลไว้ให้น้องใหม่ด้วยครับ":**

ปัญหาเริ่มต้น: อุปกรณ์น้ำ (Tuya flowmeter) ในหน้า "Set อุปกรณ์" ขึ้น
"ออฟไลน์"/ไม่มีข้อมูล ทั้งที่อุปกรณ์ไฟใช้งานได้ปกติ — สืบสาวไปเจอว่า
เป็น **ปัญหาสะสม 4 ชั้น ไม่ใช่จุดเดียว**:

1. **Tuya Cloud Project แยกกัน 2 โปรเจกต์** — อุปกรณ์ไฟถูก authorize
   ไว้ในโปรเจกต์เก่า (ตกค้างจากขั้นตอนทดสอบช่วงพัฒนาแรกสุด, Access ID
   `3cr4wn7...`), อุปกรณ์น้ำถูก authorize ไว้ในโปรเจกต์ใหม่คนละอัน
   ("ช.เช่าสุข", Access ID `d83edt9...`) — credential ชุดไหนก็เห็นได้
   แค่ประเภทเดียว ไม่เคยเห็นทั้งไฟและน้ำพร้อมกัน **แก้โดยเชื่อมบัญชี
   Smart Life ของอุปกรณ์ไฟเข้าโปรเจกต์ใหม่ด้วย** (ดูรายละเอียดเต็ม
   ด้านล่าง) แล้วอัปเดต `TUYA_ACCESS_ID`/`TUYA_ACCESS_SECRET` เป็นชุด
   `d83edt9...`/`6abe17d1...` ทั้งใน `server/.env` (เครื่อง dev) และใน
   Render's Environment Variables (เว็บจริง — **ต้องอัปเดตแยกต่างหาก
   เอง เพราะ `.env` อยู่ใน `.gitignore` ไม่เคย push ขึ้น repo เลย**)
   รวมถึงหน้า "ตั้งค่า" ของ "บ้านพักครูโจ"/"บ้านเลขที่1873" ด้วย
   (per-customer override, คนละกลไกกับ `server/.env`)

2. **หน้า "Set อุปกรณ์" เลือกห้องผิด (บั๊กโค้ด, แก้แล้ว)** — ค่าเริ่มต้น
   ของตัวแปร `equipSelectedRoom` ตั้งเป็นห้อง `'101'` แบบเดาไว้ตอนสร้าง
   state ครั้งแรก (ก่อนโหลดข้อมูลห้องจริงจาก server เสร็จ) — ถ้าตึกไหน
   ไม่มีห้องชื่อ "101" อยู่จริง (เช่น บ้านเลขที่1873 มีแต่ห้อง 1, 14 ฯลฯ)
   dropdown จะโชว์ห้องแรกที่มีจริง แต่ป้ายชื่อห้อง/ข้อมูลอุปกรณ์ด้านล่าง
   ยังอ้างอิงห้อง "101" ผีที่ไม่มีจริงอยู่ — ข้อมูลไม่ตรงกัน ("เลือกห้อง 1
   แต่แสดงห้อง 101") **แก้แล้ว**: `loadFromServer()` เช็คหลังโหลดห้อง
   จริงเสร็จ ถ้า `equipSelectedRoom` ปัจจุบันไม่ตรงกับห้องไหนเลยจริง
   จะสลับไปห้องแรกที่มีจริงให้อัตโนมัติ

3. **ชีต Google Sheet แต่ละตึกไม่เหมือนกัน (สถาปัตยกรรม multi-tenant —
   ดู section ด้านบน "Permanent gotcha")** — บาง Sheet ขาดแท็บ
   `WaterLog` (ยอดสะสมค้าง 0 ตลอด), บาง Sheet ขาดคอลัมน์
   `tuyaWaterDeviceId`/`tuyaWaterMaxLiters` เลย (กด "บันทึก" ได้
   success toast ปกติ แต่ข้อมูลไม่เคยถูกเก็บจริง — ดูเหมือน "อุปกรณ์
   หายไป" ทั้งที่จริงคือไม่เคยบันทึกสำเร็จตั้งแต่แรก) **แก้แล้วทั้ง 2
   ตึกที่พบปัญหา** (บ้านพักครูโจ, บ้านเลขที่1873)

4. **หน่วยข้อมูลจากตัวอุปกรณ์เองผิด (บั๊กจาก Tuya, แก้แล้ว)** — รายละเอียด
   เต็มด้านล่าง (สรุปสั้นๆ: อุปกรณ์บอก scale ผิด ทำให้ตัวเลขคลาดเคลื่อน
   10 เท่าจากความเป็นจริง)

**สถานะล่าสุด (ยืนยันจากคุณต้นเอง "ตอนนี้ระบบเราเชื่อมได้ปรกติกับ tuya
แล้วนะครับ"):** บ้านพักครูโจ + บ้านเลขที่1873 เชื่อมต่อได้ปกติทั้งไฟ
และน้ำแล้ว ผ่านการตรวจสอบจริงทุกจุด — เหลือแค่บัญชีหลัก/ตึกทดสอบ
(`server/.env`) ที่ต้องรอคุณต้นไปอัปเดต Render's Environment Variables
เองอีกขั้นเดียว (คำสั่งเต็มอยู่ในข้อ 1 ด้านบน) ถึงจะเห็นน้ำได้บนเว็บจริง
ของบัญชีนั้น

**Backstory, for context on why 2 Tuya Cloud Projects existed:** the very
first Tuya integration (see the old Phase 3 plan notes) was built by
temporarily linking the actual property owner's ("น้อง's") real Tuya
account into a project on the developer's own side, purely to test
against real device data during development. Once the feature was
delivered, that dev-side project was deleted and น้อง was told to link
her own phone directly to her own project instead — but the elec
breaker device had been set up under a DIFFERENT Smart Life account
than the one used to re-link water flowmeters later, so the two device
types ended up authorized under two genuinely separate Tuya Cloud
Projects with different Access ID/Secret pairs. Confirmed by testing:
old project (Access ID `3cr4wn7...`, still in `server/.env` at the time)
could read the elec breaker but got "permission deny" on any water
flowmeter; a newer project "ช.เช่าสุข" (Access ID `d83edt9...`, the one
actually open in the Tuya console) had all 56 water flowmeters
authorized via App Account `ribo_new@hotmail.com` but couldn't see the
elec device at all. **Fixed** by linking the elec device's own Smart
Life account into the "ช.เช่าสุข" project too (Cloud > Devices > Link
App Account > Tuya App Account Authorization) — confirmed both device
types (`ห้อง14` breaker, `Flowmeter 14` etc.) now read successfully
under the single `d83edt9...` credential pair. `server/.env`'s
`TUYA_ACCESS_ID`/`TUYA_ACCESS_SECRET` should be updated to this pair
once the owner confirms he's ready (not yet swapped as of this
writing — the old pair still works for existing linked elec devices,
so nothing is broken right now, just not yet consolidated).

**Real bug found + fixed in `server/tuya.js`'s `getWaterReading()`:**
this device family ("Bluetooth Flowmeter", category `slj`) reports its
own DP scale metadata WRONG — `/specifications` claims `water_use_data`/
`water_once` have `scale: 0` (i.e. divide raw value by 1), but the true
scale is ÷10 (values are in units of 0.1 L). Confirmed by comparing the
phone app's own "Single Use: 5.2 L" readout against the exact same
moment's raw `water_once` value (52) — 52 ÷ 10 = 5.2, not 52 ÷ 1 = 52.
Hardcoded scale=10 for these two DP codes specifically (the general
`findScale()`-from-spec approach, still used for `cur_voltage`/
`cur_current`/etc. in `getElecReading`, is NOT trustworthy for this
device family — don't assume other water-flowmeter DP codes are safe
without similarly verifying against the app first).

**Real gap found:** `water_use_data` — meant to be this device family's
cumulative lifetime total, the water equivalent of the elec meter's
`total_forward_energy` — never actually updates on real hardware
(confirmed: zero Report Logs entries over a 24h window, permanently
stuck reporting `0`). The phone app's own "Total Use" (932.5 L at time
of testing) is a real, continuously-growing number the app computes
server-side by summing individual `water_once` "single-use session"
events — not readable from a simple device-status poll.

**Built (not yet wired into invoices):** `getWaterUsageDeltaLiters()`
in `server/tuya.js` replays `water_once` history via Tuya's Report
Logs API (`GET /v2.0/cloud/thing/{id}/report-logs`) and detects
CONFIRMED-complete sessions (a session's peak = whatever value came
right before the next log entry drops lower, i.e. a reset). Only
counts sessions with a confirmed reset after them — an in-progress
session's events are left for the next poll to pick up once its own
reset eventually shows up, so nothing gets double-counted or counted
prematurely. New `WaterLog` Sheet tab (`id, timestamp, room,
cumulativeLiters, lastProcessedEventTimeMs, flowRate, batteryPercent`)
— `routes/tuya.js`'s `GET /status` now also fire-and-forget-appends a
row per water-linked room, hourly-throttled like `ElectricityLog`,
building its own running total going forward from each room's latest
logged watermark. **Reconstructing an exact match to Tuya's own
lifetime "Total Use" isn't possible retroactively** (their own
accounting isn't fully exposed via this API) — a first full-history
test run (30-day lookback, first-ever poll for a fresh device) landed
at 677.3 L vs the app's 932.5 L, which is the expected kind of gap
(the app's total likely includes usage from before the 30-day window,
plus any sessions genuinely still in-progress at poll time are
correctly excluded until they complete).

**2026-07-23 same-day follow-up — dashboard display now wired (billing
still is not):** the "Set อุปกรณ์" page's "ลิตร (L) สะสม" readout was
still showing the permanently-stuck 0 (it reads straight off
`getWaterReading()`'s `usage` field). Per explicit owner request
("ค่าตรงนี้พร้อมอัปเดทยังครับ" → "เชื่อมเลยครับ"), `routes/tuya.js`'s
`GET /status` now overwrites `resultMap[roomId].usage` with that room's
latest `WaterLog.cumulativeLiters` right before responding — no
frontend change needed since `Rental Management.dc.html`'s
`equipSelLiveWaterUsage` already just reads `.usage` off the merged
per-room object. This is a **read-only dashboard display change
only**.

**Still explicitly NOT done, needs a follow-up decision:** the water
*billing* flow (`deviceCharge('water', ...)` equivalent, mirroring how
elec's `total_forward_energy` feeds invoices) still computes off the
old always-zero path, not `WaterLog`. Wiring billing to read from
`WaterLog` needs the owner to watch the dashboard's now-live number
accumulate correctly over a few real poll cycles first before trusting
it for a real invoice — this is money-affecting, same caution level as
the `Lease contracts are core data` rule below. Flagging here so a
future session doesn't have to re-derive this whole investigation.

**2026-07-24 follow-up — manual calibration workflow, now a real UI
feature (`v3` gate):** confirmed with the owner that the reconstructed
`WaterLog` cumulative total is directionally correct but always
UNDER-counts vs. the Tuya app's own real "Total Use" (expected — see
"can't retroactively reconstruct" note above), so a "calibration" step
was needed: type the app's real number in, overwrite the web's running
total to match, keep accumulating from there. First did this by hand
for 4 devices in "บ้านเลขที่1873" (rooms 1, 2, 3, 14 — writing a new
`WaterLog` row with the confirmed liters + the existing
`lastProcessedEventTimeMs` watermark preserved, via one-off scripts).
Results (all 4 rooms, web reading BEFORE calibration ÷ app's real
reading): room 2 91.1%, room 1 81.9%, room 3 77.4%, room 14 71.7% —
average ~80.5%, always under never over, confirming the pulse-counting
formula itself has no bug, it just starts counting later than the
device's true lifetime total.

Owner then asked for this to be a real button instead of me running
ad-hoc scripts every time ("แบบนี้ง่ายกว่า ครับ เพิ่มช่อง คาริเบท
มิเตอร์น้ำ ใส่ค่าน้ำ ในหน้า App กด คาริเบท") — **built and shipped**:
- **`POST /api/tuya/calibrate-water`** (`server/routes/tuya.js`) — body
  `{ roomId, appLiters }`, writes a new `WaterLog` row with
  `cumulativeLiters: appLiters`, preserving the existing
  `lastProcessedEventTimeMs` watermark from that room's latest row (so
  the next hourly poll doesn't reprocess/skip anything, just adds new
  pulses on top of the corrected baseline). Returns `{ before, after,
  accuracyPercent }` (`before ÷ after × 100`, i.e. how accurate the
  auto-calculated total was right before this calibration).
- **UI** — "Set อุปกรณ์" page, น้ำ tab, new box "🎯 คาลิเบรตมิเตอร์น้ำ"
  under the live-readout card: an input for the app's Total Use value
  + a "คาลิเบรต" button, showing "ก่อนคาลิเบรต → หลัง" and the accuracy
  % after each run (`Rental Management.dc.html` — state fields
  `waterCalibrateInput`/`waterCalibrateResult`, handlers
  `onWaterCalibrateInput`/`calibrateWaterDevice`).
- **Gated behind `platformVersion >= 3`** (`cfShowWaterCalibrate`,
  `server/platformVersion.js`'s `CURRENT_PLATFORM_VERSION = 3`) per the
  staged-rollout rule below — only meaningful for buildings that
  already have a `WaterLog` tab in their own Sheet AND real Tuya water
  devices linked (see the "Permanent gotcha" note at the top — new
  tabs/columns don't automatically exist on every customer's own
  spreadsheet). Already bumped to v3 for the 3 buildings actually using
  Tuya water today: บ้านเลขที่1873, บ้านพักครูโจ, ตึกหลัก (main
  account/`server/.env`). A brand-new future building would need its
  own `WaterLog` tab created first (same manual one-off step as always)
  before "🆕 อัปเดต" is clicked for it, or the calibrate button will
  render but silently fail on click (no tab to write into).
- Also discovered while spot-checking: บ้านพักครูโจ's 3 water rooms
  (22/3, 22/4, 22/6) and the main account's room 101 all point to the
  exact SAME physical Tuya device IDs as already-calibrated
  บ้านเลขที่1873 rooms (1, 2, 14 respectively) — a device's real "Total
  Use" is a property of the device itself, not the room record, so
  those 4 rooms' calibrated values were copied directly rather than
  needing their own separate app lookup.
- Any OTHER still-uncalibrated rooms in บ้านเลขที่1873 (4, 6, 7, 8, 9,
  10, 12, 13, 15 — rooms 5/11 had no `WaterLog` data at all yet) are
  still running on the raw auto-calculated total, not yet calibrated
  against the app — use the new button next time the owner checks each
  one's real value in the Tuya app.

### "คุยกับ Claude AI ผ่าน LINE" — text works, voice needs OPENAI_API_KEY (pending)

**Status:** Built and deployed (commit `355da75`, session redesigned
after that in commit around `owner:ai` postback + `AI_SESSION_TTL_MS`).
Text part is fully live — tapping "เปิดโหมด Claude AI" on the owner's Rich
Menu starts a 5-minute AI chat session (in-memory `aiConversations` Map,
keyed per LINE user); any text message from that LINE account while the
session is live routes through the exact same tool-calling assistant as
the web command box (see `server/routes/line.js`'s `handleOwnerAiText`,
reusing `buildCommandSystemPrompt`/`extractText` exported from
`server/routes/claude.js` and the same `TOOLS`/`executeReadTool`/
`executeWriteTool` from `claudeTools.js` — kept in sync with the web
version deliberately, not a separate copy). **Per explicit owner
follow-up, this replaced an earlier persistent on/off toggle design**
(a `lineAiModeEnabled` Settings flag + a visual 🟢/⚪ badge on the Rich
Menu image itself, requiring TWO pre-built menu variants) — the owner
found the on/off-with-a-visible-badge concept unnecessary complexity and
asked for a simple auto-expiring session instead: every message sent
resets the 5-minute idle clock (`touchAiSession()`); no message for 5
minutes = the session silently lapses, no explicit "turn it off" action
needed, and the Rich Menu image itself has no on/off state to show
anymore (`ownerRichMenuId` is a SINGLE variant again, same as the
tenant/staff menus — `ownerRichMenuIdOn`/`ownerRichMenuIdOff` are
retired). Write actions ask for a "ยืนยัน"/"ยกเลิก" reply in chat instead
of the web's popup (in-memory `aiPendingWrites` Map, separate 2-minute
window). `create_room`/`open_contract_form` are hard-blocked same as
`automation.js`'s `FORM_ONLY_TOOLS` (CLAUDE.md's permanent rule below —
chat can never substitute for the native contract/room form).

**Voice/mic is coded but NOT usable yet** — needs an `OPENAI_API_KEY` env
var (OpenAI's Whisper API, a separate provider from `ANTHROPIC_API_KEY` —
Anthropic's Messages API has no audio content-block support) set on
Render's production environment variables. The owner chose this option
explicitly ("ต่อ Whisper API เลยตอนนี้") over a text-only-for-now MVP.
**Waiting on the owner to paste an OpenAI API key in chat** (get one at
platform.openai.com) — once received: add `OPENAI_API_KEY` to `server/.env`
locally AND Render's environment variables, redeploy, then voice messages
sent to the LINE OA (while AI mode is on) will transcribe via
`transcribeAudio()` in `server/claude.js` and feed into the same
`handleOwnerAiText` handler as typed text. Until then, a voice message
sent to the bot gets a polite Thai error explaining it's not set up yet —
no crash, no silent failure.

### Uploaded files (slip images, invoice PDFs, LINE broadcast images) don't survive a deploy

**Status:** Open — accepted as a known trade-off for now, revisit if it becomes
a real problem.

Render's free tier gives the app an **ephemeral disk** — anything written to
`server/uploads/` (slip photos from `server/routes/line.js`'s image-message
handler, invoice PDFs from `server/pdf.js`, LINE broadcast images from
`server/routes/uploads.js`) is wiped on every deploy/restart, not just on a
crash. This was first noticed 2026-07-08: a tenant's test payment slip
(`server/routes/line.js` → `handleSlipImage`) was uploaded, then several code
deploys happened before the owner reviewed it, and the image came back broken
in the review modal — even though the *extracted* data (amount, date, sender
name, stored on the `Invoices` sheet row via `slipPending`/`slipAmount`/etc.)
was still intact and correct.

**Why it's low-risk most days:** deploys only happen during active
development sessions like this one. In normal day-to-day use (no code pushes
happening), an uploaded slip will sit on disk untouched until the owner
reviews and confirms/rejects it, same as it always has.

**If this needs a real fix**, the options (not yet decided/built):
1. A persistent disk add-on on Render (small monthly cost).
2. Push images to a third-party object store (S3, Cloudinary, etc. — needs a
   signup + credentials, some free tiers exist).
3. Store the image as a Sheet-embedded base64 value — impractical, Sheets
   cells cap out around ~50k characters, a compressed JPEG is usually bigger.

Ask the owner before spending money on option 1/2 — they were informed of
this trade-off and initially said the free/no-signup approach was fine when
building the slip-verification feature, this note exists so a future session
can pick the conversation back up instead of re-discovering the bug.

### PIN-gated actions store the PIN as plain text — by design, low-security

**Status:** Accepted trade-off, deliberate — not a bug.

Several "are you sure" gates in this app (ล้างข้อมูลทั้งหมด factory reset,
the "ผู้ดูแลระบบ" card's save-confirm, LINE self-link via typing the PIN
instead of a room number — all in `server/routes/settings.js` /
`server/routes/line.js`) are protected by a short PIN. These PINs are
stored as **plain text** in the `Settings` Google Sheet tab (`dataResetPin`,
`adminEditPin` keys) — not hashed, not encrypted. This app has no real
authentication system, so there was never a secure place to hash against;
the PIN is meant to stop an accidental click/tap or an unauthorized person
with app access, not to withstand someone who can already open the
underlying Google Sheet (which is restricted to the owner + the service
account, same trust boundary as everything else in this app).

**Owner was told explicitly:** never reuse a real banking/sensitive PIN
here — treat these as a friction gate, not real security.

**Master recovery code:** `server/routes/settings.js` hardcodes a
permanent constant, `MASTER_RECOVERY_PIN = 'werty1122'`, which always
works as the "old PIN" step when changing the ผู้ดูแลระบบ card's PIN
(`POST /api/settings/change-admin-pin`) — explicitly requested by the
owner as a way to help a user (himself, or a future customer if this app
is ever resold — see the 1:1-for-now note above) recover access if they
forget their own PIN. Deliberately kept OUT of the Sheet (hardcoded in
source instead of a `Settings` row) specifically so it doesn't sit in
plain text next to the regular PIN where anyone glancing at the Sheet
would see both together. If this app is ever actually resold/multi-
tenant, this constant needs to move to a real per-deployment secret
instead of a shared hardcoded value — flagging now so a future session
doesn't miss it.

**Login-PIN fallback (added later, per explicit user request):**
`POST /api/settings/verify-admin-pin` — the shared endpoint behind
every one of these "are you sure" gates — now accepts the owner's own
LOGIN PIN (the one used at `/login`, phone+pin) as an alternative to
this building's own `adminEditPin`, looked up from the shared
Directory sheet matched strictly by the session's own
`customerSheetId`. Reasoning: `adminEditPin` and the login PIN are two
deliberately separate concepts (see the `change-admin-pin` comment
above), but an owner shouldn't get stuck on a confirm dialog just
because they forgot which of the two applies here — this makes either
one work, without merging the two concepts together.

**Follow-up question the owner asked directly (2026-07-14):** "if a
customer changes their login PIN from the one I originally gave them,
can WE still find out their current PIN?" — **Yes, today.** Since
nothing here is hashed, whatever the CURRENT value is (after any number
of changes) is always readable in plain text by anyone who can open the
underlying Google Sheet (คุณต้น himself, or anyone holding the service
account credentials) — not just the original value handed out at
signup. This is the direct practical consequence of the plain-text
design above, called out explicitly because it matters most for the
future resale/multi-tenant scenario: a real paying customer likely
would NOT expect the platform operator to be able to look up their
current password at will. **Owner asked to record this as a concrete
TODO for a future session** (not started yet, no code changed for
this): hash every PIN before it's ever written to a Sheet (`adminEditPin`,
`dataResetPin`, the Directory sheet's login `pin` column, each Admins-tab
row's own `pin`) — likely bcrypt, comparing hashes on verify instead of
plain equality (`server/routes/settings.js`'s `verify-admin-pin`/
`change-admin-pin`, `server/routes/auth.js`'s `/login`/`/staff-login`,
`server/routes/line.js`'s several self-link PIN-match branches all
currently do `===` plain-string comparison and would need updating).
The `MASTER_RECOVERY_PIN` design (above) would need to stay as a
separate, never-hashed bypass mechanism regardless, same reasoning as
today — just needs to move out of a shared hardcoded constant into a
real per-deployment secret first (already flagged above). Worth doing
before any real second customer relies on this system for anything
sensitive; not urgent for today's actual usage (คุณต้น + 1 known
2nd building, both trusted).

### LINE webhook — now supports per-customer webhook URLs (FIXED)

**Status:** Done. Was open (main property only) — fixed per explicit
user request while building the Rich Menu features, once a real "เข้าใช้
งานหน้าเว็ปไซต์"/multi-building conversation surfaced that this was
actually blocking something concrete (not just a theoretical gap
anymore).

`server/routes/line.js`'s webhook route is now `POST /webhook/
:customerSheetId?` — the segment is OPTIONAL, so the existing
registration for the main property (plain `/webhook`, already live in
its LINE Developers Console) keeps working unchanged. A second
building (e.g. บ้านพักครูโจ) registers its OWN distinct URL
(`https://chaosuk-rental.onrender.com/api/line/webhook/<their
customerSheetId>`) in ITS OWN LINE Developers Console, using its own
saved Channel Secret/Access Token (Settings gear-icon form, same
`readIntegrationCredentials()` the outbound `/send`/`/status` routes
already used).

**How it works:** the whole handler body runs inside
`runWithSheetId(targetSheetId, ...)` — same AsyncLocalStorage-based
per-request Sheet scoping every other route in this app already uses.
Once wrapped, credential resolution and every `readTab`/`updateRow`/
`appendRow` call inside naturally resolves to that building's own
Sheet without needing to touch individual call sites. The resolved
LINE credentials are threaded down through every outgoing LINE API
call (`verifySignature`, `replyMessage`, `getMessageContent`,
`linkRichMenuToUser`) via a small `reply(text)` closure defined in
each handler function — replaced ~20 individual call sites this way,
safer than editing each one by hand and impossible to miss threading
creds through a new call added later.

Also fixed the last hardcoded main-property assumption found while
doing this: the tenant/owner Rich Menu auto-login token builders now
use `getCurrentSheetId()` (the same ambient context) instead of a
hardcoded `process.env.GOOGLE_SHEET_ID`, so a tenant/owner tapping a
Rich Menu button on a SECOND building's own LINE OA gets linked back
into THAT building specifically.

**Still needed for a second building to actually use this:** they
need their own Rich Menus set up too — re-run `prototype-auth/setup-
tenant-richmenu.js`/`setup-owner-richmenu.js`/`setup-staff-richmenu.js`
passing their `customerSheetId` as the CLI arg (uses their own saved
LINE credentials automatically), and register their own webhook URL in
their own LINE Developers Console as described above.

**A second building is now actually live (2026-07-15): "บ้านพักครูโจ"**
(OB1บ้านพักครูโจ, `customerSheetId`
`1_018tkPfe3OLIyeA_lyek8o0H8esbi15-hBiuAqWzvA`) — own dedicated GCP
project + service account (NOT shared with the main property's), own
LINE OA channel with Messaging API enabled, own Channel Access
Token/Secret saved via the Settings gear-icon form, own webhook URL
registered and verified, all 3 Rich Menus (tenant/owner/staff)
generated and confirmed working live (at least one real tenant self-
linked and saw their menu correctly). This is the first real proof the
per-customer-webhook multi-building design above actually works
end-to-end for a genuinely separate customer, not just the main
property. If a THIRD building ever gets added, follow the exact same
steps this one went through as a template.

### Interactive demo/tutorial site (tap-to-explain, real save, resets hourly)

**Status:** Started — mechanism built and working, currently covers ONLY
the บิล & ใบแจ้งหนี้ page (per explicit request, "ทำหน้าส่วนบิลใบแจ้งหนี้
ดีกว่าผมว่า สำคัญสุด" — considered the most important page). The other 7
pages from the original scoping (ห้องพัก, ผู้เช่า, แจ้งซ่อม, ปฏิทิน,
รายจ่าย, Set อุปกรณ์, ตั้งค่า) still have NO tooltips at all — add them
the same way (see "How to add tips to another page" below) when picked
back up.

**All 3 previously-open decisions got made:**
- **Access:** dedicated `GET /demo` route (server/index.js) — no login
  form, sets a session with `role: 'demo'` scoped to a dedicated Sheet
  (`DEMO_SHEET_ID` env var, `10TD0QgpWhJxPnNHjkxTfjVGT5YbSr6g3PMg0fxbMCEY`).
  **Set on Render's production environment variables too now — verified
  working live.** Also linked from `login.html`'s own footer ("Demo —
  อธิบายการใช้งานแพลตฟอร์ม"), so a prospective customer landing on the
  real login page has an obvious way to find it without needing to
  already know the `/demo` URL.
- **Reset:** hourly cron, same external-ping pattern as
  `server/routes/scheduler.js` — see `.github/workflows/demo-reset.yml`
  (`curl .../api/demo-reset/run` every hour on the hour). The actual
  reseed logic lives in `server/demoSeed.js` (shared by the route and
  the one-time manual seed script `prototype-auth/seed-demo-data.js`) —
  clears every tab, writes back 4 baseline demo rooms (one each:
  pending bill, overdue bill, already-paid history, vacant) + 3 matching
  invoices + basic Settings (rates, a simple demo PIN `1234`).
- **Tooltip UX:** tap/click a small "❓" badge (not hover — this app is
  used on mobile a lot, hover doesn't work on touch) opens a single
  shared **centered** overlay (dimmed backdrop, tap outside or × to
  close — originally bottom-anchored, moved to center per explicit
  follow-up request since it was easy to miss near the browser's own
  UI chrome on mobile) with the explanation. One shared piece of state
  (`demoTipId` in `Rental Management.dc.html`) rather than per-badge
  state, since only one tip is ever open at once.
- Sidebar also shows a small green **"Demo"** tag right next to the
  "ช เช่าสุข" logo/brand name at the very top (visible even scrolled),
  plus a small "?" marker next to any nav item whose page already has
  tooltips built — both `isDemo`-gated, both per explicit follow-up
  requests after the first round of feedback.

**Security/scoping already handled, verified working:**
- A demo session (`role: 'demo'`) automatically gets ZERO platform-admin
  rights (`isPlatformAdminSession`'s whitelist only allows `'owner'`)
  and is NOT blocked by the tenant-only API restriction in
  `server/index.js` (that check is specifically `role === 'tenant'`) —
  a demo session behaves like a normal, fully-scoped-to-its-own-Sheet
  owner session, which is exactly right since it's a real, isolated
  Sheet with throwaway data, not real customer data.
- The green "โหมดทดลองใช้งาน — ข้อมูลรีเซ็ตทุกชั่วโมง" sidebar badge and
  every "❓" tip badge are gated behind `isDemo` (from `GET /api/auth/
  me`) — invisible for every real customer's own session, only ever
  shown when `customerSheetId` is the dedicated Demo Sheet.

**How to add tips to another page:** add the explanation text to the
`DEMO_TIPS` object near the top of `Rental Management.dc.html`'s
`<script>` block, add a render-var handler (`onDemoTip<Name>: () =>
this.showDemoTip('<key>')`), and drop a `<sc-if value="{{ isDemo }}">`
-wrapped "❓" badge (copy the styling from one of the existing บิล page
badges) next to whatever UI element needs explaining. No other wiring
needed — the bottom-banner display and open/close logic are already
shared/generic.

**Pages with tooltips so far:** บิล & ใบแจ้งหนี้, ห้องพัก (room cards +
detail panel), สัญญาเช่า (the separate contracts table page — the
owner's original scoping note called these two "ห้องพัก (rooms/
contracts)" as one item, but they're actually two distinct nav items/
pages in the real UI, both done now), ปฏิทิน (date picker, add-event
form, LINE broadcast button), **ตั้งค่า** (one tip per card — property
info, LINE admin notifications, Tuya connection, LINE OA connection,
Google Sheet status, feature toggles, system data/factory reset —
explicitly requested as "the most important page, cover every button").
Also one exception tip on **แดชบอร์ด** (auto-refresh toggle only —
Dashboard is otherwise still excluded from the tour, this one control
was a deliberate one-off exception since the owner asked for it
directly). Also **Set อุปกรณ์** (Tuya IoT page — 5 tips: page overview,
room/ไฟ-น้ำ tab selector, อุปกรณ์ไฟฟ้า card, อุปกรณ์น้ำ card, and the
สถานะอุปกรณ์ status lists incl. the ตัดไฟ/จ่ายไฟ button — explicitly
requested for IoT-using customers), **การใช้น้ำประปา** (Claude meter-
photo reader, with an explicit note that it needs Claude API connected
first), **การใช้ไฟฟ้า** (the 12/24/48-hour window chips, and why they
disappear once a room has a real Tuya device linked), the **Claude
ผู้ช่วยดูแลอัตโนมัติ** settings card (3 tips: overview, the text/voice
command box, the "+"  attach menu, and the "เปิดใช้งานฟีเจอร์นี้"
toggle — carefully worded to match actual code behavior, not the
owner's initial mental model, since the toggle only gates scheduled
messages, not the interactive chat box), the **sidebar account card**
(bottom-left "จัดการผู้ดูแล" entry point), **แจ้งซ่อม** + **บัญชีรายจ่าย**
(2 tips each), and finally **ผู้เช่า** (3 tips: page overview, the
Token·การเชื่อมต่อ Auto(LINE)/กรอกเอง toggle, and the ส่งข่าวสาร button
— explicitly requested last, "เหลืออันเดียว"). **Every nav page in the
app now has demo tooltip coverage** — the full tour is complete. If a
new page/feature is added later, follow "How to add tips to another
page" above to extend it.

### One LINE account linked to multiple roles → menu switches on re-link — DELIBERATE design (not a bug)

**Status:** Was a theoretical worry, then became a real reproduced
incident (2026-07-14 — see below), then the owner explicitly decided
NOT to build a technical fix and instead make this an intentional,
understood mechanic: **whichever role you self-link as most recently
is the menu you see** — type your PIN → owner/ผู้ดูแล menu; type your
room's phone number → tenant menu; switch back and forth anytime just
by re-typing the corresponding credential. `server/routes/line.js`'s 3
self-link confirmation replies (owner PIN, ผู้ดูแล PIN+phone, tenant
phone) now each explicitly say "เมนูด้านล่างเปลี่ยนเป็น...แล้วนะครับ"
plus how to switch back, so nobody is silently surprised by their menu
changing the way the owner was in the incident below. No blocking/
warning logic was added — a LINE ID CAN still be linked to multiple
roles at once with zero friction, that's the accepted trade-off.

**What actually happened:** while re-linking every already-connected
tenant to a newly-updated tenant Rich Menu image
(`prototype-auth/relink-tenant-richmenu.js`), the owner's OWN personal
LINE account — which was ALSO linked to a Room's `lineUserId` (most
likely from early tenant-flow testing earlier in this project) — got
swept up as "an already-linked tenant" and re-linked to the tenant
(blue) Rich Menu, silently overwriting the owner (orange) Rich Menu
he'd had before. He noticed the wrong-colored menu, we traced the
cause, and fixed it with a one-off manual re-link back to the owner
menu (`prototype-auth/relink-owner-richmenu.js`) — but the underlying
architectural gap that CAUSED it is still there.

**The original concern (as first written), for reference:** a tenant
and a staff member were worried to be two entirely separate identities
whose LINE link could collide if the same real person was both. The
specific scenario first imagined — a tenant ALSO linked via the
`Staff` (สัญญาพนักงาน, employment-contract) tab's own `lineUserId`
column — **is still not possible today**: that column is confirmed
still unwired to anything (`server/coerce.js`'s comment: "reserved for
a future LINE-linking feature... nothing writes to it yet"), so that
exact pairing genuinely can't happen yet.

**Expanded scope since the original note was written:** this session
also built real LINE linking for **"ผู้ดูแล" (Admins tab, session role
'staff', NOT the unwired Staff/สัญญาพนักงาน tab above)** — which did
NOT exist when this gap was first flagged. So the real, CONFIRMED-
possible pairings today are: **owner ↔ tenant** (the incident above)
and **ผู้ดูแล ↔ tenant** (same mechanism, not yet witnessed but
identical code path — a ผู้ดูแล's own personal LINE account could
equally already be linked to a Room from earlier testing or genuinely
being a tenant themselves).

**Root cause, now well understood:** `linkRichMenuToUser(userId,
richMenuId)` is a per-LINE-user-ID call with no memory of "this
account already has a different role's menu" — whichever call happens
LAST wins, silently, no warning to anyone. Same applies to any future
push-notification logic that might branch on "which role is this LINE
ID" — nothing today checks whether a `lineUserId` value already
appears on a DIFFERENT row/Settings-key before writing it to a new
one.

**Decision (2026-07-14):** owner chose option "explain it in chat, make
switching a normal expected action" over building any check/warn/block
logic — matches how the self-link flows already naturally work (a
tenant only ever types a phone number, a ผู้ดูแล/owner only ever types
a PIN, so which credential you type IS the role-switch action, no new
UI needed). **Still NOT built:** per-message role framing for regular
push notifications (bill reminders, maintenance updates, etc. still
don't say "as your tenant hat" vs "as your ผู้ดูแล hat") — only the
Rich Menu switch itself got the explicit callout. Low priority unless
a real customer reports actual confusion from it in practice.

### "ขอรหัส Wifi" — owner/ผู้ดูแล can now answer via LINE chat directly, relayed to the tenant automatically

**Status:** Built and deployed (2026-07-15), per explicit owner
request ("ผู้เช่าขอรหัสมา เราทำเป็นช่องให้กรอกรหัสพร้อมส่งกลับเลยครับ").

If a tenant taps "ขอรหัส Wifi" on their Rich Menu and the room's
`wifiCode` field is already set, they get it instantly, unchanged from
before. **New behavior when it's NOT set:** the tenant is told to wait
("ระบบแจ้งผู้ดูแลให้แล้ว"), and every owner/ผู้ดูแล who has WiFi-request
notifications on (see the `wifiRequest` category below) gets a push
message AND a live 10-minute `wifiReplyPending` slot
(`server/routes/line.js`) — their VERY NEXT plain text message in LINE
is captured as the WiFi code, written to the room (`updateRow('Rooms',
..., { wifiCode: text })`), and pushed straight to the tenant
automatically. This check runs with the HIGHEST priority of any
pending state in the text-message handler (before PIN self-link, AI
session, everything) since a tenant is actively waiting on the other
end. First admin to reply wins — fulfilling it clears every other
notified admin's pending slot for that same room. If nobody answers in
time, a `setTimeout` (one per wifi-request, not one per notified
admin) fires at the same 10-minute mark and tells the TENANT (not just
a late-replying admin) to tap the button again — this was a real gap
the owner caught (only the admin used to get told "หมดเวลา", the
tenant left waiting with total silence).

**New Settings notification category `wifiRequest`** (added to the
existing 6 in `adminNotify` — `taskFailure/slipPending/overdueBill/
unmatchedSlip/maintenance/leaseExpiring`) — **defaults to TRUE**
unlike every other category there (which default OFF), because this
shipped always-on first and the toggle was added as a follow-up; a
default of OFF would have silently disabled behavior that was already
live. Checked directly in the `action=wifi` handler (fans out to
MULTIPLE recipients — owner + every linked ผู้ดูแล), not through
`adminNotify.js`'s single-recipient `notifyAdmin()` helper.

**Known limitation:** the 10-minute timer relies on the Node process
staying alive the whole time (`setTimeout`, in-memory, not a real job
queue) — if Render's free-tier instance sleeps/restarts mid-window,
the tenant-facing timeout message won't fire (though the hourly
external-ping cron reduces how often that's actually a risk). Accepted
trade-off, not fixed — same category of limitation as the ephemeral-
disk upload issue documented above.

### Two production bugs found together 2026-07-24: lease-contract-form save silently blocked (oversized image cells) + Google Sheets read-quota exhaustion

**Bug 1 — "มันทำให้บันทึกไม่ได้ด้วย" (save blocked entirely):** the
"กรอกข้อมูลสัญญาเช่า" (lease contract) form's ID-card photo upload
(`_readImg` in `Rental Management.dc.html`, feeding
`tenantIdImg`/`ownerIdImg`) downscaled the photo client-side then
stored the result as a raw base64 `data:image/...` string directly in
component state, which `saveContractForm` then sent straight into a
Google Sheets cell via `PATCH /api/rooms/:id`. Even downscaled to
1400px, a real photo's base64 easily exceeds Sheets' **50,000
character-per-cell hard limit** — the owner saw the browser-native
toast "Your input contains more than the maximum of 50000 characters
in a single cell" and the whole contract save failed, with no
indication of which field caused it. **Fixed** by uploading to
Cloudinary first (new `POST /api/uploads/document`,
`server/routes/uploads.js` — reuses the same persistent-storage
pattern already established for `payment-qr`) and storing the short
returned URL instead of the raw base64 blob. Applied to both
`tenantIdImg` (`_readImg`, shared by `onCfTenantId`/`onCfOwnerId`) and
`lineQrImg` (`onCfLineQr`) — both now upload-then-store-URL instead of
embedding base64 directly. If a *third* base64-in-state field ever
gets added to this form in the future, it needs the same treatment
from day one, not after someone hits the 50k-char wall in production.

**While investigating Bug 1, found a second, unrelated pre-existing
gap:** `ownerIdImg`/`ownerIdExpiry`/`lineQrImg` had fully working
upload/preview UI but were **never actually included in
`saveContractForm`'s `roomPatch`, and the `Rooms` sheet didn't even
have those 3 columns** — meaning even before today's photo-size bug,
these 3 fields silently never persisted at all (reopening the contract
form always showed them blank). Fixed: added the missing columns
(`prototype-auth/migrate-add-owner-lineqr-columns.js`, run against the
main account + both other buildings — see the "Permanent gotcha"
section above for why every building's own separate spreadsheet needs
this run individually), wired them into `roomPatch`/`clearPatch`, and
fixed `openContractForm` to actually load them back from the room
(`ownerIdImg`/`ownerIdExpiry` were hardcoded to always reset blank on
every open, regardless of what was saved).

**Bug 2 — real "Quota exceeded for quota metric 'Read requests' and
limit 'Read requests per minute per user' of service
'sheets.googleapis.com'" errors, seen live in the owner's browser:**
`GET /api/bootstrap` (loaded on every dashboard page load, and every
30 seconds while the "รีเฟรชอัตโนมัติ" dashboard toggle is left on) was
firing **9 separate Google Sheets API read requests** every single
time (`Rooms`, `Invoices`, `Maintenance`, `Expenses`,
`CalendarEvents`, `UnmatchedSlips`, `Staff`, `PaymentLog`, `Settings`
— each its own `readTab()` call via `Promise.allSettled`). Because
**every customer building shares the same Google service
account/project** (see the "Permanent gotcha" section above — separate
spreadsheets, but one shared set of API credentials), this quota
pressure is platform-wide, not scoped to one building's own usage.
**Fixed:** added `readTabs(tabs)` to `server/sheets.js`, using Google's
`spreadsheets.values.batchGet` to fetch all 9 ranges in **one** HTTP
request instead of 9 — cuts `/api/bootstrap`'s Google API footprint
~9x. `coerce.js`'s `readSettings()` now accepts an optional
`preloadedRows` param so it can reuse the same batched fetch instead
of triggering a 10th separate read (every other existing call site
that calls `readSettings()` with no args is unaffected, still does its
own single `readTab('Settings')` as before). **Trade-off accepted:**
the old per-tab `Promise.allSettled` let one flaky tab fail
independently without taking the rest down; a single `batchGet` either
succeeds or fails as a whole. Wrapped in a try/catch that falls back to
the same empty-array/default-settings values as before (never a hard
500) — reasoned to be an acceptable trade given `batchGet` is one
atomic call to the same API or one already-authenticated connection,
unlikely to fail in a way the 9 individual calls wouldn't also have
failed together. **Not done:** other endpoints in this app likely have
similar multi-`readTab()`-per-request patterns that weren't touched
this session (only `/api/bootstrap` was fixed, since it's the
highest-frequency one) — if quota errors recur, `readTabs()` is now
available as a drop-in tool to batch any other multi-tab endpoint the
same way.

### "Can't type in this field" bugs (ค่ามัดจำห้อง, ค่าเช่าล่วงหน้า, WiFi username/password) — real root cause found 2026-07-26, NOT a framework bug

**Status: FIXED.** This is the resolution to a multi-day mystery (started
2026-07-24 with "ช่องนี้...กรอกข้อมูลอะไรไม่ได้ครับ" for ค่าเช่าล่วงหน้า,
then recurred for ค่ามัดจำห้อง, both eventually just hidden from the UI as
a stopgap while the cause stayed unknown — heavily suspected at the time
to be a dc-runtime/React-key reconciliation bug in `support.js`, since
removing one field's `<input>` appeared to "transfer" the same symptom to
its sibling field).

**The actual cause was mundane and had nothing to do with the framework:**
`Rental Management.dc.html`'s `renderVals()` ends in one giant object
literal that explicitly lists every handler function the template is
allowed to reference (e.g. `onCfRent: this.onCfRent`). `onCfDeposit` and
`onCfAdvanceRent` were both real, correctly-written class methods — but
whoever added them to the contract form's `<input>` elements forgot to
also add `onCfDeposit: this.onCfDeposit` / `onCfAdvanceRent: this.onCfAdvanceRent`
to that return object. That means `{{ onCfDeposit }}` in the template
resolved to `undefined` — the `<input>` had a `value` (controlled) but
**no `onChange` at all**. React's standard behavior for a controlled
input with no working onChange is to silently force the DOM value back
to the old value on every keystroke — indistinguishable from "can't
type" to anyone watching, cursor still blinks normally in the field
(same DOM node, nothing remounts) but the character never sticks.

**A second, independent instance of the exact same bug** was found in the
same fix pass: `onCfWifiUsername`/`onCfWifiPassword` (the real methods,
used correctly in the template) were ALSO missing from the return
object — instead there was a stale leftover key `onCfWifi: this.onCfWifi`
(from before the WiFi field was split from one `wifiCode` into separate
username/password fields), which doesn't correspond to any real method
either. Both WiFi fields had been silently broken the same way.

**Why the "removing a field breaks its sibling" observation was
misleading:** both fields were independently broken the whole time
(neither ever had a working onChange). Whichever one happened to still
be visible in the UI at any given moment "looked" like the newly-affected
one purely by coincidence of which was hidden vs shown — not a causal
relationship, and definitely not a sign of positional-key instability in
the rendering framework.

**How it was actually found (useful playbook for the next "can't type"
report):** static code reading alone couldn't distinguish "framework
bug" from "missing wire-up" — needed a live browser. Had the owner open
DevTools (F12) → Console tab, filter for `Uncaught` (came back empty —
ruled out a JS exception breaking the whole render pass), then click
into the broken field, type a character, and run
`document.activeElement.value` in the console. It came back as the
UNCHANGED old value — proof the keystroke never reached the DOM at all,
which is the fingerprint of "controlled input, no onChange" specifically
(as opposed to a remount/key issue, which would show as the cursor
losing focus, or a state-update-but-no-rerender issue, which would show
the DOM value changing while the visible React-rendered value doesn't).
That one console command was the deciding piece of evidence — from there
it was a 30-second `grep` to confirm `onCfDeposit`/`onCfAdvanceRent`
existed as methods but weren't in the render-vals return object.

**General lesson for any future "field visually accepts value=X but
typing has no effect" report in this app (or any dc-runtime `.dc.html`
file):** before assuming a framework bug, grep for the `on<Whatever>`
handler name used in the `<input onchange="{{ onXxx }}">` binding and
confirm it appears BOTH as a class method definition AND inside the
component's `renderVals()` return object. A handler existing as a method
is not sufficient — it must also be explicitly re-exported in the return
object for the template to see it. This is an easy thing to miss by hand
in a return object that's grown to list 50+ handlers across a
9000+-line file, and grep is the fastest way to audit for gaps (compare
the set of `on<X> = (e) => ...` method definitions against the set of
`on<X>: this.on<X>` entries actually returned — anything defined but not
returned is broken exactly like this).

### "ส่งใบแจ้งหนี้เมื่อไหร่ดี?" popup (ส่งทันที / ตั้งวันเวลาส่ง) — built, tested end-to-end, uncovered + fixed 2 real cross-cutting bugs along the way (2026-07-29)

**Feature itself:** right after a bill is created successfully (both
`submitInvoice`, single room, and `submitBulkInvoice`, "ออกบิลทุกห้องพร้อม
กัน"), a new popup asks ส่งทันที (calls the existing `sendReceiptLine`
per room, unchanged behavior — still generates the image+QR receipt)
or ตั้งวันและเวลาส่ง (2 fields: date + time). The itemized receipt
text-building logic was extracted out of `sendReceiptLine` into a
shared `_buildReceiptMessage(roomId)` so both paths use identical
wording. Scheduling posts to new `POST /api/scheduled-messages`
(`server/routes/scheduledMessages.js`), which appends to the same
`ScheduledMessages` Sheet tab the pre-existing `schedule_line_message`
Claude tool and calendar-event notifications already used —
`server/routes/scheduler.js`'s `GET /run` (external cron ping) sends
it when the time arrives. The Bills table shows a "🕒 ตั้งเวลาส่ง
[date] [time]" badge (blue) for any room with a pending un-sent
`invoice_receipt`-sourced row, switching to the normal green "✓ ส่ง
ไลน์แล้ว" once it actually sends.

**Lifecycle cleanup (2 follow-up owner requests, both real gaps):**
deleting an invoice now cancels ALL its `ScheduledMessages` rows
(both pending AND already-sent — first pass only handled pending,
owner caught the already-sent case lingering forever in the sheet);
marking an invoice **paid** also clears its rows (same reasoning —
"มันจะได้ไม่เต็ม เหมือนถูกเคลียร์ข้อมูลตลอด หลังจบบิล"). Both match
by `room + source:'invoice_receipt'` only (not invoice id) — safe
because a room can only ever have ONE non-paid invoice at a time (the
pre-existing duplicate-bill guard), so at delete/paid time any
leftover rows for that room can only belong to the one being
closed.

**Staged-rollout gate applied correctly** — per the owner's own
reminder mid-session ("เราเขียนไว้ว่า...ต้องใช้การอัปเดทไปสู่ตึกอื่นๆ
แทนการแก้ไขแบบรวมทุกตึกที่มี"), `CURRENT_PLATFORM_VERSION` bumped to
**v4**, documented in `server/platformVersion.js` as the first gate on
**backend automation behavior**, not just a frontend UI element — real
side effect (actual LINE messages to real tenants), so it needed the
same "🆕 อัปเดต" per-building opt-in as any visible feature. Implemented
as a **fixed local constant** `SCHEDULER_MULTI_BUILDING_VERSION = 4` in
`scheduler.js` (NOT a live reference to `CURRENT_PLATFORM_VERSION`) —
otherwise a building that already opted in would silently drop back out
the next time an unrelated frontend feature bumps the version further.
The main account itself is exempt from this check (this exact logic
already ran for it before today, gating it would be a regression).

**Real bug #1 found while testing (much bigger than the scheduling
feature itself): `GET /api/scheduler/run` only ever ran for the MAIN
account, never any other building, since it launched.** Root cause:
this endpoint is hit by an external cron ping with **no session/
cookie at all**, so `getCurrentSheetId()` always resolved to
`undefined` and every Sheets call silently fell back to
`process.env.GOOGLE_SHEET_ID` (main account only) — true for
`server/sheets.js`'s `SHEET_ID()` fallback since day one. This means
overdue-bill detection, cutoff/water-elec warnings, due-date
reminders, and lease/ID-expiring notices likely never fired for ANY
building except the main one, this whole time — a silent gap nobody
had noticed because none of those categories has an obvious "it never
ran" symptom the way "ตั้งเวลาส่งบิลไม่ส่ง" did. **Fixed:** extracted the
whole per-run body into `runSchedulerOnce()`; the route handler now
reads every `customerSheetId` from the Directory
(`GOOGLE_DIRECTORY_SHEET_ID`'s `Users` tab, same source
`my-buildings.html` uses) plus the main account, and calls
`runSchedulerOnce()` once per building via `runWithSheetId()` — one
building's failure is caught/logged, doesn't abort the rest. Also had
to fix 2 in-memory dedup Maps (`_cutoffNotifiedDates`,
`_lastLogPruneDate`) that were previously shared across the whole
process — a room ID like "101" existing in two different buildings'
own separate spreadsheets would have collided and wrongly suppressed a
real notification in one building just because another building
already fired "the same" key that day. Both are now keyed/prefixed by
`sheetId`.

**Real bug #2 found while testing (the actual reason ห้อง 647's
scheduled send kept silently failing even after bug #1 was fixed):
every direct `pushMessage()`/`pushButtonMessage()`/`lineConfigured()`
call in `scheduler.js`, AND every call inside the shared
`server/adminNotify.js`'s `notifyAdmin()` used across the WHOLE app
(not just this file), was called with no `creds` argument.**
`resolveCreds()` (`server/line.js`) always fell back to
`process.env.LINE_CHANNEL_ACCESS_TOKEN` — the main account's token —
regardless of which building's context the code was actually running
in. A secondary building with its own separate LINE OA (credentials
saved via its own Settings page, not `.env`) tries to push to a real
friend of **its own** channel using the **wrong channel's** token,
which LINE correctly rejects with a 400 `"Failed to send messages"`.
This bug was invisible before bug #1 got fixed, since `scheduler.js`
only ever ran for the main account anyway (whose own token always
happened to match). **Fixed:** every call site in `scheduler.js` now
fetches `readIntegrationCredentials()` in-scope and threads `.line`
through (cutoff warnings — both the tenant message and the admin
"ยืนยันตัดไฟ" button, due reminders, lease-expiring notices, and the
`ScheduledMessages` send loop including its own `lineConfigured()`
gate). `adminNotify.js` fixed at the source too, with an optional
`preloadedCreds` param so a caller already inside a loop (cutoff
warnings, lease-expiring, overdue bills) can reuse credentials
fetched once instead of re-reading the Settings tab per notification
— same N+1 concern as the next paragraph.

**Diagnosing this took several rounds of live production debugging**
(temporary `debugAttempted`/`debugSkipped`/`debugErrors` fields added
to the `scheduledMessages` result block, later cleaned up to just a
permanent slim `errors: []` array — genuinely useful for the next
"why didn't this send" report without needing another debug round).
Repeated manual `curl`-ing of `/api/scheduler/run` while debugging
twice tripped a real **"Quota exceeded for quota metric 'Read
requests'"** Google Sheets error — a reminder that this endpoint
(now looping N buildings × ~9-10 tabs each) is expensive to call
back-to-back; found and fixed one genuine N+1 read pattern in the
process (the receipt-sent-marking step was re-reading the WHOLE
`Invoices` tab once per room in a batch send instead of once total —
fixed by caching it lazily across the loop). **Lesson for next time
someone needs to manually poke this endpoint while debugging: wait
at least ~60s between calls, and prefer reading the JSON response via
`fs.readFileSync` after `curl -o file`, not `require(file)` — Node
caches `require()` by file path, so re-requiring the same temp file
path across multiple calls in one session silently returns stale
data instead of the fresh contents.**

**External cron reliability — replaced GitHub Actions with UptimeRobot
mid-session.** `.github/workflows/scheduler.yml`'s `cron: '*/10 * * *
*'` looked fine on paper, but the owner pulled up the actual run
history (`github.com/grit647/chaosuk-rental/actions/workflows/
scheduler.yml`) and found real gaps of **1–1.5 hours between runs**,
not the configured 10 minutes — GitHub's own docs describe scheduled
workflows as "best effort," and delays like this are a known
(if under-advertised) limitation, worse for lower-traffic
repos/accounts. Owner chose to add **UptimeRobot** (free tier, HTTP
monitor pinging `GET /api/scheduler/run`) as a dedicated, far more
reliable replacement/supplement — currently set to **every 20
minutes** (deliberately backed off from the free-tier minimum of 5
minutes, after walking through the Render free-tier math together:
pinging more often than Render's own 15-minute idle/sleep threshold
means the app literally never sleeps, eating close to the full
750-hour/month free compute quota all by itself; 20-minute pings
let the app sleep between checks, trading a slightly longer worst-case
scheduled-send delay for real headroom against that cap). GitHub
Actions' own cron config was left in place as a redundant backup
(harmless if both fire close together — worst case is one extra
no-op check).

**New: `server/uptimeRobot.js`** — thin client for UptimeRobot's
read-only v2 API (`getMonitors`), maps their numeric status codes
(0=Paused/1=Not checked/2=Up/8=Seems down/9=Down) to Thai labels +
colors. `GET /api/settings/uptime-status` (platform-admin gated, same
pattern as every other route in `settings.js`) surfaces it; a small
"🖥️ สถานะเซิร์ฟเวอร์" card now shows on BOTH `my-buildings.html`'s
"🔧 ทุกตึกในระบบ (Server only)" section AND the main Dashboard
(gated behind `isPlatformAdmin` on the Dashboard specifically — a
regular customer's own building dashboard never fetches or shows
this, since server infra status isn't their concern). Requires
`UPTIMEROBOT_API_KEY` (a **read-only** API key, deliberately not the
"Main" key which can modify/delete monitors) set in both `server/.env`
(local) and Render's Environment Variables (production) — same
2-places-to-update gotcha as every other integration credential in
this project (see the LINE/Tuya credential notes above).

**Real near-miss caught mid-session, worth flagging for next time:**
while adding `UPTIMEROBOT_API_KEY` to Render, the owner initially
opened a DIFFERENT Render service by mistake — one named
**"chuarsup"** (an old/abbreviated spelling of "เช่าสุข" from when it
was first created, `chuarsup.onrender.com`, genuinely unrelated —
its deploy log showed commits about "Projects, Receipts, contract-
project linking," which reads like the owner's separate "ชัวร์ทรัพย์"
project, not this one at all). Caught by cross-checking the URL
(`chuarsup.onrender.com` ≠ `chaosuk-rental.onrender.com`) and the
deploy log's commit messages (didn't match anything from today's
session) BEFORE actually saving the wrong env var there. **The
correct service on Render is literally named "chaosuk-rental"**
(confirmed by matching a deploy log entry to today's actual commit
hash) — if a future session needs to guide the owner through Render
dashboard again, don't assume the service name matches by vibes
alone; have him confirm the deploy log shows a real, recent, relevant
commit message before trusting he's in the right place.

## Permanent rules (do not relax without the owner explicitly re-confirming)

- **Terminology: "เลขมิเตอร์" vs "หน่วย".** "เลขมิเตอร์" (meter number/
  reading) always means the raw current value read off a physical water
  or electricity meter — for both utilities. "หน่วย" (units) is reserved
  specifically for the CALCULATED RESULT of (current reading − previous
  reading), i.e. usage. Never label a raw-reading field/box with "หน่วย"
  and never label a calculated-usage figure with "เลขมิเตอร์" — mixing
  these caused a real bug (the invoice form's device-mode meter box was
  showing usage instead of the raw reading, looked like the meter went
  backward — fixed, then this convention was set explicitly by the owner
  afterward so it doesn't happen again). Applies to new labels/copy
  anywhere in the app, not just the invoice form.
- **No code/server/credential access from the Claude command box or recurring
  automation, ever.** Not a policy switch — there must never be a tool that
  makes this mechanically possible (see `server/claudeTools.js`'s `TOOLS`
  list and its comment block).
- **Lease contracts are core data.** Any add/edit/delete of a lease contract
  must always hand off to the native form UI (`open_contract_form` tool),
  never be done purely via chat text — some fields (ID photos, lease
  documents) can't be filled through chat at all.
- **Power/water cutoff is always the owner's manual decision.** No tool
  exists (and none should be added) that lets automation cut power/water by
  itself — the most automation can do is warn the tenant + flag a calendar
  reminder for the owner (see `server/automation.js`'s system prompt). The
  owner cuts power manually via the existing confirm-gated toggle on the
  Equipment page.
- **Payment slips are OCR only, never auto-verification.** A tenant's slip
  photo sent to the LINE bot gets read by Claude Vision and flagged
  (`slipPending`) on the matching invoice, but never auto-marks an invoice
  paid — the owner always reviews and confirms manually (Bills page →
  slip queue / per-row badge).
- **Staged-rollout gate — new customer-facing features must NOT go live for
  every building the instant they're deployed.** Per explicit owner request
  (2026-07-23): Render redeploys on every push and there's no separate
  staging environment, so a code push instantly affects every real
  customer at once unless gated. `server/platformVersion.js` exports
  `CURRENT_PLATFORM_VERSION` (bump it every time a new feature ships); each
  building's Directory row (`GOOGLE_DIRECTORY_SHEET_ID`'s `Users` tab) has
  its own `platformVersion` column, defaulting to 0 for anything never
  updated. **Every new customer-facing feature from now on must be wrapped
  in a check against the version it shipped in** (e.g.
  `session.platformVersion >= 2`), and `CURRENT_PLATFORM_VERSION` bumped in
  the same change. An existing building stays pinned at whatever version it
  last accepted until คุณต้น explicitly clicks **"🆕 อัปเดต"** for that
  specific building — the button only appears in the platform-admin-only
  "🔧 ทุกตึกในระบบ (Server only)" section of `my-buildings.html`, calls
  `POST /api/settings/update-building-version`, and disappears once that
  building's version matches current. A **brand-new** building (added via
  "+ เพิ่มตึกใหม่" / `prototype-auth/add-building.js`) is created ALREADY at
  `CURRENT_PLATFORM_VERSION` — there's nothing to protect a customer who
  hasn't started using the app yet from, so they get everything current
  immediately, no update click needed. `v1` (the baseline every existing
  building was backfilled to via `prototype-auth/
  migrate-add-platform-version.js`) marks "everything shipped up to and
  including the Dashboard's LINE OA message-quota usage card" — that card
  itself was NOT retroactively gated (it shipped before this mechanism
  existed); the first feature that should actually use this gate is
  whatever ships AFTER this note was written. Exposed to the frontend via
  `GET /api/auth/me`'s `platformVersion`/`currentPlatformVersion` fields
  (current ACTIVE building only) and `GET /api/auth/my-buildings`'s
  `currentPlatformVersion` + each building's own `platformVersion` (used by
  the admin picker).
