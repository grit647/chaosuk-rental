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
