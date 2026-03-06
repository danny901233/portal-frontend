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
          vatRate: true,
          trialEndDate: true,
          subscriptionActivatedAt: true,
          businessId: true
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
    console.log('  Business ID:', config.garage.businessId);
  }
  
  // Now find users with access to these garages
  if (configs.length > 0) {
    const garageIds = configs.map(c => c.garageId);
    console.log('\n========== USERS ==========');
    const users = await prisma.user.findMany({
      where: {
        garageAccessIds: {
          hasSome: garageIds
        }
      },
      select: {
        id: true,
        email: true,
        role: true,
        garageAccessIds: true,
        billingCycleStartDate: true,
        nextBillingDate: true
      }
    });
    
    console.log('\nUsers with access:', users.length);
    users.forEach(u => {
      console.log('\n  Email:', u.email);
      console.log('  Role:', u.role);
      console.log('  Billing Cycle Start:', u.billingCycleStartDate);
      console.log('  Next Billing Date:', u.nextBillingDate);
      console.log('  Garage Access IDs:', u.garageAccessIds);
    });
  }

  await prisma.$disconnect();
}

findEACTelford();
