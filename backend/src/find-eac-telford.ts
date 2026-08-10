import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function findEACTelford() {
  const garages = await prisma.garage.findMany({
    where: {
      OR: [
        { name: { contains: 'EAC', mode: 'insensitive' } },
        { name: { contains: 'Telford', mode: 'insensitive' } }
      ]
    },
    include: {
      business: true
    }
  });

  console.log('Found garages:', garages.length);
  garages.forEach(g => {
    console.log('\n==========================================');
    console.log('Garage ID:', g.id);
    console.log('Name:', g.name);
    console.log('Subscription Cost (GBP):', g.subscriptionCostGbp);
    console.log('Included Minutes:', g.includedMinutes);
    console.log('Cost Per Minute (GBP):', g.costPerMinuteGbp);
    console.log('VAT Rate:', g.vatRate);
    console.log('Trial End Date:', g.trialEndDate);
    console.log('Subscription Activated At:', g.subscriptionActivatedAt);
    console.log('Business:', g.business);
  });

  await prisma.$disconnect();
}

findEACTelford();
