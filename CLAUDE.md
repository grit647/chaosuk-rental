# เช่าสุข (chaosuk-rental) — Project Notes

Rental management web app for a real property. Frontend is a single declarative
template file (`Rental Management.dc.html`, rendered by `support.js`). Backend
is `server/` (Express + Google Sheets as the database). Deployed on Render at
https://chaosuk-rental.onrender.com, source at `grit647/chaosuk-rental` on GitHub.

Owner/maintainer: คุณต้น (not a programmer by training — explain changes in
plain Thai, avoid assuming CS background).

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

### LINE webhook only receives messages for the main property — other customers' LINE OAs can send but not receive

**Status:** Open — decided on an approach (per-customer webhook URLs),
not yet built. Revisit when a second customer (e.g. บ้านพักครูโจ) actually
needs tenants to reply/send slips via their own LINE OA.

`server/routes/line.js`'s `POST /webhook` is ONE shared URL
(`https://chaosuk-rental.onrender.com/api/line/webhook`) registered in the
main property's LINE Developers Console, and it verifies every incoming
signature against ONLY the main property's Channel Secret (see the
"KNOWN LIMITATION" comment right above the route). This means:

- ✅ Every customer (main property + บ้านพักครูโจ, etc.) can already SEND
  messages through their own LINE OA fine — outbound `/send`/`/status`
  already resolve each customer's own saved credentials correctly.
- ❌ A tenant replying, sending a room number to self-link, or sending a
  payment slip photo to a customer OTHER than the main property's LINE
  OA is silently dropped — signature verification fails against the
  wrong Channel Secret, so the event never reaches our handlers at all.

**Decided approach when this gets built:** per-customer webhook URLs
(e.g. `/api/line/webhook/:customerSheetId` or similar), each customer
registers their OWN distinct URL in their OWN LINE Developers Console —
chosen over the alternative (one shared URL that tries every customer's
Channel Secret until one verifies) for clarity and to avoid O(n) signature
checks per webhook call as the customer count grows.

**Not yet done because:** no customer currently needs tenant-side LINE
reception through their own OA — บ้านพักครูโจ's outbound sending already
works, and the owner asked to just record the decision for now rather
than implement it speculatively.

## Permanent rules (do not relax without the owner explicitly re-confirming)

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
