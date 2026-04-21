import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function listAllGarages() {
  const configs = await prisma.agentConfiguration.findMany({
    select: {
      id: true,
      garageId: true,
      branchName: true,
      garage: {
        select: {
          id: true,
          name: true,
          subscriptionCostGbp: true,
          includedMinutes: true,
          costPerMinuteGbp: true,
          vatRate: true
        }
      }
    },
    orderBy: {
      branchName: 'asc'
    }
  });

  console.log(`Total garages: ${configs.length}\n`);
  
  configs.forEach((config, index) => {
    console.log(`${index + 1}. Branch: ${config.branchName}`);
    console.log(`   Garage Name: ${config.garage.name}`);
    console.log(`   Subscription: £${config.garage.subscriptionCostGbp}/month`);
    console.log(`   Included Minutes: ${config.garage.includedMinutes}`);
    console.log('');
  });

  await prisma.$disconnect();
}

listAllGarages();
