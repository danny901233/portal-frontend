import { prisma } from '../src/db.js';

const garageId = process.argv[2];

if (!garageId) {
  console.error('Usage: npx tsx scripts/showAgentConfig.ts <garage-id>');
  process.exit(1);
}

async function main() {
  const config = await prisma.agentConfiguration.findUnique({
    where: { garageId },
  });

  console.log(JSON.stringify(config, null, 2));
}

main()
  .catch((error) => {
    console.error('Failed to load agent configuration:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
