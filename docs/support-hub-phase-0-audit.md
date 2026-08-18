# Support hub — Phase 0 audit

Written by: Claude (VA / Gab session)
Date: 2026-08-17 (updated 2026-08-18 with direct answers to the ops-task done-criteria)
Branch: `feat/support-hub-phase-0-audit`
Purpose: baseline audit of what the support system does TODAY before Phase 2 (ticket model) is built. Reviewable checkpoint per the ops-tasks board task _"Support hub — read first (goal & rules)"_.

## 0. Done criteria — direct answers to the Phase 0 ops-task

The ops-task defined three specific checks and "a short note says exactly what exists vs. missing" as the done condition. Answering each directly:

### 1. Can a customer clearly find "Support" in the portal?

**⚠️ Partial — one entry point, and it's a floating button, not a nav link.**

- **What exists:** `SupportChatWidget` is rendered in `app/components/AppShell.tsx:494` so it appears on every portal page as a floating help button. Opens a 3-tile menu (Live Chat / WhatsApp / Phone).
- **What's missing:** No "Support" link in the sidebar or navbar. The sidebar's `supportLinks` array contains a single item labelled "Help & Guides" that points to `/help` (documentation), not to any support inbox or ticket view. There is no top-level route like `/support` that a customer could navigate to directly (e.g. from a bookmarked link, an email, or a search).
- **Effect:** a customer who doesn't spot the floating widget has no other route in. Users on smaller screens (where the widget is more likely to be obscured or forgotten) are effectively invisible to support.
- **What to add later (Phase 2+):** a dedicated `/support` page that also opens/hosts the ticket UI, and a "Support" item in the sidebar so it's discoverable via normal navigation.

### 2. Does the admin inbox (`app/admin/support`) load and show threads?

**✅ Yes, functionally — but effectively unused.**

- **What exists:** `app/admin/support/page.tsx` is live at `https://portal.receptionmate.co.uk/admin/support`. Staff-only (`isReceptionMateStaff()` redirect gate). Fetches from `GET /api/admin/support` which returns all `SupportConversation` rows sorted by `lastMessageAt` desc. Renders a left-column list + right-column selected-thread view. Reply form posts to `POST /api/admin/support/:id/messages`. Polls every 15s. Unread badge counters wire up correctly.
- **What loads today:** 39 threads (per the DB snapshot in §4). Most are `status='ai'` — Leah is handling. 1 is `awaiting_staff` (from 2026-06-25).
- **What's missing:** nothing on the code side — the page is fully functional. What IS missing is **usage**: see §3 below. The `SupportMessage` table contains **zero rows with `senderRole='staff'`** — nobody has ever replied via this inbox. Whether that means the escalation load is trivially small (39 threads across the whole history), or that staff reply via a different channel (see §3), the admin inbox itself is proven-working-but-idle infrastructure.

### 3. Does an escalation actually email the team, and does someone watch it?

**⚠️ Email is sent. Watching is unclear — no staff replies inside the portal, ever.**

- **What exists (the email side):** `backend/src/services/supportEscalationEmail.ts` sends a Mailgun email to `hello@receptionmate.co.uk` on first escalation of a conversation (state transition `ai` → `awaiting_staff`). Includes last 10 messages as a rich HTML transcript + a link to `/admin/support`. Idempotent — only fires once per conversation.
- **What exists (the DB evidence):** the 1 escalation on record fired the system message _"Support ticket created — the ReceptionMate team will email you back shortly"_ at 2026-06-13 (the only `senderRole='system'` row). This is proof the escalation path was traversed at least once and the code ran without erroring.
- **What's missing / unclear:**
  - **Zero staff replies inside the portal, ever.** `SupportMessage` breakdown: 20 AI, 20 customer, 1 system, **0 staff**. The 1 escalated thread was never answered via `/admin/support`. Either (a) staff replied to the customer directly via their own email client (which would explain no in-portal staff reply, but leaves the portal thread "orphaned"), or (b) nobody ever answered.
  - **No confirmation `hello@receptionmate.co.uk` is monitored** in the sense of "someone is on the hook to see it". It's a shared address, not a personal one. There's no monitoring alerting, no daily "unread in hello@ count", no SLA metric.
  - **The June 25 escalation is still `awaiting_staff` in the DB.** It never transitioned to `staff_handled` or `closed`. Whether that's because it was replied to out-of-band and staff forgot to update the portal, or because it was genuinely unanswered, isn't recoverable from the data alone.
