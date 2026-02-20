const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkConfig() {
  const garageId = 'e1a3fa3b-aced-40d1-84e7-e99b30fda058';
  
  const config = await prisma.agentConfiguration.findUnique({
    where: { garageId },
    include: {
      garage: {
        select: {
          name: true,
          twilioNumber: true
        }
      }
    }
  });
  
  if (!config) {
    console.log('No configuration found');
    return;
  }
  
  console.log('\n=== POSTGRES CONFIGURATION ===');
  console.log('Garage:', config.garage.name);
  console.log('Branch Name:', config.branchName);
  console.log('Agent Type:', config.agentType);
  console.log('Agent Script:', config.agentScript);
  console.log('Integration Provider:', config.integrationProvider);
  console.log('Integration Config:', JSON.stringify(config.integrationProviderConfig, null, 2));
  console.log('Updated At:', config.updatedAt.toISOString());
  
  await prisma.$disconnect();
}

checkConfig().catch(console.error);
