/**
 * Fill in each demo prospect's REAL opening hours, parsed from their own website.
 *
 *   npx tsx backend/scripts/resolve-demo-hours.ts --enriched <enriched.json> [--apply]
 *
 * Dry run unless --apply, and it always writes a review CSV, because this is the step whose
 * mistakes the prospect hears. The agent states hours as fact: Binley Woods Service Centre's demo
 * told them they open at 08:00 when their own site says 08:30, which is the kind of error that
 * has to be caught in a spreadsheet rather than on a call.
 *
 * Run AFTER seed-demo-prospects.cjs and BEFORE any link is sent. A prospect left with
 * weeklyOpeningHours NULL is not broken — the route builds that agent so it declines to state
 * hours at all, which is recoverable in a way that being confidently wrong is not.
 *
 * Deliberately a separate step from the seeder: the seeder is CommonJS and this needs the real
 * TypeScript parser. Copying the parsing logic into the seeder would let the two drift, and the
 * one that drifts is the one nobody re-tests.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { PrismaClient } from '@prisma/client';
import { parseOpeningHoursText } from '../src/utils/openingHoursText.js';
import type { WeeklyOpeningHours } from '../src/utils/googlePlaces.js';

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(n);
const opt = (n: string, d: string | null = null) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};

const APPLY = flag('--apply');
const ENRICHED = opt('--enriched');
if (!ENRICHED) {
  console.error('Pass --enriched <enriched.json> (the website scrape output)');
  process.exit(1);
}

type EnrichedRow = {
  contactId?: string;
  name?: string;
  website?: string;
  siteOk?: boolean;
  hoursLines?: string[];
};

const describe = (h: WeeklyOpeningHours): string => {
  const d = (k: keyof WeeklyOpeningHours) => {
    const v = h[k];
    return v.closed || !v.open ? 'closed' : `${v.open}-${v.close}`;
  };
  return `Mon ${d('monday')} | Sat ${d('saturday')} | Sun ${d('sunday')}`;
};

const main = async () => {
  const prisma = new PrismaClient();
  const rows: EnrichedRow[] = JSON.parse(readFileSync(ENRICHED, 'utf8'));
  const byContact = new Map(rows.filter((r) => r.contactId).map((r) => [r.contactId!, r]));

  const prospects = await prisma.demoProspect.findMany({
    select: { id: true, contactId: true, spokenName: true, weeklyOpeningHours: true },
  });

  let resolved = 0;
  let noText = 0;
  let refused = 0;
  let already = 0;
  const review: string[] = ['spokenName,source,parsed,rawLines'];

  for (const p of prospects) {
    if (p.weeklyOpeningHours) { already += 1; continue; }

    const e = p.contactId ? byContact.get(p.contactId) : undefined;
    const lines = e?.hoursLines ?? [];
    if (lines.length === 0) {
      noText += 1;
      review.push([`"${p.spokenName}"`, 'none', '"(agent will not state hours)"', '""'].join(','));
      continue;
    }

    const parsedHours = parseOpeningHoursText(lines);
    if (!parsedHours) {
      refused += 1;
      review.push([
        `"${p.spokenName}"`, 'refused', '"(agent will not state hours)"',
        `"${lines.join(' / ').replace(/"/g, '')}"`,
      ].join(','));
      continue;
    }

    resolved += 1;
    review.push([
      `"${p.spokenName}"`, 'website', `"${describe(parsedHours.hours)}"`,
      `"${lines.join(' / ').replace(/"/g, '')}"`,
    ].join(','));

    if (APPLY) {
      await prisma.demoProspect.update({
        where: { id: p.id },
        data: {
          weeklyOpeningHours: parsedHours.hours as unknown as object,
          hoursSource: 'website',
        },
      });
    }
  }

  const out = path.join(path.dirname(ENRICHED), 'demo-hours-review.csv');
  writeFileSync(out, review.join('\n'));

  console.log(`prospects              ${prospects.length}`);
  console.log(`  already had hours    ${already}`);
  console.log(`  RESOLVED from site   ${resolved}`);
  console.log(`  no hours on site     ${noText}   <- agent will not state hours`);
  console.log(`  parse refused        ${refused}   <- agent will not state hours`);
  console.log(`\nreview these before sending any link -> ${out}`);
  if (!APPLY) console.log('\nDRY RUN — pass --apply to write.');

  await prisma.$disconnect();
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