- **Effect:** the escalation path works technically, but there is no closed loop that proves the email is being watched with intent. Under Dan's rule 8 ("Unassigned = shared queue"), any Phase 2 ticket ingest MUST include an "unassigned older than N hours" alert or the same silent-drop pattern will repeat.

**Short summary that answers the done-criteria in one line each:**

- Q1: Findable via floating widget only; not in the sidebar/navbar; would benefit from a dedicated `/support` page + nav item.
- Q2: Loads and functions correctly; has never been used by staff (0 replies via the portal).
- Q3: Email fires reliably on escalation; nobody demonstrably watches it — the 1 escalation ever recorded (2026-06-25) is still `awaiting_staff` in the DB with no staff reply.

The rest of this document (from §1 onward) is the fuller engineering audit: data model, backend surface, frontend surface, prod usage numbers, gap analysis vs Dan's 8 hard rules, and the 6 open questions Dan needs to answer before Phase 2 lands.

---

## TL;DR

The support system today is **one AI-first chat widget per portal user**, escalating to a single team email when Leah can't help. It is **almost dormant** — 39 users have ever started a thread, only 1 has ever been escalated, and there's been **zero** activity in the last 14 days. There is **no inbound email** handling. There is **no WhatsApp** for support. There is no ticket concept — a "conversation" is one-per-user, not one-per-issue.

Every hard rule in Dan's spec that requires new infrastructure is currently NOT covered (email in, WhatsApp in, call-into-ticket, per-issue ownership). The one thing that IS in place — the AI-drafting-not-sending pattern — is limited to the widget path.

---

## 1. Data model (current)

Two models in `prisma/schema.prisma`:

### `SupportConversation`
```
id             cuid
userId         String   @unique   ← ONE THREAD PER USER (design limit for Phase 2)
status         'ai' | 'awaiting_staff' | 'staff_handled' | 'closed'
aiTurns        Int (cap-tracker, currently unused)
lastMessageAt  DateTime
lastMessageText String?  (cached for admin inbox)
unreadForUser  Int  (badge counter)
unreadForStaff Int  (badge counter)
closedAt       DateTime?
messages       SupportMessage[]
```

### `SupportMessage`
```
id             cuid
conversationId String
senderRole     'customer' | 'staff' | 'system' | 'ai' (see mismatch below)
senderUserId   String?  (staff replies attach the staff user)
channel        'portal' | 'whatsapp' | 'slack' (defaulted 'portal'; only 'portal' seen in prod)
body           Text
```

**Blocker for Phase 2:** `userId @unique` on `SupportConversation` means a User can only ever have one thread. Multiple concurrent issues per contact — a hard rule in the spec — can't be expressed on this schema. Phase 2 has to introduce a new `Ticket` model rather than reuse this.

**Small drift bug:** the DB `senderRole` allows `'ai'` (seen in prod), but the schema comment lists `'customer' | 'staff' | 'system'`. The escalation email templating branches on `'ai'` too. Comment is stale — real values are `customer / staff / system / ai`.

---

## 2. Backend surface (current)

**File: `backend/src/routes/support.ts` (271 lines)**

7 endpoints. All require JWT `authenticate`. `/admin/*` also `requireAdmin`.

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/support/me` | user | current user's thread + messages |
| POST | `/support/me/messages` | user | send message; Leah replies; may escalate |
| POST | `/support/me/read` | user | mark thread read for user |
| GET | `/admin/support` | staff | list all threads for admin inbox |
| GET | `/admin/support/:id` | staff | one thread + messages |
| POST | `/admin/support/:id/messages` | staff | staff reply to a thread |
| POST | `/admin/support/:id/read` | staff | mark thread read for staff |

**File: `backend/src/services/supportAi.ts` (192 lines)**

Persona: "Leah". Uses `gpt-4o-mini`. Keyword pre-check (`shouldEscalateOnKeyword`) catches human-request phrases and complaints (e.g. `speak to a human`, `refund`, `didn't book`, `is broken`) before the model call. Model returns `[[ESCALATE]]` sentinel when it decides to escalate.

Notable: escalation is fired **once per conversation transition into `awaiting_staff`** — avoids spamming the team when Leah re-flags in an already-escalated thread.

**File: `backend/src/services/supportContext.ts` (146 lines)**

Builds a Markdown snapshot of the user's account + agent config (voice, hours, integrations, transfer number, etc.) and injects it as a system message so Leah gives account-specific answers.

**File: `backend/src/services/supportEscalationEmail.ts` (100 lines)**

