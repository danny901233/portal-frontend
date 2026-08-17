# Support hub — Phase 0 audit

Written by: Claude (VA / Gab session)
Date: 2026-08-17
Branch: `feat/support-hub-phase-0-audit`
Purpose: baseline audit of what the support system does TODAY before Phase 2 (ticket model) is built. Reviewable checkpoint per the ops-tasks board task _"Support hub — read first (goal & rules)"_.

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
