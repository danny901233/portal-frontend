import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function findEACTelford() {
  // Search in AgentConfiguration by branch name
  const configs = await prisma.agentConfiguration.findMany({
    where: {
      OR: [
        { branchName: { contains: 'EAC', mode: 'insensitive' } },
        { branchName: { contains: 'Telford', mode: 'insensitive' } }
      ]
    },
    include: {
      garage: {
        include: {
          business: true
        }
      }
    }
  });

  console.log('Found agent configurations:', configs.length);
  
  for (const config of configs) {
    console.log('\n==========================================');
    console.log('Branch Name:', config.branchName);
    console.log('Garage ID:', config.garageId);
    console.log('\nGarage Details:');
    console.log('  Name:', config.garage.name);
    console.log('  Subscription Cost (GBP):', config.garage.subscriptionCostGbp);
    console.log('  Included Minutes:', config.garage.includedMinutes);
    console.log('  Cost Per Minute (GBP):', config.garage.costPerMinuteGbp);
    console.log('  VAT Rate:', config.garage.vatRate);
    console.log('  Trial End Date:', config.garage.trialEndDate);
    console.log('  Subscription Activated At:', config.garage.subscriptionActivatedAt);
    
    if (config.garage.business) {
      console.log('\nBusiness:', config.garage.business);
    }
  }

  await prisma.$disconnect();
}

findEACTelford();
