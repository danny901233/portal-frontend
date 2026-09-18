// Repair the greeting and FAQs on garages that were onboarded without them.
//
// Quick Onboard used to seed neither (fixed in admin.ts), so garages onboarded that way went
// live with an empty greeting and nothing for the agent to answer a question with. This fills
// the gap the same way onboarding now does: the standard greeting line, the curated industry
// FAQ set, then a tailored draft from the garage's own website where one scrapes usefully.
//
// An empty greeting is filled; an existing one is never touched, because most of them were
// written by hand and are exactly what the garage wants their callers to hear.
//
//   node scripts/backfill-faqs.cjs                     # dry run, every garage with 0 FAQs
//   node scripts/backfill-faqs.cjs --name "Meadowfield"  # just the ones matching
//   node scripts/backfill-faqs.cjs --name "Meadowfield" --apply
//   node scripts/backfill-faqs.cjs --defaults-only --apply   # skip the website/OpenAI step
//   node scripts/backfill-faqs.cjs --name X --force --apply  # redo one that already has some
//
// Never touches a garage that already has FAQs unless --force says to.
// The website step needs OPENAI_API_KEY, and a bare `node scripts/...` does not go through the
// server's startup, so nothing has loaded .env yet. Without this the generator finds no key,
// returns nothing, and every garage quietly gets the generic defaults.
require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');
const DEFAULTS_ONLY = process.argv.includes('--defaults-only');
// Re-do a garage that already has FAQs. Off by default so a stray run can never overwrite FAQs
// a garage wrote themselves.
const FORCE = process.argv.includes('--force');
const nameIdx = process.argv.indexOf('--name');
const NAME = nameIdx > -1 ? process.argv[nameIdx + 1] : null;

async function main() {
  // The compiled generator, so the seeded set is byte-for-byte what onboarding produces.
  const { industryDefaultFaqs, generateFaqsFromWebsite } = await import('../dist/utils/faqGenerator.js');
  const { sendAgentConfigWebhook } = await import('../dist/routes/config.js');

  const garages = await prisma.garage.findMany({
    where: {
      archivedAt: null,
      ...(NAME ? { name: { contains: NAME, mode: 'insensitive' } } : {}),
    },
    select: {
      id: true,
      name: true,
      agentConfiguration: {
        select: { faqs: true, websiteUrl: true, branchName: true, weeklyOpeningHours: true, greetingLine: true },
      },
    },
    orderBy: { name: 'asc' },
  });

  const hasFaqs = (c) => Array.isArray(c.faqs) && c.faqs.length > 0;
  const needsGreeting = (c) => !(c.greetingLine || '').trim();
  const targets = garages.filter(
    (g) => g.agentConfiguration && (FORCE || !hasFaqs(g.agentConfiguration) || needsGreeting(g.agentConfiguration)),
  );
  const skipped = garages.length - targets.length;
  console.log(
    `${targets.length} garage(s) to fill${skipped ? `, ${skipped} skipped (already have some)` : ''}` +
      `${FORCE ? ' [--force: existing FAQs will be replaced]' : ''}\n`,
  );

  for (const g of targets) {
    const cfg = g.agentConfiguration;
    const branch = cfg.branchName || g.name;
    const update = {};

    // The same line onboarding writes. Only when there isn't one already.
    if (needsGreeting(cfg)) {
      update.greetingLine = `[timeofday], ${branch}, Leah speaking, how can I help?`;
      console.log(`${APPLY ? 'WRITE' : 'would write'}  ${g.name} — greeting: ${update.greetingLine}`);
    }

    if (!hasFaqs(cfg) || FORCE) {
    let faqs = industryDefaultFaqs(branch);
    let source = 'industry defaults';

    if (!DEFAULTS_ONLY && cfg.websiteUrl) {
      try {
        // The hours we already hold beat whatever the website happens to say about them.
        const drafted = await generateFaqsFromWebsite(cfg.websiteUrl, branch, cfg.weeklyOpeningHours);
        // Same bar onboarding uses — a thin draft is worse than the curated set.
        if (drafted.length >= 3) {
          faqs = drafted;
          source = `website (${cfg.websiteUrl})`;
        } else {
          source = `industry defaults (website gave ${drafted.length})`;
        }
      } catch (e) {
        source = `industry defaults (website failed: ${e.message})`;
      }
    }

    console.log(`${APPLY ? 'WRITE' : 'would write'}  ${g.name} — ${faqs.length} FAQs from ${source}`);
    for (const f of faqs) console.log(`    Q: ${f.question}`);
    update.faqs = faqs;
    }

    if (APPLY && Object.keys(update).length) {
      await prisma.agentConfiguration.update({ where: { garageId: g.id }, data: update });
      await sendAgentConfigWebhook(g.id).catch((e) => console.error('    sync failed:', e.message));
      console.log('    saved + synced to the agent');
    }
    console.log('');
  }

  if (!APPLY) console.log('Dry run — nothing written. Re-run with --apply.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