Sends ONE email to `hello@receptionmate.co.uk` on escalation. Uses Mailgun via `sendEmail({ to: string[], subject, html, text })`. Includes last ~10 messages as transcript. **No inbound email path** — the team replies to the customer directly via their own mail client (not through the portal).

---

## 3. Frontend surface (current)

**File: `app/components/SupportChatWidget.tsx` (~500+ lines, header inspected)**

Floating help widget shown across the portal for logged-in users. 3-tile menu: Live Chat, WhatsApp, Phone.
- **Live Chat** → talks to Leah via `/support/me/messages`. Polls every 20s open / 60s closed.
- **WhatsApp** → deep-links to a Business number.
- **Phone** → `tel:+448001075988` (freephone).

Persona names shown: Leah (AI) and Dan (team). Only the AI is live-chat capable — WhatsApp and phone are outbound-to-a-different-channel, no in-portal history.

**File: `app/admin/support/page.tsx` (270 lines)**

Staff-only inbox. Left column: list of conversations, sorted by `lastMessageAt` with unread badge. Right column: selected thread. Staff can type a reply that posts to `/admin/support/:id/messages`. Mark-as-read wiring in place. Polls every 15s.

Auth gate: `isReceptionMateStaff()` → redirect to `/dashboard` otherwise (same pattern as `/observability` and `/admin/tasks`).

---

## 4. Prod usage data (READ-ONLY snapshot, 2026-08-17)

Queried directly against prod DB. Numbers are tiny.

