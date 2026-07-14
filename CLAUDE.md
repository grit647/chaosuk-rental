# เช่าสุข (chaosuk-rental) — Project Notes

Rental management web app for a real property. Frontend is a single declarative
template file (`Rental Management.dc.html`, rendered by `support.js`). Backend
is `server/` (Express + Google Sheets as the database). Deployed on Render at
https://chaosuk-rental.onrender.com, source at `grit647/chaosuk-rental` on GitHub.

Owner/maintainer: คุณต้น (not a programmer by training — explain changes in
plain Thai, avoid assuming CS background).

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
tenant-richmenu.js`/`setup-owner-richmenu.js` passing their
`customerSheetId` as the CLI arg (uses their own saved LINE
credentials automatically), and register their own webhook URL in
their own LINE Developers Console as described above.

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

### Known gap: a tenant who is ALSO staff could get mixed-up LINE messages

**Status:** Flagged by the owner while building the staff-login feature
(`server/routes/auth.js`'s `POST /staff-login`, `Rental Management.dc.html`'s
staff PIN UI on the สัญญาพนักงาน page) — not yet a real scenario, not
investigated further, just recorded so a future session doesn't miss it.

**The concern:** a tenant and a staff member are currently two entirely
separate identities in this app — a tenant's LINE link lives on their
`Rooms` row (`lineUserId`, used for bill/receipt notifications), a
staff member's own LINE link (if they ever get one — not currently
wired to anything) would live on their own `Staff` row. If the SAME
real person is both (e.g. a tenant who also helps manage the building),
and their LINE account ends up linked in both places, they could
receive both message types mixed together — a rent-due reminder text
alongside a maintenance-ticket-assigned notification, no separation
between "which hat they're wearing" when a message arrives. Nothing
in the current LINE-sending code (`server/routes/line.js`,
`server/automation.js`, `server/routes/scheduler.js`) makes any
distinction between a tenant-role message and a staff-role one beyond
which Sheet row triggered it — there's no per-message "sent to you as
tenant vs. as staff" framing, and no dedup/merge logic if one LINE
account is linked from two different rows.

**Not investigated:** whether this is likely to actually happen for
this owner's real usage, and if so what the right fix looks like
(message-type prefixes so it's at least clear which role a given
message concerns? checking for and warning about a LINE ID already
linked elsewhere when linking a new one? something else). Purely a
"remember this exists" note for now.

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
