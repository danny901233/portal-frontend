// Backfill FAQs onto garages that have none.
//
// Quick Onboard used to seed neither a greeting nor FAQs (fixed in admin.ts), so garages
// onboarded that way went live with nothing for the agent to answer a question with. This
// fills the gap the same way onboarding now does: the curated industry set, then a tailored
// draft from the garage's own website where there is one and it scrapes usefully.
//
//   node scripts/backfill-faqs.cjs                     # dry run, every garage with 0 FAQs
//   node scripts/backfill-faqs.cjs --name "Meadowfield"  # just the ones matching
//   node scripts/backfill-faqs.cjs --name "Meadowfield" --apply
//   node scripts/backfill-faqs.cjs --defaults-only --apply   # skip the website/OpenAI step
//
// Never touches a garage that already has FAQs.
// The website step needs OPENAI_API_KEY, and a bare `node scripts/...` does not go through the
// server's startup, so nothing has loaded .env yet. Without this the generator finds no key,
// returns nothing, and every garage quietly gets the generic defaults.
require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');
const DEFAULTS_ONLY = process.argv.includes('--defaults-only');
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
    select: { id: true, name: true, agentConfiguration: { select: { faqs: true, websiteUrl: true, branchName: true } } },
    orderBy: { name: 'asc' },
  });

  const targets = garages.filter(
    (g) => g.agentConfiguration && !(Array.isArray(g.agentConfiguration.faqs) && g.agentConfiguration.faqs.length),
  );
  const skipped = garages.length - targets.length;
  console.log(`${targets.length} garage(s) with no FAQs${skipped ? `, ${skipped} skipped (already have some)` : ''}\n`);

  for (const g of targets) {
    const cfg = g.agentConfiguration;
    const branch = cfg.branchName || g.name;
    let faqs = industryDefaultFaqs(branch);
    let source = 'industry defaults';

    if (!DEFAULTS_ONLY && cfg.websiteUrl) {
      try {
        const drafted = await generateFaqsFromWebsite(cfg.websiteUrl, branch);
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
    if (APPLY) {
      await prisma.agentConfiguration.update({ where: { garageId: g.id }, data: { faqs } });
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
