const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkGarage() {
  const garageId = 'e1a3fa3b-aced-40d1-84e7-e99b30fda058';
  
  const garage = await prisma.garage.findUnique({
    where: { id: garageId },
    include: {
      agentConfiguration: true,
      business: true
    }
  });
  
  if (!garage) {
    console.log('Garage not found');
    return;
  }
  
  console.log('\n=== GARAGE INFO ===');
  console.log('Name:', garage.name);
  console.log('ID:', garage.id);
  console.log('Twilio Number:', garage.twilioNumber);
  console.log('Business:', garage.business?.name || 'None');
  
  console.log('\n=== AGENT CONFIGURATION ===');
  if (garage.agentConfiguration) {
    console.log('Agent Type:', garage.agentConfiguration.agentType);
    console.log('Agent Script:', garage.agentConfiguration.agentScript);
    console.log('Branch Name:', garage.agentConfiguration.branchName);
    console.log('Integration Provider:', garage.agentConfiguration.integrationProvider);
    console.log('Integration Config:', JSON.stringify(garage.agentConfiguration.integrationProviderConfig, null, 2));
    console.log('Allow Fast Fit Only:', garage.agentConfiguration.allowFastFitOnly);
    console.log('Enable SMS Booking Links:', garage.agentConfiguration.enableSmsBookingLinks);
    console.log('Tone Preference:', garage.agentConfiguration.tonePreference);
    console.log('Voice:', garage.agentConfiguration.voice);
  } else {
    console.log('No agent configuration found');
  }
  
  await prisma.$disconnect();
}

checkGarage().catch(console.error);