| Metric | Value |
|---|---|
| Distinct users with a support thread | **39** |
| Threads currently `ai` | 38 |
| Threads currently `awaiting_staff` | **1** (the only one ever escalated in-band) |
| Threads `staff_handled` / `closed` | 0 |
| Total `SupportMessage` rows | **41** (20 customer + 20 ai + 1 system) |
| Messages in last 14 days | **0** |
| Longest thread | 21 messages (the escalated one) |
| Second longest | 20 messages, still `ai` status, from 2026-07-28 |
| Threads with 0 messages | Multiple (users opened the widget, didn't send) |

**What this tells us:**
- The current widget is used, but rarely.
- Support volume that DOES exist is landing elsewhere: email direct to `hello@`, phone, WhatsApp to Dan's mobile. None of that is captured anywhere — no dashboard, no assignee, no status.
- Building the ticket model won't disrupt many users (39 total ever) — a safe surface to migrate.
- Confirms Dan's premise: the hub is needed BECAUSE support is scattered, not because the widget is overloaded.

---

## 5. Gaps vs Dan's hard rules

Cross-referencing spec rules 1-8 against what's live.

| # | Rule | Status today |
|---|---|---|
| 1 | `hello@` stays the only support address; AI sorts after arrival | ⚠️ Partial — `hello@` receives the escalation email but there is no AI sorting, no ingest back into the portal. Email replies happen in Dan's inbox, disappear from the portal's view. |
| 2 | Lives in OUR portal | ✅ Existing widget + admin inbox is in the portal |
| 3 | AI never sends real answers unposted by a human; drafts only | ❌ **Currently Leah sends live to customers with zero human review.** The chat widget path is "AI replies immediately". This is a fundamental behaviour change for Phase 1 (email) and needs to be added retroactively to the widget too. |
| 4 | Auto-ack: email YES (24h window WhatsApp), chat NO | ❌ No inbound email — no auto-ack. |
| 5 | Never unsubscribe from transactional senders | N/A — no ingest of any kind yet, so no risk yet. Becomes relevant in Phase 1b. |
| 6 | Never auto-reply to spam | N/A — see above. |
| 7 | Support WhatsApp separate from `ChatConversation` | N/A — support WhatsApp not integrated at all today; deep-link only. |
| 8 | Unassigned = shared queue | ❌ No assignee concept. Every escalated thread pings the shared `hello@` inbox, but the portal has no "who owns this" state. |

**Rule 3 is the biggest philosophical change.** The current widget behaviour is "Leah answers instantly". Phase 1 changes this to "Leah drafts; human approves; portal sends". Applying that back to the widget would be a UX regression unless carefully done — for the widget we may want to keep the "Leah answers instantly" model (chat is real-time) but for email + WhatsApp use the drafts flow (async, more time to review). This is a design decision for Dan.

---

## 6. What's reusable vs what has to be new

**Reusable:**
- `sendEmail({ to, subject, html, text })` in `backend/src/utils/email.ts` — outbound Mailgun sender is battle-tested.
- `authenticate` + `requireAdmin` middleware from `backend/src/middleware/auth.ts` — same auth pattern for new admin routes.
- `isReceptionMateStaff()` gate in `app/lib/auth.ts` — same pattern for the new `/admin/tickets` UI.
- Meta webhook pattern from `backend/src/routes/webhooks/meta-whatsapp.ts` — a template for the Phase 3 Support WhatsApp webhook (careful to keep the two feature-flagged and separate destinations).
- `Contact` / `Customer` concept partially exists in the schema (there's a `Customer` model already, per-garage) — probably NOT the right shape for a support Contact (support contacts are cross-garage). New model needed.
- AI drafting: `generateSupportAiReply` in `supportAi.ts` is a good starting point. Would need to (a) return a draft rather than a sent reply, (b) grow a category classifier.

**Has to be new:**
- `Ticket`, `TicketEntry` (or `TicketMessage`), `Contact` models. `Contact` cross-references email + phone; `Ticket` references `Contact`, has `status`, `assigneeId`, `category`, `priority`, `channel`, plus a `garageId` when derivable.
- Inbound email webhook (`POST /webhooks/mailgun/inbound`) + Mailgun route config (Dan's side, in Mailgun UI).
- Inbound support-WhatsApp webhook + phone number registration.
- Draft-review UI (approve/edit/reject → send).
- Category classifier (billing/support/sales/other).
- Spam / marketing / transactional filter — probably lives in the same route as the inbound webhook.
- Reply-by-email round-tripping — outbound emails need `[RM #ticket_id]` in subject so replies thread back. Also needs Mailgun `X-Mailgun-Variables` or a Reply-To with a per-ticket alias.
- Admin queue view: Unassigned / Mine / Pending 3+ days. Not the same as the current inbox — needs multi-source filters.

---

## 7. Open questions Dan should answer before Phase 2 lands

1. **Existing `SupportConversation` — keep or migrate?**
   - Keep it as legacy read-only (39 old threads visible in an "old inbox" tab)
   - Migrate each old thread → new `Ticket` on Phase 2 deploy (39 tickets bootstrapped)
   - Delete after 90 days
   - **My default:** keep + migrate at deploy so history is unified.
2. **Widget behaviour under rule 3.** Does Leah in the widget still answer instantly (real-time chat is a UX expectation), or does the widget also become "Leah drafts, staff approves, then it appears"? Impacts UX significantly.
3. **Contact identity dedup.** When an email from `bob@garageX.com` arrives, do we auto-link to a Garage / User by domain match, or leave it manual until staff link it? First-pass rule matters for how the queue looks.
4. **Where should the assignment default land?**
   - Unassigned (per rule 8) — shared queue, someone claims
   - Auto-assign category → owner (e.g. billing → Dan, agent bugs → Gab)
   - Both (unassigned by default, but suggest an owner)
5. **Which staff email is the "team inbox" as-of-today?** Currently `hello@receptionmate.co.uk` in `supportEscalationEmail.ts:7`. Do all Phase 1 auto-acks come from that same address?
6. **SLA / pending-3-days rule:** what triggers the "Pending 3+ days" visibility — the ticket has been in `pending` status for 72h with no customer reply? Definition needed so the daily report can count it.

---

## 8. Suggested next step

Phase 2 kickoff — draft the Prisma schema for `Ticket`, `TicketEntry`, `Contact`, open a design PR (schema-only, no routes yet) so Dan can react to field shapes before we write API + UI code. Roughly ~2h to produce, another checkpoint before Phase 2 implementation begins.

---

## 9. Files inspected

- `prisma/schema.prisma` (SupportConversation + SupportMessage models)
- `backend/src/routes/support.ts` (7 endpoints, 271 lines)
- `backend/src/services/supportAi.ts` (persona, escalation logic, 192 lines)
- `backend/src/services/supportContext.ts` (user context builder, 146 lines)
- `backend/src/services/supportEscalationEmail.ts` (outbound team email, 100 lines)
- `app/components/SupportChatWidget.tsx` (user-facing widget, ~500+ lines)
- `app/admin/support/page.tsx` (staff inbox, 270 lines)
- `backend/src/utils/email.ts` (sendEmail — referenced for reuse)
- `backend/src/routes/webhooks/meta-whatsapp.ts` (webhook pattern for Phase 3)

Total ≈ **1,500 lines** of existing support-adjacent code — most of which stays and gets wrapped by the new ticket model, rather than deleted.
