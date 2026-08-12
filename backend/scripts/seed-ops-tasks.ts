// One-off seed for the ops-tasks board — reads ops-tasks-seed.json and inserts
// each task, skipping any whose title already exists. Safe to re-run.
//
// Run once after the OpsTask migration:
//   cd backend && npx ts-node scripts/seed-ops-tasks.ts

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

// __dirname isn't available in ESM — derive it from import.meta.url
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const prisma = new PrismaClient();

type SeedTask = {
  cadence: 'daily' | 'weekly' | 'monthly' | 'project';
  tags: string[];
  title: string;
  instructions: string;
};

async function main() {
  const seedPath = resolve(__dirname, 'ops-tasks-seed.json');
  const raw = readFileSync(seedPath, 'utf8');
  const tasks: SeedTask[] = JSON.parse(raw);

  console.log(`[ops-tasks-seed] loaded ${tasks.length} tasks from ${seedPath}`);

  let inserted = 0;
  let skipped = 0;

  for (let i = 0; i < tasks.length; i += 1) {
    const t = tasks[i];
    // Idempotent: skip if a task with the same title already exists.
    // Titles in the seed file are unique + human-meaningful, so this is a fine key.
    const existing = await prisma.opsTask.findFirst({ where: { title: t.title } });
    if (existing) {
      skipped += 1;
      continue;
    }
    await prisma.opsTask.create({
      data: {
        title: t.title,
        instructions: t.instructions,
        cadence: t.cadence,
        tags: t.tags,
        sortOrder: i, // preserve file order within each cadence
      },
    });
    inserted += 1;
  }

  console.log(`[ops-tasks-seed] done — inserted=${inserted}, skipped=${skipped}, total=${tasks.length}`);
}

main()
  .catch((err) => {
    console.error('[ops-tasks-seed] failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
