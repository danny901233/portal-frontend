import { PrismaClient } from '../backend/node_modules/.prisma/client/index.js';
import { config } from 'dotenv';
import { resolve } from 'path';

// Load environment variables from backend/.env
config({ path: resolve(process.cwd(), 'backend', '.env') });

const prisma = new PrismaClient();

async function main() {
  const configs = await prisma.agentConfiguration.findMany({
    select: {
      branchName: true,
      agentScript: true,
      agentType: true,
    },
    orderBy: {
      branchName: 'asc'
    }
  });

  console.log('Agent Script Distribution:\n');
  
  const scriptCounts = new Map<string, number>();
  configs.forEach(c => {
    const script = c.agentScript || 'null';
    scriptCounts.set(script, (scriptCounts.get(script) || 0) + 1);
  });

  scriptCounts.forEach((count, script) => {
    console.log(`  ${script}: ${count} garages`);
  });

  console.log('\n\nAll Garage Configurations:\n');
  configs.forEach(c => {
    console.log(`  ${c.branchName}:`);
    console.log(`    Script: ${c.agentScript || 'null'}`);
    console.log(`    Type: ${c.agentType}`);
    console.log('');
  });

  await prisma.$disconnect();
}

main().catch(console.error);
