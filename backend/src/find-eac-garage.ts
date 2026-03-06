import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function findEACGarage() {
  // Search for garages with EAC or Telford in name
  const garages = await prisma.garage.findMany({
    include: {
      agentConfiguration: {
        select: {
          branchName: true
        }
      }
    }
  });

  console.log('All garages in database:\n');
  garages.forEach(g => {
    console.log(`ID: ${g.id}`);
    console.log(`Name: ${g.name}`);
    console.log(`Branch: ${g.agentConfiguration?.branchName || 'N/A'}`);
    console.log(`Subscription: £${g.subscriptionCostGbp}/month`);
    console.log(`Included Minutes: ${g.includedMinutes}`);
    console.log('---');
  });

  await prisma.$disconnect();
}

findEACGarage();
