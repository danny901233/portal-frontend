# Build spec — In-portal Tasks board (`/admin/tasks`)

**Goal:** move the VA Operations Playbook *into the portal* so it's a live, shared board — not a per-browser artifact. Two staff users (Dan + the VA) can see the same tasks, read step-by-step instructions per task, add notes, assign tasks to each other, and add brand-new tasks. Because it's backed by Postgres, everything syncs between them automatically.

**Scope guardrails:** admin/staff-only. It must NOT touch anything customer-facing (agents, billing, calls). It's an internal ops tool. Build it the same way the existing **support inbox** (`SupportConversation` / `app/admin/support`) is built — copy that pattern.

---

## 1. Data model (Prisma — `prisma/schema.prisma`)

```prisma
model OpsTask {
  id            String    @id @default(cuid())
  title         String
  instructions  String?   @db.Text     // step-by-step "how to do it" (markdown)
  cadence       String    @default("weekly") // 'daily' | 'weekly' | 'monthly' | 'project'
  tags          String[]  @default([])  // e.g. ["agents","billing"] — reuse the playbook tag keys
  status        String    @default("open") // 'open' | 'done'
  notes         String?   @db.Text      // running notes (v1: one field; v2: a comment thread)
  assigneeId    String?                  // a staff User
  assignee      User?     @relation("OpsTaskAssignee", fields: [assigneeId], references: [id], onDelete: SetNull)
  createdById   String?
  createdBy     User?     @relation("OpsTaskCreatedBy", fields: [createdById], references: [id], onDelete: SetNull)
  dueDate       DateTime?
  sortOrder     Int       @default(0)
  completedAt   DateTime?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  @@index([cadence, status])
  @@index([assigneeId])
}
```
Add the two back-relations to `User`:
```prisma
  opsTasksAssigned  OpsTask[] @relation("OpsTaskAssignee")
  opsTasksCreated   OpsTask[] @relation("OpsTaskCreatedBy")
```
Then `npx prisma migrate dev --name ops_tasks` (locally) — on EC2 follow the existing regen steps (strip the schema `output` line before generating, per the deploy notes).

## 2. Who can be assigned

Assignees are staff users only: `User.role === 'RECEPTIONMATE_STAFF'`. Add an endpoint `GET /api/admin/staff` returning `{ id, email }` for those users, to populate the assignee dropdown. (Dan and the VA are both staff users.)

## 3. Backend routes (`backend/src/routes/opsTasks.ts`, mount in the real `server.ts`)

Protect every route with the existing admin/staff auth middleware (same one `app/admin/support` uses). Endpoints:

| Method | Path | Does |
|---|---|---|
| GET | `/api/admin/tasks` | list all tasks (optionally filter by `cadence`, `assigneeId`, `status`, `tag`) |
| POST | `/api/admin/tasks` | create a task — `{title, instructions?, cadence, tags, assigneeId?, dueDate?}`; sets `createdById` = caller |
| PATCH | `/api/admin/tasks/:id` | update any field (edit title/instructions, reassign, add notes, change cadence/tags) |
| POST | `/api/admin/tasks/:id/toggle` | flip `status` open↔done; set/clear `completedAt` |
| DELETE | `/api/admin/tasks/:id` | delete a task |
| GET | `/api/admin/staff` | list assignable staff users |

Keep it boring CRUD — mirror the shape of the support routes.

## 4. Frontend (`app/admin/tasks/page.tsx`)

Reuse the current playbook's look (it's a good base). The page shows tasks grouped by **cadence** (Daily / Weekly / Monthly / Project), with:

- **Filters** at top: by owner (Me / Dan / VA / anyone), status (open/done), cadence, tag. Plus a progress bar per section (done / total).
- **Each task row:** a done checkbox, the title, its tag chips, and the **assignee** (name/initial). 
- **An "i" info button** on each row → expands to show the task's **instructions** (rendered markdown) — this is the "how do I do it" content.
- **A notes area** in the expanded view → editable, saves via PATCH.
- **A reassign control** (the staff dropdown) inline on each task.
- **"+ Add task"** button → a small form (title, cadence, tags, assignee, instructions) → POST. Both Dan and the VA can add + assign.
- Because it's server-backed, a change one person makes shows for the other on next load (v1). For live sync, poll `GET /api/admin/tasks` every ~30s (v2: websockets — not needed for two people).

**Daily tasks:** cadence is a label + filter. Daily items are meant to be re-run each morning — either add a "Reset daily" button that flips all `cadence:'daily'` tasks back to `open`, or a tiny cron at 06:00 that does the same. Start with the button; add the cron later.

## 5. Seed data — migrate this playbook in

The current playbook's tasks become the first `OpsTask` rows. Write a one-off seed script (`backend/scripts/seed-ops-tasks.ts`) that inserts each task with its `cadence`, `tags`, `title`, and `instructions`. **Ask Dan/Claude to generate the instructions per task** — a 2–4 step "how to" for each — so the board ships useful from day one rather than empty. (I can produce that instruction set from the playbook content.)

## 6. Nice-to-haves (v2, don't block v1)

- **Assignment notifications:** when a task is assigned to someone, ping them — reuse the existing push-notification infra (the same `deviceTokens` / call-notification system). "Dan assigned you: Reconcile manual-pay invoices."
- **Comment thread** instead of a single notes field (a small `OpsTaskComment` model) so it reads like a conversation.
- **Recurring instances** — auto-generate a fresh daily/weekly instance instead of re-opening, so history is kept.
- **Due dates + an "overdue" flag** surfaced to the assignee (and optionally into the agent-watchdog alerts).

## 7. Definition of done (v1)

Both Dan and the VA, logged into the portal, can: see the same task list; open a task and read its instructions; add/edit notes; assign a task to the other person; tick it done; and add a brand-new task assigned to either of them — and each sees the other's changes. Seeded from the current playbook with real instructions.
