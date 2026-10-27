/**
 * Tell HighLevel which prospects built their receptionist and then never rang it.
 *
 * The demo funnel has three steps and only the middle one is invisible to the CRM: the email is
 * sent (HighLevel knows), the link is clicked and the agent is built (only Postgres knows), the
 * agent is called (only Postgres knows). So a garage can be halfway in — persuaded enough to
 * click, not enough to pick up the phone — and nothing in HighLevel can see it to follow up.
 *
 * This closes that gap the narrow way: it adds a tag and sends nothing. The follow-up email is a
 * normal HighLevel campaign built on that tag, which keeps unsubscribes, tracking, branding and
 * timing where every other campaign lives. The portal supplies the one fact HighLevel cannot
 * observe, and stops there.
 *
 * Deliberately NOT triggered on email opens. Apple Mail Privacy Protection fetches images for
 * every message whether or not anyone looked, so "opened but didn't click" is mostly noise. A
 * click that builds an agent is a real signal.
 *
 * `.mjs` so it can import the compiled dist modules; run from the backend dir so dotenv and
 * @prisma/client resolve. Exits after each run.
 *
 *   node demo-nudge-sweep.mjs                  one sweep
 *   node demo-nudge-sweep.mjs --dry-run        list who would be tagged, change nothing
 *   node demo-nudge-sweep.mjs --hours=48       wait longer before nudging (default 24)
 *   node demo-nudge-sweep.mjs --limit=50       smaller batch
 *
 * The batch cap is the safety rail. A bug here cannot tag thousands of contacts in one run, and
 * at the send rates this campaign will reach, a few hundred a day is the most it should ever see.
 */
import 'dotenv/config';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
};

const DRY_RUN = flag('dry-run');
const HOURS = Number(value('hours', '24'));
const LIMIT = Number(value('limit', '200'));
const TAG = process.env.DEMO_NUDGE_TAG || 'demo-built-no-call';
const CALLED_TAG = process.env.DEMO_CALLED_TAG || 'demo-called';

if (!Number.isFinite(HOURS) || HOURS <= 0) {
  console.error('[DEMO_NUDGE] --hours must be a positive number');
  process.exit(1);
}
if (!Number.isFinite(LIMIT) || LIMIT <= 0) {
  console.error('[DEMO_NUDGE] --limit must be a positive number');
  process.exit(1);
}

const { prisma } = await import('./dist/db.js');
const { addContactTags, highlevelConfigured } = await import('./dist/services/highlevel.js');

if (!highlevelConfigured()) {
  console.error('[DEMO_NUDGE] HighLevel is not configured (GHL_API_KEY / GHL_LOCATION_ID) — '
    + 'nothing to tag into.');
  process.exit(1);
}

const cutoff = new Date(Date.now() - HOURS * 60 * 60 * 1000);

/*
 * First, tell HighLevel who DID call.
 *
 * This runs before the nudge pass so that anyone who rang in the meantime is marked before the
 * follow-up logic looks at them. It is what lets a follow-up workflow stop itself: a prospect can
 * be tagged for a nudge on Tuesday and ring the number on Wednesday, and nothing should then
 * email them to say they never tried it. The exit condition in the workflow reads this tag.
 *
 * No time threshold -- a call is a call the moment it happens.
 */
const callers = await prisma.demoProspect.findMany({
  where: { callCount: { gt: 0 }, contactId: { not: null }, calledTaggedAt: null },
  select: { id: true, contactId: true, spokenName: true, callCount: true },
  orderBy: { lastCalledAt: 'asc' },
  take: LIMIT,
});
console.log(`[DEMO_NUDGE] called their agent and not yet marked in the CRM: ${callers.length}`);
if (!DRY_RUN) {
  for (const p of callers) {
    if (!(await addContactTags(p.contactId, [CALLED_TAG]))) {
      console.error(`[DEMO_NUDGE] could not tag ${p.spokenName} as ${CALLED_TAG}`);
      continue;
    }
    await prisma.demoProspect.update({
      where: { id: p.id },
      data: { calledTaggedAt: new Date() },
    });
    console.log(`[DEMO_NUDGE] ${CALLED_TAG}: ${p.spokenName} (${p.callCount} call(s))`);
  }
} else {
  for (const p of callers) {
    console.log(`  would tag ${p.spokenName} as ${CALLED_TAG} (${p.callCount} call(s))`);
  }
}

/*
 * Who earns a nudge:
 *   builtAt before the cutoff   they clicked, and have had time to call since
 *   callCount 0                 they never did
 *   contactId present           there is somewhere to put the tag
 *   nudgeTaggedAt null          they have not been nudged before
 *   expiresAt in the future     the link still works, so the email still has somewhere to send
 *
 * The expiry check matters more than it looks: nudging someone towards a 410 page is worse than
 * not nudging them at all.
 */
const candidates = await prisma.demoProspect.findMany({
  where: {
    builtAt: { not: null, lt: cutoff },
    callCount: 0,
    contactId: { not: null },
    nudgeTaggedAt: null,
    expiresAt: { gt: new Date() },
  },
  select: { id: true, contactId: true, spokenName: true, builtAt: true, email: true },
  orderBy: { builtAt: 'asc' },
  take: LIMIT,
});

console.log(`[DEMO_NUDGE] built before ${cutoff.toISOString()} and never called: `
  + `${candidates.length}${candidates.length === LIMIT ? ` (capped at ${LIMIT})` : ''}`);

if (!candidates.length) {
  await prisma.$disconnect();
  process.exit(0);
}

if (DRY_RUN) {
  for (const p of candidates) {
    console.log(`  would tag ${p.spokenName} <${p.email ?? 'no email'}> `
      + `built ${p.builtAt.toISOString().slice(0, 10)}`);
  }
  console.log(`[DEMO_NUDGE] DRY RUN — nothing tagged. Tag would be "${TAG}".`);
  await prisma.$disconnect();
  process.exit(0);
}

let tagged = 0;
let failed = 0;
for (const p of candidates) {
  // addContactTags POSTs to /contacts/{id}/tags, which APPENDS. Writing the tags array through
  // /contacts/upsert or PUT /contacts/{id} replaces them instead, and would strip tmg-2026-10,
  // mot centres and everything else off the contact.
  const ok = await addContactTags(p.contactId, [TAG]);
  if (!ok) {
    failed += 1;
    console.error(`[DEMO_NUDGE] could not tag ${p.spokenName} (${p.contactId})`);
    continue;
  }
  // Stamped only after the tag lands, so a failed call is retried on the next sweep rather than
  // silently written off.
  await prisma.demoProspect.update({
    where: { id: p.id },
    data: { nudgeTaggedAt: new Date() },
  });
  tagged += 1;
  console.log(`[DEMO_NUDGE] tagged ${p.spokenName} <${p.email ?? 'no email'}>`);
}

console.log(`[DEMO_NUDGE] tagged ${tagged}, failed ${failed}`);
await prisma.$disconnect();
