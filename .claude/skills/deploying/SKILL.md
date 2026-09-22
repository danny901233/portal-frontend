---
name: deploying
description: Deploy the portal backend or frontend to the live EC2 box, or run a query/script against the production database. Use for any change that has to reach portal.receptionmate.co.uk — building, restarting pm2, Prisma schema changes, or one-off prod data scripts. Covers the traps that have taken production down before.
---

# Deploying the portal

One EC2 box runs both halves under pm2. Deploy = commit → push → pull on the box → build →
restart. Never SCP: the box is a clean checkout and an SCP'd file makes the next `git pull`
refuse, which then silently rebuilds stale source.

- Branch: **`receptionmate-demo-branch-2`** (NOT `main` — main is hundreds of commits behind)
- SSH: `ssh -i ~/.ssh/ReceptionMatebackend.pem ec2-user@18.171.223.223`
- Backend: `/home/ec2-user/portal-frontend/backend` (pm2 `portal-backend`, port 4000)
- Frontend: `/home/ec2-user/portal-frontend` (pm2 `portal-frontend`, port 3000)

## The sequence

```bash
# local
git add <files> && git commit && git push origin receptionmate-demo-branch-2

# on the box — check the pull's REAL exit code, never pipe it
cd /home/ec2-user/portal-frontend
git pull --ff-only origin receptionmate-demo-branch-2; echo "EXIT=$?"

# backend
cd backend && npm run build        # NOT npx tsc — see below
grep -c "<something you just added>" dist/<file>.js     # prove the emit landed
export PATH=/home/ec2-user/.local/share/fnm/node-versions/v20.19.6/installation/bin:$PATH
pm2 restart portal-backend

# frontend
cd /home/ec2-user/portal-frontend
./node_modules/.bin/tsc --noEmit -p tsconfig.json      # Turbopack does NOT typecheck
rm -rf .next && npm run build; echo "EXIT=$?"          # clean build, capture the code
PORT=3000 pm2 restart portal-frontend --update-env

curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4000/health
curl -s -o /dev/null -w "%{http_code}\n" https://portal.receptionmate.co.uk/
```

## Traps that have caused outages

**Piping a command hides its failure.** `git pull | tail -1` exits 0 even when the pull failed, so
a `&& build && restart` chain runs on stale source and reports success. The box fell six commits
behind that way. Same trap bit an `npm ci` and a `psql` in one session. Capture `$?` directly, or
use `PIPESTATUS`.

**`npx tsc` emits nothing.** The default `tsconfig.json` is `noEmit: true` — it is the typecheck
config. `npm run build` uses `tsconfig.build.json`, which emits. Run `npx tsc`, see errors scroll,
restart pm2, and you have restarted on unchanged `dist/`. Always grep `dist/` for your change.

**Never source `.env` before `pm2 restart --update-env`.** `.env` contains `PORT=4000`; sourcing it
exports PORT into the shell, and `--update-env` pushes the shell environment into every process
named. Restarting both processes from that shell gave both `PORT=4000`: the frontend won the race,
the backend crash-looped on EADDRINUSE, nginx 502'd everything. Scope env to the one command that
needs it (`DATABASE_URL=... psql ...`), restart processes separately with explicit ports.

The backend loads `dotenv/config` itself, so a plain `pm2 restart portal-backend` re-reads `.env`.
You rarely need `--update-env` at all.

**Always `rm -rf .next` before a frontend build.** An incremental Turbopack build can stitch a
stale chunk into an otherwise-correct build and produce a client-side `ReferenceError` from correct
source. Took the portal down once. After deploying, users need a hard refresh — chunk hashes change.

**Restarts need the stable fnm node on PATH.** Both processes launch via npm → `sh -c "node ..."`.
A non-login SSH shell has no fnm, so the saved env loses `node` and the process crash-loops with
`node: command not found`.

**`backend/src/services/chatAgentV2.ts` has pre-existing TS errors.** They print on every build and
do not block the emit. Filter them (`grep -v chatAgentV2`) rather than chasing them.

## Prisma / schema changes

`prisma migrate deploy` is broken on prod. Apply the SQL by hand, then regenerate:

```bash
DB=$(grep -m1 "^DATABASE_URL=" .env | cut -d= -f2- | tr -d '"' | sed 's/?.*$//')   # psql rejects ?schema=
psql "$DB" -v ON_ERROR_STOP=1 -f prisma/migrations/<dir>/migration.sql
cd backend && npx prisma generate --schema=/home/ec2-user/portal-frontend/prisma/schema.prisma
```

Keep the schema's `output` line — it points at `backend/node_modules/.prisma/client`, which is what
the app resolves. Stripping it generates into the repo root and the app never sees it, while
`generate` reports success.

**Order matters:** add the column BEFORE regenerating the client. A client that selects a column the
database lacks makes every query on that model throw.

Then **probe** rather than trusting "✔ Generated":

```js
prisma.<model>.findFirst({ select: { <newField>: true } })
```

## Production data scripts

Write `.cjs` (backend `package.json` is `"type": "module"`) and run from the backend directory so
`@prisma/client` resolves. `.mjs` works for importing compiled `dist/` modules. Put the file in
the backend dir, not `/tmp` — `/tmp` cannot resolve the dependencies. Delete it afterwards.

## Agent config does not live in Postgres alone

The voice agents read config from **DynamoDB** (`AgentConfig`), synced on a portal save. A direct
Postgres UPDATE does not reach the agent. Either save through the portal, or edit the DynamoDB item
in place and verify both sides agree.
