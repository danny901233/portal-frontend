# Support hub — Phase 2 schema (design)

Branch: `feat/support-hub-phase-2-schema`
Follow-up to: [Phase 0 audit PR #378](https://github.com/danny901233/portal-frontend/pull/378) · [tracking issue #377](https://github.com/danny901233/portal-frontend/issues/377)

**Purpose:** propose the ticket model that Phase 1 (email ingest) and Phase 3 (WhatsApp ingest) will write to, and that the admin queue UI will read from. Reviewable checkpoint before we write routes or UI. **Schema-only PR** — no runtime code, no data migration, all-additive migration file that Dan can apply on his usual deploy cycle.

## The three models

### `Contact`
A person who has ever contacted support. **One Contact per person, not per ticket** — the same customer can have five open issues and it's still one Contact with five Tickets. Cross-channel: has an `email`, a `phone`, or both.

Key fields:
- `email` (nullable, unique) — the canonical identity when set. Nullable-unique = Postgres allows multiple NULLs but one non-null, which is what we want (phone-only contacts don't clash).
- `phone` (nullable, indexed, NOT unique) — normalised to E.164 on write. Not unique because branches/families sometimes share a number.
- `garageId` + `userId` (both nullable, both FK-SET-NULL) — identified linkage when we can resolve to an existing Garage or User. Nullable so cold sales leads and one-off enquiries have a home too.
- `blocked` (boolean, default false) — manual hard-block for repeat spam senders. Distinct from the per-message spam filter (Phase 1b).

### `Ticket`
One ticket = one issue. Not one customer.

Key fields:
- `number` (SERIAL, unique) — human-readable sequential ticket number. Used in outbound email subjects as `[RM #123]` so customer replies thread back via Mailgun. DB-managed autoincrement so concurrent creates can't collide.
- `title` — editable subject/first sentence.
- `status` — `new` → `open` → `pending` → `on_hold` → `solved` → `closed` (definitions in the schema comments).
- `category` — AI-classified on ingest, staff can override.
- `priority` — `low | normal | high | urgent`.
- `channel` — `email | whatsapp | portal_chat | phone`. Set at create, never changes.
- `contactId` — the person who reported it (Contact FK, required).
- `garageId` — cached from `contact.garageId` at create time. Kept even if the Contact is later re-linked to another Garage, so the ticket stays attached to the right one.
- `assigneeId` — nullable. Null = **Unassigned** (Dan's hard rule 8: unassigned is a shared queue, not defaulted to one person).
- **Lifecycle timestamps as real columns** (not derived): `firstResponseAt`, `lastCustomerActivityAt`, `lastStaffActivityAt`, `solvedAt`, `closedAt`. Real columns so the 9pm daily report can count "pending 3+ days" tickets with a cheap indexed query, not a scan.

### `TicketEntry`
A single event on a ticket. Five kinds:
- `public_reply` — seen by the customer (via email/whatsapp/chat reply)
- `internal_note` — staff-only; never leaves the portal
- `status_change` — auto-log for audit
- `assignment_change` — auto-log for audit
- `auto_ack` — the auto-generated acknowledgement sent on ingest (per rule 4)

Key fields:
- `authorUserId` OR `authorContactId` (exactly one set for `public_reply`/`internal_note`, both null for the system-generated `status_change`/`assignment_change`/`auto_ack`). Enforced in app code.
- `body` — the message text.
- `isDraft` (boolean, default false) — **this is Dan's rule 3 in schema form**. AI-drafted replies for email/whatsapp land as `public_reply` rows with `isDraft: true`. They are NEVER sent until a staff action flips `isDraft: false`. The only entry the system creates and sends unassisted is `auto_ack`.
- `outboundMessageId` — Mailgun message-id or WhatsApp wa_id for sent replies. Inbound webhooks look it up via In-Reply-To header to thread the customer's reply back to the same ticket.

## How this resolves the 6 open questions from Phase 0

1. **Old `SupportConversation` — keep / migrate / delete?**
   - **Default in this schema:** keep alongside. The two models coexist. The old widget can keep working as-is (rule 3 change deferred — see #2). Later PR migrates the 39 historical threads into `Ticket` rows if we want a unified history.
   - **Why:** doesn't force a migration to land Phase 2. Reversible. Dan can change mind later without schema churn.

2. **Widget behaviour under rule 3 — Leah drafts vs Leah answers instantly.**
   - **Default in this schema:** the widget stays as-is (Leah answers instantly). Email + WhatsApp use the drafts flow via `TicketEntry.isDraft`. This split is what the field enables — an inline chat expectation of instant reply is different from an email expectation of "someone will get back to me". Neither is forced by the schema.
   - **Dan can flip this** by writing widget-side `TicketEntry` rows with `isDraft: true` later; no schema change needed.

3. **Contact identity dedup.**
   - **Default in this schema:** unique on `email` (nullable-unique). No auto-link on domain. When an email from `bob@garageX.com` arrives, we get-or-create the Contact by email; if that's a new email, staff can manually link it to a Garage via the admin UI (Phase 2 continues with routes + UI). Auto-linking by domain is deferred — too many garages share generic domains (gmail.com, outlook.com) for it to be safe as a default.
   - **`phone` is indexed but not unique.** A branch of one garage often shares a number with head office. Merging happens in code (Phase 2 continues with a "merge contacts" endpoint).

4. **Default assignment.**
   - **Default in this schema:** `assigneeId` nullable, defaults to NULL = Unassigned. Shared queue per rule 8. Category-based auto-assign (billing → Dan) can layer on later as an ingest rule; the schema doesn't force one.

5. **Team address (`hello@receptionmate.co.uk`) for outbound auto-acks.**
   - **Not schema-affecting.** Lives in env (`MAILGUN_FROM`). Confirmed with Dan later.

6. **"Pending 3+ days" SLA trigger.**
   - **Schema affects this via `lastCustomerActivityAt`.** Query: `WHERE status='pending' AND now() - lastCustomerActivityAt > interval '3 days'`. Index `(status, updatedAt)` supports the queue-view scan; add `(status, lastCustomerActivityAt)` later if the exact SLA query gets slow (unlikely at hundreds of tickets/week).

## Indexes (why these)

| Index | Query it supports |
|---|---|
| `Ticket(status, updatedAt)` | Queue view "all open, newest first" |
| `Ticket(assigneeId, status)` | "Mine open" filter |
| `Ticket(contactId, createdAt)` | Show all tickets for a contact (in contact detail view) |
| `Ticket(channel, status)` | Filter queue by channel (email only / whatsapp only) |
| `Ticket(garageId, status)` | "All open tickets for garage X" (staff view of a customer) |
| `Ticket(number)` unique | Look up by ticket number from email subject `[RM #123]` |
| `TicketEntry(ticketId, createdAt)` | Load one ticket's thread in order |
| `TicketEntry(outboundMessageId)` | Inbound webhook: "which ticket did this reply thread back to" |
| `Contact(email)` unique | Get-or-create Contact by inbound email address |
| `Contact(phone)` | Get-or-create Contact by inbound WhatsApp phone |
| `Contact(garageId)` | List all contacts for a garage |
| `Contact(userId)` | Find contacts linked to a portal User |

## Migration

Hand-written SQL at `prisma/migrations/20260818125403_add_support_tickets/migration.sql`. Purely additive:
- **5 CREATE TYPE** (enums for `status`, `category`, `priority`, `channel`, `kind`)
- 3 CREATE TABLE
- 14 CREATE INDEX (one unique on `Contact.email`, one unique on `Ticket.number`, two extras on `TicketEntry` author fields)
- 8 ADD FOREIGN KEY (all `ON DELETE SET NULL` except `Ticket.contactId` which is `RESTRICT` — cannot delete a Contact that still has tickets; use `Contact.blocked=true` for spam sender cleanup)

No existing table is touched. No data change. Safe to apply on prod. Prisma auto-migration is still blocked on this branch by the pre-existing drift documented in [GH #357](https://github.com/danny901233/portal-frontend/issues/357), which is why this file is hand-written rather than `prisma migrate dev`-generated.

**Application order for Dan:**
1. Merge this PR (source is now in git; nothing has changed at runtime yet)
2. Apply the migration file: `psql "$DATABASE_URL" -f prisma/migrations/20260818125403_add_support_tickets/migration.sql`
3. Regenerate the Prisma client: `cd backend && npx prisma generate --schema=../prisma/schema.prisma`
4. Restart `portal-backend` (`pm2 restart portal-backend --update-env`)

No user-visible change from step 2-4 alone — the tables are empty and nothing reads/writes them yet. Phase 2 continuation (routes + admin UI) is the next PR.

## What's NOT in this PR

- **No routes.** `/api/admin/tickets/*` come in the next PR.
- **No admin UI.** `/admin/tickets` comes in the next PR.
- **No AI classifier.** Category defaults to `uncategorized` on Ticket create; the classifier layers on in Phase 1.
- **No Mailgun inbound webhook.** Comes in Phase 1.
- **No data migration from `SupportConversation`.** Old model coexists.
- **No changes to the widget.** Rule-3 flip deferred (see question 2).

## Estimated Phase 2 continuation after this merges

If Dan approves this schema shape:
- Routes (CRUD, filters, assignment change, status change): ~4-6h
- Admin queue UI (list + detail + reply form + filters): ~6-8h
- Total Phase 2 remainder: **~10-14h** to a working staff-usable queue with test data.

## Related

- [Ops-tasks board task "Support hub — read first (goal & rules)"](https://portal.receptionmate.co.uk/admin/tasks) — the spec Dan wrote
- [GH #377](https://github.com/danny901233/portal-frontend/issues/377) — tracking issue with the phase plan
- [PR #378](https://github.com/danny901233/portal-frontend/pull/378) — Phase 0 audit doc
- [GH #357](https://github.com/danny901233/portal-frontend/issues/357) — schema drift that blocks `prisma migrate dev` (unrelated to this PR, but why the migration file is hand-written)

## Review-response changelog

**2026-08-24 — addressed Dan's PR #381 review:**
- **#1** `Ticket.contactId` cascade → `RESTRICT`. Contact deletion no longer wipes ticket history. Use `Contact.blocked=true` for spam sender cleanup.
- **#3** `status`, `category`, `priority`, `channel`, `kind` promoted from `TEXT` to Prisma/Postgres enums (`TicketStatus`, `TicketCategory`, `TicketPriority`, `TicketChannel`, `TicketEntryKind`). Invalid values now rejected at DB level. (Note: Prisma reserves `new` as a keyword, so `TicketStatus.new_` maps to DB literal `"new"` via `@map`.)
- **#5** Added `TicketEntry(authorUserId)` and `TicketEntry(authorContactId)` indexes for "everything X replied to" queries.
- **#4** `Contact.email` global-unique is deliberate — see "Contacts and shared mailboxes" below.
- **#2** Migration diff against a prod snapshot posted separately as a PR comment.

## Contacts and shared mailboxes (answer to review Q4)

`Contact.email @unique` is intentional. Design assumes an email address identifies a single support-worthy person. Shared mailboxes like `info@garage.co.uk` are the known edge case:

- All correspondence from that mailbox collapses into **one** Contact record
- Every ticket that Contact raises is a separate `Ticket` row (thread-per-issue, not thread-per-person)
- `Ticket.garageId` is cached at ticket-create time from `Contact.garageId`, so re-linking the Contact later doesn't leak a ticket across garages
- If a shared mailbox is used by two garages (rare but possible via forwarders), the second garage's ticket still lands correctly against them because `garageId` is set from the ingest context, not the Contact record

Trade-off accepted: replies from that mailbox will not distinguish between individuals at the same garage (staff will see "info@garage.co.uk" as the requester on every ticket). The alternative — non-unique email — would multiply Contact rows for common cases like Dan replying from `dan@receptionmate.co.uk` across dozens of tickets, and would make cross-channel identity harder (email address as stable identity is standard in every Zendesk/HelpScout/Freshdesk-class product).

Reversible: dropping the unique constraint later is a single `DROP INDEX` if the shared-mailbox pattern turns out to matter more than assumed.
