require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Find ReceptionMate garage
  const garage = await prisma.garage.findFirst({
    where: { name: { contains: 'ReceptionMate' } },
    include: { agentConfiguration: true },
  });

  if (!garage) {
    console.log('Garage not found');
    return;
  }

  console.log('Garage:', garage.name);
  console.log('ID:', garage.id);
  
  const config = garage.agentConfiguration;
  if (!config) {
    console.log('No agent configuration');
    return;
  }

  console.log('\nAgent Configuration:');
  console.log('Integration Provider:', config.integrationProvider);
  console.log('Integration Provider Config:', JSON.stringify(config.integrationProviderConfig, null, 2));
  console.log('Agent Type:', config.agentType);
  
  // Check if GarageHive would be detected
  const hasGH = config.integrationProvider === 'garagehive' ||
                (config.integrationProviderConfig &&
                 config.integrationProviderConfig.ghCustomerId);
  
  console.log('\nWould enable booking tools?', hasGH);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
