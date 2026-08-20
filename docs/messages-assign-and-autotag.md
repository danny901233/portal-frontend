# Garage Messages: assign + auto-tag (backend)

Backend half of the garage-side Messages inbox feature. Two capabilities:

1. **Assign a conversation to a garage user** — ownership, not takeover.
2. **Auto-tag a conversation by enquiry type** — filter/display only, never
   drives what the AI says.

The frontend (filters, per-conversation assign menu, tag chips) ships in a
separate PR against the same branch's UI surface.

## Rules (from Dan's brief)

- Assignment is **ownership**, not silencing. The AI keeps running. The
  existing `agentPaused` flag remains the way to hand a conversation to a
  human.
- Assignment is **per-garage**: a multi-branch user only sees / owns
  conversations on their allowed garages. Enforced at write (the assign
  endpoint 400s if the target user has no access) and at read (unchanged
  garage-scoped list query).
- If a user later **loses garage access**, their conversations fall back to
  unassigned — via the FK's `ON DELETE SET NULL`. No orphaned rows.
- **Unassigned is a shared queue.** No round-robin, no auto-assignment.
- **Notifications**: push + email to the new owner. Skipped when the owner
  assigned it to themselves. Uses the user's `notificationEmail` when set,
  otherwise their login `email`.
- Tags **must not influence agent behaviour**. The derivation reads the
  session state the agent has already produced; it does not run its own
  classifier and never feeds anything back into the agent.
- Assignment and tags are **internal to the garage**. Nothing surfaces to the
  customer over WhatsApp / webchat / FB / IG.

## Schema

Two new columns on `ChatConversation`:

- `enquiryType String?` — nullable. App-code values: `parts | sales | booking
  | complaint | general`. Null means "we couldn't classify" — safer than
  guessing.
- `assigneeId String?` — nullable FK to `User.id`. `ON DELETE SET NULL` so
  losing access drops the conversation back into the unassigned pool.

New indexes on `(garageId, assigneeId)` and `(garageId, enquiryType)` to keep
"My conversations" and category filters cheap even for garages with lots of
history. Existing indexes untouched.

Migration is **additive** only — no drops, no renames.

## Enquiry-type derivation

Values in priority order (higher wins when we already have a tag):

| Priority | Value      | Source                                                    |
|----------|------------|-----------------------------------------------------------|
| 4        | complaint  | `session.intent === 'message' && step === 'message_only'` |
| 3        | booking    | `session.intent === 'booking'`                            |
| 3        | parts      | staff hand-tag today (not auto-derived)                   |
| 2        | sales      | `session.intent === 'quote'`                              |
| 1        | general    | `session.intent === 'message'` (non-complaint)            |
| —        | null       | anything else                                             |

Runs on every `saveSession()` call in `chatAgentV2` (fire-and-forget). Only
writes when the derived value is a **stronger** signal than what's already on
the row — so once a complaint has been detected it stays a complaint.

Deliberately does **not** re-run the complaint regex. `chatAgentV2` already
does that at the top of `run()` and sets `intent = 'message'` +
`step = MESSAGE_ONLY`. Duplicating would risk drift; running it on every save
(including tool-turn saves without a user message) would be either noisy or
wrong.

Poole/Assist/Tyresoft/MMH agents don't share `chatAgentV2`'s session shape
and are out of scope for PR A. Their conversations keep `enquiryType = null`
until a follow-up plugs in.

## Endpoints

### `POST /api/conversations/:id/assign`
Body: `{ "assigneeId": "<userId>" | null }`. Returns
`{ success: true, assigneeId }`.

- 400 if `assigneeId` isn't a string or null.
- 403 if the caller has no access to the conversation's garage.
- 400 if the target user has no access to the conversation's garage
  (staff bypass this check).
- 404 if the assignee user doesn't exist.
- Fires push + email to the new owner **unless** it's a self-assign or a
  no-op reassign.

### `GET /api/conversations/:id/assignable-users`
Returns `{ users: [{ id, email }] }` — every USER/MANAGER with access to
this conversation's garage. Excludes `RECEPTIONMATE_STAFF` (Dan's rule:
hello@receptionmate.co.uk stays the only support address; this inbox is for
the garage's own team).

### `GET /api/conversations`
Extended with two optional query params:

- `enquiryType=<value>` — filter to conversations with a specific tag.
- `assigneeId=mine | unassigned | <userId>` — filter by owner. `mine`
  resolves to the caller's own userId. `unassigned` is the shared queue.

Response objects gain three fields: `enquiryType`, `assigneeId`, and
`assignee: { id, email } | null`. Existing fields unchanged.

## What's NOT in this PR

- Frontend UI (filter chips, assign menu, per-conversation owner display) —
  ships in PR B.
- `parts` auto-derivation — staff hand-tag for now.
- Assignment / auto-tag for Poole, Assist, Tyresoft, MMH conversations.
- Bulk assign, reassign audit log, notification preferences.

## Deploy notes for Dan

- Migration `20260820161919_add_conversation_assign_and_enquiry_type` is
  additive; safe to apply on the live DB.
- `notifyUser` in `utils/push.ts` is a new export; existing pushes untouched.
- `PORTAL_BASE_URL` (used in the assignment email link) falls back to
  `https://portal.receptionmate.co.uk` if unset.
- Backend typechecks: `cd backend && npx tsc --noEmit -p tsconfig.json`.
